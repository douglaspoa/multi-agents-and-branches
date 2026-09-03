import SwiftUI

/// Tela 01 — Central: a fila na ordem em que ela te cobra.
struct CentralView: View {
    @EnvironmentObject var supa: Supa
    @EnvironmentObject var router: PushRouter
    @State private var tasks: [CloudTask] = []
    @State private var questions: [Question] = []
    @State private var lastFeed: [String: FeedItem] = [:]   // taskId → última fala
    @State private var projects: [Epic] = []                 // id,name (reuso do shape)
    @State private var projFilter: String? = nil
    @State private var loaded = false
    @State private var showNew = false
    @State private var openTaskId: String? = nil
    @State private var answering: Set<String> = []

    private var visible: [CloudTask] {
        tasks // filtro de projeto entra quando project_id estiver no select
    }
    private var qByTask: [String: Question] {
        Dictionary(questions.compactMap { q in q.taskId.map { ($0, q) } }, uniquingKeysWith: { a, _ in a })
    }
    private var waiting: [CloudTask] { visible.filter { qByTask[$0.id] != nil && $0.flag != "closed" } }
    private var running: [CloudTask] { visible.filter { qByTask[$0.id] == nil && $0.flag != "closed" && ["running", "thinking", "queued", "requested", "plan-review", "error", "conflict"].contains($0.status) } }
    private var ready: [CloudTask] { visible.filter { $0.flag != "closed" && ["review", "delivered"].contains($0.status) && $0.prUrl == nil } }
    private var prOpen: [CloudTask] { visible.filter { $0.flag != "closed" && $0.prUrl != nil && !["merged", "done"].contains($0.status) } }
    private var doneToday: [CloudTask] {
        visible.filter { $0.flag == "closed" || ["merged", "done"].contains($0.status) }.prefix(8).map { $0 }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if !loaded { BoardSkeleton() } else {
                    daily
                    if !waiting.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            kicker("⏳ ESPERANDO VOCÊ", T.warn, count: waiting.count)
                            ForEach(waiting) { t in questionCard(t) }
                        }
                    }
                    section("● RODANDO AGORA", T.accent, running, empty: "nenhum agente rodando") { t in runningCard(t) }
                    section("◆ PRONTAS PRA REVISAR", T.accent, ready, empty: "nada esperando revisão") { t in readyCard(t) }
                    section("⇱ PR ABERTO", T.info, prOpen, empty: nil) { t in prCard(t) }
                    section("✓ CONCLUÍDAS HOJE", T.dim, doneToday, empty: nil) { t in doneRow(t) }
                    if waiting.isEmpty && running.isEmpty && ready.isEmpty && prOpen.isEmpty {
                        VStack(spacing: 8) {
                            Text("✓ Fila limpa").font(.system(size: 17, weight: .bold)).foregroundStyle(T.accent)
                            Text("nada esperando você — bora criar a próxima?").font(.system(size: 13)).foregroundStyle(T.dim)
                        }.frame(maxWidth: .infinity).padding(.vertical, 30)
                    }
                }
            }
            .padding(16).padding(.bottom, 80)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(T.bg)
        .refreshable { await load() }
        .overlay(alignment: .bottomTrailing) {
            Button { showNew = true } label: {
                Text("＋").font(.system(size: 26, weight: .bold)).foregroundStyle(T.onAccent)
                    .frame(width: 56, height: 56).background(T.accent).clipShape(Circle())
                    .shadow(color: .black.opacity(0.4), radius: 12, y: 4)
            }.padding(20)
        }
        .sheet(isPresented: $showNew) { NewTaskView { id in if !id.isEmpty { openTaskId = id } } }
        .navigationDestination(item: $openTaskId) { id in
            TaskDetailView(taskId: id, title: tasks.first(where: { $0.id == id })?.title ?? "Tarefa")
        }
        .onChange(of: router.openTaskId) { _, id in if let id { openTaskId = id; router.openTaskId = nil } }
        .task {
            await load()
            #if DEBUG
            if let tid = ProcessInfo.processInfo.environment["DEMO_OPEN_TASK"], !tid.isEmpty {
                openTaskId = tid == "auto" ? (running.first ?? prOpen.first ?? tasks.first)?.id : tid
            }
            #endif
            if let id = router.openTaskId { openTaskId = id; router.openTaskId = nil }
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(6)); await load() }
        }
    }

    // ---- seções ----
    @ViewBuilder private func section(_ label: String, _ color: Color, _ list: [CloudTask], empty: String?, @ViewBuilder row: @escaping (CloudTask) -> some View) -> some View {
        if !list.isEmpty || empty != nil {
            VStack(alignment: .leading, spacing: 10) {
                kicker(label, color, count: list.count)
                if list.isEmpty, let e = empty {
                    Text(e).font(.system(size: 12)).foregroundStyle(T.dim2)
                }
                ForEach(list) { t in
                    Button { openTaskId = t.id } label: { row(t) }.buttonStyle(.plain)
                }
            }
        }
    }

    private var daily: some View {
        let done = doneToday.count
        let cost = visible.compactMap { $0.costUsd }.reduce(0, +)
        return HStack(spacing: 14) {
            stat("\(done)", "entregas hoje")
            stat("\(running.count)", "rodando")
            stat(String(format: "$%.0f", cost), "custo")
            Spacer()
            HStack(spacing: 5) { BlinkDot(); Text("AO VIVO").font(.system(size: 9, design: .monospaced).bold()).foregroundStyle(T.accent) }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .background(T.panel).overlay(RoundedRectangle(cornerRadius: 14).stroke(T.line))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
    private func stat(_ v: String, _ l: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(v).font(.system(size: 17, design: .monospaced).bold()).foregroundStyle(T.text)
            Text(l).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(T.dim)
        }
    }

    // ---- cards ----
    /// 5.3 — pergunta com as opções DIRETO no card
    private func questionCard(_ t: CloudTask) -> some View {
        let q = qByTask[t.id]!
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Av(name: q.agent, size: 22)
                Text("\(q.agent.uppercased()) · PERGUNTOU").font(.system(size: 10, design: .monospaced).bold()).foregroundStyle(T.warn)
                Spacer()
                Text(agoPt(q.createdAt)).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(T.dim)
            }
            Text(t.title).font(.system(size: 12, design: .monospaced)).foregroundStyle(T.dim).lineLimit(1)
            Text(q.prompt).font(.system(size: 14)).foregroundStyle(T.text)
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
                    Text("✎ responder com minhas palavras").font(.system(size: 12, design: .monospaced)).foregroundStyle(T.dim)
                }
            }
        }
        .card(stroke: T.warn.opacity(0.4))
        .contentShape(Rectangle())
        .onTapGesture { openTaskId = t.id }
    }

    private func runningCard(_ t: CloudTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                BlinkDot(color: T.warn)
                Text(t.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(1)
                Spacer()
                Text("\(T.pct(t))%").font(.system(size: 10.5, design: .monospaced)).foregroundStyle(T.dim)
            }
            PhaseBar(phase: t.phase)
            if let f = lastFeed[t.id] {
                HStack(spacing: 6) {
                    let g = feedGlyph(f.kind)
                    Text(g.0).font(.system(size: 11, design: .monospaced)).foregroundStyle(g.1)
                    Text(f.text).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(T.dim).lineLimit(1)
                }
            }
            HStack(spacing: 10) {
                if let a = t.assignee ?? t.createdBy { Av(name: a, size: 18) }
                if t.spec?.previewUrl != nil {
                    Text("🌐 preview no ar").font(.system(size: 10.5, design: .monospaced)).foregroundStyle(T.accent)
                }
                Spacer()
                if let c = fmtUsd(t.costUsd) { Text(c).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(T.dim) }
                Text(agoPt(t.updatedAt)).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(T.dim2)
            }
        }.card()
    }

    private func readyCard(_ t: CloudTask) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Text("◆").foregroundStyle(T.accent)
                Text(t.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(2)
                Spacer()
            }
            PhaseBar(phase: t.phase)
            if let r = t.reqsProved {
                Text("✓ \(r.done)/\(r.total) requisitos provados")
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(r.done == r.total ? T.accent : T.warn)
            }
            if t.spec?.intent?.kind == "openPr" {
                IntentPill(label: "o Mac está executando · abrir PR")
            } else {
                BigButton(label: "aprovar e abrir PR") { sendIntent(t, "openPr") }
            }
            if let res = t.spec?.intentResult, res.ok == false, res.kind == "openPr" {
                Text("✖ \(res.msg ?? "falhou")").font(.system(size: 11.5)).foregroundStyle(T.bad)
            }
        }.card(stroke: T.accent.opacity(0.35))
    }

    private func prCard(_ t: CloudTask) -> some View {
        let pr = t.spec?.prInfo
        let open = (pr?.comments ?? []).filter { !($0.answered ?? false) }.count
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("⇱").foregroundStyle(T.info)
                Text(t.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(1)
                Spacer()
                if let n = pr?.number { Text("#\(n)").font(.system(size: 11.5, design: .monospaced)).foregroundStyle(T.info) }
            }
            PhaseBar(phase: 5)
            HStack(spacing: 10) {
                if pr?.decision == "APPROVED" { Text("✓ aprovado").font(.system(size: 11, design: .monospaced)).foregroundStyle(T.accent) }
                else if pr?.decision == "CHANGES_REQUESTED" { Text("mudanças pedidas").font(.system(size: 11, design: .monospaced)).foregroundStyle(T.warn) }
                if open > 0 { Text("\(open) comentário\(open == 1 ? "" : "s") aberto\(open == 1 ? "" : "s")").font(.system(size: 11, design: .monospaced)).foregroundStyle(T.warn) }
                Spacer()
                Text(agoPt(t.updatedAt)).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(T.dim2)
            }
        }.card()
    }

    private func doneRow(_ t: CloudTask) -> some View {
        HStack(spacing: 9) {
            Text("✓").foregroundStyle(T.dim2)
            Text(t.title).font(.system(size: 13)).foregroundStyle(T.dim).lineLimit(1)
            Spacer()
            if let n = t.spec?.prInfo?.number { Text("#\(n)").font(.system(size: 10.5, design: .monospaced)).foregroundStyle(T.dim2) }
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
            // última fala das rodando (1 query, mapeia a primeira por tarefa)
            var feed: [String: FeedItem] = [:]
            if let fd = try? await supa.rest("task_feed?select=id,task_id,agent,kind,text&order=id.desc&limit=80"),
               let fs = try? JSONDecoder().decode([FeedItem].self, from: fd) {
                for f in fs { if let tid = f.taskId, feed[tid] == nil { feed[tid] = f } }
            }
            await MainActor.run { tasks = ts; lastFeed = feed; loaded = true }
        } catch { await MainActor.run { loaded = true } }
    }
}
