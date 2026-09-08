import SwiftUI
import PhotosUI

/// Telas 02–04 do escopo: Execução (conversa ao vivo) · Entrega (revisão) · PR.
struct TaskDetailView: View {
    @EnvironmentObject var supa: Supa
    let taskId: String
    let title: String

    struct FeedItem: Identifiable, Decodable {
        let id: Int
        let agent: String
        let kind: String
        let text: String
        let at: String
    }

    @State private var task: CloudTask? = nil
    @State private var feed: [FeedItem] = []
    @State private var lastId = 0
    @State private var msg = ""
    @State private var asReq = false
    @State private var sending = false
    @State private var question: Question? = nil
    @State private var error = ""
    @State private var pickedPhoto: PhotosPickerItem? = nil
    @State private var uploadingImg = false
    @State private var expandedMsgs: Set<Int> = []
    @State private var tickN = 0
    @State private var ownerNames: [String: String] = [:]

    /// Demanda MINHA? (dono = assignee, senão quem criou). Enquanto não carrega,
    /// assume minha só pra não piscar — o corpo re-renderiza quando chega.
    private var isMine: Bool {
        guard let t = task else { return true }
        let me = supa.session?.userId ?? ""
        let owner = t.assignee ?? t.createdBy
        return owner == nil || owner == me
    }
    private var ownerName: String {
        guard let t = task, let id = t.assignee ?? t.createdBy else { return "outra pessoa" }
        return (ownerNames[id] ?? "outra pessoa")
    }
    @State private var ticked = false
    @State private var localPreview: String? = nil
    @State private var requestingTunnel = false
    @State private var tab = 0                 // 0 conversa · 1 entrega
    @State private var techOpen: Set<Int> = [] // blocos técnicos expandidos
    @State private var proofs: [ArtifactMeta] = []
    @State private var proofUrl: URL? = nil
    @State private var ignoredComments: Set<String> = []

    private var status: String { task?.status ?? "" }
    private var previewUrl: String? { task?.spec?.previewUrl }
    private var intent: TaskSpec.Intent? { task?.spec?.intent }
    private var intentResult: TaskSpec.IntentResult? { task?.spec?.intentResult }

    var body: some View {
        VStack(spacing: 0) {
            stepperBar
            previewBar
            if let it = intent {
                IntentPill(label: "o Mac está executando · \(intentLabel(it.kind))")
                    .padding(.horizontal, 14).padding(.vertical, 6)
            } else if let r = intentResult, !r.ok {
                Text("✖ \(intentLabel(r.kind)): \(r.msg ?? "falhou")")
                    .font(.system(size: 11.5)).foregroundStyle(T.bad)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 5)
            }
            if isMine {
                Picker("", selection: $tab) {
                    Text("Conversa").tag(0)
                    Text("Requisitos · Provas").tag(1)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 14).padding(.vertical, 7)
                // a barra de entrada vive DENTRO da conversa (safeAreaInset):
                // o teclado empurra a barra, nunca a cobre
                if tab == 0 { conversa } else { entrega }
            } else {
                // demanda de OUTRO membro: acompanhamento — objetivo, entregáveis,
                // requisitos e provas (o aviso 'só leitura' vive no topo do entrega).
                // Chat e comandos são do dono (é o Mac DELE que executa).
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
                        if ["running", "thinking", "queued"].contains(status) {
                            Button("❙❙ pausar no Mac") { sendIntent("pause") }
                            Button("✖ abortar", role: .destructive) { sendIntent("abort") }
                        }
                        if task?.prUrl == nil && status != "draft" {
                            Button("⇱ abrir PR") { sendIntent("openPr") }
                        }
                    }
                    if let pr = task?.prUrl, let u = URL(string: pr) { Link("abrir PR no GitHub ↗", destination: u) }
                } label: { Image(systemName: "ellipsis.circle").foregroundStyle(T.dim) }
            }
        }
        .sheet(item: $proofUrl) { url in ProofSheet(url: url) }
        .onChange(of: pickedPhoto) { _, item in
            guard let item else { return }
            Task { await sendImage(item); pickedPhoto = nil }
        }
        .task {
            #if DEBUG
            if ProcessInfo.processInfo.environment["DEMO_DETAIL_TAB"] == "1" { tab = 1 }
            #endif
            // enquanto ativa, atualiza rápido (chat ao vivo); parada, alivia
            while !Task.isCancelled {
                await tick()
                let live = ["running", "thinking", "queued", "requested", "plan-review"].contains(status)
                try? await Task.sleep(for: .seconds(live ? 1.5 : 4))
            }
        }
    }

    // ---- topo: stepper de 5 fases + % + provados ----
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
            // resposta do humano vira bolha SUA
            if f.text.hasPrefix("humano respondeu:") {
                flush()
                out.append(.talk(FeedItem(id: f.id, agent: f.agent, kind: f.kind,
                                          text: "💬 " + f.text.replacingOccurrences(of: "humano respondeu: ", with: ""), at: f.at)))
                continue
            }
            // fala do agente = think/note/done/error com texto de gente (o Mac publica
            // o pensamento como kind "think" — é ELE a mensagem principal da conversa)
            let isTalk = ["think", "note", "done", "error"].contains(f.kind) && f.text.count > 40 && !f.text.hasPrefix("$")
            let isYou = f.text.hasPrefix("💬")
            if isTalk || isYou {
                // o 'done' costuma repetir o último 'note' — não mostra a bolha 2x
                if !isYou {
                    let key = String(f.text.prefix(120))
                    if key == lastTalk { bucket.append(f); continue }
                    lastTalk = key
                }
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
                        Text(status == "requested" ? "esperando o Mac assumir (~6s) — ele precisa estar ligado, acordado e com o Constellation aberto" : "esperando o agente… os passos aparecem aqui ao vivo")
                            .font(.footnote).foregroundStyle(T.dim).padding(.top, 30).frame(maxWidth: .infinity)
                    }
                    ForEach(rows) { row in rowView(row).id(row.id) }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            // barra SEMPRE visível: safeAreaInset acompanha o teclado — era o bug
            // de "a caixa some e fica só o teclado por cima de tudo"
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    if let q = question { questionBar(q) }
                    inputBar
                }
                .background(.bar)
            }
            .onChange(of: feed.count) { _, _ in
                // rola SÓ quando chega linha realmente nova — sem dançar a cada poll
                guard let last = rows.last, last.id != lastScrolled else { return }
                lastScrolled = last.id
                proxy.scrollTo(last.id, anchor: .bottom)
            }
        }
    }

    @ViewBuilder private func rowView(_ row: Row) -> some View {
        switch row {
        case .talk(let f):
            if f.text.hasPrefix("💬") {
                // sua mensagem
                HStack {
                    Spacer(minLength: 40)
                    Text(f.text.replacingOccurrences(of: "💬 ", with: ""))
                        .font(.system(size: 13.5)).foregroundStyle(T.onAccent)
                        .padding(.horizontal, 13).padding(.vertical, 9)
                        .background(T.accent2).clipShape(RoundedRectangle(cornerRadius: 13))
                }
            } else {
                // mensagem longa do agente: mostra o começo e "ver mais" — antes
                // um raciocínio inteiro tomava a tela e escondia a conclusão
                let long = f.text.count > 260
                let expanded = expandedMsgs.contains(f.id)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 7) {
                        Av(name: f.agent, size: 18)
                        Text(f.agent.uppercased()).font(.system(size: 10, design: .monospaced).bold())
                            .foregroundStyle(f.kind == "error" ? T.bad : T.dim)
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
                    }.foregroundStyle(T.dim2)
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
            .frame(maxWidth: .infinity, alignment: .leading) // trava a largura — sem isso, token longo empurra a tela pro lado
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
                    // OBJETIVO — sempre visível (o "sobre o que é" da demanda)
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
                        VStack(alignment: .leading, spacing: 2) {
                            kicker("REQUISITOS COM EVIDÊNCIA", T.accent, count: reqs.count)
                            ForEach(Array(reqs.enumerated()), id: \.offset) { _, r in
                                ReqRow(text: r, proof: matchProof(r)) { ev in openProof(named: ev) }
                            }
                        }
                    }
                    if let how = t.spec?.review?.howToTest, !how.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            kicker("COMO TESTAR", T.accent)
                            Text(how).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(T.text2)
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
                                    Button { openProof(a) } label: {
                                        VStack(spacing: 4) {
                                            Text(a.kind == "image" ? "🖼" : "📄").font(.system(size: 22))
                                            Text(a.name).font(.system(size: 9.5, design: .monospaced))
                                                .foregroundStyle(T.dim).lineLimit(1)
                                        }
                                        .frame(maxWidth: .infinity).frame(height: 74)
                                        .background(T.panel)
                                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.line))
                                        .clipShape(RoundedRectangle(cornerRadius: 10))
                                    }
                                }
                            }
                        }
                    }
                    if let pr = t.spec?.prInfo, t.prUrl != nil { prSection(t, pr) }
                    // rodapé de decisão (fase 4)
                    if ["review", "delivered"].contains(t.status), t.prUrl == nil, isMine {
                        VStack(spacing: 9) {
                            if intent?.kind == "openPr" { IntentPill(label: "o Mac está executando · abrir PR") }
                            else {
                                BigButton(label: "aprovar e abrir PR") { sendIntent("openPr") }
                                Button { tab = 0; msg = "" } label: {
                                    Text("pedir ajuste").font(.system(size: 13.5, weight: .semibold))
                                        .frame(maxWidth: .infinity).frame(height: 46)
                                        .background(T.panel).foregroundStyle(T.text)
                                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(T.lineHard))
                                        .clipShape(RoundedRectangle(cornerRadius: 12))
                                }
                            }
                        }.padding(.top, 4)
                    }
                    // nada entregue ainda? não deixa a tela vazia
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
            }
            ForEach(pr.comments ?? []) { c in
                let done = c.answered ?? false
                let skipped = ignoredComments.contains(c.listId)
                VStack(alignment: .leading, spacing: 7) {
                    HStack(spacing: 7) {
                        Text(c.author ?? "").font(.system(size: 11, design: .monospaced).bold()).foregroundStyle(T.text)
                        if c.isBot == true { Text("bot").font(.system(size: 8.5, design: .monospaced)).padding(.horizontal, 4).background(T.info.opacity(0.2)).foregroundStyle(T.info).clipShape(Capsule()) }
                        if let p = c.path { Text("\(p)\(c.line.map { ":\($0)" } ?? "")").font(.system(size: 9.5, design: .monospaced)).foregroundStyle(T.dim).lineLimit(1) }
                        Spacer()
                        if done { Text("✔ respondido").font(.system(size: 9.5, design: .monospaced)).foregroundStyle(T.accent) }
                        else if skipped { Text("ignorado").font(.system(size: 9.5, design: .monospaced)).foregroundStyle(T.dim2) }
                    }
                    Text(c.body ?? "").font(.system(size: 12.5)).foregroundStyle(done || skipped ? T.dim : T.text2)
                    if !done && !skipped {
                        if intent?.kind == "fixComment" { IntentPill(label: "o Mac está executando · aplicar correção") }
                        else {
                            HStack(spacing: 8) {
                                Button { sendIntent("fixComment", extra: ["commentId": c.id ?? 0]) } label: {
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
            if intent?.kind == "merge" { IntentPill(label: "o Mac está executando · merge") }
            else { BigButton(label: "⌥ Merge PR") { sendIntent("merge") } }
        }
    }

    private func matchProof(_ req: String) -> ReqProof? {
        let norm = { (s: String) in s.folding(options: .diacriticInsensitive, locale: nil).lowercased() }
        return task?.requirementsProof?.items.first { p in
            guard let r = p.req else { return false }
            return norm(r) == norm(req) || norm(r).contains(norm(String(req.prefix(30)))) || norm(req).contains(norm(String(r.prefix(30))))
        }
    }
    private func openProof(named ev: String) {
        let name = ev.components(separatedBy: "·").last?.trimmingCharacters(in: .whitespaces) ?? ev
        if let a = proofs.first(where: { $0.name.contains(name) || name.contains($0.name) }) { openProof(a) }
    }
    private func openProof(_ a: ArtifactMeta) {
        Task { if let u = try? await supa.signedUrl(a.storagePath) { await MainActor.run { proofUrl = u } } }
    }

    private func intentLabel(_ k: String) -> String {
        switch k {
        case "openPr": return "abrir PR"
        case "merge": return "merge"
        case "pause": return "pausar"
        case "abort": return "abortar"
        case "fixComment": return "aplicar correção"
        default: return k
        }
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
            _ = try await supa.rest("task_messages", method: "POST", json: [
                "task_id": taskId, "author": supa.session?.userId ?? "",
                "body": "[img] \(path)" + (caption.isEmpty ? "" : " | \(caption)"),
            ])
            msg = ""
            await tick()
        } catch { self.error = error.localizedDescription }
    }

    private func sendIntent(_ kind: String, extra: [String: Any] = [:]) {
        Task { try? await supa.sendIntent(taskId: taskId, kind: kind, extra: extra); await tick() }
    }

    // ---- barra do preview (inalterada na essência) ----
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
                }
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

    private func requestTunnelClose() async {
        if let d = try? await supa.rest("tasks?select=spec&id=eq.\(taskId)"),
           let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]],
           var spec = arr.first?["spec"] as? [String: Any] {
            spec["tunnelClose"] = ISO8601DateFormatter().string(from: Date())
            spec["previewUrl"] = nil
            _ = try? await supa.rest("tasks?id=eq.\(taskId)", method: "PATCH", json: ["spec": spec])
        }
        await tick()
    }
    private func requestTunnel() async {
        requestingTunnel = true
        if let d = try? await supa.rest("tasks?select=spec&id=eq.\(taskId)"),
           let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]],
           var spec = arr.first?["spec"] as? [String: Any] {
            spec["tunnelWanted"] = ISO8601DateFormatter().string(from: Date())
            _ = try? await supa.rest("tasks?id=eq.\(taskId)", method: "PATCH", json: ["spec": spec])
        }
        Task { try? await Task.sleep(for: .seconds(45)); await MainActor.run { requestingTunnel = false } }
    }

    // ---- pergunta inline + input (mantidos) ----
    @State private var qExpanded = false
    @ViewBuilder private func questionBar(_ q: Question) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("❓ \(q.agent.isEmpty ? "agente" : q.agent) pergunta").font(.caption.bold()).foregroundStyle(T.warn)
                Spacer()
                if q.prompt.count > 160 {
                    Button { qExpanded.toggle() } label: {
                        Text(qExpanded ? "recolher ▲" : "ler tudo ▼").font(.system(size: 10.5, design: .monospaced).bold()).foregroundStyle(T.warn)
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
            if !q.options.isEmpty {
                ForEach(q.options, id: \.self) { opt in
                    Button { Task { await answerQuestion(q, text: opt) } } label: {
                        Text(opt).font(.system(size: 13, weight: .semibold))
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).frame(height: 42)
                            .background(T.warn.opacity(0.12)).foregroundStyle(T.warn)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                    }
                }
            }
            Text("ou responda no campo abaixo ↓").font(.caption2).foregroundStyle(T.dim)
        }
        .padding(12)
        .background(T.warn.opacity(0.07))
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
                            Task { _ = try? await supa.rest("task_messages", method: "POST", json: ["task_id": taskId, "author": supa.session?.userId ?? "", "body": s.2]) }
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
                }
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
                TextField(question != nil ? "responda a pergunta…" : "peça um ajuste… ( / skills )", text: $msg, axis: .vertical)
                    .font(.footnote)
                    .lineLimit(1...4) // cresce até 4 linhas e vira scroll — nunca engole a tela
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
            }
            .padding(.horizontal, 12).padding(.top, 10)
            // toggle só aparece quando você está escrevendo um ajuste (não numa
            // resposta de pergunta) — antes ficava fixo, amontoando a barra
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

    // ---- dados ----
    private func tick() async {
        // as queries são independentes → dispara em PARALELO (era 4 em série,
        // por isso o chat 'demorava' a mostrar a última mensagem)
        async let taskD = try? supa.rest("tasks?select=id,title,status,flag,branch,pr_url,cost_usd,assignee,created_by,updated_at,spec,requirements_proof&id=eq.\(taskId)")
        async let feedD: Data? = isMine ? (try? await supa.rest("task_feed?select=id,agent,kind,text,at&task_id=eq.\(taskId)&id=gt.\(lastId)&order=id&limit=120")) : nil
        async let questD = try? supa.rest("questions?select=id,agent,prompt,options,created_at&task_id=eq.\(taskId)&status=eq.open&order=id.desc&limit=1")
        // artefatos mudam devagar — só a cada ~5 ticks (ou na aba de provas)
        let wantArts = tab == 1 || proofs.isEmpty || tickN % 5 == 0
        async let artsD: Data? = wantArts ? (try? await supa.rest("artifacts_meta?select=name,kind,storage_path&task_id=eq.\(taskId)&order=created_at.desc&limit=16")) : nil

        if let d = await taskD, let t = (try? JSONDecoder().decode([CloudTask].self, from: d))?.first {
            await MainActor.run { task = t; if t.spec?.previewUrl != nil { requestingTunnel = false } }
            // nome do dono (pra 'acompanhando a demanda de X') — uma vez só
            if let owner = t.assignee ?? t.createdBy, ownerNames[owner] == nil,
               let pd = try? await supa.rest("profiles?select=user_id,name,email&user_id=eq.\(owner)"),
               let ps = try? JSONSerialization.jsonObject(with: pd) as? [[String: Any]], let p = ps.first {
                let nm = (p["name"] as? String) ?? (p["email"] as? String).map { String($0.split(separator: "@").first ?? "") } ?? "outra pessoa"
                await MainActor.run { ownerNames[owner] = nm }
            }
        }
        if let d = await feedD, let items = try? JSONDecoder().decode([FeedItem].self, from: d), !items.isEmpty {
            await MainActor.run {
                feed.append(contentsOf: items)
                if feed.count > 400 { feed.removeFirst(feed.count - 400) }
                lastId = items.last!.id
                for it in items {
                    if let r = it.text.range(of: #"🌐 preview:\s*(https?://[^\s]+)"#, options: .regularExpression) {
                        localPreview = String(it.text[r]).replacingOccurrences(of: "🌐 preview:", with: "").trimmingCharacters(in: .whitespaces)
                    }
                }
            }
        }
        if let d = await questD, let qs = try? JSONDecoder().decode([Question].self, from: d) {
            await MainActor.run { question = qs.first }
        }
        if let d = await artsD, let arts = try? JSONDecoder().decode([ArtifactMeta].self, from: d) {
            await MainActor.run { proofs = arts }
        }
        await MainActor.run { tickN += 1; if !ticked { withAnimation(.easeOut(duration: 0.25)) { ticked = true } } }
    }

    private func send() async {
        let text = msg.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        do {
            if let q = question {
                await answerQuestion(q, text: text)
            } else {
                // "[req]" — o Mac transforma em requisito da checklist
                let body = (asReq ? "[req] " : "") + text
                _ = try await supa.rest("task_messages", method: "POST", json: ["task_id": taskId, "author": supa.session?.userId ?? "", "body": body])
            }
            await MainActor.run { msg = ""; asReq = false }
        } catch { self.error = error.localizedDescription }
        sending = false
    }

    private func answerQuestion(_ q: Question, text: String) async {
        _ = try? await supa.rest("questions?id=eq.\(q.id)", method: "PATCH", json: [
            "status": "answered", "answer": text,
            "answered_by": supa.session?.userId ?? "",
            "answered_at": ISO8601DateFormatter().string(from: Date()),
        ])
        await MainActor.run { question = nil; msg = "" }
    }
}

/// visualizador de prova (imagem/doc via URL assinada)
struct ProofSheet: View {
    let url: URL
    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img): img.resizable().scaledToFit()
                    case .failure: Link("abrir no navegador ↗", destination: url).padding(30)
                    default: ProgressView().tint(T.accent).padding(60)
                    }
                }
            }
            .background(T.bg)
            .navigationTitle("Prova")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

extension URL: @retroactive Identifiable { public var id: String { absoluteString } }
