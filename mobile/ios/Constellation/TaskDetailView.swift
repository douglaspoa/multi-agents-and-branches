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

    var body: some View {
        VStack(spacing: 0) {
            stepperBar
            if isMine { controlBar }
            previewBar
            if let it = intent {
                IntentPill(label: "o Mac está executando · \(intentLabel(it.kind))")
                    .padding(.horizontal, 14).padding(.vertical, 6)
            } else if let r = intentResult {
                Text("\(r.ok ? "✓" : "✖") \(intentLabel(r.kind)): \(r.msg ?? (r.ok ? "feito" : "falhou"))")
                    .font(.system(size: 11.5)).foregroundStyle(r.ok ? T.accent : T.bad)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 5)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if isMine {
                Picker("", selection: $tab) {
                    Text("Conversa").tag(0)
                    Text("Entrega").tag(1)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 14).padding(.vertical, 7)
                // a barra de entrada vive DENTRO da conversa (safeAreaInset):
                // o teclado empurra a barra, nunca a cobre
                if tab == 0 { conversa } else { entrega }
            } else {
                // demanda de OUTRO membro: acompanhamento — objetivo, entregáveis,
                // requisitos e provas. Chat e comandos são do dono (é o Mac DELE que executa).
                entrega
            }
        }
        .background(T.bg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if isMine {
                        if task?.isLive == true {
                            Button { act("pause") } label: { Label("pausar no Mac", systemImage: "pause") }
                            Button { confirm = .stop } label: { Label("parar o turno", systemImage: "stop") }
                        }
                        if status == "paused" { Button { act("resume") } label: { Label("retomar", systemImage: "play") } }
                        if task?.prUrl == nil && ["review", "delivered"].contains(status) {
                            Button { approve() } label: { Label("aprovar e abrir PR", systemImage: "arrow.triangle.pull") }
                        }
                        if task?.isEnded == false {
                            Button(role: .destructive) { confirm = .abort } label: { Label("abortar a demanda", systemImage: "xmark.octagon") }
                        }
                    }
                    if let pr = task?.prUrl, let u = URL(string: pr) { Link("abrir PR no GitHub ↗", destination: u) }
                } label: { Image(systemName: "ellipsis.circle").foregroundStyle(T.dim) }
                .accessibilityLabel("ações da demanda")
            }
        }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            if confirm == .abort { Button("abortar", role: .destructive) { act("abort") } }
            if confirm == .stop { Button("parar o turno") { act("stop") } }
            if confirm == .merge { Button("fazer o merge (squash)") { act("merge") } }
            Button("cancelar", role: .cancel) {}
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
        .onChange(of: pickedPhoto) { _, item in
            guard let item else { return }
            Task { await sendImage(item); pickedPhoto = nil }
        }
        .onReceive(hub.nudge) { tid in if tid == taskId { wake += 1 } }
        .onAppear { hub.joinFeed(taskId) }
        .onDisappear { hub.leaveFeed(taskId) }
        .task {
            #if DEBUG
            if ProcessInfo.processInfo.environment["DEMO_DETAIL_TAB"] == "1" { tab = 1 }
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

    // ---- topo: stepper de 5 fases + provados ----
    private var stepperBar: some View {
        VStack(spacing: 8) {
            if let t = task {
                PhaseStepper(phase: t.phase, proved: t.reqsProved)
            } else {
                PhaseBar(phase: 1).opacity(0.4)
            }
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 4)
        .background(T.panel2)
    }

    /// estado + custo + controles do agente À VISTA (antes escondidos no ⋯)
    @ViewBuilder private var controlBar: some View {
        if let t = task {
            let st = T.status(t.status, flag: t.flag)
            VStack(spacing: 6) {
                HStack(spacing: 8) {
                    Circle().fill(st.1).frame(width: 7, height: 7)
                    Text(st.0).font(.mono(11.5, .medium)).foregroundStyle(st.1)
                    if let c = fmtUsd(t.costUsd) {
                        Text("· \(c)\(t.spec?.budgetUsd.map { String(format: " de $%.0f", $0) } ?? "")").font(.mono(11)).foregroundStyle(T.dim)
                    }
                    Spacer()
                    if intent == nil {
                        if t.isLive {
                            ctl("pause", "pausar") { act("pause") }
                            ctl("stop.fill", "parar", color: T.bad) { confirm = .stop }
                        } else if t.status == "paused" && question?.isTeto != true {
                            ctl("play.fill", "retomar", color: T.accent) { act("resume") }
                        }
                    }
                }
                ReachNote(reach: reach)
            }
            .padding(.horizontal, 14).padding(.vertical, 7)
            .background(T.panel2)
        }
    }

    private func ctl(_ icon: String, _ label: String, color: Color = T.text2, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 10, weight: .bold))
                Text(label).font(.mono(11, .semibold))
            }
            .foregroundStyle(color).padding(.horizontal, 10).frame(height: 30)
            .overlay(Capsule().stroke(color.opacity(0.45)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label + " o agente")
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
                LazyVStack(alignment: .leading, spacing: 10) {
                    if feed.isEmpty && !ticked { FeedSkeleton().padding(.top, 12) }
                    else if feed.isEmpty {
                        emptyFeed.padding(.top, 30).frame(maxWidth: .infinity)
                    }
                    ForEach(rows) { row in rowView(row).id(row.id) }
                    // mensagens do celular que o Mac ainda não entregou ao agente (antes sumiam até ele ecoar)
                    ForEach(outbox.filter { $0.deliveredAt == nil }) { m in pendingBubble(m) }
                    Color.clear.frame(height: 1).id("fim")
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            // barra SEMPRE visível: safeAreaInset acompanha o teclado
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    if let q = question { questionBar(q) }
                    inputBar
                }
                .background(.bar)
            }
            .onChange(of: feed.count + outbox.count) { _, _ in
                // rola SÓ quando chega linha realmente nova — sem dançar a cada leitura
                let last = (rows.last?.id ?? 0) + outbox.count * 1_000_000
                guard last != lastScrolled else { return }
                lastScrolled = last
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("fim", anchor: .bottom) }
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
                Text(m.shown).font(.system(size: 13.5)).foregroundStyle(T.text)
                    .padding(.horizontal, 13).padding(.vertical, 9)
                    .background(T.accent2.opacity(0.25))
                    .overlay(RoundedRectangle(cornerRadius: 13).strokeBorder(T.accent.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                    .clipShape(RoundedRectangle(cornerRadius: 13))
                HStack(spacing: 4) {
                    Image(systemName: "clock").font(.system(size: 9))
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
                        .font(.system(size: 13.5)).foregroundStyle(T.onAccent)
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
                        Text(f.agent.uppercased()).font(.system(size: 10, design: .monospaced).bold())
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
                                    .font(.system(size: 11, design: .monospaced).bold())
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
                        Text(open ? "▾" : "▸").font(.system(size: 10, design: .monospaced))
                        Text("\(fs.count) passo\(fs.count == 1 ? "" : "s") técnico\(fs.count == 1 ? "" : "s")")
                            .font(.system(size: 11, design: .monospaced))
                        if !open, let l = fs.last { Text("· " + l.text).font(.mono(10.5)).lineLimit(1).truncationMode(.tail) }
                    }.foregroundStyle(T.dim2).frame(minHeight: 28)
                }
                if open {
                    ForEach(fs) { f in
                        HStack(alignment: .top, spacing: 7) {
                            let g = feedGlyph(f.kind)
                            Text(g.0).font(.system(size: 11, design: .monospaced)).foregroundStyle(g.1)
                            Text(f.text).font(.system(size: 11.5, design: .monospaced))
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

    // ---- entrega (telas 03–04): requisitos, provas, PR ----
    private var entrega: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 18) {
                if let t = task {
                    if !isMine {
                        HStack(spacing: 7) {
                            Image(systemName: "eye").font(.system(size: 11)).foregroundStyle(T.dim)
                            Text("acompanhando a demanda de \(ownerName) — só leitura")
                                .font(.system(size: 11.5)).foregroundStyle(T.dim)
                        }
                    }
                    if let obj = t.spec?.objective, !obj.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            kicker("OBJETIVO", T.accent)
                            mdText(obj, size: 13.5, color: T.text2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let dels = t.spec?.deliverables, !dels.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            kicker("ENTREGÁVEIS", T.accent, count: dels.count)
                            ForEach(Array(dels.enumerated()), id: \.offset) { _, d in
                                HStack(alignment: .top, spacing: 7) {
                                    Text("◆").font(.system(size: 10)).foregroundStyle(T.accent).padding(.top, 3)
                                    Text(d).font(.system(size: 13)).foregroundStyle(T.text2)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
                    if let rev = t.spec?.review, let s = rev.summary, !s.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            kicker("O QUE FOI FEITO", T.accent)
                            mdText(s, size: 13.5, color: T.text2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let st = t.spec?.stat, (st.files ?? 0) > 0 || (st.add ?? 0) > 0 || (st.commits ?? 0) > 0 {
                        HStack(spacing: 14) {
                            if let f = st.files { statV("\(f)", "arquivos") }
                            if let a = st.add { statV("+\(a)", "linhas").foregroundStyle(T.accent) }
                            if let d = st.del { statV("−\(d)", "").foregroundStyle(T.bad) }
                            if let c = st.commits { statV("\(c)", "commits") }
                            if let c = fmtUsd(t.costUsd) { statV(c, "custo") }
                            Spacer()
                        }
                    }
                    if let reqs = t.spec?.requirements, !reqs.isEmpty {
                        let rws = ProofGate.rows(reqs, t.requirementsProof?.list)
                        VStack(alignment: .leading, spacing: 2) {
                            kicker("REQUISITOS COM PROVA", T.accent, count: reqs.count)
                            ForEach(Array(rws.enumerated()), id: \.offset) { _, r in
                                ReqGateRow(row: r) { ev in openProof(named: ev) }
                            }
                        }
                    }
                    if let how = t.spec?.review?.howToTest, !how.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            kicker("COMO TESTAR", T.accent)
                            Text(softBreak(how)).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(T.text2)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                .background(T.accent.opacity(0.05))
                                .overlay(Rectangle().fill(T.accent.opacity(0.5)).frame(width: 2), alignment: .leading)
                        }
                    }
                    if !proofs.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            kicker("GALERIA DE PROVAS", T.accent, count: proofs.count)
                            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 9) {
                                ForEach(proofs) { a in
                                    Button { openProof(a) } label: { ProofThumb(a: a, url: thumbs[a.storagePath]) }.buttonStyle(.plain)
                                        .accessibilityLabel((a.isVideo ? "vídeo " : a.isImage ? "imagem " : "arquivo ") + a.name)
                                }
                            }
                        }
                    }
                    if let pr = t.spec?.prInfo, t.prUrl != nil { prSection(t, pr) }
                    if ["review", "delivered"].contains(t.status), t.prUrl == nil, isMine { decision(t) }
                    let nothing = (t.spec?.requirements?.isEmpty ?? true) && proofs.isEmpty && (t.spec?.review?.summary?.isEmpty ?? true)
                    if nothing {
                        VStack(spacing: 8) {
                            Image(systemName: "hourglass").font(.title2).foregroundStyle(T.dim)
                            Text(["review", "delivered", "merged", "done"].contains(t.status)
                                 ? "sem provas publicadas ainda"
                                 : "em execução — requisitos e provas aparecem conforme o agente avança")
                                .font(.footnote).foregroundStyle(T.dim)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity).padding(.top, 40)
                    }
                } else { BoardSkeleton() }
            }
            .padding(16).padding(.bottom, 40)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// rodapé de decisão (fase 4) com o PORTÃO DE PROVA — mesma regra do desktop (PR #100)
    @ViewBuilder private func decision(_ t: CloudTask) -> some View {
        let gate = ProofGate.gate(t)
        let nonCode = ["design", "invest"].contains(t.kind)
        VStack(spacing: 9) {
            if let it = intent, ["openPr", "askProof"].contains(it.kind) { IntentPill(label: "o Mac está executando · \(intentLabel(it.kind))") }
            else if nonCode {
                Text("esta demanda entrega documentos, não código — o fim é salvar os entregáveis no Mac")
                    .font(.system(size: 12)).foregroundStyle(T.dim).multilineTextAlignment(.center)
            } else if case .unproven(let miss) = gate {
                Text("\(miss.count) requisito\(miss.count == 1 ? "" : "s") sem prova — prova antes de promessa")
                    .font(.system(size: 12.5, weight: .medium)).foregroundStyle(T.warn)
                BigButton(label: "pedir a prova ao agente") { act("askProof") }
                OutlineButton(label: "aprovar sem prova…", full: true, color: T.warn, stroke: T.warn.opacity(0.45)) { showNoProof = true }
            } else {
                BigButton(label: "aprovar e abrir PR") { act("openPr") }
            }
            Button { showAdjust = true } label: {
                Text("pedir ajuste").font(.system(size: 13.5, weight: .semibold))
                    .frame(maxWidth: .infinity).frame(height: 46)
                    .background(T.panel).foregroundStyle(T.text)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(T.lineHard))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }.padding(.top, 4)
    }

    private func approve() {
        guard let t = task else { return }
        if case .unproven = ProofGate.gate(t) { tab = 1; showNoProof = true } else { act("openPr") }
    }

    private func statV(_ v: String, _ l: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(v).font(.system(size: 15, design: .monospaced).bold())
            if !l.isEmpty { Text(l).font(.system(size: 9, design: .monospaced)).foregroundStyle(T.dim) }
        }
    }

    @ViewBuilder private func prSection(_ t: CloudTask, _ pr: TaskSpec.PrInfo) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            kicker("PR \(pr.number.map { "#\($0)" } ?? "")", T.info)
            if let b = pr.body, !b.isEmpty {
                Text(b).font(.system(size: 12.5)).foregroundStyle(T.text2).lineLimit(14)
                    .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(pr.comments ?? []) { c in
                let done = c.answered ?? false
                let skipped = ignoredComments.contains(c.listId)
                VStack(alignment: .leading, spacing: 7) {
                    HStack(spacing: 7) {
                        Text(c.author ?? "").font(.system(size: 11, design: .monospaced).bold()).foregroundStyle(T.text)
                        if c.isBot == true { Text("bot").font(.system(size: 8.5, design: .monospaced)).padding(.horizontal, 4).background(T.info.opacity(0.2)).foregroundStyle(T.info).clipShape(Capsule()) }
                        if let p = c.path { Text(softBreak("\(p)\(c.line.map { ":\($0)" } ?? "")")).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(T.dim).lineLimit(1).truncationMode(.middle) }
                        Spacer()
                        if done { Text("✔ respondido").font(.system(size: 9.5, design: .monospaced)).foregroundStyle(T.accent) }
                        else if skipped { Text("ignorado").font(.system(size: 9.5, design: .monospaced)).foregroundStyle(T.dim2) }
                    }
                    Text(c.body ?? "").font(.system(size: 12.5)).foregroundStyle(done || skipped ? T.dim : T.text2)
                        .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    if !done && !skipped && isMine {
                        if intent?.kind == "fixComment" { IntentPill(label: "o Mac está executando · aplicar correção") }
                        else {
                            HStack(spacing: 8) {
                                Button { act("fixComment", extra: ["commentId": c.id ?? 0]) } label: {
                                    Text("aplicar correção").font(.system(size: 12, weight: .bold))
                                        .padding(.horizontal, 13).frame(height: 38)
                                        .background(T.accent).foregroundStyle(T.onAccent).clipShape(Capsule())
                                }
                                Button { ignoredComments.insert(c.listId) } label: {
                                    Text("ignorar").font(.system(size: 12))
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
                else { BigButton(label: "⌥ Merge PR") { confirm = .merge } }
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

    // ---- pergunta inline (e o TETO de custo) + input ----
    @State private var qExpanded = false
    @State private var answeringQ = false
    @ViewBuilder private func questionBar(_ q: Question) -> some View {
        let teto = q.isTeto
        let color = teto ? T.bad : T.warn
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(teto ? "⏸ teto de custo atingido" : "❓ \(q.agent.isEmpty ? "agente" : q.agent) pergunta").font(.caption.bold()).foregroundStyle(color)
                Spacer()
                if q.prompt.count > 160 {
                    Button { qExpanded.toggle() } label: {
                        Text(qExpanded ? "recolher ▲" : "ler tudo ▼").font(.system(size: 10.5, design: .monospaced).bold()).foregroundStyle(color)
                    }
                }
            }
            // prompt cresce até um teto e ROLA — nunca toma a tela inteira
            ScrollView(.vertical) {
                mdText(q.prompt, size: 13, color: T.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxHeight: qExpanded ? 320 : 96)
            if answeringQ { IntentPill(label: "enviando a resposta…") }
            else if !q.options.isEmpty {
                ForEach(q.options, id: \.self) { opt in
                    Button { Task { await answerQuestion(q, text: opt) } } label: {
                        Text(opt).font(.system(size: 13, weight: .semibold))
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).frame(minHeight: 42)
                            .background(color.opacity(0.12)).foregroundStyle(color)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                    }
                }
            }
            if !teto { Text("ou responda no campo abaixo ↓").font(.caption2).foregroundStyle(T.dim) }
        }
        .padding(12)
        .background(color.opacity(0.07))
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

    private var inputBar: some View {
        VStack(spacing: 0) {
            if !skillMatches.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(skillMatches, id: \.0) { s in
                        Button {
                            msg = ""
                            Task { if await hub.message(taskId, s.2) { await loadOutbox() } }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("/" + s.0).font(.system(.footnote, design: .monospaced).bold()).foregroundStyle(T.accent)
                                Text(s.1).font(.caption2).foregroundStyle(T.dim)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                        }
                        Divider().overlay(T.line)
                    }
                }
                .background(T.panel)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.line))
                .padding(.horizontal, 10).padding(.bottom, 6)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button { msg = msg.hasPrefix("/") ? "" : "/" } label: {
                    Text("/").font(.system(.body, design: .monospaced).bold())
                        .frame(width: 36, height: 36)
                        .background(msg.hasPrefix("/") ? T.accent : T.panel)
                        .foregroundStyle(msg.hasPrefix("/") ? .black : T.accent)
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.line))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }.accessibilityLabel("skills")
                PhotosPicker(selection: $pickedPhoto, matching: .images) {
                    Group {
                        if uploadingImg { ProgressView().tint(T.accent) }
                        else { Image(systemName: "photo").font(.body).foregroundStyle(T.accent) }
                    }
                    .frame(width: 36, height: 36)
                    .background(T.panel)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.line))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .disabled(uploadingImg)
                .accessibilityLabel("anexar imagem")
                TextField(question != nil ? (question?.isTeto == true ? "ou escreva: continuar / parar" : "responda a pergunta…") : "peça um ajuste… ( / skills )", text: $msg, axis: .vertical)
                    .font(.footnote)
                    .lineLimit(1...4)
                    .padding(10)
                    .background(T.panel)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.line))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                MicButton(text: $msg)
                Button { Task { await send() } } label: {
                    Group {
                        if sending { ProgressView().tint(.black) }
                        else { Image(systemName: "paperplane.fill").font(.body) }
                    }
                    .frame(width: 40, height: 36)
                    .background(msg.trimmingCharacters(in: .whitespaces).isEmpty ? T.panel : T.accent)
                    .foregroundStyle(msg.trimmingCharacters(in: .whitespaces).isEmpty ? T.dim : .black)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .disabled(sending || msg.trimmingCharacters(in: .whitespaces).isEmpty || msg.hasPrefix("/"))
                .accessibilityLabel("enviar")
            }
            .padding(.horizontal, 12).padding(.top, 10)
            if !msg.trimmingCharacters(in: .whitespaces).isEmpty && question == nil {
                Toggle(isOn: $asReq) {
                    Text("virar requisito da tarefa").font(.caption2).foregroundStyle(T.dim)
                }
                .toggleStyle(.switch).tint(T.accent).controlSize(.mini)
                .padding(.horizontal, 14).padding(.top, 6)
            }
        }
        .padding(.bottom, 6)
        .background(T.bg)
        .overlay(Rectangle().fill(T.line).frame(height: 0.5), alignment: .top)
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
            Text(glyph).font(.system(size: 13, design: .monospaced).bold()).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.text).font(.system(size: 13.5)).foregroundStyle(proved ? T.text : T.text2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                if let note { Text(note).font(.system(size: 11)).foregroundStyle(color) }
                if proved, let ev = row.evidence.first {
                    HStack(spacing: 7) {
                        Text(softBreak(ev)).font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(T.dim).lineLimit(1).truncationMode(.middle)
                        if let onProof {
                            Button("ver prova") { onProof(ev) }
                                .font(.system(size: 10, design: .monospaced).bold())
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
