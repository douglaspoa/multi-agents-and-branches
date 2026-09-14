import SwiftUI

/// Minhas — sua órbita: chips (rodando · review · backlog · feitas) e cartões
/// com faixa de status. `mine=false` mostra o quadro inteiro (mesmo layout).
struct TasksView: View {
    @EnvironmentObject var supa: Supa
    @EnvironmentObject var router: PushRouter
    var mine = false
    @State private var tasks: [CloudTask] = []
    @State private var profiles: [String: Profile] = [:]
    @State private var loaded = false
    @State private var error = ""
    @State private var showNew = false
    @State private var openTaskId: String? = nil
    @State private var openQ: Set<String> = []
    @State private var filter = 0   // 0 rodando · 1 review · 2 backlog · 3 feitas

    private var waiting: [CloudTask] { tasks.filter { openQ.contains($0.id) && $0.flag != "closed" } }
    private var doing: [CloudTask] { tasks.filter { !openQ.contains($0.id) && $0.flag != "closed" && ["running", "thinking", "queued", "plan-review", "requested", "error", "conflict"].contains($0.status) } }
    private var review: [CloudTask] { tasks.filter { $0.flag != "closed" && (["review", "delivered"].contains($0.status) || ($0.prUrl != nil && !["merged", "done"].contains($0.status))) } }
    private var done: [CloudTask] { tasks.filter { $0.flag == "closed" || ["merged", "done"].contains($0.status) } }
    private var backlog: [CloudTask] { tasks.filter { $0.flag != "closed" && ["backlog", "draft"].contains($0.status) } }
    private var lists: [[CloudTask]] { [waiting + doing, review, backlog, done] }
    private let names = ["rodando", "review", "backlog", "feitas"]

    var body: some View {
        ZStack(alignment: .top) {
            T.bg.ignoresSafeArea()
            Starfield(seed: 9).frame(height: 380).frame(maxHeight: .infinity, alignment: .top)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    PageHeader(kicker: mine ? "Sua órbita" : "Quadro", title: mine ? "Minhas" : "Quadro",
                               sub: loaded ? "\(tasks.count) tarefa\(tasks.count == 1 ? "" : "s") · \(lists[0].count) rodando agora" : "sincronizando…")
                    if !loaded { BoardSkeleton() } else {
                        if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(T.warn) }
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(0..<4, id: \.self) { i in
                                    Button { withAnimation(.easeOut(duration: 0.15)) { filter = i } } label: {
                                        Chip(label: names[i], count: lists[i].count, on: filter == i)
                                    }.buttonStyle(.plain)
                                }
                            }.padding(.horizontal, 1)
                        }
                        let list = lists[filter]
                        if list.isEmpty {
                            Text(["nenhum agente rodando", "nada esperando review", "backlog vazio", "nada concluído ainda"][filter])
                                .font(.system(size: 12.5)).foregroundStyle(T.dim2).padding(.vertical, 10)
                        }
                        ForEach(filter == 3 ? Array(list.prefix(40)) : list) { t in row(t) }
                    }
                }
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 96)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable { await load() }
        }
        .overlay(alignment: .bottomTrailing) {
            Button { showNew = true } label: {
                Image(systemName: "plus").font(.system(size: 22, weight: .bold)).foregroundStyle(T.onAccent)
                    .frame(width: 56, height: 56)
                    .background(LinearGradient(colors: [T.accent, T.accent2], startPoint: .top, endPoint: .bottom))
                    .clipShape(RoundedRectangle(cornerRadius: 18))
                    .shadow(color: T.accent.opacity(0.45), radius: 18, y: 6)
            }.padding(.trailing, 20).padding(.bottom, 18)
        }
        .sheet(isPresented: $showNew) {
            NewTaskView { createdId in if !createdId.isEmpty { openTaskId = createdId } }
        }
        .navigationDestination(item: $openTaskId) { id in
            TaskDetailView(taskId: id, title: tasks.first(where: { $0.id == id })?.title ?? "Tarefa")
        }
        .onChange(of: router.openTaskId) { _, id in
            if mine, let id { openTaskId = id; router.openTaskId = nil }
        }
        .task {
            await load()
            if mine, let id = router.openTaskId { openTaskId = id; router.openTaskId = nil }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(6))
                await load()
            }
        }
    }

    @ViewBuilder
    private func row(_ t: CloudTask) -> some View {
        let st = T.status(t.status, flag: t.flag)
        let isWaiting = openQ.contains(t.id)
        Button { openTaskId = t.id } label: {
            VStack(alignment: .leading, spacing: 9) {
                if isWaiting {
                    Text("⏳ o agente fez uma pergunta — toque pra responder").font(.mono(10.5, .bold)).foregroundStyle(T.warn)
                }
                Text(t.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                ProgressLine(pct: T.pct(t), color: isWaiting ? T.warn : st.1)
                HStack(spacing: 8) {
                    Text(isWaiting ? "esperando você" : st.0).font(.mono(11)).foregroundStyle(isWaiting ? T.warn : st.1).lineLimit(1).fixedSize()
                    if let code = t.issueCode {
                        Text(code).font(.mono(10)).padding(.horizontal, 5).padding(.vertical, 1)
                            .background(T.info.opacity(0.15)).foregroundStyle(T.info).clipShape(Capsule())
                    }
                    if !mine, let who = t.assignee ?? t.createdBy, let p = profiles[who] {
                        Text(p.name ?? p.email ?? "").font(.system(size: 11)).foregroundStyle(T.dim).lineLimit(1)
                    }
                    Spacer()
                    HStack(spacing: 5) {
                        if let c = fmtUsd(t.costUsd) { Text(c).font(.mono(11)).foregroundStyle(T.dim2) }
                        if t.prUrl != nil { Text("· PR ↗").font(.mono(11)).foregroundStyle(T.dim2) }
                        Text("· \(agoPt(t.updatedAt))").font(.mono(11)).foregroundStyle(T.dim2)
                    }
                }
            }
            .card(stroke: isWaiting ? T.warn.opacity(0.5) : T.line)
            .rail(isWaiting ? T.warn : st.1)
        }
        .buttonStyle(.plain)
    }

    private func load() async {
        do {
            let me = supa.session?.userId ?? ""
            let filter = mine ? "&or=(assignee.eq.\(me),created_by.eq.\(me))" : ""
            if let qd = try? await supa.rest("questions?select=task_id&status=eq.open&limit=50"),
               let qs = try? JSONSerialization.jsonObject(with: qd) as? [[String: Any]] {
                let ids = Set(qs.compactMap { $0["task_id"] as? String })
                await MainActor.run { openQ = ids }
            }
            let data = try await supa.rest("tasks?select=id,title,status,flag,branch,pr_url,cost_usd,assignee,created_by,updated_at,spec,requirements_proof\(filter)&order=updated_at.desc&limit=150")
            let ts = try JSONDecoder().decode([CloudTask].self, from: data)
            var profs = profiles
            let missing = Set(ts.compactMap { $0.assignee ?? $0.createdBy }).subtracting(profs.keys)
            if !mine, !missing.isEmpty {
                let list = missing.map { "\"\($0)\"" }.joined(separator: ",")
                if let pd = try? await supa.rest("profiles?select=user_id,name,email&user_id=in.(\(list))"),
                   let ps = try? JSONDecoder().decode([Profile].self, from: pd) {
                    for p in ps { profs[p.userId] = p }
                }
            }
            await MainActor.run { self.tasks = ts; self.profiles = profs; self.loaded = true; self.error = "" }
        } catch {
            await MainActor.run { if self.loaded { self.error = error.localizedDescription }; self.loaded = true }
        }
    }
}
