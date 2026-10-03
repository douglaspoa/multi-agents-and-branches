import SwiftUI

// Componentes próprios do mobile (DESIGN-SYSTEM.md §5)

/// Renderiza o texto do agente como MARKDOWN (negrito, `código`, links) em vez
/// de mostrar os asteriscos e crases crus. Quebra tokens longos (nomes de tool,
/// arquivos.md) inserindo pontos de quebra — sem isso o texto empurra a tela
/// pro lado. Preserva quebras de linha.
/// Insere pontos de quebra invisíveis em tokens longos (paths, nomes de tool)
/// pra texto MONOSPACE poder quebrar de linha — senão empurra a tela pro lado.
@inline(__always)
func softBreak(_ s: String) -> String {
    s.replacingOccurrences(of: "/", with: "/\u{200B}")
     .replacingOccurrences(of: "_", with: "_\u{200B}")
     .replacingOccurrences(of: "-", with: "-\u{200B}")
     .replacingOccurrences(of: ".", with: ".\u{200B}")
}

@inline(__always)
func mdText(_ text: String, size: CGFloat = 13.5, color: Color = T.text) -> Text {
    // títulos markdown (##, ###) viram **negrito** (o parser inline os ignora);
    // marcadores de lista (- , * ) viram bullet legível
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
        var l = String(line)
        if let r = l.range(of: #"^#{1,6}\s+"#, options: .regularExpression) {
            l = "**" + l[r.upperBound...] + "**"
        } else if let r = l.range(of: #"^\s*[-*]\s+"#, options: .regularExpression) {
            l = "  •  " + l[r.upperBound...]
        }
        return l
    }
    // insere zero-width-space em tokens longos sem espaço → o layout pode quebrar
    let softened = lines.joined(separator: "\n")
        .replacingOccurrences(of: "_", with: "_\u{200B}")
        .replacingOccurrences(of: "/", with: "/\u{200B}")
    let opts = AttributedString.MarkdownParsingOptions(
        allowsExtendedAttributes: false,
        interpretedSyntax: .inlineOnlyPreservingWhitespace,
        failurePolicy: .returnPartiallyParsedIfPossible
    )
    if let attr = try? AttributedString(markdown: softened, options: opts) {
        return Text(attr).font(.ui(size)).foregroundStyle(color)
    }
    return Text(softened).font(.ui(size)).foregroundStyle(color)
}

/// 5.1 — barra de 5 fases: leitura de relance de "em que fase está"
struct PhaseBar: View {
    let phase: Int          // 1…5 (atual)
    var body: some View {
        HStack(spacing: 3) {
            ForEach(1...5, id: \.self) { i in
                Capsule()
                    .fill(i < phase ? T.accent : i == phase ? T.accent.opacity(0.55) : Color.white.opacity(0.1))
                    .frame(height: 4)
            }
        }
    }
}

/// 5.2 — pill de intenção: o celular escreve, o Mac executa
struct IntentPill: View {
    let label: String
    @Environment(\.accessibilityReduceMotion) private var reduce
    @State private var pulse = false
    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(T.accent).frame(width: 8, height: 8)
                .overlay(Circle().stroke(T.accent.opacity(0.5), lineWidth: 2)
                    .scaleEffect(pulse ? 2.0 : 1.0).opacity(pulse ? 0 : 1))
            Text(label).font(.mono(12).weight(.medium))
                .foregroundStyle(T.accent)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(T.accent.opacity(0.07))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(T.accent.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .onAppear { if !T.still && !reduce { withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { pulse = true } } }
    }
}

/// avatar mono de duas letras sobre a cor do agente
struct Av: View {
    let name: String
    var size: CGFloat = 24
    var body: some View {
        Text(String(name.prefix(2)).uppercased())
            .font(.system(size: size * 0.36, design: .monospaced).bold())
            .foregroundStyle(T.onAccent)
            .frame(width: size, height: size)
            .background(agentColor(name))
            .clipShape(Circle())
    }
}

func agentColor(_ name: String) -> Color {
    let palette: [Color] = [T.accent, T.info, T.purple, T.cyan, T.warn, Color(hex: 0xe8788a)]
    var h = 0
    for u in name.unicodeScalars { h = (h &* 31 &+ Int(u.value)) & 0xffff }
    return palette[h % palette.count]
}

/// glifo do feed técnico
func feedGlyph(_ kind: String) -> (String, Color) {
    switch kind {
    case "bash": return ("$", T.dim)
    case "edit": return ("✎", T.accent)
    case "write": return ("+", T.accent)
    case "error": return ("✖", T.bad)
    case "done": return ("✓", T.accent)
    case "think": return ("·", T.dim2)
    default: return ("»", T.dim)
    }
}

/// botão primário 48px (mínimo de toque)
struct BigButton: View {
    let label: String
    var color: Color = T.accent
    var fg: Color = T.onAccent
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.ui(14.5, .bold))
                .frame(maxWidth: .infinity).frame(height: 48)
                .background(color).foregroundStyle(fg)
                .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
}

/// dot que pisca (● rodando · ao vivo)
struct BlinkDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduce
    var color: Color = T.accent
    @State private var on = true
    var body: some View {
        Circle().fill(color).frame(width: 7, height: 7)
            .opacity(on ? 1 : 0.35)
            .onAppear { if !T.still && !reduce { withAnimation(.easeInOut(duration: 0.9).repeatForever()) { on.toggle() } } }
    }
}
