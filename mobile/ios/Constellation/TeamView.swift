import SwiftUI

/// Time — números de relance, pessoas (presença + demandas em andamento, expansível),
/// PRs pra revisar e atividade. Lista nativa inset-grouped.
struct TeamView: View {
    @EnvironmentObject var supa: Supa
    @State private var tasks: [CloudTask] = []
    @State private var profiles: [String: Profile] = [:]
    @State private var teamName = ""
    @State private var activity: [Activity] = []
    @State private var loaded = false
    @State private var openTaskId: String? = nil
    @State private var showNew = false
    @State private var expanded: Set<String> = []

    private var members: [String] {
        var s: [String] = []
        for t in tasks { for u in [t.assignee, t.createdBy] { if let u, !s.contains(u) { s.append(u) } } }
        // eu primeiro, depois quem está online
        let me = supa.session?.userId ?? ""
        return s.sorted { a, b in
            if a == me { return true }; if b == me { return false }
            return isOnline(a) && !isOnline(b)
        }
    }
    private var doing: [CloudTask] { tasks.filter { ["running", "thinking", "queued"].contains($0.status) && $0.flag != "closed" } }
    private var prs: [CloudTask] { tasks.filter { $0.prUrl != nil && !["merged", "done"].contains($0.status) && $0.flag != "closed" } }
    private var delivered: Int { tasks.filter { ["merged", "done", "review", "delivered"].contains($0.status) }.count }

    var body: some View {
        List {
            if !loaded {
                Section { ForEach(0..<3, id: \.self) { _ in TaskRowSkeleton().rowStyle() } }
            } else if members.isEmpty {
                Section {
                    EmptyBoard(title: "Ninguém no time ainda", message: "Convide o time pelo Starfork no Mac — as demandas de todo mundo aparecem aqui, num lugar só.", symbol: "person.2")
                        .listRowBackground(Color.clear)
                }
            } else {
                Section {
                    HStack(spacing: 0) {
                        stat("\(doing.count)", "rodando")
                        Divider().overlay(T.line)
                        stat("\(delivered)", "entregas")
                        Divider().overlay(T.line)
                        stat(String(format: "$%.0f", tasks.compactMap { $0.costUsd }.reduce(0, +)), "custo")
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityElement(children: .combine)
                    .rowStyle()
                }
                Section {
                    ForEach(members, id: \.self) { uid in personRows(uid) }
                } header: { SectionHead(title: "Pessoas", symbol: "person.2.fill", count: members.count) }
                if !prs.isEmpty {
                    Section {
                        ForEach(prs) { t in
                            NavigationLink(value: TaskRef(id: t.id)) {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 8) {
                                        IconText(symbol: "arrow.triangle.pull", text: "PR aberto").font(.ui(12, .semibold)).foregroundStyle(T.info)
                                        Spacer(minLength: 6)
                                        if let n = t.spec?.prInfo?.number { Text("#\(n)").font(.mono(12, .semibold)).foregroundStyle(T.info) }
                                    }
                                    Text(t.title).font(.ui(15, .semibold)).foregroundStyle(T.text).lineLimit(2)
                                    HStack(spacing: 8) {
                                        if let who = t.assignee ?? t.createdBy { IconText(symbol: "person.fill", text: name(who)).lineLimit(1) }
                                        Spacer(minLength: 0)
                                        Text(agoPt(t.updatedAt))
                                    }.font(.ui(12)).foregroundStyle(T.dim)
                                }.padding(.vertical, 3)
                            }.rowStyle()
                        }
                    } header: { SectionHead(title: "PRs pra revisar", symbol: "arrow.triangle.pull", color: T.info, count: prs.count) }
                }
                if !activity.isEmpty {
                    Section {
                        ForEach(activity.prefix(12)) { a in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("\(a.userId.map(name) ?? "") \(kindPt(a.kindK)) \(taskTitle(a.taskId))")
                                    .font(.ui(13)).foregroundStyle(T.text2).lineLimit(2)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                if let at = a.at { Text(agoPt(at)).font(.ui(12)).foregroundStyle(T.dim2) }
                            }.rowStyle()
                        }
                    } header: { SectionHead(title: "Atividade", symbol: "clock.arrow.circlepath") }
                }
            }
        }
        .appList()
        .refreshable { await load(); Haptic.select() }
        .navigationTitle(teamName.isEmpty ? "Time" : teamName)
        .navigationBarTitleDisplayMode(.large)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { NewTaskToolbarButton { showNew = true } } }
        .sheet(isPresented: $showNew) { NewTaskView { _ in } }
        .navigationDestination(for: TaskRef.self) { r in
            TaskDetailView(taskId: r.id, title: tasks.first(where: { $0.id == r.id })?.title ?? "Tarefa")
        }
        .navigationDestination(item: $openTaskId) { id in
            TaskDetailView(taskId: id, title: tasks.first(where: { $0.id == id })?.title ?? "Tarefa")
        }
        .task {
            await load()
            if expanded.isEmpty, let first = members.first { expanded = [first] }
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(10)); await load() }
        }
    }

    private func stat(_ v: String, _ l: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(v).font(.ui(20, .semibold)).monospacedDigit().foregroundStyle(T.text).lineLimit(1).minimumScaleFactor(0.6)
            Text(l).font(.ui(12)).foregroundStyle(T.dim).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6)
    }

    /// pessoa (linha que expande) + as demandas em andamento dela
    @ViewBuilder private func personRows(_ uid: String) -> some View {
        let mine = tasks.filter { ($0.assignee ?? $0.createdBy) == uid }
        let active = mine.filter { !["merged", "done"].contains($0.status) && $0.flag != "closed" }
        let done = mine.filter { ["merged", "done", "review", "delivered"].contains($0.status) }.count
        let cost = mine.compactMap { $0.costUsd }.reduce(0, +)
        let online = isOnline(uid)
        let open = expanded.contains(uid)
        Button {
            Haptic.select()
            withAnimation(.easeOut(duration: 0.2)) { if open { expanded.remove(uid) } else { expanded.insert(uid) } }
        } label: {
            HStack(spacing: 12) {
                Av(name: name(uid), size: 36)
                    .overlay(alignment: .bottomTrailing) {
                        Circle().fill(online ? T.accent : T.dim2).frame(width: 11, height: 11)
                            .overlay(Circle().stroke(T.panel, lineWidth: 2))
                    }
                VStack(alignment: .leading, spacing: 2) {
                    Text(name(uid)).font(.ui(16, .semibold)).foregroundStyle(T.text).lineLimit(1)
                    Text([online ? "online agora" : (profiles[uid]?.lastSeenAt).map { "visto há \(agoPt($0))" } ?? "offline",
                          "\(active.count) em andamento", "\(done) entrega\(done == 1 ? "" : "s")"].joined(separator: " · "))
                        .font(.ui(12)).foregroundStyle(online ? T.accent : T.dim).lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if cost > 0 { Text(String(format: "$%.0f", cost)).font(.mono(14, .semibold)).foregroundStyle(T.text2) }
                Image(systemName: "chevron.down").font(.ui(12, .semibold)).foregroundStyle(T.dim2)
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name(uid)), \(online ? "online" : "offline"), \(active.count) em andamento")
        .accessibilityHint(open ? "recolher" : "ver as demandas")
        .rowStyle()
        if open {
            if active.isEmpty {
                Text("Nada em andamento").font(.ui(13)).foregroundStyle(T.dim).padding(.leading, 48).rowStyle()
            }
            ForEach(active.prefix(5)) { t in
                NavigationLink(value: TaskRef(id: t.id)) {
                    TaskRow(task: t).padding(.leading, 48)
                }.rowStyle()
            }
        }
    }

    private func name(_ uid: String) -> String {
        profiles[uid]?.name ?? profiles[uid]?.email?.components(separatedBy: "@").first ?? String(uid.prefix(6))
    }
    private func isOnline(_ uid: String) -> Bool {
        guard let seen = profiles[uid]?.lastSeenAt else { return false }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: seen) ?? ISO8601DateFormatter().date(from: seen) else { return false }
        return Date().timeIntervalSince(d) < 180
    }
    private func taskTitle(_ id: String?) -> String {
        id.flatMap { i in tasks.first { $0.id == i }?.title }.map { "“\($0.prefix(34))”" } ?? ""
    }
    private func kindPt(_ k: String?) -> String {
        switch k {
        case "created": return "criou"
        case "started": return "iniciou"
        case "delivered": return "entregou"
        case "merged": return "mergeou"
        case "answered": return "respondeu em"
        default: return k ?? ""
        }
    }

    private func load() async {
        do {
            let data = try await supa.rest("tasks?select=id,title,status,flag,branch,pr_url,cost_usd,assignee,created_by,updated_at,spec,requirements_proof&order=updated_at.desc&limit=150")
            let ts = try JSONDecoder().decode([CloudTask].self, from: data)
            var profs = profiles
            let missing = Set(ts.compactMap { $0.assignee ?? $0.createdBy }).subtracting(profs.keys)
            if !missing.isEmpty {
                let list = missing.map { "\"\($0)\"" }.joined(separator: ",")
                if let pd = try? await supa.rest("profiles?select=user_id,name,email,last_seen_at&user_id=in.(\(list))"),
                   let ps = try? JSONDecoder().decode([Profile].self, from: pd) {
                    for p in ps { profs[p.userId] = p }
                }
            }
            var act: [Activity] = []
            if let ad = try? await supa.rest("task_activity?select=id,task_id,user_id,kind,at&order=id.desc&limit=20"),
               let asx = try? JSONDecoder().decode([Activity].self, from: ad) { act = asx }
            var tname = teamName
            if tname.isEmpty, let td = try? await supa.rest("teams?select=name&order=name&limit=1"),
               let arr = try? JSONSerialization.jsonObject(with: td) as? [[String: Any]], let n = arr.first?["name"] as? String { tname = n }
            await MainActor.run { tasks = ts; profiles = profs; activity = act; teamName = tname; loaded = true }
        } catch { await MainActor.run { loaded = true } }
    }
}
