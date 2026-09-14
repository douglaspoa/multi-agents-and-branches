import SwiftUI

/// Time — pessoas primeiro (cartão por pessoa, expansível com as demandas em
/// andamento), faixa de números e PRs pra revisar.
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
        ZStack(alignment: .top) {
            T.bg.ignoresSafeArea()
            Starfield(seed: 13).frame(height: 380).frame(maxHeight: .infinity, alignment: .top)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    PageHeader(kicker: teamName.isEmpty ? "Time" : teamName, title: "Time",
                               sub: loaded ? "\(members.count) pessoa\(members.count == 1 ? "" : "s") · \(doing.count) agente\(doing.count == 1 ? "" : "s") rodando" : "sincronizando…",
                               live: true)
                    if !loaded { BoardSkeleton() } else {
                        StatRow(items: [
                            .init(value: "\(doing.count)", label: "em órbita"),
                            .init(value: "\(delivered)", label: "entregas"),
                            .init(value: String(format: "$%.0f", tasks.compactMap { $0.costUsd }.reduce(0, +)), label: "custo"),
                        ])
                        VStack(spacing: 10) { ForEach(members, id: \.self) { uid in personCard(uid) } }
                        if !prs.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                kicker("PRs pra revisar", T.info, count: prs.count, dot: true)
                                ForEach(prs) { t in
                                    Button { openTaskId = t.id } label: {
                                        HStack(spacing: 9) {
                                            if let n = t.spec?.prInfo?.number { Text("#\(n)").font(.mono(11.5, .bold)).foregroundStyle(T.info) }
                                            Text(t.title).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(1)
                                            Spacer()
                                            if let who = t.assignee ?? t.createdBy { Av(name: name(who), size: 18) }
                                            Text(agoPt(t.updatedAt)).font(.mono(10)).foregroundStyle(T.dim2)
                                        }.card(radius: 14).rail(T.info, radius: 14)
                                    }.buttonStyle(.plain)
                                }
                            }
                        }
                        if !activity.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                kicker("atividade", T.dim)
                                ForEach(activity.prefix(12)) { a in
                                    HStack(spacing: 8) {
                                        if let u = a.userId { Av(name: name(u), size: 16) }
                                        Text("\(a.userId.map(name) ?? "") \(kindPt(a.kindK)) \(taskTitle(a.taskId))")
                                            .font(.system(size: 12)).foregroundStyle(T.text2).lineLimit(1)
                                        Spacer()
                                        if let at = a.at { Text(agoPt(at)).font(.mono(9.5)).foregroundStyle(T.dim2) }
                                    }
                                }
                            }
                        }
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
        .sheet(isPresented: $showNew) { NewTaskView { _ in } }
        .navigationDestination(item: $openTaskId) { id in
            TaskDetailView(taskId: id, title: tasks.first(where: { $0.id == id })?.title ?? "Tarefa")
        }
        .task {
            await load()
            if expanded.isEmpty, let first = members.first { expanded = [first] }
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(10)); await load() }
        }
    }

    private func personCard(_ uid: String) -> some View {
        let mine = tasks.filter { ($0.assignee ?? $0.createdBy) == uid }
        let active = mine.filter { !["merged", "done"].contains($0.status) && $0.flag != "closed" }
        let done = mine.filter { ["merged", "done", "review", "delivered"].contains($0.status) }.count
        let cost = mine.compactMap { $0.costUsd }.reduce(0, +)
        let online = isOnline(uid)
        let open = expanded.contains(uid)
        return VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.easeOut(duration: 0.2)) { if open { expanded.remove(uid) } else { expanded.insert(uid) } }
            } label: {
                HStack(spacing: 12) {
                    ZStack {
                        Circle().stroke(online ? T.accent.opacity(0.5) : T.lineHard, style: StrokeStyle(lineWidth: 1, dash: [3, 3])).frame(width: 44, height: 44)
                        Av(name: name(uid), size: 34)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(name(uid)).font(.system(size: 15, weight: .semibold)).foregroundStyle(T.text).lineLimit(1)
                        HStack(spacing: 6) {
                            Text(online ? "online agora" : (profiles[uid]?.lastSeenAt).map { "visto há \(agoPt($0))" } ?? "—")
                                .font(.mono(10.5)).foregroundStyle(online ? T.accent : T.dim2)
                            Text("· \(done) entrega\(done == 1 ? "" : "s")").font(.mono(10.5)).foregroundStyle(T.dim2)
                        }
                    }
                    Spacer()
                    if cost > 0 { Text(String(format: "$%.0f", cost)).font(.system(size: 15, weight: .semibold)).foregroundStyle(T.text) }
                    Image(systemName: open ? "chevron.up" : "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(T.dim2)
                }
            }.buttonStyle(.plain)
            if open {
                if active.isEmpty {
                    Text("nada em andamento").font(.system(size: 12)).foregroundStyle(T.dim2)
                }
                ForEach(active.prefix(4)) { t in
                    Button { openTaskId = t.id } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .top, spacing: 8) {
                                let b = T.kindBadge(t.kind)
                                Text(b.0).font(.mono(9, .bold)).kerning(0.6)
                                    .padding(.horizontal, 6).padding(.vertical, 3)
                                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(b.1.opacity(0.7)))
                                    .foregroundStyle(b.1)
                                Text(t.title).font(.system(size: 13)).foregroundStyle(T.text2).lineLimit(2)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 0)
                            }
                            ProgressLine(pct: T.pct(t), color: T.status(t.status, flag: t.flag).1)
                        }
                        .padding(.top, 10)
                        .overlay(Rectangle().fill(T.line).frame(height: 1), alignment: .top)
                    }.buttonStyle(.plain)
                }
            }
        }
        .card(stroke: online && open ? T.accent.opacity(0.35) : T.line)
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
