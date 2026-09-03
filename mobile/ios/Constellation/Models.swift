import Foundation

// spec da tarefa que a nuvem carrega (subset que o mobile usa)
struct TaskSpec: Decodable {
    let objective: String?
    let deliverables: [String]?
    let requirements: [String]?
    let kind: String?
    let previewUrl: String?
    let intent: Intent?
    let intentResult: IntentResult?
    let stat: Stat?
    let prInfo: PrInfo?
    let review: Review?

    struct Intent: Decodable { let kind: String; let at: String? }
    struct IntentResult: Decodable { let kind: String; let ok: Bool; let msg: String?; let at: String? }
    struct Stat: Decodable { let files: Int?; let add: Int?; let del: Int?; let commits: Int? }
    struct Review: Decodable { let summary: String?; let howToTest: String? }
    struct PrInfo: Decodable {
        let number: Int?
        let state: String?
        let decision: String?
        let body: String?
        let comments: [PrComment]?
    }
    struct PrComment: Decodable, Identifiable {
        let id: Int?
        let author: String?
        let path: String?
        let line: Int?
        let answered: Bool?
        let isBot: Bool?
        let body: String?
        var listId: String { "\(id ?? 0)|\(author ?? "")" }
    }

    /// fração de requisitos provados (requirements_proof casada é do Mac; aqui aproximamos)
    var reqFraction: Double? { nil }
}

struct CloudTask: Identifiable, Decodable {
    let id: String
    let title: String
    let status: String
    let flag: String?
    let branch: String?
    let prUrl: String?
    let costUsd: Double?
    let assignee: String?
    let createdBy: String?
    let updatedAt: String
    let spec: TaskSpec?
    let requirementsProof: ReqProofWrap?

    enum CodingKeys: String, CodingKey {
        case id, title, status, flag, branch, assignee, spec
        case prUrl = "pr_url"
        case costUsd = "cost_usd"
        case createdBy = "created_by"
        case updatedAt = "updated_at"
        case requirementsProof = "requirements_proof"
    }

    var phase: Int { T.phase(self) }
    var kind: String { spec?.kind ?? "build" }
    var issueCode: String? {
        let s = "\(branch ?? "") \(title)"
        if let r = s.range(of: #"[A-Z]{2,10}-\d+"#, options: .regularExpression) { return String(s[r]) }
        return nil
    }
    /// requisitos provados: casa a lista da spec com o requirements_proof publicado
    var reqsProved: (done: Int, total: Int)? {
        guard let reqs = spec?.requirements, !reqs.isEmpty else { return nil }
        let list = requirementsProof?.items ?? []
        let done = list.filter { $0.status == "done" }.count
        return (min(done, reqs.count), reqs.count)
    }
}

/// requirements_proof chega como lista OU como {list:[...]} — aceita os dois
struct ReqProofWrap: Decodable {
    let items: [ReqProof]
    init(from decoder: Decoder) throws {
        if let arr = try? [ReqProof](from: decoder) { items = arr; return }
        struct W: Decodable { let list: [ReqProof]? }
        items = (try? W(from: decoder).list) ?? []
    }
}
struct ReqProof: Decodable {
    let req: String?
    let status: String?
    let evidence: [String]?
}

struct FeedItem: Identifiable, Decodable {
    let id: Int
    let taskId: String?
    let agent: String?
    let kind: String
    let text: String
    enum CodingKeys: String, CodingKey { case id, agent, kind, text, taskId = "task_id" }
}

struct ArtifactMeta: Identifiable, Decodable {
    let name: String
    let kind: String?
    let storagePath: String
    var id: String { storagePath }
    enum CodingKeys: String, CodingKey { case name, kind, storagePath = "storage_path" }
}

struct Activity: Identifiable, Decodable {
    let id: Int
    let taskId: String?
    let userId: String?
    let kindK: String?
    let at: String?
    enum CodingKeys: String, CodingKey { case id, taskId = "task_id", userId = "user_id", kindK = "kind", at }
}

struct Epic: Identifiable, Decodable {
    let id: String
    let name: String
}

struct Question: Identifiable, Decodable {
    let id: String
    let taskId: String?
    let agent: String
    let prompt: String
    let options: [String]
    let createdAt: String
    let task: EmbeddedTask?

    struct EmbeddedTask: Decodable { let title: String }

    enum CodingKeys: String, CodingKey {
        case id, agent, prompt, options
        case taskId = "task_id"
        case createdAt = "created_at"
        case task = "tasks"
    }
}

extension String: @retroactive Identifiable { public var id: String { self } }

struct Profile: Decodable {
    let userId: String
    let name: String?
    let email: String?
    let lastSeenAt: String?
    enum CodingKeys: String, CodingKey { case userId = "user_id", name, email, lastSeenAt = "last_seen_at" }
}

func agoPt(_ iso: String) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) ?? Date()
    let s = Date().timeIntervalSince(d)
    if s < 60 { return "agora" }
    if s < 3600 { return "\(Int(s / 60))min" }
    if s < 86400 { return "\(Int(s / 3600))h" }
    return "\(Int(s / 86400))d"
}

func fmtUsd(_ v: Double?) -> String? {
    guard let v, v > 0 else { return nil }
    return String(format: "$%.2f", v)
}
