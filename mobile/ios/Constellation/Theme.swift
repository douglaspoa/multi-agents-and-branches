import SwiftUI

/// Tokens do Design System mobile (redesign 09/2026) — mesma paleta do desktop:
/// fundo #0b0d10, cartões translúcidos, verde #3fdd8a, mono pros rótulos.
enum T {
    // superfícies
    static let bg       = Color(hex: 0x0b0d10)
    static let panel    = Color(hex: 0x141718)          // cartão / campo (≈ branco 7%)
    static let panel2   = Color(hex: 0x0f1214)          // barras
    static let line     = Color.white.opacity(0.09)
    static let lineHard = Color.white.opacity(0.14)
    // texto
    static let text   = Color(hex: 0xeaf2ee)
    static let text2  = Color.white.opacity(0.62)
    static let dim    = Color.white.opacity(0.42)
    static let dim2   = Color.white.opacity(0.34)
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

    static func status(_ s: String, flag: String?) -> (String, Color) {
        if flag == "closed" { return ("encerrada", dim) }
        switch s {
        case "running", "thinking": return ("escrevendo código", accent)
        case "queued": return ("na fila", warn)
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

// MARK: - tipografia

extension Font {
    /// rótulo mono maiúsculo (eyebrow) — 10px, tracking largo
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
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
    /// kicker de seção: 10px mono maiúsculo + contagem + régua
    func kicker(_ label: String, _ color: Color, count: Int? = nil, dot: Bool = false) -> some View {
        HStack(spacing: 9) {
            if dot { Circle().fill(color).frame(width: 6, height: 6) }
            Text(label.uppercased()).font(.mono(10, .medium)).kerning(1.6).foregroundStyle(color)
            if let n = count, n > 0 {
                Text("\(n)").font(.mono(9, .bold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(color.opacity(0.16)).foregroundStyle(color).clipShape(Capsule())
            }
            Rectangle().fill(T.line).frame(height: 1)
        }
    }
    /// rótulo de campo (NOME, E-MAIL…)
    func fieldLabel(_ label: String) -> some View {
        Text(label.uppercased()).font(.mono(10, .medium)).kerning(1.6).foregroundStyle(T.dim)
    }
}

// MARK: - peças do redesign

/// Cabeçalho de página: eyebrow + régua (+ AO VIVO) · título 30px · subtítulo
struct PageHeader: View {
    let kicker: String
    let title: String
    let sub: String
    var live = false
    var accentKicker = true
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Text(kicker.uppercased()).font(.mono(10, .medium)).kerning(1.6)
                    .foregroundStyle(accentKicker ? T.accent.opacity(0.75) : T.dim)
                    .lineLimit(1)
                Rectangle().fill(T.line).frame(height: 1)
                if live {
                    HStack(spacing: 5) { BlinkDot(); Text("AO VIVO").font(.mono(9.5, .bold)).kerning(1).foregroundStyle(T.accent) }
                }
            }
            Text(title).font(.system(size: 30, weight: .semibold)).kerning(-0.75).foregroundStyle(T.text)
            Text(sub).font(.system(size: 13)).foregroundStyle(T.dim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Faixa de 3 números (EM ÓRBITA · ESPERAM VOCÊ · CUSTO)
struct StatRow: View {
    struct Item { let value: String; let label: String; var color: Color = T.text }
    let items: [Item]
    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                VStack(alignment: .leading, spacing: 4) {
                    Text(it.value).font(.system(size: 22, weight: .semibold)).kerning(-0.4).foregroundStyle(it.color)
                        .lineLimit(1).minimumScaleFactor(0.7)
                    Text(it.label.uppercased()).font(.mono(9.5)).kerning(0.95).foregroundStyle(T.dim2)
                        .lineLimit(1).minimumScaleFactor(0.8)
                }
                .padding(.horizontal, 14).padding(.vertical, 13)
                .frame(maxWidth: .infinity, alignment: .leading)
                if i < items.count - 1 { Rectangle().fill(T.line).frame(width: 1) }
            }
        }
        .background(T.panel)
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(T.line))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

/// barra fina de progresso (2px) — % da tarefa
struct ProgressLine: View {
    let pct: Int
    var color: Color = T.accent
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.08))
                Capsule().fill(color).frame(width: g.size.width * CGFloat(min(max(pct, 0), 100)) / 100)
            }
        }.frame(height: 3)
    }
}

/// chip de filtro (Minhas): ativo = verde cheio, inativo = cartão
struct Chip: View {
    let label: String
    var count: Int? = nil
    var on = false
    var body: some View {
        HStack(spacing: 6) {
            Text(label).font(.system(size: 13.5, weight: on ? .semibold : .medium))
            if let n = count {
                Text("\(n)").font(.mono(10.5, .medium))
                    .foregroundStyle(on ? T.onAccent.opacity(0.7) : T.dim2)
            }
        }
        .foregroundStyle(on ? T.onAccent : T.text2)
        .padding(.horizontal, 14).frame(height: 36)
        .background(on ? T.accent : T.panel)
        .overlay(Capsule().stroke(on ? .clear : T.line))
        .clipShape(Capsule())
    }
}

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
            Text(label).font(.system(size: 14, weight: .semibold))
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
                .font(.system(size: 15))
                .foregroundStyle(T.text)
                .keyboardType(keyboard)
                .textContentType(content)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                if secure {
                    Button { reveal.toggle() } label: {
                        Image(systemName: reveal ? "eye.slash" : "eye").font(.system(size: 13)).foregroundStyle(T.dim2)
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
