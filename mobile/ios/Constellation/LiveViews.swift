import SwiftUI
import AVKit

// Peças do companion "nível Orca": estado de conexão honesto, presença do Mac, filtro de projetos,
// aviso de alcance (o Mac consegue executar ISTO agora?), toast de erro, visor de provas (imagem/vídeo/texto),
// portão de prova na aprovação e "pedir ajuste".

/// selo do cabeçalho — antes "AO VIVO" fixo, mesmo sem internet
struct LiveTag: View {
    @EnvironmentObject var hub: SyncHub
    var body: some View {
        let s = hub.summary
        let (txt, c): (String, Color) = {
            if !hub.network { return ("OFFLINE", T.bad) }
            switch hub.rt {
            case .live: return ("AO VIVO", T.accent)
            case .retrying, .connecting: return ("RECONECTANDO", T.warn)
            default: return (s.level == .bad ? "OFFLINE" : "A CADA 5S", T.dim)
            }
        }()
        HStack(spacing: 5) {
            BlinkDot(color: c)
            Text(txt).font(.mono(9.5, .bold)).kerning(1).foregroundStyle(c)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("conexão \(txt)")
    }
}

/// o Mac consegue executar ESTA demanda agora? (só fala quando a resposta é "não")
struct ReachNote: View {
    let reach: MacReach
    var body: some View {
        if let (icon, text) = msg {
            HStack(alignment: .top, spacing: 7) {
                Image(systemName: icon).font(.ui(11, .semibold)).foregroundStyle(T.warn).padding(.top, 1)
                Text(text).font(.ui(11.5)).foregroundStyle(T.warn).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 11).padding(.vertical, 8)
            .background(T.warn.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
    private var msg: (String, String)? {
        switch reach {
        case .here, .unknown: return nil
        case .offline(let d): return ("moon.zzz", "Mac offline\(d.map { " (visto \(agoPtDate($0)))" } ?? "") — o que você mandar daqui fica na fila e roda quando ele voltar.")
        case .otherProject(let p): return ("folder.badge.questionmark", "O Mac está com \(p) aberto — ele só executa esta demanda quando você abrir este projeto no Starfork.")
        case .notOnMac: return ("questionmark.folder", "Nenhum Mac seu tem este projeto clonado — clone e abra no Starfork pra ele assumir.")
        }
    }
}

/// toast global (erros que antes sumiam em `try?`)
struct ToastHost: ViewModifier {
    @EnvironmentObject var hub: SyncHub
    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            if let t = hub.toast {
                HStack(spacing: 8) {
                    Image(systemName: t.bad ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                        .foregroundStyle(t.bad ? T.bad : T.accent)
                    Text(t.text).font(.ui(13, .medium)).foregroundStyle(T.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 14).padding(.vertical, 11)
                .background(Color(hex: 0x1a1e20))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(t.bad ? T.bad.opacity(0.5) : T.accent.opacity(0.4)))
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .shadow(color: .black.opacity(0.4), radius: 16, y: 6)
                .padding(.horizontal, 16).padding(.top, 6)
                .transition(.move(edge: .top).combined(with: .opacity))
                .onTapGesture { hub.toast = nil }
                .task(id: t.id) {
                    try? await Task.sleep(for: .seconds(t.bad ? 6 : 3.5))
                    if hub.toast?.id == t.id { withAnimation { hub.toast = nil } }
                }
                .accessibilityAddTraits(.isStaticText)
            }
        }
        .animation(.easeOut(duration: 0.22), value: hub.toast)
    }
}
extension View { func toastHost() -> some View { modifier(ToastHost()) } }

// MARK: - provas

/// visor de prova: imagem com zoom, VÍDEO tocando (antes só imagem — o .mp4 abria "abrir no navegador"), texto
struct ProofViewer: View {
    let name: String
    let url: URL
    @Environment(\.dismiss) var dismiss
    @State private var text: String? = nil
    @State private var player: AVPlayer? = nil
    private var lower: String { name.lowercased() }
    private var isVideo: Bool { [".mp4", ".mov", ".m4v", ".webm"].contains { lower.hasSuffix($0) } }
    private var isText: Bool { [".md", ".txt", ".json", ".log"].contains { lower.hasSuffix($0) } }

    var body: some View {
        NavigationStack {
            Group {
                if isVideo {
                    VideoPlayer(player: player)
                        .onAppear { let p = AVPlayer(url: url); player = p; p.play() }
                        .onDisappear { player?.pause() }
                } else if isText {
                    ScrollView {
                        Text(text ?? "carregando…").font(.mono(12)).foregroundStyle(T.text2)
                            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(16)
                    }
                    .task { if let (d, _) = try? await URLSession.shared.data(from: url) { text = String(decoding: d, as: UTF8.self) } else { text = "não consegui abrir" } }
                } else {
                    ZoomableImage(url: url)
                }
            }
            .background(T.bg)
            .navigationTitle(name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("fechar") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { ShareLink(item: url) { Image(systemName: "square.and.arrow.up") } }
            }
        }
        .preferredColorScheme(.dark)
    }
}

struct ZoomableImage: View {
    let url: URL
    @State private var scale: CGFloat = 1
    @State private var last: CGFloat = 1
    var body: some View {
        GeometryReader { g in
            ScrollView([.vertical, .horizontal], showsIndicators: false) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img): img.resizable().scaledToFit()
                    case .failure: Label("não consegui carregar a imagem", systemImage: "photo.badge.exclamationmark").foregroundStyle(T.dim).padding(40)
                    default: ProgressView().tint(T.accent).padding(60)
                    }
                }
                .frame(width: g.size.width * scale)
                .gesture(MagnificationGesture().onChanged { v in scale = max(1, min(5, last * v)) }.onEnded { _ in last = scale })
                .onTapGesture(count: 2) { withAnimation { scale = scale > 1 ? 1 : 2.5; last = scale } }
            }
        }
    }
}

/// miniatura da galeria: imagem de verdade (antes um emoji 🖼), vídeo com ▶
struct ProofThumb: View {
    let a: ArtifactMeta
    let url: URL?
    var body: some View {
        ZStack {
            T.panel
            if a.isImage, let url {
                AsyncImage(url: url) { ph in
                    if case .success(let img) = ph { img.resizable().scaledToFill() } else { Color.clear }
                }
                .frame(maxWidth: .infinity, maxHeight: 110)
                .clipped()
            } else {
                Image(systemName: a.isVideo ? "film" : "doc.text").font(.ui(22)).foregroundStyle(T.dim)
            }
            if a.isVideo {
                Image(systemName: "play.circle.fill").font(.ui(30)).foregroundStyle(.white.opacity(0.9)).shadow(radius: 4)
            }
            VStack { Spacer()
                Text(a.name).font(.mono(9.5)).foregroundStyle(T.text2).lineLimit(1).truncationMode(.middle)
                    .padding(.horizontal, 6).padding(.vertical, 4).frame(maxWidth: .infinity).background(.black.opacity(0.55))
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 110)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .contentShape(RoundedRectangle(cornerRadius: 10))   // a miniatura (scaledToFill) não vaza o toque pra vizinha
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.line))
        .accessibilityLabel((a.isVideo ? "vídeo " : a.isImage ? "imagem " : "arquivo ") + a.name)
    }
}

// MARK: - aprovar com portão de prova (consistente com o desktop, PR #100)

struct ApproveNoProofSheet: View {
    let missing: [ProofGate.Row]
    let onConfirm: (String) -> Void
    @Environment(\.dismiss) var dismiss
    @State private var reason = ""
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("\(missing.count) requisito\(missing.count == 1 ? "" : "s") sem prova")
                        .font(.ui(18, .semibold)).foregroundStyle(T.warn)
                    ForEach(Array(missing.enumerated()), id: \.offset) { _, r in
                        HStack(alignment: .top, spacing: 8) {
                            Text("○").font(.mono(13, .bold)).foregroundStyle(T.warn)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.text).font(.ui(13.5)).foregroundStyle(T.text)
                                Text(r.st == .ok ? "marcado como feito, mas sem arquivo de prova" : r.st == .blk ? "bloqueado\(r.note.isEmpty ? "" : ": \(r.note)")" : "sem verificação")
                                    .font(.ui(11)).foregroundStyle(T.dim)
                            }
                        }
                    }
                    Text("Por que aprovar assim? O motivo vai na descrição do PR e fica registrado — igual ao \"aprovar sem prova…\" do Mac.")
                        .font(.ui(12.5)).foregroundStyle(T.dim).fixedSize(horizontal: false, vertical: true)
                    TextField("motivo (obrigatório)", text: $reason, axis: .vertical)
                        .lineLimit(3...6).padding(12).background(T.panel)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(T.lineHard)).clipShape(RoundedRectangle(cornerRadius: 12))
                    BigButton(label: "aprovar sem prova e abrir PR", color: reason.trimmingCharacters(in: .whitespacesAndNewlines).count >= 4 ? T.warn : T.panel2,
                              fg: reason.trimmingCharacters(in: .whitespacesAndNewlines).count >= 4 ? T.onAccent : T.dim2) {
                        let r = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard r.count >= 4 else { return }
                        onConfirm(r); dismiss()
                    }
                }.padding(18)
            }
            .background(T.bg)
            .navigationTitle("Aprovar sem prova")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("cancelar") { dismiss() } } }
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.medium, .large])
    }
}

/// "pedir ajuste": follow-up focado (antes o botão só trocava de aba e limpava o campo)
struct AdjustSheet: View {
    let title: String
    let reach: MacReach
    let onSend: (String, Bool) async -> Bool
    @Environment(\.dismiss) var dismiss
    @State private var text = ""
    @State private var asReq = false
    @State private var busy = false
    @FocusState private var focus: Bool
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text(title).font(.mono(11)).foregroundStyle(T.dim).lineLimit(1)
                TextField("o que o agente deve ajustar?", text: $text, axis: .vertical)
                    .focused($focus).lineLimit(4...10).padding(12).background(T.panel)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(T.lineHard)).clipShape(RoundedRectangle(cornerRadius: 12))
                Toggle(isOn: $asReq) { Text("virar requisito da demanda (entra na checklist de provas)").font(.ui(12.5)).foregroundStyle(T.text2) }
                    .tint(T.accent)
                ReachNote(reach: reach)
                BigButton(label: busy ? "enviando…" : "mandar pro agente") {
                    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty, !busy else { return }
                    busy = true
                    Task { if await onSend(t, asReq) { dismiss() }; busy = false }
                }
                .opacity(text.trimmingCharacters(in: .whitespaces).isEmpty ? 0.5 : 1)
                Spacer()
            }
            .padding(18)
            .background(T.bg)
            .navigationTitle("Pedir ajuste")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("cancelar") { dismiss() } } }
            .onAppear { focus = true }
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.medium, .large])
    }
}
