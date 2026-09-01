import Foundation

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

    enum CodingKeys: String, CodingKey {
        case id, title, status, flag, branch, assignee
        case prUrl = "pr_url"
        case costUsd = "cost_usd"
        case createdBy = "created_by"
        case updatedAt = "updated_at"
    }
}

struct Question: Identifiable, Decodable {
    let id: String
    let agent: String
    let prompt: String
    let options: [String]
    let createdAt: String
    let task: EmbeddedTask?

    struct EmbeddedTask: Decodable { let title: String }

    enum CodingKeys: String, CodingKey {
        case id, agent, prompt, options
        case createdAt = "created_at"
        case task = "tasks"
    }
}

struct Profile: Decodable {
    let userId: String
    let name: String?
    let email: String?
    enum CodingKeys: String, CodingKey { case userId = "user_id", name, email }
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
