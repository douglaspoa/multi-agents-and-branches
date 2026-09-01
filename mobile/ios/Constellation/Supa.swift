import Foundation

/// Cliente Supabase mínimo (REST puro, sem dependências). A anon key é pública
/// por design — o RLS no banco é quem protege os dados.
final class Supa: ObservableObject {
    static let url = URL(string: "https://fivoakrhazlzcdoocgbg.supabase.co")!
    static let anon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpdm9ha3JoYXpsemNkb29jZ2JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwMjcxOTcsImV4cCI6MjEwMzYwMzE5N30.NXr1RjGqhcYHfMU050PRBcBraXsAYw-4FUVyoo3RC8U"

    @Published var session: Session? = Session.load()

    struct Session: Codable {
        var accessToken: String
        var refreshToken: String
        var userId: String
        var email: String

        static func load() -> Session? {
            guard let d = UserDefaults.standard.data(forKey: "sb.session") else { return nil }
            return try? JSONDecoder().decode(Session.self, from: d)
        }
        func save() { UserDefaults.standard.set(try? JSONEncoder().encode(self), forKey: "sb.session") }
        static func clear() { UserDefaults.standard.removeObject(forKey: "sb.session") }
    }

    enum SupaError: LocalizedError {
        case api(String)
        var errorDescription: String? { if case .api(let m) = self { return m }; return nil }
    }

    func signIn(email: String, password: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["email": email, "password": password])
        var req = URLRequest(url: Self.url.appending(path: "/auth/v1/token").appending(queryItems: [.init(name: "grant_type", value: "password")]))
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue(Self.anon, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw SupaError.api("sem resposta") }
        let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard http.statusCode < 300, let at = j["access_token"] as? String, let rt = j["refresh_token"] as? String,
              let user = j["user"] as? [String: Any], let uid = user["id"] as? String else {
            let msg = (j["error_description"] ?? j["msg"] ?? j["message"]) as? String ?? "login falhou (\(http.statusCode))"
            throw SupaError.api(Self.ptError(msg))
        }
        let s = Session(accessToken: at, refreshToken: rt, userId: uid, email: email)
        s.save()
        await MainActor.run { self.session = s }
    }

    func signOut() {
        Session.clear()
        session = nil
    }

    private func refresh() async -> Bool {
        guard let s = session else { return false }
        var req = URLRequest(url: Self.url.appending(path: "/auth/v1/token").appending(queryItems: [.init(name: "grant_type", value: "refresh_token")]))
        req.httpMethod = "POST"
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["refresh_token": s.refreshToken])
        req.setValue(Self.anon, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode ?? 500 < 300,
              let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let at = j["access_token"] as? String, let rt = j["refresh_token"] as? String else {
            await MainActor.run { self.signOut() }
            return false
        }
        var ns = s; ns.accessToken = at; ns.refreshToken = rt
        ns.save()
        await MainActor.run { self.session = ns }
        return true
    }

    /// REST autenticado com um retry após refresh no 401.
    func rest(_ pathAndQuery: String, method: String = "GET", json: [String: Any]? = nil, retried: Bool = false) async throws -> Data {
        guard let s = session else { throw SupaError.api("não autenticado") }
        var req = URLRequest(url: URL(string: Self.url.absoluteString + "/rest/v1/" + pathAndQuery)!)
        req.httpMethod = method
        req.setValue(Self.anon, forHTTPHeaderField: "apikey")
        req.setValue("Bearer " + s.accessToken, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let json { req.httpBody = try JSONSerialization.data(withJSONObject: json) }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 500
        if code == 401, !retried, await refresh() { return try await rest(pathAndQuery, method: method, json: json, retried: true) }
        guard code < 300 else {
            let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw SupaError.api((j?["message"] as? String) ?? "erro \(code)")
        }
        return data
    }

    static func ptError(_ m: String) -> String {
        if m.localizedCaseInsensitiveContains("invalid login") { return "e-mail ou senha incorretos." }
        if m.localizedCaseInsensitiveContains("email not confirmed") { return "confirme o e-mail primeiro." }
        if m.localizedCaseInsensitiveContains("rate limit") { return "muitas tentativas — aguarde um pouco." }
        return m
    }
}
