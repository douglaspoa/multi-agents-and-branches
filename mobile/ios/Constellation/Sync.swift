import Foundation
import Network
import Combine
import UserNotifications

/// SINCRONIA ÚNICA do app (antes: Central, Minhas e a barra de abas tinham cada uma o seu laço de 6–7s,
/// três leituras iguais em paralelo e nenhuma sabia se a rede tinha caído).
///
///  - ao vivo (Realtime) acorda a leitura; polling é a rede de segurança: 30s com o ao vivo de pé, 5s sem ele;
///  - fundo = para tudo; primeiro plano = reconecta e relê na hora; rede voltou = idem;
///  - estado HONESTO: sem internet · reconectando · Mac offline (visto há X) · ao vivo;
///  - avisos por transição (terminou · travou · perguntou · teto · PR) — mesmos com o app aberto ou no fundo.
@MainActor
final class SyncHub: ObservableObject {
    static let shared = SyncHub()

    @Published private(set) var tasks: [CloudTask] = []
    @Published private(set) var questions: [Question] = []
    @Published private(set) var projects: [Project] = []
    @Published private(set) var presence: [DesktopPresence] = []
    @Published private(set) var loaded = false
    @Published private(set) var lastOk: Date? = nil
    @Published private(set) var restFails = 0
    @Published private(set) var network = true
    @Published private(set) var rt: RTState = .idle
    @Published private(set) var presenceFromTable = true
    /// última fala do agente por tarefa (o "o que está fazendo agora" dos cartões)
    @Published private(set) var lastFeed: [String: FeedItem] = [:]
    @Published var toast: Toast? = nil
    /// projeto escolhido nos chips (nil = todos)
    @Published var projectFilter: String? = UserDefaults.standard.string(forKey: "projectFilter") {
        didSet { UserDefaults.standard.set(projectFilter, forKey: "projectFilter") }
    }
    /// empurrão por tarefa (feed/mensagem/pergunta/status mudou) — o detalhe relê pelo cursor
    let nudge = PassthroughSubject<String, Never>()

    struct Toast: Identifiable, Equatable { let id = UUID(); let text: String; let bad: Bool }

    private let supa = Supa.shared
    private lazy var realtime: RealtimeClient = {
        let r = RealtimeClient(baseURL: Supa.url, apikey: Supa.anon)
        r.tokenProvider = { await Supa.shared.validToken() }
        r.refreshToken = { await Supa.shared.refresh() }
        // o ao vivo caiu ou voltou: relê JÁ e recalcula o ritmo (sem esperar o intervalo de 30s de quando estava ao vivo)
        r.onState = { [weak self] s in
            guard let self else { return }
            let was = self.rt
            self.rt = s
            if s == .live || was == .live { self.wake() }
        }
        r.onChange = { [weak self] c in self?.onChange(c) }
        r.onChannel = { [weak self] topic, ok in self?.onChannel(topic, ok) }
        return r
    }()
    private let monitor = NWPathMonitor()
    private var loop: Task<Void, Never>?
    private var active = false
    private var wantNow = false
    private var nextAt = Date.distantPast
    private var projectsAt = Date.distantPast
    private var fallbackSeen: Date? = nil
    private var coreLive = false
    private var userId = ""

    private init() {
        monitor.pathUpdateHandler = { [weak self] p in
            let ok = p.status == .satisfied
            Task { @MainActor in
                guard let self, ok != self.network else { return }
                self.network = ok
                if ok { self.realtime.kick(); self.wake() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "starfork.net"))
        supa.onToken = { [weak self] tok in Task { @MainActor in self?.realtime.updateToken(tok) } }
    }

    // MARK: derivados

    var me: String { supa.session?.userId ?? "" }
    func isMine(_ t: CloudTask) -> Bool { let o = t.assignee ?? t.createdBy; return o == nil || o == me }
    var macStatus: MacStatus { MacStatus.eval(rows: presence, fallbackLastSeen: fallbackSeen) }
    var summary: ConnSummary { ConnSummary.make(network: network, rt: rt, restFails: restFails, lastOk: lastOk, mac: macStatus) }
    func project(_ id: String?) -> Project? { projects.first { $0.id == id } }
    func reach(_ t: CloudTask) -> MacReach { MacReach.eval(projectRemote: project(t.projectId)?.repoRemote, rows: presence, status: macStatus) }
    func reach(projectId: String) -> MacReach { MacReach.eval(projectRemote: project(projectId)?.repoRemote, rows: presence, status: macStatus) }
    /// tarefas visíveis no filtro de projeto
    var visible: [CloudTask] { projectFilter.map { pf in tasks.filter { $0.projectId == pf } } ?? tasks }
    /// projetos que aparecem nos chips: só os que têm demanda (ou o filtrado)
    var projectChips: [Project] {
        let used = Set(tasks.compactMap(\.projectId))
        return projects.filter { used.contains($0.id) || $0.id == projectFilter }
    }
    /// perguntas abertas de demandas MINHAS (as dos outros o banco recusa — 0013)
    var myQuestions: [Question] {
        questions.filter { q in
            if let t = tasks.first(where: { $0.id == q.taskId }) { return isMine(t) }
            let o = q.task?.assignee ?? q.task?.createdBy
            return o == nil || o == me
        }
    }

    // MARK: ciclo de vida

    func setActive(_ on: Bool) {
        guard supa.session != nil else { stopAll(); return }
        if on == active { if on { wake() }; return }
        active = on
        if on {
            userId = me
            realtime.join(.init(topic: "realtime:core", tables: [("tasks", nil), ("questions", nil)]))
            realtime.join(.init(topic: "realtime:mac", tables: [("desktop_presence", "user_id=eq.\(me)")]))
            realtime.start()
            wake()
            if loop == nil { loop = Task { [weak self] in await self?.run() } }
        } else {
            realtime.stop()
            loop?.cancel(); loop = nil
        }
    }

    /// saiu da conta: limpa tudo (nada da conta anterior aparece na próxima)
    func stopAll() {
        active = false
        realtime.stop()
        loop?.cancel(); loop = nil
        tasks = []; questions = []; presence = []; projects = []; lastFeed = [:]; loaded = false; lastOk = nil; restFails = 0
        fallbackSeen = nil; projectsAt = .distantPast
    }

    /// relê na próxima volta (coalescido: 10 empurrões em 1s = 1 leitura)
    func wake() { wantNow = true }

    private func run() async {
        while !Task.isCancelled {
            if active && (wantNow || Date() >= nextAt) {
                wantNow = false
                await refresh()
                nextAt = Date().addingTimeInterval(coreLive && rt == .live ? 30 : (network ? 5 : 15))
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    // MARK: leitura

    func refresh() async {
        guard supa.session != nil else { return }
        if !userId.isEmpty && me != userId { stopAll() }   // trocou de conta: nada da anterior fica na tela
        userId = me
        async let tD = supa.rest("tasks?select=id,title,status,flag,branch,pr_url,cost_usd,assignee,created_by,updated_at,project_id,spec,requirements_proof&order=updated_at.desc&limit=150")
        async let qD = supa.rest("questions?select=id,task_id,agent,prompt,options,created_at,tasks(title,assignee,created_by)&status=eq.open&order=created_at.desc&limit=40")
        let wantProjects = Date().timeIntervalSince(projectsAt) > 300 || projects.isEmpty
        async let pD: Data? = wantProjects ? (try? await supa.rest("projects?select=id,name,team_id,repo_remote&order=name")) : nil
        async let fD: Data? = try? await supa.rest("task_feed?select=id,task_id,agent,kind,text&order=id.desc&limit=80")
        await refreshPresence()
        do {
            let ts = try JSONDecoder().decode([CloudTask].self, from: try await tD)
            let qs = (try? JSONDecoder().decode([Question].self, from: try await qD)) ?? questions
            if let pd = await pD, let ps = try? JSONDecoder().decode([Project].self, from: pd) { projects = ps; projectsAt = Date() }
            if let fd = await fD, let fs = try? JSONDecoder().decode([FeedItem].self, from: fd) {
                var m: [String: FeedItem] = [:]
                for f in fs where !f.text.hasPrefix("❓") { if let tid = f.taskId, m[tid] == nil { m[tid] = f } }
                if m.mapValues(\.id) != lastFeed.mapValues(\.id) { lastFeed = m }
            }
            notifyTransitions(ts, qs)
            if ts.map(\.updatedAt) != tasks.map(\.updatedAt) || ts.map(\.id) != tasks.map(\.id) { tasks = ts }
            if qs != questions { questions = qs }
            loaded = true; lastOk = Date(); restFails = 0
            if let f = projectFilter, !projects.isEmpty, !projects.contains(where: { $0.id == f }) { projectFilter = nil }
        } catch {
            loaded = true
            restFails += 1
            // erro de verdade (não queda de rede) aparece uma vez — o banner já conta a história da conexão
            if !Supa.isOffline(error), restFails == 2 { toast = Toast(text: error.localizedDescription, bad: true) }
        }
    }

    private func refreshPresence() async {
        if presenceFromTable {
            do {
                let d = try await supa.rest("desktop_presence?select=device_id,device_name,open_remote,open_legacy,open_project,local_remotes,running,online,last_seen_at&user_id=eq.\(me)&order=last_seen_at.desc&limit=5")
                presence = (try? JSONDecoder().decode([DesktopPresence].self, from: d)) ?? []
                if !presence.isEmpty { return }
            } catch Supa.SupaError.missingTable {
                presenceFromTable = false   // migration 0030 não aplicada: usa o "online" do perfil
            } catch { return }
        }
        if let d = try? await supa.rest("profiles?select=last_seen_at&user_id=eq.\(me)"),
           let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]],
           let s = arr.first?["last_seen_at"] as? String {
            fallbackSeen = parseISO(s)
        }
    }

    // MARK: ao vivo

    private func onChange(_ c: RealtimeClient.Change) {
        let tid = (c.record["task_id"] as? String) ?? (c.table == "tasks" ? c.record["id"] as? String : nil)
        if let tid { nudge.send(tid) }
        if c.table == "desktop_presence" || c.table == "tasks" || c.table == "questions" { wake() }
    }

    private func onChannel(_ topic: String, _ ok: Bool) {
        if topic == "realtime:core" { coreLive = ok }
        if topic == "realtime:mac" && !ok { /* sem a 0030: o batimento chega pelo polling */ }
        if topic.hasPrefix("realtime:feed-") { feedLive[String(topic.dropFirst("realtime:feed-".count))] = ok }
        wake()
    }

    @Published private(set) var feedLive: [String: Bool] = [:]
    func joinFeed(_ taskId: String) {
        realtime.join(.init(topic: "realtime:feed-\(taskId)", tables: [("task_feed", "task_id=eq.\(taskId)"), ("task_messages", "task_id=eq.\(taskId)")]))
    }
    func leaveFeed(_ taskId: String) {
        realtime.leave("realtime:feed-\(taskId)")
        feedLive[taskId] = nil
    }

    // MARK: ações (erros VISÍVEIS — antes `try?` engolia e o botão fingia que foi)

    func answer(_ q: Question, _ text: String) async -> Bool {
        do {
            try await supa.answerQuestion(id: q.id, text: text)
            questions.removeAll { $0.id == q.id }
            let r = tasks.first { $0.id == q.taskId }.map(reach) ?? .unknown
            toast = Toast(text: reachNote(r, done: "resposta enviada — o agente continua"), bad: false)
            wake(); return true
        } catch { toast = Toast(text: error.localizedDescription, bad: true); wake(); return false }
    }

    func intent(_ taskId: String, _ kind: String, extra: [String: Any] = [:]) async -> Bool {
        do {
            try await supa.sendIntent(taskId: taskId, kind: kind, extra: extra)
            let r = tasks.first { $0.id == taskId }.map(reach) ?? .unknown
            toast = Toast(text: reachNote(r, done: "pedido enviado ao Mac"), bad: false)
            wake(); nudge.send(taskId); return true
        } catch { toast = Toast(text: error.localizedDescription, bad: true); return false }
    }

    func message(_ taskId: String, _ body: String) async -> Bool {
        do {
            try await supa.sendMessage(taskId: taskId, body: body)
            nudge.send(taskId); return true
        } catch { toast = Toast(text: error.localizedDescription, bad: true); return false }
    }

    /// o que dizer depois de uma ação, conforme o Mac consegue (ou não) executar agora
    func reachNote(_ r: MacReach, done: String) -> String {
        switch r {
        case .here, .unknown: return done
        case .offline: return "na fila — o Mac está offline; executa quando voltar"
        case .otherProject(let p): return "na fila — o Mac está com \(p) aberto; abra este projeto lá"
        case .notOnMac: return "na fila — nenhum Mac seu tem este projeto"
        }
    }

    // MARK: avisos por transição

    private static let snapKey = "sync.snap", qKey = "sync.seenQ", sentKey = "sync.sentNotices"

    private func notifyTransitions(_ ts: [CloudTask], _ qs: [Question]) {
        let ud = UserDefaults.standard
        let prevData = ud.data(forKey: Self.snapKey + "." + me)
        let prev = prevData.flatMap { try? JSONDecoder().decode([String: TaskSnap].self, from: $0) } ?? [:]
        let prevQ = Set(ud.stringArray(forKey: Self.qKey + "." + me) ?? [])
        let notices = Transitions.diff(prev: prev, tasks: ts, prevQ: prevQ,
                                       questions: qs.map { .init(id: $0.id, taskId: $0.taskId, agent: $0.agent, prompt: $0.prompt, options: $0.options) },
                                       isMine: isMine, firstLoad: prevData == nil)
        let snap = Dictionary(ts.map { ($0.id, Transitions.snap($0)) }, uniquingKeysWith: { a, _ in a })
        if let d = try? JSONEncoder().encode(snap) { ud.set(d, forKey: Self.snapKey + "." + me) }
        ud.set(Array(Set(qs.map(\.id)).union(prevQ).suffix(300)), forKey: Self.qKey + "." + me)
        if !notices.isEmpty { Task { await Notifier.post(notices) } }
    }

    /// BGAppRefresh (app no fundo): mesma leitura + avisos, sem ao vivo
    func backgroundCheck() async {
        guard supa.session != nil else { return }
        await refresh()
    }
}

/// posta notificações LOCAIS respeitando as preferências e sem duplicar com o push APNs do Mac
enum Notifier {
    static func enabled(_ k: Notice.Kind) -> Bool {
        let key = Transitions.prefKey(k)
        return UserDefaults.standard.object(forKey: key) as? Bool ?? true
    }

    static func post(_ notices: [Notice]) async {
        let c = UNUserNotificationCenter.current()
        let delivered = await c.deliveredNotifications()
        var sent = Set(UserDefaults.standard.stringArray(forKey: "sync.sentNotices") ?? [])
        for n in notices where enabled(n.kind) {
            if sent.contains(n.key) { continue }
            // o Mac já mandou push APNs da mesma coisa (pergunta / entrega pronta)? não repete
            let dup = delivered.contains { d in
                let u = d.request.content.userInfo
                if let q = n.questionId, (u["questionId"] as? String) == q { return true }
                return n.kind == .ready && (u["taskId"] as? String) == n.taskId && d.request.content.title.hasPrefix("Entrega pronta")
            }
            sent.insert(n.key)
            if dup { continue }
            let ct = UNMutableNotificationContent()
            ct.title = n.title
            ct.body = n.body
            ct.sound = .default
            ct.threadIdentifier = n.taskId
            ct.userInfo = ["taskId": n.taskId, "questionId": n.questionId ?? "", "kind": n.kind.rawValue]
            if n.kind == .question { ct.categoryIdentifier = "QUESTION" }
            if n.kind == .teto { ct.categoryIdentifier = "TETO" }
            try? await c.add(UNNotificationRequest(identifier: n.key, content: ct, trigger: nil))
        }
        UserDefaults.standard.set(Array(sent.suffix(400)), forKey: "sync.sentNotices")
    }
}
