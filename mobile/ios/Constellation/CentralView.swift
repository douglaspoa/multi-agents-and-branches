import SwiftUI

/// Tela 01 — Central: a fila na ordem em que ela te cobra.
/// Redesign: cabeçalho com eyebrow + AO VIVO, faixa de números, EM ÓRBITA
/// (agentes rodando) e ESPERAM VOCÊ (entregas prontas + perguntas).
struct CentralView: View {
    @EnvironmentObject var supa: Supa
    @EnvironmentObject var router: PushRouter
    @State private var tasks: [CloudTask] = []
    @State private var questions: [Question] = []
    @State private var lastFeed: [String: FeedItem] = [:]   // taskId → última fala
    @State private var loaded = false
    @State private var showNew = false
    @State private var openTaskId: String? = nil
    @State private var answering: Set<String> = []

    private var visible: [CloudTask] { tasks }
    private var qByTask: [String: Question] {
        Dictionary(questions.compactMap { q in q.taskId.map { ($0, q) } }, uniquingKeysWith: { a, _ in a })
    }
    private func mine(_ t: CloudTask) -> Bool {
        let me = supa.session?.userId ?? ""
        let owner = t.assignee ?? t.createdBy
        return owner == nil || owner == me
    }
    // "esperando VOCÊ" é literal: só perguntas de demanda SUA (o banco também
    // recusa resposta de terceiro — 0013). As dos outros seguem em órbita.
    private var waiting: [CloudTask] { visible.filter { qByTask[$0.id] != nil && $0.flag != "closed" && mine($0) } }
    private var running: [CloudTask] { visible.filter { (qByTask[$0.id] == nil || !mine($0)) && $0.flag != "closed" && ["running", "thinking", "queued", "requested", "plan-review", "error", "conflict"].contains($0.status) } }
    private var ready: [CloudTask] { visible.filter { $0.flag != "closed" && ["review", "delivered"].contains($0.status) && $0.prUrl == nil } }
    private var prOpen: [CloudTask] { visible.filter { $0.flag != "closed" && $0.prUrl != nil && !["merged", "done"].contains($0.status) } }
    private var doneToday: [CloudTask] {
        visible.filter { $0.flag == "closed" || ["merged", "done"].contains($0.status) }.prefix(8).map { $0 }
    }
    private var cost: Double { visible.compactMap { $0.costUsd }.reduce(0, +) }

    var body: some View {
        ZStack(alignment: .top) {
            T.bg.ignoresSafeArea()
            Starfield(seed: 5).frame(height: 420).frame(maxHeight: .infinity, alignment: .top)
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    PageHeader(kicker: "Constellation", title: "Central",
                               sub: loaded ? "\(running.count) agente\(running.count == 1 ? "" : "s") em órbita · \(ready.count + waiting.count) entrega\(ready.count + waiting.count == 1 ? "" : "s") esperando você" : "sincronizando com a nuvem…",
                               live: true)
                    if !loaded { BoardSkeleton() } else {
                        StatRow(items: [
                            .init(value: "\(running.count)", label: "em órbita"),
                            .init(value: "\(ready.count + waiting.count)", label: "esperam você", color: T.accent),
                            .init(value: String(format: "$%.0f", cost), label: "custo"),
                        ])
                        section("em órbita", T.warn, running, empty: "nenhum agente rodando — bora criar a próxima?") { t in orbitCard(t) }
                        if !waiting.isEmpty || !ready.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                kicker("esperam você", T.accent, count: waiting.count + ready.count, dot: true)
                                ForEach(waiting) { t in questionCard(t) }
                                ForEach(ready) { t in readyCard(t) }
                            }
                        }
                        section("PR aberto", T.info, prOpen, empty: nil) { t in prCard(t) }
                        section("concluídas hoje", T.dim, doneToday, empty: nil) { t in doneRow(t) }
                    }
                }
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 96)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable { await load() }
        }
        .overlay(alignment: .bottomTrailing) { fab }
        .sheet(isPresented: $showNew) { NewTaskView { id in if !id.isEmpty { openTaskId = id } } }
        .navigationDestination(item: $openTaskId) { id in
            TaskDetailView(taskId: id, title: tasks.first(where: { $0.id == id })?.title ?? "Tarefa")
        }
        .onChange(of: router.openTaskId) { _, id in if let id { openTaskId = id; router.openTaskId = nil } }
        .task {
            await load()
            #if DEBUG
            if let tid = ProcessInfo.processInfo.environment["DEMO_OPEN_TASK"], !tid.isEmpty {
                openTaskId = tid == "auto" ? (running.first ?? prOpen.first ?? ready.first ?? tasks.first)?.id
                    : tid == "ready" ? (ready.first ?? tasks.first)?.id
                    : tid == "pr" ? (prOpen.first ?? tasks.first)?.id
                    : tid
            }
            if ProcessInfo.processInfo.environment["DEMO_NEW"] == "1" { showNew = true }
            #endif
            if let id = router.openTaskId { openTaskId = id; router.openTaskId = nil }
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(6)); await load() }
        }
    }

    private var fab: some View {
        Button { showNew = true } label: {
            Image(systemName: "plus").font(.system(size: 22, weight: .bold)).foregroundStyle(T.onAccent)
                .frame(width: 56, height: 56)
                .background(LinearGradient(colors: [T.accent, T.accent2], startPoint: .top, endPoint: .bottom))
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .shadow(color: T.accent.opacity(0.45), radius: 18, y: 6)
        }.padding(.trailing, 20).padding(.bottom, 18)
    }

    // ---- seções ----
    @ViewBuilder private func section(_ label: String, _ color: Color, _ list: [CloudTask], empty: String?, @ViewBuilder row: @escaping (CloudTask) -> some View) -> some View {
        if !list.isEmpty || empty != nil {
            VStack(alignment: .leading, spacing: 10) {
                kicker(label, color, count: list.count, dot: true)
                if list.isEmpty, let e = empty {
                    Text(e).font(.system(size: 12.5)).foregroundStyle(T.dim2).padding(.vertical, 6)
                }
                ForEach(list) { t in
                    Button { openTaskId = t.id } label: { row(t) }.buttonStyle(.plain)
                }
            }
        }
    }

    // ---- cards ----
    /// EM ÓRBITA: avatar do agente + título + última fala + barra + status · custo · tempo
    private func orbitCard(_ t: CloudTask) -> some View {
        let st = T.status(t.status, flag: t.flag)
        let who = t.issueCode ?? String(t.id.suffix(2))
        return HStack(alignment: .top, spacing: 12) {
            Av(name: who, size: 30)
            VStack(alignment: .leading, spacing: 8) {
                Text(t.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                if let f = lastFeed[t.id] {
                    let g = feedGlyph(f.kind)
                    HStack(spacing: 6) {
                        Text(g.0).font(.mono(11)).foregroundStyle(g.1)
                        Text(f.text).font(.mono(11)).foregroundStyle(T.dim).lineLimit(1).truncationMode(.tail)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                ProgressLine(pct: T.pct(t), color: st.1)
                HStack(spacing: 8) {
                    Text(st.0).font(.mono(11)).foregroundStyle(st.1)
                    if t.spec?.previewUrl != nil { Text("· preview no ar").font(.mono(11)).foregroundStyle(T.accent) }
                    Spacer()
                    Text([fmtUsd(t.costUsd), agoPt(t.updatedAt)].compactMap { $0 }.joined(separator: " · "))
                        .font(.mono(11)).foregroundStyle(T.dim2)
                }
            }
        }
        .card()
        .rail(agentColor(who))
    }

    /// pergunta com as opções DIRETO no card
    private func questionCard(_ t: CloudTask) -> some View {
        let q = qByTask[t.id]!
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Av(name: q.agent, size: 22)
                Text("\(q.agent) · perguntou".uppercased()).font(.mono(10, .bold)).kerning(1).foregroundStyle(T.warn)
                Spacer()
                Text(agoPt(q.createdAt)).font(.mono(10.5)).foregroundStyle(T.dim)
            }
            Text(t.title).font(.mono(12)).foregroundStyle(T.dim).lineLimit(1)
            mdText(q.prompt, size: 14, color: T.text)
                .lineLimit(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            if answering.contains(q.id) {
                IntentPill(label: "resposta enviada — o turno continua")
            } else {
                ForEach(q.options, id: \.self) { opt in
                    Button { answer(q, opt) } label: {
                        Text(opt).font(.system(size: 13.5, weight: .semibold))
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 13).frame(height: 46)
                            .background(T.accent.opacity(0.12)).foregroundStyle(T.accent)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                    }
                }
                Button { openTaskId = t.id } label: {
                    Text("✎ responder com minhas palavras").font(.mono(12)).foregroundStyle(T.dim)
                }
            }
        }
        .card(stroke: T.warn.opacity(0.4))
        .rail(T.warn)
        .contentShape(Rectangle())
        .onTapGesture { openTaskId = t.id }
    }

    /// ESPERAM VOCÊ: entrega pronta — provas + "aprovar e abrir PR" + "ver"
    private func readyCard(_ t: CloudTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(t.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                if let r = t.reqsProved {
                    Text("✓ \(r.done)/\(r.total) requisitos provados").font(.mono(11)).foregroundStyle(r.done == r.total ? T.accent : T.warn)
                } else {
                    Text("✓ entrega pronta pra revisar").font(.mono(11)).foregroundStyle(T.accent)
                }
                Spacer()
                Text("\(t.kind == "invest" ? "Investigador" : t.kind == "design" ? "Designer" : "Coder") · \(agoPt(t.updatedAt))").font(.mono(11)).foregroundStyle(T.dim2)
            }
            if t.spec?.intent?.kind == "openPr" {
                IntentPill(label: "o Mac está executando · abrir PR")
            } else {
                HStack(spacing: 8) {
                    Button { sendIntent(t, "openPr") } label: {
                        Text("aprovar e abrir PR").font(.system(size: 13.5, weight: .semibold))
                            .frame(maxWidth: .infinity).frame(height: 44)
                            .background(T.accent).foregroundStyle(T.onAccent)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                    }.buttonStyle(.plain)
                    OutlineButton(label: "ver") { openTaskId = t.id }
                }
            }
            if let res = t.spec?.intentResult, res.ok == false, res.kind == "openPr" {
                Text("✖ \(res.msg ?? "falhou")").font(.system(size: 11.5)).foregroundStyle(T.bad)
            }
        }
        .card(stroke: T.accent.opacity(0.3))
        .rail(T.accent)
        .contentShape(Rectangle())
        .onTapGesture { openTaskId = t.id }
    }

    private func prCard(_ t: CloudTask) -> some View {
        let pr = t.spec?.prInfo
        let open = (pr?.comments ?? []).filter { !($0.answered ?? false) }.count
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(t.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(2)
                Spacer()
                if let n = pr?.number { Text("#\(n)").font(.mono(11.5, .bold)).foregroundStyle(T.info) }
            }
            ProgressLine(pct: 92, color: T.info)
            HStack(spacing: 10) {
                if pr?.decision == "APPROVED" { Text("✓ aprovado").font(.mono(11)).foregroundStyle(T.accent) }
                else if pr?.decision == "CHANGES_REQUESTED" { Text("mudanças pedidas").font(.mono(11)).foregroundStyle(T.warn) }
                else { Text("PR aberto").font(.mono(11)).foregroundStyle(T.info) }
                if open > 0 { Text("\(open) comentário\(open == 1 ? "" : "s") aberto\(open == 1 ? "" : "s")").font(.mono(11)).foregroundStyle(T.warn) }
                Spacer()
                Text(agoPt(t.updatedAt)).font(.mono(11)).foregroundStyle(T.dim2)
            }
        }.card().rail(T.info)
    }

    private func doneRow(_ t: CloudTask) -> some View {
        HStack(spacing: 9) {
            Text("✓").font(.mono(12, .bold)).foregroundStyle(T.dim2)
            Text(t.title).font(.system(size: 13)).foregroundStyle(T.dim).lineLimit(1)
            Spacer()
            if let n = t.spec?.prInfo?.number { Text("#\(n)").font(.mono(10.5)).foregroundStyle(T.dim2) }
        }.padding(.vertical, 5)
    }

    // ---- ações ----
    private func answer(_ q: Question, _ opt: String) {
        answering.insert(q.id)
        Task {
            _ = try? await supa.rest("questions?id=eq.\(q.id)", method: "PATCH",
                                     json: ["status": "answered", "answer": opt,
                                            "answered_by": supa.session?.userId ?? "",
                                            "answered_at": ISO8601DateFormatter().string(from: Date())])
            await load()
        }
    }
    private func sendIntent(_ t: CloudTask, _ kind: String) {
        Task { try? await supa.sendIntent(taskId: t.id, kind: kind); await load() }
    }

    private func load() async {
        do {
            if let qd = try? await supa.rest("questions?select=id,task_id,agent,prompt,options,created_at,tasks(title)&status=eq.open&order=created_at.desc&limit=20"),
               let qs = try? JSONDecoder().decode([Question].self, from: qd) {
                await MainActor.run { questions = qs }
            }
            let data = try await supa.rest("tasks?select=id,title,status,flag,branch,pr_url,cost_usd,assignee,created_by,updated_at,spec,requirements_proof&order=updated_at.desc&limit=120")
            let ts = try JSONDecoder().decode([CloudTask].self, from: data)
            var feed: [String: FeedItem] = [:]
            if let fd = try? await supa.rest("task_feed?select=id,task_id,agent,kind,text&order=id.desc&limit=80"),
               let fs = try? JSONDecoder().decode([FeedItem].self, from: fd) {
                for f in fs { if let tid = f.taskId, feed[tid] == nil { feed[tid] = f } }
            }
            await MainActor.run { tasks = ts; lastFeed = feed; loaded = true }
        } catch { await MainActor.run { loaded = true } }
    }
}
