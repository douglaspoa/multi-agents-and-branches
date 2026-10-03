import Foundation

/// Cliente Supabase mínimo (REST puro, sem dependências). A anon key é pública
/// por design — o RLS no banco é quem protege os dados.
final class Supa: ObservableObject {
    /// UMA instância no app inteiro (app, push, sincronia): antes cada pedaço criava a sua `Supa()` e cada uma
    /// renovava o token por conta própria — renovações paralelas com o MESMO refresh token derrubavam a sessão.
    static let shared = Supa()
    static let prodUrl = URL(string: "https://fivoakrhazlzcdoocgbg.supabase.co")!
    /// DEBUG: SUPA_URL aponta o app pra nuvem FALSA (mobile/ios/mock/mock-supabase.mjs) — prova sem tocar no banco real
    static let url: URL = {
        #if DEBUG
        if let s = ProcessInfo.processInfo.environment["SUPA_URL"], let u = URL(string: s) { return u }
        #endif
        return prodUrl
    }()
    static let anon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpdm9ha3JoYXpsemNkb29jZ2JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwMjcxOTcsImV4cCI6MjEwMzYwMzE5N30.NXr1RjGqhcYHfMU050PRBcBraXsAYw-4FUVyoo3RC8U"
    /// páginas do site que os e-mails de confirmação/recuperação apontam
    static let site = "https://constellation-ai-v1.lovable.app"

    @Published var session: Session? = Session.load()
    /// portão de entrada: sessão + assinatura. `.open` mostra o app.
    @Published var gate: Gate = Session.load() == nil ? .loggedOut : .open
    @Published var plans: [BillingPlan] = []
    @Published var billing: BillingRow? = nil

    enum Gate: Equatable { case loggedOut, needsPlan, ready, open }

    struct Session: Codable {
        var accessToken: String
        var refreshToken: String
        var userId: String
        var email: String
        /// epoch (s) em que o access token vence — renovamos ANTES (sessões antigas não têm: renova no 1º 401)
        var expiresAt: Double? = nil

        static func load() -> Session? {
            #if DEBUG
            if ProcessInfo.processInfo.environment["DEMO_SESSION"] == "1", Supa.url != Supa.prodUrl, UserDefaults.standard.data(forKey: "sb.session") == nil {
                // token VENCIDO de propósito: a 1ª chamada leva 401 e prova a renovação
                return Session(accessToken: "mock-at-0-0", refreshToken: "mock-rt-0", userId: "11111111-1111-4111-8111-111111111111", email: "douglas@exemplo.dev")
            }
            #endif
            guard let d = UserDefaults.standard.data(forKey: "sb.session") else { return nil }
            return try? JSONDecoder().decode(Session.self, from: d)
        }
        func save() { UserDefaults.standard.set(try? JSONEncoder().encode(self), forKey: "sb.session") }
        static func clear() { UserDefaults.standard.removeObject(forKey: "sb.session") }
    }

    enum SupaError: LocalizedError {
        case api(String)
        /// sem rede / servidor inalcançável — a tela diz "sem internet", não um erro cru
        case offline
        /// a tabela não existe nessa nuvem (migration ainda não aplicada) — o app degrada sem quebrar
        case missingTable(String)
        case http(Int, String)
        var errorDescription: String? {
            switch self {
            case .api(let m): return m
            case .offline: return "sem conexão com a nuvem — tento de novo sozinho"
            case .missingTable(let t): return "a nuvem ainda não tem \(t) (migration pendente)"
            case .http(let c, let m): return m.isEmpty ? "erro \(c)" : m
            }
        }
    }

    static func isOffline(_ e: Error) -> Bool {
        if case SupaError.offline = e { return true }
        if let u = e as? URLError {
            return [.notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotFindHost, .cannotConnectToHost,
                    .dnsLookupFailed, .internationalRoamingOff, .dataNotAllowed, .secureConnectionFailed].contains(u.code)
        }
        return false
    }

    // MARK: - auth (GoTrue)

    /// POST /auth/v1/<path> com a anon key; devolve o JSON (ou lança em PT)
    @discardableResult
    private func auth(_ path: String, _ body: [String: Any], method: String = "POST", bearer: String? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: Self.url.absoluteString + "/auth/v1/" + path)!)
        req.httpMethod = method
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        req.setValue(Self.anon, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let bearer { req.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization") }
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw SupaError.api("sem resposta") }
        let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard http.statusCode < 300 else {
            let msg = (j["error_description"] ?? j["msg"] ?? j["message"] ?? j["error"]) as? String ?? "falhou (\(http.statusCode))"
            throw SupaError.api(Self.ptError(msg))
        }
        return j
    }

    private func adopt(_ j: [String: Any], email: String) async throws {
        guard let at = j["access_token"] as? String, let rt = j["refresh_token"] as? String,
              let user = j["user"] as? [String: Any], let uid = user["id"] as? String else {
            throw SupaError.api("resposta sem sessão")
        }
        var s = Session(accessToken: at, refreshToken: rt, userId: uid, email: (user["email"] as? String) ?? email)
        s.expiresAt = Self.expiry(j)
        s.save()
        let fresh = s
        await MainActor.run { self.session = fresh; self.onToken?(fresh.accessToken) }
    }

    private static func redir(_ path: String) -> String {
        "redirect_to=" + ((site + path).addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")
    }

    func signIn(email: String, password: String) async throws {
        let j = try await auth("token?grant_type=password", ["email": email, "password": password])
        try await adopt(j, email: email)
    }

    /// cria a conta; a sessão só nasce depois do código de 6 dígitos (confirmação)
    func signUp(name: String, email: String, password: String) async throws {
        let j = try await auth("signup?" + Self.redir("/confirmado"), ["email": email, "password": password, "data": ["name": name]])
        // e-mail já confirmado no projeto? então a sessão vem direto
        if j["access_token"] != nil { try await adopt(j, email: email) }
    }

    /// troca o código de 6 dígitos por sessão (signup · magiclink · recovery · email)
    func verify(type: String, email: String, code: String) async throws {
        let j = try await auth("verify", ["type": type, "email": email, "token": code])
        try await adopt(j, email: email)
    }

    /// Login por CÓDIGO do Mac (Conta → Celular → gerar código)
    func signIn(email: String, code: String) async throws { try await verify(type: "email", email: email, code: code) }

    func resendSignup(email: String) async throws { try await auth("resend?" + Self.redir("/confirmado"), ["type": "signup", "email": email]) }
    func recover(email: String) async throws { try await auth("recover?" + Self.redir("/redefinir-senha"), ["email": email]) }
    func magicLink(email: String) async throws { try await auth("otp?" + Self.redir("/confirmado"), ["email": email, "create_user": false]) }

    func updatePassword(_ password: String) async throws {
        guard let s = session else { throw SupaError.api("não autenticado") }
        try await auth("user", ["password": password], method: "PUT", bearer: s.accessToken)
    }

    func signOut() {
        Session.clear()
        session = nil
        gate = .loggedOut
        billing = nil
    }

    private static func expiry(_ j: [String: Any]) -> Double? {
        if let e = j["expires_at"] as? Double { return e }
        if let e = j["expires_at"] as? Int { return Double(e) }
        if let i = j["expires_in"] as? Double { return Date().timeIntervalSince1970 + i }
        if let i = j["expires_in"] as? Int { return Date().timeIntervalSince1970 + Double(i) }
        return nil
    }

    /// renovação em VOO ÚNICO: várias telas levando 401 juntas esperam a MESMA renovação
    private actor RefreshGate {
        private var task: Task<Bool, Never>?
        func run(_ work: @escaping () async -> Bool) async -> Bool {
            if let t = task { return await t.value }
            let t = Task { await work() }
            task = t
            let v = await t.value
            task = nil
            return v
        }
    }
    private let gate1 = RefreshGate()
    /// avisado a cada token novo (o ao vivo troca o token do canal sem reconectar)
    var onToken: ((String) -> Void)?

    @discardableResult
    func refresh() async -> Bool { await gate1.run { await self.refreshOnce() } }

    /// token que ainda vale pelo menos 60s — renova antes se estiver no fim (nada de 401 evitável)
    func validToken() async -> String? {
        guard let s = session else { return nil }
        if let exp = s.expiresAt, exp - Date().timeIntervalSince1970 < 60 { _ = await refresh() }
        return session?.accessToken
    }

    private func refreshOnce() async -> Bool {
        guard let s = session else { return false }
        var req = URLRequest(url: Self.url.appending(path: "/auth/v1/token").appending(queryItems: [.init(name: "grant_type", value: "refresh_token")]))
        req.httpMethod = "POST"
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["refresh_token": s.refreshToken])
        req.setValue(Self.anon, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // FALHA DE REDE NÃO PODE DESLOGAR: só deslogamos quando o SERVIDOR
        // rejeita o refresh token (400–403).
        guard let (data, resp) = try? await Self.net.data(for: req) else { return false }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 500
        let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if code < 300, let at = j["access_token"] as? String, let rt = j["refresh_token"] as? String {
            var ns = s; ns.accessToken = at; ns.refreshToken = rt; ns.expiresAt = Self.expiry(j)
            ns.save()
            let fresh = ns
            await MainActor.run { self.session = fresh; self.onToken?(at) }
            return true
        }
        if (400...403).contains(code) { await MainActor.run { self.signOut() }; return false }
        return false
    }

    // MARK: - assinatura (mesma régua do desktop: billingSync)

    struct BillingPlan: Identifiable, Decodable {
        let id: String
        let plan: String          // individual · team · enterprise
        let interval: String      // month · year
        let amountCents: Int
        let perSeat: Bool?
        let seats: Int?
        let trialDays: Int?
        enum CodingKeys: String, CodingKey { case id, plan, interval, seats; case amountCents = "amount_cents"; case perSeat = "per_seat"; case trialDays = "trial_days" }
    }
    struct BillingRow: Decodable {
        let userId: String?
        let teamId: String?
        let plan: String?
        let status: String?
        let seats: Int?
        let trialEnd: String?
        var org = false
        enum CodingKeys: String, CodingKey { case plan, status, seats; case userId = "user_id"; case teamId = "team_id"; case trialEnd = "trial_end" }
    }

    /// Decide o portão depois de ter sessão: enterprise da org cobre todos;
    /// senão precisa de assinatura própria ou do time. Erro de rede NUNCA tranca.
    @MainActor
    func checkBilling(afterCheckout: Bool = false) async {
        guard session != nil else { gate = .loggedOut; return }
        do {
            let pd = try await rest("billing_plans?select=*&active=eq.true")
            let ps = (try? JSONDecoder().decode([BillingPlan].self, from: pd)) ?? []
            plans = ps
            if ps.isEmpty { gate = .open; return }         // cobrança não ativada
            struct Org: Decodable { let plan: String?; let paidUntil: String?; enum CodingKeys: String, CodingKey { case plan; case paidUntil = "paid_until" } }
            // paid_until só é gravado pelo ADMIN: validade futura libera em QUALQUER plano (igual ao desktop, 30/09)
            if let od = try? await rest("orgs?select=plan,paid_until"), let orgs = try? JSONDecoder().decode([Org].self, from: od) {
                let parse: (String) -> Date? = { iso in ISO8601DateFormatter().date(from: iso) ?? ISO8601DateFormatter().date(from: String(iso.prefix(19)) + "Z") }
                let grant = orgs.first { o in
                    if let pu = o.paidUntil, let d = parse(pu) { return d > Date() }
                    return o.plan == "enterprise" && o.paidUntil == nil
                }
                if let o = grant { var b = BillingRow(userId: nil, teamId: nil, plan: o.plan ?? "enterprise", status: "active", seats: nil, trialEnd: nil); b.org = true; billing = b; gate = .open; return }
            }
            let bd = try await rest("billing?select=*")
            let rows = (try? JSONDecoder().decode([BillingRow].self, from: bd)) ?? []
            let me = session?.userId ?? ""
            var myTeams: Set<String> = []
            if let td = try? await rest("team_members?select=team_id&user_id=eq.\(me)"),
               let arr = try? JSONSerialization.jsonObject(with: td) as? [[String: Any]] {
                myTeams = Set(arr.compactMap { $0["team_id"] as? String })
            }
            let live = ["trialing", "active"]
            let mine = rows.first { $0.userId == me && live.contains($0.status ?? "") }
            let team = rows.first { $0.plan == "team" && live.contains($0.status ?? "") && myTeams.contains($0.teamId ?? "-") }
            billing = mine ?? team ?? rows.first { $0.userId == me }
            let active = (billing != nil) && live.contains(billing?.status ?? "")
            if active { gate = afterCheckout ? .ready : .open }
            else { gate = .needsPlan }
        } catch {
            gate = .open   // sem rede / erro: não tranca quem já entrou
        }
    }

    /// meu time (pra assinar o plano Time): o primeiro em que sou membro
    func myTeamId() async -> String? {
        guard let me = session?.userId,
              let td = try? await rest("team_members?select=team_id&user_id=eq.\(me)&limit=1"),
              let arr = try? JSONSerialization.jsonObject(with: td) as? [[String: Any]] else { return nil }
        return arr.first?["team_id"] as? String
    }

    /// cria a sessão de checkout na Stripe (edge function) e devolve a URL segura
    func checkoutUrl(planId: String, teamId: String?, seats: Int) async throws -> URL {
        guard let s = session else { throw SupaError.api("não autenticado") }
        var req = URLRequest(url: URL(string: Self.url.absoluteString + "/functions/v1/stripe-checkout")!)
        req.httpMethod = "POST"
        var body: [String: Any] = ["planId": planId, "seats": seats]
        body["teamId"] = teamId ?? NSNull()
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        req.setValue(Self.anon, forHTTPHeaderField: "apikey")
        req.setValue("Bearer " + s.accessToken, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, resp) = try await URLSession.shared.data(for: req)
        let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let u = j["url"] as? String, let url = URL(string: u) else {
            throw SupaError.api((j["error"] as? String) ?? "checkout falhou (\((resp as? HTTPURLResponse)?.statusCode ?? 0))")
        }
        return url
    }

    // MARK: - storage / rest

    /// Sobe uma imagem/arquivo do celular pro Storage (bucket task-refs,
    /// caminho <taskId>/<arquivo>) — o Mac do dono baixa pra worktree do agente.
    func uploadTaskRef(taskId: String, data: Data, filename: String, contentType: String = "image/jpeg", retried: Bool = false) async throws -> String {
        guard session != nil, let tok = await validToken() else { throw SupaError.api("não autenticado") }
        let path = "\(taskId)/\(filename)"
        var req = URLRequest(url: Self.url.appending(path: "/storage/v1/object/task-refs/\(path)"))
        req.httpMethod = "POST"
        req.httpBody = data
        req.setValue(Self.anon, forHTTPHeaderField: "apikey")
        req.setValue("Bearer " + tok, forHTTPHeaderField: "Authorization")
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        req.setValue("true", forHTTPHeaderField: "x-upsert")
        let (d, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 500
        if code == 401, !retried, await refresh() {
            return try await uploadTaskRef(taskId: taskId, data: data, filename: filename, contentType: contentType, retried: true)
        }
        guard code < 300 else {
            let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
            throw SupaError.api((j?["message"] as? String) ?? "upload falhou (\(code))")
        }
        return path
    }

    /// REST autenticado com um retry após refresh no 401.
    /// sessão curta: um pedido preso não pode segurar a tela (o padrão do iOS espera 60s)
    static let net: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 15
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    func rest(_ pathAndQuery: String, method: String = "GET", json: Any? = nil, prefer: String? = nil, retried: Bool = false) async throws -> Data {
        guard session != nil, let tok = await validToken() else { throw SupaError.api("não autenticado") }
        guard let url = URL(string: Self.url.absoluteString + "/rest/v1/" + pathAndQuery) else { throw SupaError.api("endereço inválido") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(Self.anon, forHTTPHeaderField: "apikey")
        req.setValue("Bearer " + tok, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let prefer { req.setValue(prefer, forHTTPHeaderField: "Prefer") }
        else if method == "POST" { req.setValue("return=representation", forHTTPHeaderField: "Prefer") }
        if let json { req.httpBody = try JSONSerialization.data(withJSONObject: json) }
        let data: Data, resp: URLResponse
        do { (data, resp) = try await Self.net.data(for: req) }
        catch { throw Self.isOffline(error) ? SupaError.offline : error }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 500
        if code == 401, !retried, await refresh() { return try await rest(pathAndQuery, method: method, json: json, prefer: prefer, retried: true) }
        guard code < 300 else {
            let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let msg = (j?["message"] as? String) ?? ""
            let pg = (j?["code"] as? String) ?? ""
            if code == 404 || pg == "42P01" || pg == "PGRST205" || msg.contains("does not exist") || msg.contains("schema cache") {
                throw SupaError.missingTable(String(pathAndQuery.prefix { $0 != "?" }))
            }
            if code >= 500 || code == 429 { throw SupaError.http(code, msg) }
            throw SupaError.api(msg.isEmpty ? "erro \(code)" : msg)
        }
        return data
    }

    /// URL assinada de uma prova no bucket privado `artifacts` (1h)
    func signedUrl(_ storagePath: String, retried: Bool = false) async throws -> URL {
        guard session != nil, let tok = await validToken() else { throw SupaError.api("não autenticado") }
        var req = URLRequest(url: URL(string: Self.url.absoluteString + "/storage/v1/object/sign/artifacts/" + storagePath)!)
        req.httpMethod = "POST"
        req.setValue(Self.anon, forHTTPHeaderField: "apikey")
        req.setValue("Bearer " + tok, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["expiresIn": 3600])
        let (data, resp) = try await Self.net.data(for: req)
        if (resp as? HTTPURLResponse)?.statusCode == 401, !retried, await refresh() { return try await signedUrl(storagePath, retried: true) }
        guard (resp as? HTTPURLResponse)?.statusCode ?? 500 < 300,
              let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let p = (j["signedURL"] as? String) ?? (j["signedUrl"] as? String),
              let u = URL(string: Self.url.absoluteString + "/storage/v1" + p)
        else { throw SupaError.api("não consegui assinar a prova") }
        return u
    }

    /// escreve uma INTENÇÃO no spec da tarefa — o Mac executa e publica o resultado
    func sendIntent(taskId: String, kind: String, extra: [String: Any] = [:]) async throws {
        let data = try await rest("tasks?select=spec&id=eq.\(taskId)")
        guard let row = ((try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]])?.first else {
            throw SupaError.api("não achei essa demanda na nuvem")
        }
        var spec = row["spec"] as? [String: Any] ?? [:]
        // outra intenção ainda na fila do Mac: não atropela (o Mac executa uma por vez por tarefa)
        if let cur = spec["intent"] as? [String: Any], let k = cur["kind"] as? String, k != kind {
            throw SupaError.api("o Mac ainda está executando “\(k)” — espere terminar")
        }
        var intent: [String: Any] = ["kind": kind, "at": ISO8601DateFormatter().string(from: Date())]
        for (k, v) in extra { intent[k] = v }
        spec["intent"] = intent
        spec["intentResult"] = NSNull()
        _ = try await rest("tasks?id=eq.\(taskId)", method: "PATCH", json: ["spec": spec])
    }

    /// responde uma pergunta do agente (ou do teto) — o Mac entrega ao agente e fecha
    func answerQuestion(id: String, text: String) async throws {
        let d = try await rest("questions?id=eq.\(id)&status=eq.open", method: "PATCH", json: [
            "status": "answered", "answer": text,
            "answered_by": session?.userId ?? "",
            "answered_at": ISO8601DateFormatter().string(from: Date()),
        ], prefer: "return=representation")
        // 0 linhas = alguém já respondeu (no Mac ou em outro aparelho) — dizer, não fingir que foi
        if let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]], arr.isEmpty {
            throw SupaError.api("essa pergunta já foi respondida (no Mac ou em outro aparelho)")
        }
    }

    /// mensagem pro agente da demanda (o Mac entrega quando estiver com o projeto aberto)
    func sendMessage(taskId: String, body: String) async throws {
        _ = try await rest("task_messages", method: "POST", json: ["task_id": taskId, "author": session?.userId ?? "", "body": body])
    }

    static func ptError(_ m: String) -> String {
        let l = m.lowercased()
        if l.contains("invalid login") { return "e-mail ou senha incorretos." }
        if l.contains("email not confirmed") { return "confirme o e-mail primeiro." }
        if l.contains("rate limit") || l.contains("security purposes") { return "muitas tentativas — aguarde um pouco." }
        if l.contains("already registered") || l.contains("already been registered") { return "já existe uma conta com esse e-mail — entre com a senha." }
        if l.contains("token has expired") || l.contains("otp_expired") || l.contains("invalid") && l.contains("otp") { return "código inválido ou expirado — peça um novo." }
        if l.contains("password should be") || l.contains("weak") { return "senha fraca — use 8+ caracteres." }
        if l.contains("signups not allowed") { return "cadastro desligado neste ambiente." }
        return m
    }
}
