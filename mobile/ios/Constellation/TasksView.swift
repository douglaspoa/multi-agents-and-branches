import SwiftUI

/// Minhas — sua órbita: chips (rodando · review · backlog · feitas) e cartões
/// com faixa de status. `mine=false` mostra o quadro inteiro (mesmo layout).
struct TasksView: View {
    @EnvironmentObject var supa: Supa
    @EnvironmentObject var router: PushRouter
    @EnvironmentObject var hub: SyncHub
    var mine = false
    @State private var profiles: [String: Profile] = [:]
    @State private var showNew = false
    @State private var openTaskId: String? = nil
    @State private var filter = 0   // 0 rodando · 1 review · 2 backlog · 3 feitas

    /// da sincronia única (antes: laço próprio de 6s, o terceiro igual no app)
    private var tasks: [CloudTask] { mine ? hub.visible.filter { hub.isMine($0) } : hub.visible }
    private var loaded: Bool { hub.loaded }
    private var openQ: Set<String> { Set(hub.myQuestions.compactMap(\.taskId)) }
    private var waiting: [CloudTask] { tasks.filter { openQ.contains($0.id) && $0.flag != "closed" } }
    private var doing: [CloudTask] { tasks.filter { !openQ.contains($0.id) && $0.flag != "closed" && ["running", "thinking", "queued", "plan-review", "requested", "error", "conflict", "paused"].contains($0.status) } }
    private var review: [CloudTask] { tasks.filter { $0.flag != "closed" && (["review", "delivered"].contains($0.status) || ($0.prUrl != nil && !["merged", "done"].contains($0.status))) } }
    private var done: [CloudTask] { tasks.filter { $0.isEnded } }
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
                    ConnBanner(compact: true)
                    ProjectChips()
                    if !loaded { BoardSkeleton() } else {
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
            .refreshable { await hub.refresh() }
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
        .task(id: tasks.count) {
            if mine, let id = router.openTaskId { openTaskId = id; router.openTaskId = nil }
            if !mine { await loadProfiles() }
        }
    }

    @ViewBuilder
    private func row(_ t: CloudTask) -> some View {
        let st = T.status(t.status, flag: t.flag)
        let isWaiting = openQ.contains(t.id)
        Button { openTaskId = t.id } label: {
            VStack(alignment: .leading, spacing: 9) {
                if isWaiting {
                    let teto = hub.myQuestions.contains { $0.taskId == t.id && $0.isTeto }
                    Text(teto ? "⏸ parou no teto de custo — continuar ou parar?" : "⏳ o agente fez uma pergunta — toque pra responder")
                        .font(.mono(10.5, .bold)).foregroundStyle(teto ? T.bad : T.warn)
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

    /// nomes de quem é cada cartão (só no quadro do time)
    private func loadProfiles() async {
        let missing = Set(tasks.compactMap { $0.assignee ?? $0.createdBy }).subtracting(profiles.keys)
        guard !missing.isEmpty else { return }
        let list = missing.map { "\"\($0)\"" }.joined(separator: ",")
        if let pd = try? await supa.rest("profiles?select=user_id,name,email&user_id=in.(\(list))"),
           let ps = try? JSONDecoder().decode([Profile].self, from: pd) {
            for p in ps { profiles[p.userId] = p }
        }
    }
}
