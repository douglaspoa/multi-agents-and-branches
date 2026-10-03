import SwiftUI
import PhotosUI

/// Telas 02–04: Execução (conversa ao vivo) · Entrega (revisão com o portão de prova) · PR.
/// Ao vivo: canal do feed DESTA tarefa (Realtime) acorda a leitura pelo cursor (id > último) — sem duplicar,
/// sem perder; sem o canal, polling de 2s enquanto roda. Controles do agente à vista (pausar · parar · retomar).
struct TaskDetailView: View {
    @EnvironmentObject var supa: Supa
    @EnvironmentObject var hub: SyncHub
    let taskId: String
    let title: String

    struct FeedItem: Identifiable, Decodable, Equatable {
        let id: Int
        let agent: String
        let kind: String
        let text: String
        let at: String
    }

    @State private var task: CloudTask? = nil
    @State private var feed: [FeedItem] = []
    @State private var feedIds: Set<Int> = []
    @State private var lastId = 0
    @State private var outbox: [OutMsg] = []
    @State private var msg = ""
    @State private var asReq = false
    @State private var sending = false
    @State private var question: Question? = nil
    @State private var pickedPhoto: PhotosPickerItem? = nil
    @State private var uploadingImg = false
    @State private var expandedMsgs: Set<Int> = []
    @State private var tickN = 0
    @State private var ownerNames: [String: String] = [:]
    @State private var ticked = false
    @State private var localPreview: String? = nil
    @State private var requestingTunnel = false
    @State private var tab = 0                 // 0 conversa · 1 entrega
    @State private var techOpen: Set<Int> = [] // blocos técnicos expandidos
    @State private var proofs: [ArtifactMeta] = []
    @State private var thumbs: [String: URL] = [:]
    @State private var viewing: Viewing? = nil
    @State private var ignoredComments: Set<String> = []
    @State private var showNoProof = false
    @State private var showAdjust = false
    @State private var confirm: Confirm? = nil
    @State private var wake = 0

    struct Viewing: Identifiable { let name: String; let url: URL; var id: String { url.absoluteString } }
    enum Confirm: String, Identifiable { case abort, merge, stop; var id: String { rawValue } }

    /// Demanda MINHA? (dono = assignee, senão quem criou). Enquanto não carrega,
    /// assume minha só pra não piscar — o corpo re-renderiza quando chega.
    private var isMine: Bool {
        guard let t = task else { return true }
        return hub.isMine(t)
    }
    private var ownerName: String {
        guard let t = task, let id = t.assignee ?? t.createdBy else { return "outra pessoa" }
        return (ownerNames[id] ?? "outra pessoa")
    }
    private var status: String { task?.status ?? "" }
    private var previewUrl: String? { task?.spec?.previewUrl }
    private var intent: TaskSpec.Intent? { task?.spec?.intent }
    private var intentResult: TaskSpec.IntentResult? { task?.spec?.intentResult }
    private var reach: MacReach { task.map(hub.reach) ?? .unknown }
    private var feedLive: Bool { hub.feedLive[taskId] == true && hub.rt == .live }

    @FocusState private var composerFocused: Bool
    @Environment(\.dynamicTypeSize) private var dts
    @State private var showPhotos = false

    /// 0 feed · 1 requisitos/provas · 2 detalhes (demanda de outro membro: sem feed — o chat é do dono)
    private var shownTab: Int { isMine ? tab : max(tab, 1) }

    var body: some View {
        VStack(spacing: 0) {
            // teclado aberto: o cabeçalho recolhe e o chat ganha a tela (iPhone SE inclusive)
            if !composerFocused {
                header
                previewBar
                tabPicker
            }
            Group {
                switch shownTab {
                case 0: conversa
                case 1: provas
                default: detalhes
                }
            }
            .frame(maxHeight: .infinity)
        }
        // compositor FIXO embaixo: safeAreaInset acompanha o teclado; a barra de abas fica escondida aqui
        // (antes ela vivia num safeAreaInset do TabView e subia junto com o teclado POR CIMA do compositor)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if isMine { composer }
        }
        .animation(.easeOut(duration: 0.22), value: composerFocused)
        .background(T.bg)
        .toolbar(.hidden, for: .tabBar)
        .navigationTitle(task?.title ?? title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if isMine {
                        if task?.isLive == true {
                            Button { act("pause") } label: { Label("Pausar no Mac", systemImage: "pause") }
                            Button { confirm = .stop } label: { Label("Parar o turno", systemImage: "stop") }
                        }
                        if status == "paused" { Button { act("resume") } label: { Label("Retomar", systemImage: "play") } }
                        if task?.prUrl == nil && ["review", "delivered"].contains(status) {
                            Button { approve() } label: { Label("Aprovar e abrir PR", systemImage: "arrow.triangle.pull") }
                        }
                        Button { showAdjust = true } label: { Label("Pedir ajuste", systemImage: "square.and.pencil") }
                        if task?.isEnded == false {
                            Button(role: .destructive) { confirm = .abort } label: { Label("Abortar a demanda", systemImage: "xmark.octagon") }
                        }
                    }
                    if let pr = task?.prUrl, let u = URL(string: pr) { Link(destination: u) { Label("Abrir PR no GitHub", systemImage: "arrow.up.right.square") } }
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("ações da demanda")
            }
        }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            if confirm == .abort { Button("Abortar", role: .destructive) { Haptic.warning(); act("abort") } }
            if confirm == .stop { Button("Parar o turno", role: .destructive) { Haptic.warning(); act("stop") } }
            if confirm == .merge { Button("Fazer o merge (squash)") { Haptic.success(); act("merge") } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text(confirmMsg) }
        .sheet(item: $viewing) { v in ProofViewer(name: v.name, url: v.url) }
        .sheet(isPresented: $showNoProof) {
            if let t = task, case .unproven(let miss) = ProofGate.gate(t) {
                ApproveNoProofSheet(missing: miss) { reason in
                    act("openPr", extra: ["noProofReason": reason, "missing": miss.map(\.text)])
                }
            }
        }
        .sheet(isPresented: $showAdjust) {
            AdjustSheet(title: task?.title ?? title, reach: reach) { text, req in
                let ok = await hub.message(taskId, (req ? "[req] " : "") + text)
                if ok { await loadOutbox(); tab = 0 }
                return ok
            }
        }
        .photosPicker(isPresented: $showPhotos, selection: $pickedPhoto, matching: .images)
        .onChange(of: pickedPhoto) { _, item in
            guard let item else { return }
            Task { await sendImage(item); pickedPhoto = nil }
        }
        .onReceive(hub.nudge) { tid in if tid == taskId { wake += 1 } }
        .onAppear { hub.joinFeed(taskId) }
        .onDisappear { hub.leaveFeed(taskId) }
        .task {
            #if DEBUG
            if let t = ProcessInfo.processInfo.environment["DEMO_DETAIL_TAB"], let n = Int(t) { tab = n }
            #endif
            // empurrão do ao vivo = lê já; sem ele: 2s rodando · 5s parada (o canal ao vivo alivia pra 15s)
            var seen = wake
            while !Task.isCancelled {
                await tick()
                let base: Double = feedLive ? 15 : (task?.isLive == true ? 2 : 5)
                var waited = 0.0
                while waited < base && !Task.isCancelled && seen == wake {
                    try? await Task.sleep(for: .milliseconds(200)); waited += 0.2
                }
                seen = wake
            }
        }
    }

    private var tabPicker: some View {
        Picker("Seção", selection: Binding(get: { shownTab }, set: { tab = $0; Haptic.select() })) {
            if isMine { Text("Feed").tag(0) }
            Text("Requisitos e provas").tag(1)
            Text("Detalhes").tag(2)
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(T.panel2)
        .overlay(alignment: .bottom) { Rectangle().fill(T.line).frame(height: 0.5) }
        .accessibilityIdentifier("secao")
    }

    private var confirmTitle: String {
        switch confirm { case .abort: "Abortar a demanda?"; case .stop: "Parar o turno do agente?"; case .merge: "Fazer o merge do PR?"; case nil: "" }
    }
    private var confirmMsg: String {
        switch confirm {
        case .abort: "O agente é encerrado no Mac; a branch/worktree fica preservada pra inspeção."
        case .stop: "O agente termina o que está fazendo agora e a demanda volta pra você revisar."
        case .merge: "O Mac faz o merge (squash) no GitHub."
        case nil: ""
        }
    }

    // ---- cabeçalho: status em palavra + fase + custo + prova + controles do agente ----
    @ViewBuilder private var header: some View {
        if let t = task {
            // o estado REAL da demanda (a pergunta aberta já tem a faixa própria logo acima do compositor)
            let st = StatusInfo.of(t, teto: question?.isTeto == true)
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    StatusWord(info: st).layoutPriority(1)
                    Text("· \(T.phaseNames[max(0, min(4, t.phase - 1))])").font(.ui(12)).foregroundStyle(T.dim).lineLimit(1)
                    Spacer(minLength: 6)
                    if let c = fmtUsd(t.costUsd) {
                        Text(c + (t.spec?.budgetUsd.map { String(format: " de $%.0f", $0) } ?? ""))
                            .font(.mono(12)).monospacedDigit().foregroundStyle(T.text2).lineLimit(1)
                    }
                }
                PhaseBar(phase: t.phase)
                    .accessibilityElement()
                    .accessibilityLabel("fase \(t.phase) de 5: \(T.phaseNames[max(0, min(4, t.phase - 1))])")
                // texto grande (acessibilidade): prova numa linha, controles na de baixo — nada espremido
                let row = dts.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
                row {
                    ProofBadge(proved: t.reqsProved)
                    if t.reqsProved == nil { Text("sem requisitos ainda").font(.ui(12)).foregroundStyle(T.dim2) }
                    if !dts.isAccessibilitySize { Spacer(minLength: 4) }
                    HStack(spacing: 8) {
                    if isMine && intent == nil {
                        if t.isLive {
                            Button { Haptic.tap(); act("pause") } label: { Label("Pausar", systemImage: "pause.fill") }
                                .buttonStyle(.bordered).tint(T.warn)
                                .accessibilityLabel("pausar o agente")
                            Button { Haptic.warning(); confirm = .stop } label: { Label("Parar", systemImage: "stop.fill") }
                                .buttonStyle(.bordered).tint(T.bad)
                                .accessibilityLabel("parar o agente")
                        } else if t.status == "paused" && question?.isTeto != true {
                            Button { Haptic.success(); act("resume") } label: { Label("Retomar", systemImage: "play.fill") }
                                .buttonStyle(.borderedProminent).tint(T.accent).foregroundStyle(T.onAccent)
                                .accessibilityLabel("retomar o agente")
                        }
                    }
                    }
                    .lineLimit(1)
                    .fixedSize()
                }
                .font(.ui(13, .semibold))
                .controlSize(.small)
                if isMine { ReachNote(reach: reach) }
                if let it = intent {
                    IntentPill(label: "o Mac está executando · \(intentLabel(it.kind))")
                } else if let r = intentResult {
                    Label("\(intentLabel(r.kind)): \(r.msg ?? (r.ok ? "feito" : "falhou"))", systemImage: r.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .font(.ui(12)).foregroundStyle(r.ok ? T.accent : T.bad)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T.panel2)
        } else {
            VStack(alignment: .leading, spacing: 10) { Bone(w: 140, h: 12); PhaseBar(phase: 1).opacity(0.4) }
                .padding(16).frame(maxWidth: .infinity, alignment: .leading).background(T.panel2).shimmer()
        }
    }
    // ---- conversa (tela 02): fala é conteúdo, técnica colapsa ----
    private enum Row: Identifiable {
        case talk(FeedItem)
        case tech([FeedItem])
        var id: Int {
            switch self {
            case .talk(let f): return f.id
            case .tech(let fs): return fs.first?.id ?? 0
            }
        }
    }
    private var rows: [Row] {
        var out: [Row] = []
        var bucket: [FeedItem] = []
        var lastTalk = ""
        func flush() { if !bucket.isEmpty { out.append(.tech(bucket)); bucket = [] } }
        for f in feed {
            if f.text.hasPrefix("❓") { continue }   // duplica o "perguntou ao humano:" — o desktop também esconde
            // a pergunta aberta já aparece na BARRA amarela — não repetir no feed
            if question != nil, f.text.hasPrefix("perguntou ao humano:") { continue }
            // resposta do humano e mensagem do celular viram bolha SUA (antes "Você: ok" caía nos passos técnicos)
            if f.text.hasPrefix("humano respondeu:") || f.agent == "Você" || f.text.hasPrefix("Você: ") {
                flush()
                let txt = f.text.replacingOccurrences(of: "humano respondeu: ", with: "").replacingOccurrences(of: "Você: ", with: "")
                out.append(.talk(FeedItem(id: f.id, agent: "Você", kind: f.kind, text: "💬 " + txt, at: f.at)))
                continue
            }
            // fala do agente = think/note/done/error com texto de gente
            let isTalk = ["think", "note", "done", "error"].contains(f.kind) && f.text.count > 40 && !f.text.hasPrefix("$")
            if isTalk {
                // o 'done' costuma repetir o último 'note' — não mostra a bolha 2x
                let key = String(f.text.prefix(120))
                if key == lastTalk { bucket.append(f); continue }
                lastTalk = key
                flush(); out.append(.talk(f))
            } else { bucket.append(f) }
        }
        flush()
        return out
    }

    @State private var lastScrolled = 0
    private var conversa: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if feed.isEmpty && !ticked { FeedSkeleton().padding(.top, 12) }
                    else if feed.isEmpty {
                        emptyFeed.padding(.top, 30).frame(maxWidth: .infinity)
                    }
                    ForEach(rows) { row in rowView(row).id(row.id) }
                    // mensagens do celular que o Mac ainda não entregou ao agente (antes sumiam até ele ecoar)
                    ForEach(outbox.filter { $0.deliveredAt == nil }) { m in pendingBubble(m) }
                    Color.clear.frame(height: 1).id("fim")
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: feed.count + outbox.count) { _, _ in
                // rola SÓ quando chega linha realmente nova — sem dançar a cada leitura
                let last = (rows.last?.id ?? 0) + outbox.count * 1_000_000
                guard last != lastScrolled else { return }
                lastScrolled = last
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("fim", anchor: .bottom) }
            }
            // teclado abriu: leva o chat até a mensagem mais nova (depois da animação do teclado)
            .onChange(of: composerFocused) { _, f in
                guard f else { return }
                Task {
                    try? await Task.sleep(for: .milliseconds(350))
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("fim", anchor: .bottom) }
                }
            }
        }
    }
    @ViewBuilder private var emptyFeed: some View {
        VStack(spacing: 8) {
            Text(status == "requested" ? "esperando o Mac assumir" : "esperando o agente… os passos aparecem aqui ao vivo")
                .font(.footnote).foregroundStyle(T.dim)
            if status == "requested" {
                switch reach {
                case .here: Text("o Mac está online com o projeto aberto — começa em segundos").font(.caption2).foregroundStyle(T.dim2)
                case .unknown: Text("o Starfork precisa estar aberto no seu Mac, com este projeto").font(.caption2).foregroundStyle(T.dim2)
                default: EmptyView()
                }
            }
        }
        .multilineTextAlignment(.center)
    }

    private func pendingBubble(_ m: OutMsg) -> some View {
        let state = reach == .here || reach == .unknown ? "na fila do Mac…" : "na fila — o Mac entrega quando puder"
        return HStack {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 4) {
                Text(m.shown).font(.ui(13.5)).foregroundStyle(T.text)
                    .padding(.horizontal, 13).padding(.vertical, 9)
                    .background(T.accent2.opacity(0.25))
                    .overlay(RoundedRectangle(cornerRadius: 13).strokeBorder(T.accent.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                    .clipShape(RoundedRectangle(cornerRadius: 13))
                HStack(spacing: 4) {
                    Image(systemName: "clock").font(.ui(9))
                    Text(state).font(.mono(10))
                }.foregroundStyle(T.dim)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(m.shown) — \(state)")
    }

    @ViewBuilder private func rowView(_ row: Row) -> some View {
        switch row {
        case .talk(let f):
            if f.text.hasPrefix("💬") {
                HStack {
                    Spacer(minLength: 40)
                    Text(f.text.replacingOccurrences(of: "💬 ", with: ""))
                        .font(.ui(13.5)).foregroundStyle(T.onAccent)
                        .padding(.horizontal, 13).padding(.vertical, 9)
                        .background(T.accent2).clipShape(RoundedRectangle(cornerRadius: 13))
                }
            } else {
                // mensagem longa do agente: mostra o começo e "ver mais"
                let long = f.text.count > 260
                let expanded = expandedMsgs.contains(f.id)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 7) {
                        Av(name: f.agent, size: 18)
                        Text(f.agent.uppercased()).font(.mono(10).bold())
                            .foregroundStyle(f.kind == "error" ? T.bad : T.dim)
                        Spacer()
                        Text(agoPt(f.at)).font(.mono(9.5)).foregroundStyle(T.dim2)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        linkableText(f.text)
                            .lineLimit(long && !expanded ? 6 : nil)
                        if long {
                            Button {
                                if expanded { expandedMsgs.remove(f.id) } else { expandedMsgs.insert(f.id) }
                            } label: {
                                Text(expanded ? "ver menos ▲" : "ver mais ▼")
                                    .font(.mono(11).bold())
                                    .foregroundStyle(T.accent)
                            }
                        }
                    }
                    .padding(.horizontal, 13).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(T.panel)
                    .overlay(RoundedRectangle(cornerRadius: 13).stroke(f.kind == "error" ? T.bad.opacity(0.4) : T.line))
                    .clipShape(RoundedRectangle(cornerRadius: 13))
                }
            }
        case .tech(let fs):
            let open = techOpen.contains(fs.first?.id ?? 0)
            VStack(alignment: .leading, spacing: 5) {
                Button {
                    if open { techOpen.remove(fs.first?.id ?? 0) } else { techOpen.insert(fs.first?.id ?? 0) }
                } label: {
                    HStack(spacing: 6) {
                        Text(open ? "▾" : "▸").font(.mono(10))
                        Text("\(fs.count) passo\(fs.count == 1 ? "" : "s") técnico\(fs.count == 1 ? "" : "s")")
                            .font(.mono(11))
                        if !open, let l = fs.last { Text("· " + l.text).font(.mono(10.5)).lineLimit(1).truncationMode(.tail) }
                    }.foregroundStyle(T.dim2).frame(minHeight: 28)
                }
                if open {
                    ForEach(fs) { f in
                        HStack(alignment: .top, spacing: 7) {
                            let g = feedGlyph(f.kind)
                            Text(g.0).font(.mono(11)).foregroundStyle(g.1)
                            Text(f.text).font(.mono(11.5))
                                .foregroundStyle(T.dim).textSelection(.enabled)
                            Spacer(minLength: 0)
                        }
                    }
                    .padding(.leading, 6)
                }
            }
        }
    }

    @ViewBuilder private func linkableText(_ text: String) -> some View {
        mdText(text, size: 13.5, color: T.text2)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    // ---- requisitos e provas (telas 03–04): o diferencial — prova por requisito, galeria, decisão, PR ----
    private func block<C: View>(_ title: String, _ symbol: String, count: Int? = nil, color: Color = T.text2, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHead(title: title, symbol: symbol, color: color == T.text2 ? T.dim : color, count: count)
            VStack(alignment: .leading, spacing: 10) { content() }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(T.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    private var provas: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                if let t = task {
                    if let reqs = t.spec?.requirements, !reqs.isEmpty {
                        let rws = ProofGate.rows(reqs, t.requirementsProof?.list)
                        block("Requisitos com prova", "checkmark.seal", count: reqs.count) {
                            ForEach(Array(rws.enumerated()), id: \.offset) { i, r in
                                if i > 0 { Divider().overlay(T.line) }
                                ReqGateRow(row: r) { ev in openProof(named: ev) }
                            }
                        }
                    }
                    if !proofs.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHead(title: "Galeria de provas", symbol: "photo.on.rectangle", count: proofs.count)
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 128), spacing: 10)], spacing: 10) {
                                ForEach(proofs) { a in
                                    Button { openProof(a) } label: { ProofThumb(a: a, url: thumbs[a.storagePath]) }.buttonStyle(.plain)
                                        .accessibilityLabel((a.isVideo ? "vídeo " : a.isImage ? "imagem " : "arquivo ") + a.name)
                                }
                            }
                        }
                    }
                    if ["review", "delivered"].contains(t.status), t.prUrl == nil, isMine { decision(t) }
                    if let pr = t.spec?.prInfo, t.prUrl != nil { prSection(t, pr) }
                    let nothing = (t.spec?.requirements?.isEmpty ?? true) && proofs.isEmpty
                    if nothing {
                        ContentUnavailableView {
                            Label(["review", "delivered", "merged", "done"].contains(t.status) ? "Sem provas publicadas" : "Provas a caminho",
                                  systemImage: "checkmark.seal")
                        } description: {
                            Text(["review", "delivered", "merged", "done"].contains(t.status)
                                 ? "O agente não publicou provas desta entrega."
                                 : "Requisitos e provas aparecem aqui conforme o agente avança.")
                        }
                        .foregroundStyle(T.dim)
                        .padding(.top, 20)
                    }
                } else { BoardSkeleton() }
            }
            .padding(16).padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    // ---- detalhes: objetivo, entregáveis, o que foi feito, números, como testar, branch ----
    private var detalhes: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                if let t = task {
                    if !isMine {
                        Label("Acompanhando a demanda de \(ownerName) — só leitura", systemImage: "eye")
                            .font(.ui(13)).foregroundStyle(T.dim)
                    }
                    if let obj = t.spec?.objective, !obj.isEmpty {
                        block("Objetivo", "scope") {
                            mdText(obj, size: 15, color: T.text)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let dels = t.spec?.deliverables, !dels.isEmpty {
                        block("Entregáveis", "shippingbox", count: dels.count) {
                            ForEach(Array(dels.enumerated()), id: \.offset) { _, d in
                                Label { Text(d).font(.ui(14)).foregroundStyle(T.text2).fixedSize(horizontal: false, vertical: true) }
                                    icon: { Image(systemName: "diamond.fill").font(.ui(10)).foregroundStyle(T.accent) }
                            }
                        }
                    }
                    if let rev = t.spec?.review, let s = rev.summary, !s.isEmpty {
                        block("O que foi feito", "text.badge.checkmark") {
                            mdText(s, size: 15, color: T.text)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let st = t.spec?.stat, (st.files ?? 0) > 0 || (st.add ?? 0) > 0 || (st.commits ?? 0) > 0 {
                        block("Números", "chart.bar") {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), alignment: .leading)], alignment: .leading, spacing: 12) {
                                if let f = st.files { statV("\(f)", "arquivos") }
                                if let a = st.add { statV("+\(a)", "linhas").foregroundStyle(T.accent) }
                                if let d = st.del { statV("−\(d)", "removidas").foregroundStyle(T.bad) }
                                if let c = st.commits { statV("\(c)", "commits") }
                                if let c = fmtUsd(t.costUsd) { statV(c, "custo") }
                            }
                        }
                    }
                    if let how = t.spec?.review?.howToTest, !how.isEmpty {
                        block("Como testar", "checklist") {
                            Text(softBreak(how)).font(.mono(13)).foregroundStyle(T.text2)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    block("Demanda", "info.circle") {
                        if let b = t.branch, !b.isEmpty { infoRow("Branch", softBreak(b), mono: true) }
                        if let p = hub.project(t.projectId)?.name { infoRow("Projeto", p) }
                        infoRow("Estado", StatusInfo.of(t).word)
                        infoRow("Atualizada", agoPt(t.updatedAt))
                        if let m = t.spec?.model, !m.isEmpty { infoRow("IA", AIModel.named(m)) }
                    }
                } else { BoardSkeleton() }
            }
            .padding(16).padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func infoRow(_ k: String, _ v: String, mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.ui(12)).foregroundStyle(T.dim)
            Text(v).font(mono ? .mono(13) : .ui(14)).foregroundStyle(T.text2).fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
    /// rodapé de decisão (fase 4) com o PORTÃO DE PROVA — mesma regra do desktop (PR #100)
    @ViewBuilder private func decision(_ t: CloudTask) -> some View {
        let gate = ProofGate.gate(t)
        let nonCode = ["design", "invest"].contains(t.kind)
        VStack(alignment: .leading, spacing: 10) {
            SectionHead(title: "Sua decisão", symbol: "hand.raised.fill", color: T.warn)
            if let it = intent, ["openPr", "askProof"].contains(it.kind) { IntentPill(label: "o Mac está executando · \(intentLabel(it.kind))") }
            else if nonCode {
                Text("Esta demanda entrega documentos, não código — o fim é salvar os entregáveis no Mac.")
                    .font(.ui(13)).foregroundStyle(T.dim)
            } else if case .unproven(let miss) = gate {
                Label("\(miss.count) requisito\(miss.count == 1 ? "" : "s") sem prova — prova antes de promessa", systemImage: "exclamationmark.circle.fill")
                    .font(.ui(13, .medium)).foregroundStyle(T.warn)
                Button { Haptic.tap(); act("askProof") } label: {
                    Label("Pedir a prova ao agente", systemImage: "checkmark.seal").font(.ui(16, .semibold)).frame(maxWidth: .infinity).padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent).tint(T.accent).foregroundStyle(T.onAccent)
                Button { Haptic.warning(); showNoProof = true } label: {
                    Text("Aprovar sem prova…").font(.ui(15, .semibold)).frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.bordered).tint(T.warn)
            } else {
                Button { Haptic.success(); act("openPr") } label: {
                    Label("Aprovar e abrir PR", systemImage: "arrow.triangle.pull").font(.ui(16, .semibold)).frame(maxWidth: .infinity).padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent).tint(T.accent).foregroundStyle(T.onAccent)
            }
            Button { showAdjust = true } label: {
                Label("Pedir ajuste", systemImage: "square.and.pencil").font(.ui(15, .semibold)).frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.bordered).tint(T.text2)
        }
        .buttonBorderShape(.roundedRectangle(radius: 12))
    }

    private func approve() {
        guard let t = task else { return }
        if case .unproven = ProofGate.gate(t) { tab = 1; showNoProof = true } else { act("openPr") }
    }

    private func statV(_ v: String, _ l: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(v).font(.mono(15).bold())
            if !l.isEmpty { Text(l).font(.mono(9)).foregroundStyle(T.dim) }
        }
    }

    @ViewBuilder private func prSection(_ t: CloudTask, _ pr: TaskSpec.PrInfo) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHead(title: "Pull request \(pr.number.map { "#\($0)" } ?? "")", symbol: "arrow.triangle.pull", color: T.info)
            if let b = pr.body, !b.isEmpty {
                Text(b).font(.ui(12.5)).foregroundStyle(T.text2).lineLimit(14)
                    .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(pr.comments ?? []) { c in
                let done = c.answered ?? false
                let skipped = ignoredComments.contains(c.listId)
                VStack(alignment: .leading, spacing: 7) {
                    HStack(spacing: 7) {
                        Text(c.author ?? "").font(.mono(11).bold()).foregroundStyle(T.text)
                        if c.isBot == true { Text("bot").font(.mono(8.5)).padding(.horizontal, 4).background(T.info.opacity(0.2)).foregroundStyle(T.info).clipShape(Capsule()) }
                        if let p = c.path { Text(softBreak("\(p)\(c.line.map { ":\($0)" } ?? "")")).font(.mono(9.5)).foregroundStyle(T.dim).lineLimit(1).truncationMode(.middle) }
                        Spacer()
                        if done { Text("✔ respondido").font(.mono(9.5)).foregroundStyle(T.accent) }
                        else if skipped { Text("ignorado").font(.mono(9.5)).foregroundStyle(T.dim2) }
                    }
                    Text(c.body ?? "").font(.ui(12.5)).foregroundStyle(done || skipped ? T.dim : T.text2)
                        .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    if !done && !skipped && isMine {
                        if intent?.kind == "fixComment" { IntentPill(label: "o Mac está executando · aplicar correção") }
                        else {
                            HStack(spacing: 8) {
                                Button { act("fixComment", extra: ["commentId": c.id ?? 0]) } label: {
                                    Text("Aplicar correção").font(.ui(13, .semibold))
                                        .padding(.horizontal, 13).frame(height: 38)
                                        .background(T.accent).foregroundStyle(T.onAccent).clipShape(Capsule())
                                }
                                Button { ignoredComments.insert(c.listId) } label: {
                                    Text("Ignorar").font(.ui(13))
                                        .padding(.horizontal, 13).frame(height: 38)
                                        .overlay(Capsule().stroke(T.lineHard)).foregroundStyle(T.dim)
                                }
                            }
                        }
                    }
                }
                .card(radius: 12)
            }
            if isMine && !["merged", "done"].contains(t.status) {
                if intent?.kind == "merge" { IntentPill(label: "o Mac está executando · merge") }
                else {
                    Button { Haptic.tap(); confirm = .merge } label: {
                        Label("Fazer o merge do PR", systemImage: "arrow.triangle.merge").font(.ui(16, .semibold)).frame(maxWidth: .infinity).padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent).buttonBorderShape(.roundedRectangle(radius: 12)).tint(T.accent).foregroundStyle(T.onAccent)
                }
            }
        }
    }

    private func openProof(named ev: String) {
        let name = ev.components(separatedBy: "·").last?.trimmingCharacters(in: .whitespaces) ?? ev
        let base = (name as NSString).lastPathComponent
        if let a = proofs.first(where: { $0.name == base || $0.name.contains(base) || base.contains($0.name) }) { openProof(a) }
        else { hub.toast = .init(text: "essa prova (\(base)) ainda não foi publicada pro time — o Mac sobe as provas ao publicar", bad: false) }
    }
    private func openProof(_ a: ArtifactMeta) {
        Task {
            do { let u = try await supa.signedUrl(a.storagePath); viewing = Viewing(name: a.name, url: u) }
            catch { hub.toast = .init(text: error.localizedDescription, bad: true) }
        }
    }

    private func act(_ kind: String, extra: [String: Any] = [:]) {
        Task { if await hub.intent(taskId, kind, extra: extra) { await tick() } }
    }

    /// Foto do celular → Storage → o Mac baixa pra .cardume/refs e avisa o agente.
    private func sendImage(_ item: PhotosPickerItem) async {
        uploadingImg = true
        defer { uploadingImg = false }
        do {
            guard let raw = try await item.loadTransferable(type: Data.self),
                  let ui = UIImage(data: raw) else { throw Supa.SupaError.api("não consegui ler a imagem") }
            // redimensiona (máx 1600px) e comprime — print de tela não precisa de 12MB
            let maxDim: CGFloat = 1600
            let scale = min(1, maxDim / max(ui.size.width, ui.size.height))
            let size = CGSize(width: ui.size.width * scale, height: ui.size.height * scale)
            let img = UIGraphicsImageRenderer(size: size).image { _ in ui.draw(in: CGRect(origin: .zero, size: size)) }
            guard let jpg = img.jpegData(compressionQuality: 0.8) else { throw Supa.SupaError.api("falha ao comprimir") }
            let name = "img-\(Int(Date().timeIntervalSince1970)).jpg"
            let path = try await supa.uploadTaskRef(taskId: taskId, data: jpg, filename: name)
            let caption = msg.trimmingCharacters(in: .whitespacesAndNewlines)
            if await hub.message(taskId, "[img] \(path)" + (caption.isEmpty ? "" : " | \(caption)")) { msg = "" }
            await loadOutbox()
        } catch { hub.toast = .init(text: error.localizedDescription, bad: true) }
    }

    // ---- barra do preview ----
    @ViewBuilder private var previewBar: some View {
        if let pv = previewUrl, let url = URL(string: pv) {
            HStack(spacing: 0) {
                Link(destination: url) {
                    HStack {
                        Image(systemName: "play.rectangle.fill")
                        Text("abrir preview ao vivo").bold()
                        Spacer()
                        Image(systemName: "arrow.up.right")
                    }
                    .font(.system(.subheadline, design: .monospaced))
                    .padding(.horizontal, 14).padding(.vertical, 11)
                }
                Button { Task { await requestTunnelClose() } } label: {
                    Image(systemName: "xmark").font(.subheadline.bold())
                        .padding(.horizontal, 14).padding(.vertical, 13)
                        .background(Color.black.opacity(0.18))
                }.accessibilityLabel("fechar o acesso ao preview")
            }
            .background(T.accent).foregroundStyle(.black)
        } else if requestingTunnel {
            HStack {
                ProgressView().tint(T.accent).scaleEffect(0.8)
                Text("criando acesso do celular… (~10s)").font(.footnote)
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(T.accent.opacity(0.10)).foregroundStyle(T.accent)
        } else if localPreview != nil {
            Button { Task { await requestTunnel() } } label: {
                HStack {
                    Image(systemName: "iphone.radiowaves.left.and.right")
                    Text("o agente subiu um preview no Mac — tocar pra abrir aqui").font(.footnote).bold()
                    Spacer()
                }
                .padding(.horizontal, 14).padding(.vertical, 11)
                .background(T.accent.opacity(0.12)).foregroundStyle(T.accent)
            }
        }
    }

    private func patchSpec(_ edit: (inout [String: Any]) -> Void) async {
        do {
            let d = try await supa.rest("tasks?select=spec&id=eq.\(taskId)")
            guard let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]], var spec = arr.first?["spec"] as? [String: Any] else { return }
            edit(&spec)
            _ = try await supa.rest("tasks?id=eq.\(taskId)", method: "PATCH", json: ["spec": spec])
        } catch { hub.toast = .init(text: error.localizedDescription, bad: true) }
    }
    private func requestTunnelClose() async {
        await patchSpec { s in s["tunnelClose"] = ISO8601DateFormatter().string(from: Date()); s["previewUrl"] = NSNull() }
        await tick()
    }
    private func requestTunnel() async {
        requestingTunnel = true
        await patchSpec { s in s["tunnelWanted"] = ISO8601DateFormatter().string(from: Date()) }
        Task { try? await Task.sleep(for: .seconds(45)); requestingTunnel = false }
    }

    // ---- pergunta inline (e o TETO de custo) + compositor ----
    @State private var qExpanded = false
    @State private var answeringQ = false
    @ViewBuilder private func questionBar(_ q: Question) -> some View {
        let teto = q.isTeto
        let color = teto ? T.bad : T.warn
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(teto ? "Teto de custo atingido" : "\(q.agent.isEmpty ? "Agente" : q.agent) pergunta",
                      systemImage: teto ? "gauge.with.dots.needle.100percent" : "questionmark.bubble.fill")
                    .font(.ui(13, .semibold)).foregroundStyle(color)
                Spacer()
                if q.prompt.count > 140 && !composerFocused {
                    Button(qExpanded ? "Recolher" : "Ler tudo") { qExpanded.toggle() }
                        .font(.ui(12, .semibold)).tint(color).buttonStyle(.borderless)
                }
            }
            if composerFocused {
                // digitando: a pergunta encolhe pra 2 linhas e o chat continua visível
                mdText(q.prompt, size: 13, color: T.text2).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                // prompt cresce até um teto e ROLA — nunca toma a tela inteira
                ScrollView(.vertical) {
                    mdText(q.prompt, size: 14, color: T.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxHeight: qExpanded ? 260 : 72)
                if answeringQ { IntentPill(label: "enviando a resposta…") }
                else if !q.options.isEmpty {
                    ForEach(q.options, id: \.self) { opt in
                        Button { Haptic.success(); Task { await answerQuestion(q, text: opt) } } label: {
                            Text(opt).font(.ui(14, .semibold)).multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.bordered).buttonBorderShape(.roundedRectangle(radius: 11))
                        .tint(teto && opt.hasPrefix("Parar") ? T.bad : color)
                    }
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(color.opacity(0.08))
    }

    private var composer: some View {
        VStack(spacing: 0) {
            if let q = question { questionBar(q) }
            if !skillMatches.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(skillMatches, id: \.0) { s in
                        Button {
                            msg = ""
                            Haptic.tap()
                            Task { if await hub.message(taskId, s.2) { await loadOutbox() } }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("/" + s.0).font(.mono(13, .semibold)).foregroundStyle(T.accent)
                                Text(s.1).font(.ui(12)).foregroundStyle(T.dim).lineLimit(2)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                        }
                        Divider().overlay(T.line)
                    }
                }
                .background(T.panel)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    Section("Skills do agente") {
                        ForEach(Self.skills, id: \.0) { s in
                            Button {
                                Haptic.tap()
                                Task { if await hub.message(taskId, s.2) { await loadOutbox() } }
                            } label: { Text("/" + s.0); Text(s.1) }
                        }
                    }
                    Button { showPhotos = true } label: { Label("Anexar imagem", systemImage: "photo") }
                } label: {
                    Group {
                        if uploadingImg { ProgressView().tint(T.accent) }
                        else { Image(systemName: "plus").font(.ui(17, .semibold)).foregroundStyle(T.accent) }
                    }
                    .frame(width: 40, height: 40)
                    .background(T.panel3, in: Circle())
                }
                .disabled(uploadingImg)
                .accessibilityLabel("skills e anexar imagem")
                TextField(question != nil ? (question?.isTeto == true ? "ou escreva: continuar / parar" : "Responda a pergunta…") : "Peça um ajuste ao agente…",
                          text: $msg, axis: .vertical)
                    .focused($composerFocused)
                    .accessibilityIdentifier("composer")
                    .font(.ui(16))
                    .foregroundStyle(T.text)
                    .lineLimit(1...5)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .frame(minHeight: 40)
                    .background(T.panel3, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(composerFocused ? T.accent.opacity(0.5) : T.line))
                if msg.isEmpty { MicButton(text: $msg) }
                let empty = msg.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                Button { Task { await send() } } label: {
                    Group {
                        if sending { ProgressView().tint(T.onAccent) }
                        else { Image(systemName: "arrow.up").font(.ui(16, .bold)) }
                    }
                    .frame(width: 40, height: 40)
                    .background(empty ? T.panel3 : T.accent, in: Circle())
                    .foregroundStyle(empty ? T.dim2 : T.onAccent)
                }
                .disabled(sending || empty || msg.hasPrefix("/"))
                .accessibilityLabel("enviar")
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 8)
            if !msg.trimmingCharacters(in: .whitespaces).isEmpty && question == nil {
                Toggle(isOn: $asReq) {
                    Label("Virar requisito da demanda", systemImage: "checkmark.seal").font(.ui(13)).foregroundStyle(T.text2)
                }
                .tint(T.accent)
                .padding(.horizontal, 16).padding(.bottom, 8)
            }
        }
        .background(.bar)
        .overlay(alignment: .top) { Rectangle().fill(T.line).frame(height: 0.5) }
    }
    static let designPrompt = """
    MODO DESIGN — refine o VISUAL desta entrega comigo, agindo como um designer sênior de produto:
    1) Suba o ambiente (siga o .cardume/RUNBOOK.md) e ANUNCIE "🌐 preview: <url da tela em questão>" pra eu acompanhar ao vivo (também vejo do celular).
    2) Faça um DIAGNÓSTICO visual objetivo da tela atual (hierarquia, espaçamento, tipografia, cores, estados vazios, consistência com o design system JÁ EXISTENTE no projeto) e liste os 3 piores problemas.
    3) ANTES de mexer, pergunte via mcp__cardume__ask_human o que priorizar — sempre com OPÇÕES CONCRETAS (nunca "o que você quer mudar?"). Se referência visual ajudar, peça.
    4) Aplique em ITERAÇÕES CURTAS: um ajuste por vez, re-anuncie o preview e pergunte "melhorou? sigo?" com opções.
    5) Só finalize quando eu aprovar explicitamente; ao final, screenshot antes/depois nos artefatos.
    """

    static let skills: [(String, String, String)] = [
        ("design", "refinar o visual comigo — diagnóstico, opções e iterações com preview", designPrompt),
        ("preview", "subir o ambiente e me dar o link ao vivo", "Suba o ambiente local desta branch AGORA (siga o .cardume/RUNBOOK.md) e ANUNCIE \"🌐 preview: <url da tela desta tarefa>\". Mantenha rodando e re-anuncie se trocar de página."),
        ("requisitos", "verificar cada requisito e gerar as provas", "Verifique AGORA cada requisito do TASK.yaml, um a um: diga se está cumprido, linke a evidência real (print e/ou teste) e gere/atualize .cardume/artifacts/requirements.json. Se algum não estiver cumprido, me pergunte via ask_human antes de finalizar."),
        ("testes", "rodar a suíte real e anexar a saída", "Rode os testes REAIS na suíte do projeto pra esta branch (comandos do .cardume/RUNBOOK.md). Salve .cardume/artifacts/tests.md com os comandos e a SAÍDA literal. Falhou algo? Investigue e corrija antes de me responder."),
        ("provas", "provar na UI real com screenshots", "Prove que a entrega funciona NA UI REAL: suba o ambiente (RUNBOOK), execute o fluxo desta tarefa de ponta a ponta e capture screenshots reais em .cardume/artifacts/. Anuncie o 🌐 preview enquanto estiver de pé."),
        ("resumo", "estado atual em 1 minuto de leitura", "Me dê um resumo executivo do estado ATUAL desta tarefa: o que já foi feito (com os arquivos), o que falta, riscos/decisões em aberto. NÃO execute nada novo."),
        ("segurança", "auditar riscos no diff da branch", "Audite o diff desta branch com olhar de segurança: injeção, authz/escopo de tenant, segredos, dados sensíveis em log. Achados por severidade com arquivo:linha e correção proposta — me apresente via ask_human antes de corrigir."),
    ]

    private var skillMatches: [(String, String, String)] {
        guard msg.hasPrefix("/"), !msg.contains(" ") else { return [] }
        let q = msg.dropFirst().folding(options: .diacriticInsensitive, locale: .init(identifier: "pt")).lowercased()
        return Self.skills.filter { q.isEmpty || $0.0.folding(options: .diacriticInsensitive, locale: .init(identifier: "pt")).lowercased().hasPrefix(q) }
    }

    // ---- dados (cursor por id: sem duplicar, sem perder) ----
    private func tick() async {
        async let taskD = try? supa.rest("tasks?select=id,title,status,flag,branch,pr_url,cost_usd,assignee,created_by,updated_at,project_id,spec,requirements_proof&id=eq.\(taskId)")
        async let feedD: Data? = isMine ? (try? await supa.rest("task_feed?select=id,agent,kind,text,at&task_id=eq.\(taskId)&id=gt.\(lastId)&order=id&limit=200")) : nil
        async let questD = try? supa.rest("questions?select=id,agent,prompt,options,created_at&task_id=eq.\(taskId)&status=eq.open&order=created_at.desc&limit=1")
        let wantArts = tab == 1 || proofs.isEmpty || tickN % 5 == 0
        async let artsD: Data? = wantArts ? (try? await supa.rest("artifacts_meta?select=name,kind,storage_path&task_id=eq.\(taskId)&order=created_at.desc&limit=24")) : nil
        if isMine { await loadOutbox() }

        if let d = await taskD, let t = (try? JSONDecoder().decode([CloudTask].self, from: d))?.first {
            task = t
            if t.spec?.previewUrl != nil { requestingTunnel = false }
            if let owner = t.assignee ?? t.createdBy, ownerNames[owner] == nil,
               let pd = try? await supa.rest("profiles?select=user_id,name,email&user_id=eq.\(owner)"),
               let ps = try? JSONSerialization.jsonObject(with: pd) as? [[String: Any]], let p = ps.first {
                ownerNames[owner] = (p["name"] as? String) ?? (p["email"] as? String).map { String($0.split(separator: "@").first ?? "") } ?? "outra pessoa"
            }
        } else if task == nil, let t = hub.tasks.first(where: { $0.id == taskId }) {
            task = t   // sem rede: mostra o que a sincronia já tinha
        }
        if let d = await feedD, let items = try? JSONDecoder().decode([FeedItem].self, from: d) {
            let fresh = items.filter { !feedIds.contains($0.id) }
            if !fresh.isEmpty {
                feed.append(contentsOf: fresh)
                for it in fresh { feedIds.insert(it.id) }
                if feed.count > 500 { let drop = feed.prefix(feed.count - 500); for f in drop { feedIds.remove(f.id) }; feed.removeFirst(drop.count) }
                lastId = max(lastId, fresh.map(\.id).max() ?? lastId)
                for it in fresh {
                    if let r = it.text.range(of: #"🌐 preview:\s*(https?://[^\s]+)"#, options: .regularExpression) {
                        localPreview = String(it.text[r]).replacingOccurrences(of: "🌐 preview:", with: "").trimmingCharacters(in: .whitespaces)
                    }
                }
            }
        }
        if let d = await questD, let qs = try? JSONDecoder().decode([Question].self, from: d) {
            if qs.first != question { question = qs.first }
        }
        if let d = await artsD, let arts = try? JSONDecoder().decode([ArtifactMeta].self, from: d) {
            if arts.map(\.id) != proofs.map(\.id) { proofs = arts }
            for a in arts where a.isImage && thumbs[a.storagePath] == nil {
                if let u = try? await supa.signedUrl(a.storagePath) { thumbs[a.storagePath] = u }
            }
        }
        tickN += 1
        if !ticked { withAnimation(.easeOut(duration: 0.25)) { ticked = true } }
    }

    private func loadOutbox() async {
        guard let me = supa.session?.userId,
              let d = try? await supa.rest("task_messages?select=id,body,delivered_at,created_at&task_id=eq.\(taskId)&author=eq.\(me)&order=id.desc&limit=20"),
              let ms = try? JSONDecoder().decode([OutMsg].self, from: d) else { return }
        let sorted = ms.sorted { $0.id < $1.id }
        if sorted != outbox { outbox = sorted }
    }

    private func send() async {
        let text = msg.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        if let q = question {
            if await hub.answer(q, text) { msg = ""; question = nil }
        } else {
            // "[req]" — o Mac transforma em requisito da checklist
            if await hub.message(taskId, (asReq ? "[req] " : "") + text) { msg = ""; asReq = false; await loadOutbox() }
        }
        sending = false
    }

    private func answerQuestion(_ q: Question, text: String) async {
        answeringQ = true
        if await hub.answer(q, text) { question = nil; msg = "" }
        answeringQ = false
        wake += 1
    }
}

/// requisito com o estado do portão: ✓ com prova · ✓ sem arquivo · ⊘ bloqueado · ○ sem verificação
struct ReqGateRow: View {
    let row: ProofGate.Row
    var onProof: ((String) -> Void)? = nil
    var body: some View {
        let proved = row.st == .ok && !row.evidence.isEmpty
        let (glyph, color, note): (String, Color, String?) = {
            if proved { return ("✓", T.accent, nil) }
            if row.st == .ok { return ("✓", T.warn, "feito, mas sem arquivo de prova") }
            if row.st == .blk { return ("⊘", T.bad, row.note.isEmpty ? "bloqueado" : "bloqueado: \(row.note)") }
            return ("○", T.dim2, nil)
        }()
        HStack(alignment: .top, spacing: 9) {
            Text(glyph).font(.mono(13).bold()).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.text).font(.ui(13.5)).foregroundStyle(proved ? T.text : T.text2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                if let note { Text(note).font(.ui(11)).foregroundStyle(color) }
                if proved, let ev = row.evidence.first {
                    HStack(spacing: 7) {
                        Text(softBreak(ev)).font(.mono(10.5))
                            .foregroundStyle(T.dim).lineLimit(1).truncationMode(.middle)
                        if let onProof {
                            Button("ver prova") { onProof(ev) }
                                .font(.mono(10).bold())
                                .foregroundStyle(T.accent)
                                .fixedSize()
                        }
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}
