import SwiftUI

/// Tokens do Design System mobile — herdados do desktop, hierarquia do escopo.
enum T {
    // superfícies
    static let bg       = Color(hex: 0x0b0d0f)
    static let panel    = Color(hex: 0x13171a)          // surface: cartão, campo
    static let panel2   = Color(hex: 0x0e1113)          // surface-2: barras
    static let line     = Color.white.opacity(0.08)
    static let lineHard = Color.white.opacity(0.14)
    // texto
    static let text   = Color(hex: 0xe9edef)
    static let text2  = Color(hex: 0xc9d1d6)
    static let dim    = Color(hex: 0x8b959b)
    static let dim2   = Color(hex: 0x5b6469)
    // semântica — amarelo = te esperando · verde = pronto/sua ação
    static let accent   = Color(hex: 0x3fd68a)
    static let accent2  = Color(hex: 0x34c07b)
    static let onAccent = Color(hex: 0x04241a)
    static let warn   = Color(hex: 0xf0b449)
    static let bad    = Color(hex: 0xf2685c)
    static let info   = Color(hex: 0x5b9df9)
    static let cyan   = Color(hex: 0x4fc4c9)
    static let purple = Color(hex: 0xb47ce0)

    static func status(_ s: String, flag: String?) -> (String, Color) {
        if flag == "closed" { return ("encerrada", dim) }
        switch s {
        case "running", "thinking", "queued": return ("rodando", warn)
        case "plan-review": return ("plano em revisão", warn)
        case "review", "delivered": return ("pronta pra review", accent)
        case "merged", "done": return ("mergeada", cyan)
        case "error", "conflict": return (s == "error" ? "erro" : "conflito", bad)
        case "backlog": return ("backlog", dim)
        case "requested": return ("esperando o Mac", warn)
        default: return (s, dim)
        }
    }

    /// fase 1–5 (Descoberta → Despacho → Execução → Revisão → PR)
    static func phase(_ t: CloudTask) -> Int {
        if t.flag == "closed" || ["merged", "done"].contains(t.status) { return 5 }
        if t.prUrl != nil { return 5 }
        if ["review", "delivered"].contains(t.status) { return 4 }
        if ["running", "thinking", "paused", "error", "conflict"].contains(t.status) { return 3 }
        if ["queued", "requested"].contains(t.status) { return 2 }
        return 1
    }
    static let phaseNames = ["Descoberta", "Despacho", "Execução", "Revisão", "PR"]

    /// % de conclusão: fase + requisitos provados (mesma régua do Mac)
    static func pct(_ t: CloudTask) -> Int {
        if t.flag == "closed" || ["merged", "done"].contains(t.status) { return 100 }
        if t.prUrl != nil { return 92 }
        let proof: Double? = {
            if let r = t.reqsProved, r.total > 0 { return Double(r.done) / Double(r.total) }
            return nil
        }()
        if ["review", "delivered"].contains(t.status) { return Int(80 + (proof ?? 0.33) * 15) }
        if t.status == "queued" || t.status == "requested" { return 15 }
        if t.status == "plan-review" { return 25 }
        return Int(35 + (proof ?? 0.25) * 40)
    }

    static func kindBadge(_ kind: String?) -> (String, Color) {
        switch kind {
        case "fix": return ("FIX", warn)
        case "invest": return ("INVEST", purple)
        case "design": return ("DESIGN", info)
        case "review": return ("REVIEW", accent)
        default: return ("FEATURE", accent)
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xff) / 255,
                  green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255)
    }
}

extension View {
    func card(radius: CGFloat = 14, stroke: Color = T.line) -> some View {
        padding(13)
            .background(T.panel)
            .overlay(RoundedRectangle(cornerRadius: radius).stroke(stroke))
            .clipShape(RoundedRectangle(cornerRadius: radius))
    }
    /// kicker de seção: 10px mono maiúsculo + régua na cor semântica
    func kicker(_ label: String, _ color: Color, count: Int? = nil) -> some View {
        HStack(spacing: 9) {
            Text(label).font(.system(size: 10, design: .monospaced).weight(.bold))
                .kerning(1.2).foregroundStyle(color)
            if let n = count, n > 0 {
                Text("\(n)").font(.system(size: 9, design: .monospaced).bold())
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(color.opacity(0.16)).foregroundStyle(color).clipShape(Capsule())
            }
            Rectangle().fill(color.opacity(0.25)).frame(height: 1)
        }
    }
}
