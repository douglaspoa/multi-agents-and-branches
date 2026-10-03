import Foundation

/// Supabase Realtime (protocolo Phoenix v1 sobre WebSocket), sem dependências.
///
/// Papel no app: o ao vivo é um EMPURRÃO — cada mudança (tarefa, pergunta, fala do agente, batimento do Mac)
/// acorda a sincronia, que relê pela API REST com CURSOR (feed por id > último). Assim nada duplica nem se perde:
/// se o socket cair no meio, a próxima leitura pelo cursor traz o buraco inteiro.
///
/// Confiabilidade:
///  - batimento a cada 25s; sem resposta ao anterior = conexão morta → reconecta (rede que "pendura" calada);
///  - reconexão com backoff exponencial + jitter (0,5s → 30s); rede voltou/app voltou ao primeiro plano = já;
///  - token novo → `access_token` em cada canal (sem derrubar o socket); canal fechado por token vencido →
///    renova e entra de novo;
///  - canal recusado pelo servidor (tabela fora da publicação, migration pendente) → marca indisponível e a
///    sincronia cai pro polling rápido daquela parte (nada quebra).
@MainActor
final class RealtimeClient {
    struct Change { let table: String; let type: String; let record: [String: Any]; let topic: String }
    struct ChannelSpec { let topic: String; let tables: [(table: String, filter: String?)] }

    private(set) var state: RTState = .idle { didSet { if state != oldValue { onState?(state) } } }
    var onState: ((RTState) -> Void)?
    var onChange: ((Change) -> Void)?
    /// canal confirmado (true) ou recusado (false) — a sincronia ajusta o ritmo do polling
    var onChannel: ((String, Bool) -> Void)?
    var tokenProvider: (() async -> String?)?
    var refreshToken: (() async -> Bool)?

    private let baseURL: URL
    private let apikey: String
    private var ws: URLSessionWebSocketTask?
    private var session: URLSession = URLSession(configuration: .default)
    private var specs: [String: ChannelSpec] = [:]
    private var joined: [String: String] = [:]      // topic → join_ref
    private(set) var refused: [String: String] = [:] // topic → motivo
    private var ref = 0
    private var pendingHeartbeat: String?
    private var heartbeatTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var attempt = 0
    private var wanted = false
    private var generation = 0

    init(baseURL: URL, apikey: String) {
        self.baseURL = baseURL
        self.apikey = apikey
    }

    var isLive: Bool { state == .live }
    func isJoined(_ topic: String) -> Bool { joined[topic] != nil }

    // MARK: ciclo de vida

    func start() {
        wanted = true
        if ws == nil { connect() }
    }

    /// app foi pro fundo / saiu da conta: fecha limpo (o iOS suspenderia o socket de qualquer jeito)
    func stop() {
        wanted = false
        retryTask?.cancel(); retryTask = nil
        teardown()
        state = .idle
    }

    /// rede voltou / app voltou à frente: tenta JÁ (zera o backoff)
    func kick() {
        guard wanted else { return }
        attempt = 0
        if case .live = state { sendHeartbeat(); return }
        retryTask?.cancel(); retryTask = nil
        teardown()
        connect()
    }

    func join(_ spec: ChannelSpec) {
        specs[spec.topic] = spec
        refused[spec.topic] = nil
        if state == .live { sendJoin(spec) }
    }

    func leave(_ topic: String) {
        specs[topic] = nil
        refused[topic] = nil
        if joined.removeValue(forKey: topic) != nil { send(topic: topic, event: "phx_leave", payload: [:]) }
    }

    func updateToken(_ token: String) {
        for topic in joined.keys { send(topic: topic, event: "access_token", payload: ["access_token": token]) }
    }

    // MARK: conexão

    private func socketURL() -> URL? {
        guard var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        c.scheme = (c.scheme == "http") ? "ws" : "wss"
        c.path = (c.path.hasSuffix("/") ? String(c.path.dropLast()) : c.path) + "/realtime/v1/websocket"
        c.queryItems = [URLQueryItem(name: "apikey", value: apikey), URLQueryItem(name: "vsn", value: "1.0.0")]
        return c.url
    }

    private func connect() {
        guard wanted, let url = socketURL() else { return }
        generation += 1
        let gen = generation
        state = attempt == 0 ? .connecting : state
        let task = session.webSocketTask(with: url)
        ws = task
        task.resume()
        receiveTask = Task { [weak self] in await self?.receiveLoop(task, gen: gen) }
        // o handshake só se confirma na 1ª resposta: o batimento serve de sonda
        pendingHeartbeat = nil
        sendHeartbeat()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(25))
                guard let self, gen == self.generation else { return }
                if self.pendingHeartbeat != nil { self.fail("sem resposta ao batimento"); return }
                self.sendHeartbeat()
            }
        }
    }

    private func teardown() {
        generation += 1
        heartbeatTask?.cancel(); heartbeatTask = nil
        receiveTask?.cancel(); receiveTask = nil
        ws?.cancel(with: .goingAway, reason: nil)
        ws = nil
        joined.removeAll()
        pendingHeartbeat = nil
    }

    private func fail(_ why: String) {
        teardown()
        guard wanted else { state = .idle; return }
        let d = Backoff.delay(attempt: attempt)
        state = .retrying(attempt: attempt, at: Date().addingTimeInterval(d))
        attempt += 1
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(d))
            guard !Task.isCancelled, let self, self.wanted else { return }
            self.connect()
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask, gen: Int) async {
        while !Task.isCancelled {
            do {
                let msg = try await task.receive()
                guard gen == generation else { return }
                switch msg {
                case .string(let s): handle(s)
                case .data(let d): handle(String(decoding: d, as: UTF8.self))
                @unknown default: break
                }
            } catch {
                guard gen == generation else { return }
                fail(error.localizedDescription)
                return
            }
        }
    }

    // MARK: protocolo

    private func nextRef() -> String { ref += 1; return String(ref) }

    @discardableResult
    private func send(topic: String, event: String, payload: [String: Any], joinRef: String? = nil) -> String {
        let r = nextRef()
        var m: [String: Any] = ["topic": topic, "event": event, "payload": payload, "ref": r]
        if let joinRef { m["join_ref"] = joinRef }
        if let d = try? JSONSerialization.data(withJSONObject: m), let s = String(data: d, encoding: .utf8) {
            ws?.send(.string(s)) { _ in }
        }
        return r
    }

    private func sendHeartbeat() {
        pendingHeartbeat = send(topic: "phoenix", event: "heartbeat", payload: [:])
    }

    private func sendJoin(_ spec: ChannelSpec) {
        Task { [weak self] in
            guard let self else { return }
            let tok = await self.tokenProvider?() ?? ""
            guard self.state == .live, self.specs[spec.topic] != nil else { return }
            let pcs: [[String: Any]] = spec.tables.map { t in
                var c: [String: Any] = ["event": "*", "schema": "public", "table": t.table]
                if let f = t.filter { c["filter"] = f }
                return c
            }
            let payload: [String: Any] = [
                "config": ["broadcast": ["ack": false, "self": false], "presence": ["key": ""], "postgres_changes": pcs, "private": false],
                "access_token": tok,
            ]
            let r = self.nextRef()
            self.pendingJoins[r] = spec.topic
            var m: [String: Any] = ["topic": spec.topic, "event": "phx_join", "payload": payload, "ref": r, "join_ref": r]
            m["join_ref"] = r
            if let d = try? JSONSerialization.data(withJSONObject: m), let s = String(data: d, encoding: .utf8) {
                self.ws?.send(.string(s)) { _ in }
            }
        }
    }
    private var pendingJoins: [String: String] = [:]  // ref → topic

    private func handle(_ text: String) {
        guard let d = text.data(using: .utf8),
              let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
        let topic = m["topic"] as? String ?? ""
        let event = m["event"] as? String ?? ""
        let payload = m["payload"] as? [String: Any] ?? [:]
        let r = m["ref"] as? String

        if event == "phx_reply" {
            let status = payload["status"] as? String
            if topic == "phoenix", r == pendingHeartbeat {
                pendingHeartbeat = nil
                if state != .live {
                    // socket de pé: (re)entra em todos os canais
                    state = .live
                    attempt = 0
                    for s in specs.values { sendJoin(s) }
                }
                return
            }
            if let r, let jt = pendingJoins.removeValue(forKey: r) {
                if status == "ok" { joined[jt] = r }
                else {
                    let reason = ((payload["response"] as? [String: Any])?["reason"] as? String) ?? "recusado"
                    joined[jt] = nil
                    if reason.lowercased().contains("token") { rejoinAfterRefresh(jt) }
                    else { refused[jt] = reason; onChannel?(jt, false) }
                }
            }
            return
        }
        if event == "system" {
            let status = payload["status"] as? String
            let msg = payload["message"] as? String ?? ""
            if status == "ok" { refused[topic] = nil; onChannel?(topic, true) }
            else if msg.lowercased().contains("token") { joined[topic] = nil; rejoinAfterRefresh(topic) }
            else { refused[topic] = msg; joined[topic] = nil; onChannel?(topic, false) }
            return
        }
        if event == "phx_close" || event == "phx_error" {
            if joined.removeValue(forKey: topic) != nil, specs[topic] != nil, refused[topic] == nil { rejoinAfterRefresh(topic) }
            return
        }
        if event == "postgres_changes", let data = payload["data"] as? [String: Any] {
            let table = data["table"] as? String ?? ""
            let type = data["type"] as? String ?? ""
            let rec = (data["record"] as? [String: Any]) ?? (data["old_record"] as? [String: Any]) ?? [:]
            onChange?(Change(table: table, type: type, record: rec, topic: topic))
        }
    }

    private var rejoining: Set<String> = []
    private func rejoinAfterRefresh(_ topic: String) {
        guard !rejoining.contains(topic) else { return }
        rejoining.insert(topic)
        Task { [weak self] in
            guard let self else { return }
            _ = await self.refreshToken?()
            try? await Task.sleep(for: .seconds(Backoff.delay(attempt: 1)))
            self.rejoining.remove(topic)
            if let s = self.specs[topic], self.state == .live { self.sendJoin(s) }
        }
    }
}
