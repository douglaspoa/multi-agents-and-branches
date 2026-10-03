import SwiftUI

/// Tokens do Design System mobile (redesign 09/2026) — mesma paleta do desktop:
/// fundo #0b0d10, cartões translúcidos, verde #3fdd8a, mono pros rótulos.
enum T {
    /// sem animação infinita: UI tests (o XCUITest espera o app ficar ocioso) — DEBUG, env UITEST=1
    static let still: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.environment["UITEST"] == "1"
        #else
        return false
        #endif
    }()
    // superfícies
    static let bg       = Color(hex: 0x0a0f0d)
    static let panel    = Color(hex: 0x131b18)          // linha de lista / cartão / campo (verde-escuro)
    static let panel2   = Color(hex: 0x0f1613)          // barras / cabeçalho do detalhe
    static let panel3   = Color(hex: 0x1a2420)          // controle sobre cartão (campo, botão secundário)
    static let line     = Color.white.opacity(0.09)
    static let lineHard = Color.white.opacity(0.14)
    // texto
    static let text   = Color(hex: 0xeaf2ee)
    static let text2  = Color.white.opacity(0.72)
    static let dim    = Color.white.opacity(0.58)   // ≥ 4.5:1 sobre panel
    static let dim2   = Color.white.opacity(0.50)   // ≥ 4.5:1 sobre bg (só rótulo secundário)
    // semântica — amarelo = te esperando · verde = pronto/sua ação
    static let accent   = Color(hex: 0x3fdd8a)
    static let accent2  = Color(hex: 0x34c07b)
    static let onAccent = Color(hex: 0x05170e)
    static let warn   = Color(hex: 0xf0b449)
    static let bad    = Color(hex: 0xf2685c)
    static let info   = Color(hex: 0x5b9df9)
    static let cyan   = Color(hex: 0x4fc4c9)
    static let purple = Color(hex: 0xb47ce0)
    static let pink   = Color(hex: 0xe8788a)

    /// rótulo = o MESMO do desktop (StatusMeta ↔ STATUS_META); a cor é a semântica do mobile
    static func status(_ s: String, flag: String?) -> (String, Color) {
        if flag == "closed" { return ("concluída", dim) }
        let c: Color
        switch s {
        case "running", "thinking": c = accent
        case "queued", "plan-review", "requested", "asking", "blocked": c = warn
        case "review", "delivered": c = accent
        case "merged", "done": c = cyan
        case "error", "conflict": c = bad
        default: c = dim
        }
        return (StatusMeta.label(s), c)
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

// MARK: - tipografia

extension Font {
    /// tamanho de desenho (pt) → estilo do Dynamic Type mais próximo. Nada fica com fonte fixa:
    /// tudo cresce com o "Tamanho do Texto" do iPhone, e nada fica menor que o caption2 (11pt).
    static func textStyle(_ size: CGFloat) -> Font.TextStyle {
        switch size {
        case ..<11.5: return .caption2
        case ..<12.5: return .caption
        case ..<14: return .footnote
        case ..<15.5: return .subheadline
        case ..<16.5: return .callout
        case ..<19: return .body
        case ..<21: return .title3
        case ..<25: return .title2
        case ..<31: return .title
        default: return .largeTitle
        }
    }
    /// rótulo mono (eyebrow, custo, ids) — escala com o Dynamic Type
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(textStyle(size), design: .monospaced, weight: weight)
    }
    /// texto de interface — escala com o Dynamic Type
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(textStyle(size), design: .default, weight: weight)
    }
}

extension View {
    /// cartão padrão do redesign: fundo translúcido, borda 1px, raio 16
    func card(radius: CGFloat = 16, stroke: Color = T.line, pad: CGFloat = 14, fill: Color = T.panel) -> some View {
        padding(pad)
            .background(fill)
            .overlay(RoundedRectangle(cornerRadius: radius).stroke(stroke))
            .clipShape(RoundedRectangle(cornerRadius: radius))
    }
    /// faixa colorida na borda esquerda do cartão (leitura de relance)
    func rail(_ color: Color, radius: CGFloat = 16) -> some View {
        overlay(alignment: .leading) {
            UnevenRoundedRectangle(topLeadingRadius: radius, bottomLeadingRadius: radius)
                .fill(color.opacity(0.85)).frame(width: 3)
        }
    }
    /// rótulo de campo (NOME, E-MAIL…)
    func fieldLabel(_ label: String) -> some View {
        Text(label.uppercased()).font(.mono(10, .medium)).kerning(1.6).foregroundStyle(T.dim)
    }
}

// MARK: - peças do redesign

/// botão secundário (contorno) — "ver", "Já tenho conta"
struct OutlineButton: View {
    let label: String
    var height: CGFloat = 44
    var full = false
    var color: Color = T.text2
    var stroke: Color = T.lineHard
    var fill: Color = .clear
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label).font(.ui(14, .semibold))
                .foregroundStyle(color)
                .padding(.horizontal, 16)
                .frame(maxWidth: full ? .infinity : nil).frame(height: height)
                .background(fill)
                .overlay(RoundedRectangle(cornerRadius: 11).stroke(stroke))
                .clipShape(RoundedRectangle(cornerRadius: 11))
        }.buttonStyle(.plain)
    }
}

/// campo de texto do redesign: 48px, cartão, borda, placeholder mono
struct Field: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    var secure = false
    var keyboard: UIKeyboardType = .default
    var content: UITextContentType? = nil
    var trailing: (() -> AnyView)? = nil
    @State private var reveal = false
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                fieldLabel(label)
                Spacer()
                if let trailing { trailing() }
            }
            HStack(spacing: 8) {
                Group {
                    if secure && !reveal {
                        SecureField("", text: $text, prompt: Text(placeholder).foregroundStyle(T.dim2).font(.mono(14)))
                    } else {
                        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(T.dim2).font(.mono(14)))
                    }
                }
                .font(.ui(15))
                .foregroundStyle(T.text)
                .keyboardType(keyboard)
                .textContentType(content)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                if secure {
                    Button { reveal.toggle() } label: {
                        Image(systemName: reveal ? "eye.slash" : "eye").font(.ui(13)).foregroundStyle(T.dim2)
                    }
                }
            }
            .padding(.horizontal, 14).frame(height: 48)
            .background(T.panel)
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(T.line))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
}

/// Fundo cósmico do redesign: estrelas fixas, algumas ligadas em constelação,
/// brilho verde no topo. Desenha uma vez (seed fixa) — barato.
struct Starfield: View {
    var seed: UInt64 = 7
    var glow = true
    var body: some View {
        Canvas { ctx, size in
            var rng = SeededRNG(seed: seed)
            var pts: [CGPoint] = []
            for _ in 0..<38 {
                let p = CGPoint(x: CGFloat(rng.next01()) * size.width, y: CGFloat(rng.next01()) * size.height * 0.75)
                let r = CGFloat(0.6 + rng.next01() * 1.4)
                let a = 0.18 + rng.next01() * 0.5
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)),
                         with: .color(.white.opacity(a)))
                pts.append(p)
            }
            // linhas da constelação: liga pares próximos
            var line = Path()
            for i in 0..<pts.count {
                for j in (i + 1)..<pts.count {
                    let d = hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
                    if d < 70 { line.move(to: pts[i]); line.addLine(to: pts[j]) }
                }
            }
            ctx.stroke(line, with: .color(.white.opacity(0.07)), lineWidth: 0.6)
            // duas estrelas verdes em destaque
            for k in 0..<2 {
                let p = pts[(k * 11 + 3) % pts.count]
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - 2, y: p.y - 2, width: 4, height: 4)), with: .color(T.accent.opacity(0.9)))
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - 9, y: p.y - 9, width: 18, height: 18)), with: .color(T.accent.opacity(0.12)))
            }
        }
        .overlay(alignment: .top) {
            if glow {
                RadialGradient(colors: [T.accent.opacity(0.10), .clear], center: .top, startRadius: 0, endRadius: 320)
                    .frame(height: 380)
            }
        }
        .allowsHitTesting(false)
        .ignoresSafeArea()
    }
}

struct SeededRNG {
    private var state: UInt64
    init(seed: UInt64) { state = seed &* 6364136223846793005 &+ 1442695040888963407 }
    mutating func next() -> UInt64 {
        state ^= state << 13; state ^= state >> 7; state ^= state << 17
        return state
    }
    mutating func next01() -> Double { Double(next() % 10_000) / 10_000 }
}

/// ícone "em órbita" (logo, ✦, ✓) com anel pontilhado ao redor — telas de onboarding
struct OrbitIcon: View {
    let glyph: String
    var size: CGFloat = 64
    var body: some View {
        ZStack {
            Circle().stroke(T.accent.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
                .frame(width: size * 2, height: size * 2)
            Circle().fill(T.accent).frame(width: 6, height: 6).offset(y: -size)
            RoundedRectangle(cornerRadius: size * 0.28)
                .fill(LinearGradient(colors: [T.accent, T.accent2], startPoint: .top, endPoint: .bottom))
                .frame(width: size, height: size)
                .shadow(color: T.accent.opacity(0.45), radius: 22, y: 6)
            Text(glyph).font(.system(size: size * 0.42, weight: .bold, design: .rounded)).foregroundStyle(T.onAccent)
        }
        .frame(width: size * 2 + 8, height: size * 2 + 8)
    }
}
