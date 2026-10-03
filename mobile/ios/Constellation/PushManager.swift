import SwiftUI
import UserNotifications
import BackgroundTasks

/// Roteia o toque numa notificação pra tarefa certa dentro do app.
final class PushRouter: ObservableObject {
    static let shared = PushRouter()
    @Published var openTaskId: String? = nil
    @Published var goToQuestions = false
}

/// Push + notificações locais:
/// - pede permissão e registra o token APNs na nuvem (device_tokens) — pronto
///   pro remetente quando a chave da conta Apple existir;
/// - mostra banner mesmo com o app em primeiro plano;
/// - toque na notificação → abre a tarefa/pergunta;
/// - BGAppRefresh: com o app em background, re-checa perguntas abertas e
///   dispara notificação LOCAL (funciona hoje, sem conta Apple).
final class PushManager: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let refreshId = "dev.constellation.refresh"

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // QUESTION: responder a pergunta DIRETO da notificação (app fechado)
        let reply = UNTextInputNotificationAction(identifier: "reply", title: "Responder…",
                                                  options: [], textInputButtonTitle: "Enviar",
                                                  textInputPlaceholder: "sua resposta pro agente")
        let open = UNNotificationAction(identifier: "open", title: "Abrir a tarefa", options: [.foreground])
        // TETO de custo: as duas saídas na própria notificação
        let more = UNNotificationAction(identifier: "teto-more", title: "Continuar (+1 teto)", options: [])
        let stop = UNNotificationAction(identifier: "teto-stop", title: "Parar aqui", options: [.destructive])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "QUESTION", actions: [reply, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "TETO", actions: [more, stop, open], intentIdentifiers: []),
        ])
        // já autorizado antes? registra o token (a PERGUNTA de permissão só vem depois do login, com contexto)
        UNUserNotificationCenter.current().getNotificationSettings { st in
            if st.authorizationStatus == .authorized || st.authorizationStatus == .provisional {
                DispatchQueue.main.async { application.registerForRemoteNotifications() }
            }
        }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshId, using: nil) { task in
            Self.handleRefresh(task as! BGAppRefreshTask)
        }
        Self.scheduleRefresh()
        return true
    }

    /// pede a permissão (uma vez, já logado — antes era na 1ª abertura, por cima do onboarding)
    static func requestAuthorization() {
        #if DEBUG
        if ProcessInfo.processInfo.environment["DEMO_SESSION"] == "1" { return } // harness: sem o alerta do sistema por cima dos prints
        #endif
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in
            // registra SEMPRE — o token existe mesmo com alerta negado; assim, quando a
            // pessoa ligar a permissão nos Ajustes, o push já funciona sem reinstalar
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    // token APNs → nuvem (upsert; RLS: só o dono vê) — pela Supa ÚNICA (renova o token se preciso)
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task {
            let supa = Supa.shared
            guard let uid = supa.session?.userId else { return }
            _ = try? await supa.rest("device_tokens?on_conflict=token", method: "POST", json: [
                "token": token, "user_id": uid, "platform": "ios",
                "updated_at": ISO8601DateFormatter().string(from: Date()),
            ], prefer: "resolution=merge-duplicates")
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // simulador/sem conta Apple: normal — as notificações LOCAIS seguem valendo
    }

    // banner visível mesmo com o app aberto; push do Mac que repete um aviso local já mostrado = silencioso
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        if notification.request.trigger is UNPushNotificationTrigger {
            let u = notification.request.content.userInfo
            let delivered = await center.deliveredNotifications()
            let dup = delivered.contains { d in
                guard !(d.request.trigger is UNPushNotificationTrigger) else { return false }
                let v = d.request.content.userInfo
                if let q = u["questionId"] as? String, !q.isEmpty, (v["questionId"] as? String) == q { return true }
                return (u["taskId"] as? String) == (v["taskId"] as? String) && (v["kind"] as? String) == "ready"
                    && notification.request.content.title.hasPrefix("Entrega pronta")
            }
            if dup { return [] }
        }
        return [.banner, .sound, .badge, .list]
    }

    // toque/resposta → roteia ou responde a pergunta sem abrir o app
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let qid = info["questionId"] as? String ?? ""
        var answer: String? = nil
        if let text = (response as? UNTextInputNotificationResponse)?.userText { answer = text }
        if response.actionIdentifier == "teto-more" { answer = "Continuar com mais um teto" }
        if response.actionIdentifier == "teto-stop" { answer = "Parar aqui" }
        if let answer, !qid.isEmpty {
            // resposta NA notificação → fecha a pergunta na nuvem (com renovação de token); o Mac entrega ao agente
            do { try await Supa.shared.answerQuestion(id: qid, text: answer) }
            catch {
                // falhou (sem rede, já respondida…): avisa em vez de sumir calado
                let c = UNMutableNotificationContent()
                c.title = "A resposta não foi enviada"
                c.body = error.localizedDescription + " — abra o app e responda de novo."
                c.userInfo = info
                try? await center.add(UNNotificationRequest(identifier: "fail-" + qid, content: c, trigger: nil))
            }
            return
        }
        await MainActor.run {
            if let tid = info["taskId"] as? String, !tid.isEmpty {
                PushRouter.shared.openTaskId = tid
            } else {
                PushRouter.shared.goToQuestions = true
            }
        }
    }

    // ---- background refresh: mesma sincronia (transições → avisos locais) ----
    static func scheduleRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: refreshId)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    static func handleRefresh(_ task: BGAppRefreshTask) {
        scheduleRefresh() // re-agenda sempre
        let work = Task { @MainActor in
            await SyncHub.shared.backgroundCheck()
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
    }
}
