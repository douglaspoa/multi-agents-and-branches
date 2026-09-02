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
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { ok, _ in
            if ok { DispatchQueue.main.async { application.registerForRemoteNotifications() } }
        }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshId, using: nil) { task in
            Self.handleRefresh(task as! BGAppRefreshTask)
        }
        Self.scheduleRefresh()
        return true
    }

    // token APNs → nuvem (upsert; RLS: só o dono vê)
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task {
            let supa = Supa()
            guard supa.session != nil else { return }
            var req = URLRequest(url: URL(string: Supa.url.absoluteString + "/rest/v1/device_tokens?on_conflict=token")!)
            req.httpMethod = "POST"
            req.setValue(Supa.anon, forHTTPHeaderField: "apikey")
            req.setValue("Bearer " + (supa.session?.accessToken ?? ""), forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("resolution=merge-duplicates", forHTTPHeaderField: "Prefer")
            req.httpBody = try? JSONSerialization.data(withJSONObject: [
                "token": token, "user_id": supa.session?.userId ?? "", "platform": "ios",
                "updated_at": ISO8601DateFormatter().string(from: Date()),
            ])
            _ = try? await URLSession.shared.data(for: req)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // simulador/sem conta Apple: normal — as notificações LOCAIS seguem valendo
    }

    // banner visível mesmo com o app aberto (ex.: você está na aba Time)
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    // toque → roteia
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        await MainActor.run {
            if let tid = info["taskId"] as? String, !tid.isEmpty {
                PushRouter.shared.openTaskId = tid
            } else {
                PushRouter.shared.goToQuestions = true
            }
        }
    }

    // ---- background refresh: pergunta nova → notificação local ----
    static func scheduleRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: refreshId)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    static func handleRefresh(_ task: BGAppRefreshTask) {
        scheduleRefresh() // re-agenda sempre
        let work = Task {
            await checkQuestionsAndNotify()
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
    }

    /// Busca perguntas abertas; as que ainda não foram notificadas viram
    /// notificação local com o taskId no userInfo (toque abre a tarefa).
    static func checkQuestionsAndNotify() async {
        let supa = Supa()
        guard let s = supa.session else { return }
        var req = URLRequest(url: URL(string: Supa.url.absoluteString + "/rest/v1/questions?select=id,agent,prompt,task_id&status=eq.open&order=id&limit=20")!)
        req.setValue(Supa.anon, forHTTPHeaderField: "apikey")
        req.setValue("Bearer " + s.accessToken, forHTTPHeaderField: "Authorization")
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        var seen = Set(UserDefaults.standard.stringArray(forKey: "notifiedQ") ?? [])
        for r in rows {
            guard let qid = r["id"] as? String ?? (r["id"] as? Int).map(String.init) else { continue }
            if seen.contains(qid) { continue }
            seen.insert(qid)
            let c = UNMutableNotificationContent()
            c.title = "Precisa de você — \(r["agent"] as? String ?? "agente")"
            c.body = String((r["prompt"] as? String ?? "").prefix(140))
            c.sound = .default
            c.userInfo = ["taskId": r["task_id"] as? String ?? ""]
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "q-" + qid, content: c, trigger: nil))
        }
        UserDefaults.standard.set(Array(seen.suffix(200)), forKey: "notifiedQ")
    }
}
