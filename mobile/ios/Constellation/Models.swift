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
    let modelRaw: String?
    let engine: String?
    var budgetRaw: LenientDouble? = nil
    /// teto de custo da demanda (53-teto-protecao) — pode vir número, texto ou vazio
    var budgetUsd: Double? { budgetRaw?.value }

    enum CodingKeys: String, CodingKey { case objective, deliverables, requirements, kind, previewUrl, intent, intentResult, stat, prInfo, review, engine; case modelRaw = "model"; case budgetRaw = "budgetUsd" }

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

/// número que às vezes chega como texto ("5") ou vazio — nunca derruba a decodificação do spec inteiro
struct LenientDouble: Decodable, Equatable {
    let value: Double?
    init(_ v: Double?) { value = v }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let d = try? c.decode(Double.self) { value = d }
        else if let s = try? c.decode(String.self) { value = Double(s.replacingOccurrences(of: ",", with: ".")) }
        else { value = nil }
    }
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
    var projectId: String? = nil

    enum CodingKeys: String, CodingKey {
        case id, title, status, flag, branch, assignee, spec
        case projectId = "project_id"
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
    /// requisitos COM PROVA (feito + arquivo de evidência) — mesma régua do portão de prova do desktop
    var reqsProved: (done: Int, total: Int)? { ProofGate.proved(self) }
    var isLive: Bool { flag != "closed" && StatusMeta.running.contains(status) }
    var isEnded: Bool { flag == "closed" || StatusMeta.ended.contains(status) }
}

/// requirements_proof chega como lista OU como {list:[...]} — aceita os dois
struct ReqProofWrap: Decodable {
    let items: [ReqProof]
    /// nil = o Mac ainda não publicou o requirements.json (o desktop trata igual: tudo "sem prova")
    let list: [ReqProof]?
    init(items: [ReqProof]?) { self.items = items ?? []; self.list = items }
    init(from decoder: Decoder) throws {
        if let arr = try? [ReqProof](from: decoder) { items = arr; list = arr; return }
        struct W: Decodable { let list: [ReqProof]? }
        let l = try? W(from: decoder).list
        items = l ?? []; list = l
    }
}
struct ReqProof: Decodable, Equatable {
    let req: String?
    let status: String?
    let evidence: [String]?
    var note: String? = nil
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
    var isVideo: Bool { kind == "video" || [".mp4", ".mov", ".m4v", ".webm"].contains { name.lowercased().hasSuffix($0) } }
    var isImage: Bool { !isVideo && (kind == "image" || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"].contains { name.lowercased().hasSuffix($0) }) }
}

struct Project: Identifiable, Decodable, Equatable {
    let id: String
    let name: String
    let teamId: String?
    let repoRemote: String?
    enum CodingKeys: String, CodingKey { case id, name, teamId = "team_id", repoRemote = "repo_remote" }
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

struct Question: Identifiable, Decodable, Equatable {
    let id: String
    let taskId: String?
    let agent: String
    let prompt: String
    let options: [String]
    let createdAt: String
    let task: EmbeddedTask?

    struct EmbeddedTask: Decodable, Equatable {
        let title: String
        let assignee: String?
        let createdBy: String?
        enum CodingKeys: String, CodingKey { case title, assignee; case createdBy = "created_by" }
    }

    enum CodingKeys: String, CodingKey {
        case id, agent, prompt, options
        case taskId = "task_id"
        case createdAt = "created_at"
        case task = "tasks"
    }
    var isTeto: Bool { Teto.isTeto(agent: agent, options: options) }
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

// MARK: - IA / modelos (espelho de app/src/js/29-ia-picker.js)

struct AIModel: Identifiable, Hashable {
    let id: String          // id enviado no spec.model ("" = padrão da assinatura)
    let name: String
    let tag: String         // rótulo curto
    let hint: String
    var recommended = false
    static let all: [AIModel] = [
        AIModel(id: "claude-opus-5-5", name: "Opus 5.5", tag: "opus", hint: "o mais capaz pra código — recomendado", recommended: true),
        AIModel(id: "claude-opus-4-8", name: "Opus 4.8", tag: "opus", hint: "geração anterior do Opus"),
        AIModel(id: "claude-sonnet-5", name: "Sonnet 5", tag: "sonnet", hint: "equilíbrio entre custo e qualidade"),
        AIModel(id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", tag: "haiku", hint: "o mais veloz e barato — tarefas simples"),
        AIModel(id: "claude-fable-5-1", name: "Fable 5.1", tag: "fable", hint: "topo de linha — investigações difíceis"),
        AIModel(id: "claude-opus-5", name: "Opus 5", tag: "opus5", hint: "geração nova do Opus"),
    ]
    static func named(_ id: String?) -> String {
        guard let id, !id.isEmpty else { return "padrão" }
        if let m = all.first(where: { $0.id == id }) { return m.name }
        switch id { case "opus": return "Opus"; case "sonnet": return "Sonnet"; case "haiku": return "Haiku"; default: return id }
    }
    /// modelo padrão do usuário (Conta → IA padrão); "" = padrão da assinatura
    static var userDefault: String {
        get { UserDefaults.standard.string(forKey: "defaultModel") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "defaultModel") }
    }
}

extension TaskSpec {
    var model: String? { modelRaw }
}
