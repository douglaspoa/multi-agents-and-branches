import SwiftUI

/// Tokens visuais — mesma identidade Terminal/TUI do desktop.
enum T {
    static let bg      = Color(red: 0.043, green: 0.059, blue: 0.055)   // #0b0f0e
    static let panel   = Color(red: 0.075, green: 0.098, blue: 0.090)   // #131916
    static let line    = Color.white.opacity(0.08)
    static let text    = Color(white: 0.92)
    static let dim     = Color(white: 0.55)
    static let accent  = Color(red: 0.224, green: 0.831, blue: 0.416)   // #39d46a
    static let warn    = Color(red: 0.898, green: 0.753, blue: 0.482)   // #e5c07b
    static let bad     = Color(red: 0.898, green: 0.392, blue: 0.361)
    static let info    = Color(red: 0.337, green: 0.714, blue: 0.761)   // #56b6c2

    static func status(_ s: String, flag: String?) -> (String, Color) {
        if flag == "closed" { return ("encerrada", dim) }
        switch s {
        case "running", "thinking", "queued": return ("rodando", warn)
        case "plan-review": return ("plano em revisão", warn)
        case "review", "delivered": return ("pronta pra review", accent)
        case "merged", "done": return ("mergeada", info)
        case "error", "conflict": return (s == "error" ? "erro" : "conflito", bad)
        case "backlog": return ("backlog", dim)
        default: return (s, dim)
        }
    }
}

extension View {
    func card() -> some View {
        padding(12)
            .background(T.panel)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.line))
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
