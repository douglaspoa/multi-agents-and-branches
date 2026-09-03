import SwiftUI

/// Tela 08 — Time: pessoas primeiro, depois PRs pra revisar, épicos e atividade.
struct TeamView: View {
    @EnvironmentObject var supa: Supa
    @State private var tasks: [CloudTask] = []
    @State private var profiles: [String: Profile] = [:]
    @State private var epics: [Epic] = []
    @State private var activity: [Activity] = []
    @State private var loaded = false
    @State private var openTaskId: String? = nil
    @State private var showNew = false

    private var members: [String] {
        var s: [String] = []
        for t in tasks { for u in [t.assignee, t.createdBy] { if let u, !s.contains(u) { s.append(u) } } }
        return s
    }
    private var doing: [CloudTask] { tasks.filter { ["running", "thinking", "queued"].contains($0.status) && $0.flag != "closed" } }
    private var prs: [CloudTask] { tasks.filter { $0.prUrl != nil && !["merged", "done"].contains($0.status) && $0.flag != "closed" } }
    private var weekDone: Int {
        tasks.filter { ["merged", "done", "review", "delivered"].contains($0.status) }.count
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if !loaded { BoardSkeleton() } else {
                    // KPIs
                    HStack(spacing: 12) {
                        kpi("\(doing.count)", "rodando")
                        kpi("\(weekDone)", "entregas")
                        kpi(String(format: "$%.0f", tasks.compactMap { $0.costUsd }.reduce(0, +)), "custo")
                        Spacer()
                        HStack(spacing: 5) { BlinkDot(); Text("AO VIVO").font(.system(size: 9, design: .monospaced).bold()).foregroundStyle(T.accent) }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 11)
                    .background(T.panel).overlay(RoundedRectangle(cornerRadius: 14).stroke(T.line))
                    .clipShape(RoundedRectangle(cornerRadius: 14))

                    // pessoas primeiro
                    VStack(alignment: .leading, spacing: 10) {
                        kicker("PESSOAS", T.accent, count: members.count)
                        ForEach(members, id: \.self) { uid in personCard(uid) }
                    }
                    // PRs pra revisar
                    if !prs.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            kicker("⇱ PRS PRA REVISAR", T.info, count: prs.count)
                            ForEach(prs) { t in
                                Button { openTaskId = t.id } label: {
                                    HStack(spacing: 9) {
                                        if let n = t.spec?.prInfo?.number { Text("#\(n)").font(.system(size: 11.5, design: .monospaced).bold()).foregroundStyle(T.info) }
                                        Text(t.title).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(1)
                                        Spacer()
                                        if let who = t.assignee ?? t.createdBy { Av(name: name(who), size: 18) }
                                        Text(agoPt(t.updatedAt)).font(.system(size: 10, design: .monospaced)).foregroundStyle(T.dim2)
                                    }.card(radius: 12)
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                    // atividade
                    if !activity.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            kicker("ATIVIDADE", T.dim)
                            ForEach(activity.prefix(12)) { a in
                                HStack(spacing: 8) {
                                    if let u = a.userId { Av(name: name(u), size: 16) }
                                    Text("\(a.userId.map(name) ?? "") \(kindPt(a.kindK)) \(taskTitle(a.taskId))")
                                        .font(.system(size: 12)).foregroundStyle(T.text2).lineLimit(1)
                                    Spacer()
                                    if let at = a.at { Text(agoPt(at)).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(T.dim2) }
                                }
                            }
                        }
                    }
                }
            }
            .padding(16).padding(.bottom, 80)
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
        .sheet(isPresented: $showNew) { NewTaskView { _ in } }
        .navigationDestination(item: $openTaskId) { id in
            TaskDetailView(taskId: id, title: tasks.first(where: { $0.id == id })?.title ?? "Tarefa")
        }
        .task {
            await load()
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(10)); await load() }
        }
    }

    private func kpi(_ v: String, _ l: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(v).font(.system(size: 17, design: .monospaced).bold()).foregroundStyle(T.text)
            Text(l).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(T.dim)
        }
    }

    private func personCard(_ uid: String) -> some View {
        let mine = tasks.filter { ($0.assignee ?? $0.createdBy) == uid }
        let running = mine.filter { ["running", "thinking"].contains($0.status) }
        let done = mine.filter { ["merged", "done", "review", "delivered"].contains($0.status) }.count
        let cost = mine.compactMap { $0.costUsd }.reduce(0, +)
        let online = isOnline(uid)
        return VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 9) {
                ZStack(alignment: .bottomTrailing) {
                    Av(name: name(uid), size: 30)
                    if online { Circle().fill(T.accent).frame(width: 8, height: 8).overlay(Circle().stroke(T.panel, lineWidth: 1.5)) }
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text(name(uid)).font(.system(size: 14, weight: .bold)).foregroundStyle(T.text)
                    Text(online ? "online agora" : (profiles[uid]?.lastSeenAt).map(agoPt) ?? "—")
                        .font(.system(size: 10, design: .monospaced)).foregroundStyle(online ? T.accent : T.dim2)
                }
                Spacer()
                HStack(spacing: 14) {
                    kpi("\(done)", "entregas")
                    kpi("\(running.count)", "rodando")
                    if cost > 0 { kpi(String(format: "$%.0f", cost), "custo") }
                }
            }
            ForEach(mine.filter { !["merged", "done"].contains($0.status) && $0.flag != "closed" }.prefix(3)) { t in
                Button { openTaskId = t.id } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 7) {
                            let b = T.kindBadge(t.kind)
                            Text(b.0).font(.system(size: 8.5, design: .monospaced).bold())
                                .padding(.horizontal, 5).padding(.vertical, 1.5)
                                .overlay(RoundedRectangle(cornerRadius: 4).stroke(b.1))
                                .foregroundStyle(b.1)
                            Text(t.title).font(.system(size: 12.5)).foregroundStyle(T.text2).lineLimit(1)
                            Spacer()
                        }
                        PhaseBar(phase: t.phase)
                    }
                    .padding(.top, 7)
                    .overlay(Rectangle().fill(T.line).frame(height: 1), alignment: .top)
                }.buttonStyle(.plain)
            }
        }.card()
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
            let data = try await supa.rest("tasks?select=id,title,status,flag,branch,pr_url,cost_usd,assignee,created_by,updated_at,spec&order=updated_at.desc&limit=150")
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
            await MainActor.run { tasks = ts; profiles = profs; activity = act; loaded = true }
        } catch { await MainActor.run { loaded = true } }
    }
}
