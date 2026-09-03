import SwiftUI

// Componentes próprios do mobile (DESIGN-SYSTEM.md §5)

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

/// stepper completo do detalhe: círculos + rótulos + provados
struct PhaseStepper: View {
    let phase: Int
    let proved: (done: Int, total: Int)?
    var body: some View {
        VStack(spacing: 8) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(1...5, id: \.self) { i in
                    VStack(spacing: 5) {
                        ZStack {
                            Circle()
                                .fill(i < phase ? T.accent.opacity(0.15) : i == phase ? T.accent : Color.clear)
                                .overlay(Circle().stroke(i <= phase ? T.accent : T.lineHard, lineWidth: 1.2))
                                .frame(width: 22, height: 22)
                            if i < phase {
                                Text("✓").font(.system(size: 11, weight: .bold)).foregroundStyle(T.accent)
                            } else {
                                Text("\(i)").font(.system(size: 10, design: .monospaced).bold())
                                    .foregroundStyle(i == phase ? T.onAccent : T.dim2)
                            }
                        }
                        Text(T.phaseNames[i - 1])
                            .font(.system(size: 8.5, design: .monospaced))
                            .foregroundStyle(i == phase ? T.text : T.dim2)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            if let p = proved, p.total > 0 {
                HStack(spacing: 8) {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.white.opacity(0.1))
                            Capsule().fill(T.accent)
                                .frame(width: g.size.width * CGFloat(p.done) / CGFloat(max(p.total, 1)))
                        }
                    }.frame(height: 4)
                    Text("\(p.done)/\(p.total) provados")
                        .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(T.dim)
                        .fixedSize()
                }
            }
        }
    }
}

/// 5.2 — pill de intenção: o celular escreve, o Mac executa
struct IntentPill: View {
    let label: String
    @State private var pulse = false
    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(T.accent).frame(width: 8, height: 8)
                .overlay(Circle().stroke(T.accent.opacity(0.5), lineWidth: 2)
                    .scaleEffect(pulse ? 2.0 : 1.0).opacity(pulse ? 0 : 1))
            Text(label).font(.system(size: 12, design: .monospaced).weight(.medium))
                .foregroundStyle(T.accent)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(T.accent.opacity(0.07))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(T.accent.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .onAppear { withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { pulse = true } }
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

/// 5.4 — requisito com evidência (substitui o diff no bolso)
struct ReqRow: View {
    let text: String
    let proof: ReqProof?
    var onProof: ((String) -> Void)? = nil
    var body: some View {
        let ok = proof?.status == "done"
        HStack(alignment: .top, spacing: 9) {
            Text(ok ? "✓" : "○")
                .font(.system(size: 13, design: .monospaced).bold())
                .foregroundStyle(ok ? T.accent : T.dim2)
            VStack(alignment: .leading, spacing: 3) {
                Text(text).font(.system(size: 13.5)).foregroundStyle(ok ? T.text : T.text2)
                if let ev = proof?.evidence?.first, ok {
                    HStack(spacing: 7) {
                        Text(ev).font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(T.dim).lineLimit(1)
                        if let onProof {
                            Button("ver prova") { onProof(ev) }
                                .font(.system(size: 10, design: .monospaced).bold())
                                .foregroundStyle(T.accent)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
    }
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
                .font(.system(size: 14.5, weight: .bold))
                .frame(maxWidth: .infinity).frame(height: 48)
                .background(color).foregroundStyle(fg)
                .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
}

/// dot que pisca (● rodando · ao vivo)
struct BlinkDot: View {
    var color: Color = T.accent
    @State private var on = true
    var body: some View {
        Circle().fill(color).frame(width: 7, height: 7)
            .opacity(on ? 1 : 0.35)
            .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever()) { on.toggle() } }
    }
}
