import SwiftUI

/// Quadro do time (leitura): rodando · pra review · finalizadas — com PR link.
struct TasksView: View {
    @EnvironmentObject var supa: Supa
    @State private var tasks: [CloudTask] = []
    @State private var profiles: [String: Profile] = [:]
    @State private var loaded = false
    @State private var error = ""
    @State private var showNew = false
    @State private var openTaskId: String? = nil

    private var doing: [CloudTask] { tasks.filter { $0.flag != "closed" && ["running", "thinking", "queued", "plan-review", "error", "conflict"].contains($0.status) } }
    private var review: [CloudTask] { tasks.filter { $0.flag != "closed" && ["review", "delivered"].contains($0.status) } }
    private var done: [CloudTask] { tasks.filter { $0.flag == "closed" || ["merged", "done"].contains($0.status) } }
    private var backlog: [CloudTask] { tasks.filter { $0.flag != "closed" && $0.status == "backlog" } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(T.warn) }
                section("● RODANDO AGORA", doing, empty: "nenhum agente rodando")
                section("◆ PRONTAS PRA REVIEW", review, empty: "nada esperando review")
                section("○ BACKLOG", backlog, empty: "backlog vazio")
                section("✓ FINALIZADAS", Array(done.prefix(20)), empty: "—")
            }
            .padding(14)
        }
        .background(T.bg)
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNew = true } label: {
                    Image(systemName: "plus.circle.fill").foregroundStyle(T.accent)
                }
            }
        }
        .sheet(isPresented: $showNew) {
            NewTaskView { createdId in if !createdId.isEmpty { openTaskId = createdId } }
        }
        .navigationDestination(item: $openTaskId) { id in
            TaskDetailView(taskId: id, title: tasks.first(where: { $0.id == id })?.title ?? "Tarefa")
        }
        .task {
            await load()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(6))
                await load()
            }
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ list: [CloudTask], empty: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(.caption, design: .monospaced).bold())
                .foregroundStyle(T.dim).kerning(1)
            if list.isEmpty {
                Text(empty).font(.caption).foregroundStyle(T.dim.opacity(0.6))
            }
            ForEach(list) { t in row(t) }
        }
    }

    @ViewBuilder
    private func row(_ t: CloudTask) -> some View {
        let st = T.status(t.status, flag: t.flag)
        Button { openTaskId = t.id } label: { rowBody(t, st) }
            .buttonStyle(.plain)
    }

    @ViewBuilder
    private func rowBody(_ t: CloudTask, _ st: (String, Color)) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(t.title).font(.subheadline).foregroundStyle(T.text).lineLimit(2)
            HStack(spacing: 8) {
                Circle().fill(st.1).frame(width: 7, height: 7)
                Text(st.0).font(.system(.caption2, design: .monospaced)).foregroundStyle(st.1)
                if let who = t.assignee ?? t.createdBy, let p = profiles[who] {
                    Text(p.name ?? p.email ?? "").font(.caption2).foregroundStyle(T.dim).lineLimit(1)
                }
                Spacer()
                if let c = t.costUsd, c > 0 {
                    Text(String(format: "$%.2f", c)).font(.system(.caption2, design: .monospaced)).foregroundStyle(T.dim)
                }
                if let pr = t.prUrl, let url = URL(string: pr) {
                    Link(destination: url) {
                        Text("PR ↗").font(.system(.caption2, design: .monospaced).bold()).foregroundStyle(T.accent)
                    }
                }
                Text(agoPt(t.updatedAt)).font(.caption2).foregroundStyle(T.dim)
            }
        }
        .card()
    }

    private func load() async {
        do {
            let data = try await supa.rest("tasks?select=id,title,status,flag,branch,pr_url,cost_usd,assignee,created_by,updated_at&order=updated_at.desc&limit=150")
            let ts = try JSONDecoder().decode([CloudTask].self, from: data)
            var profs = profiles
            let missing = Set(ts.compactMap { $0.assignee ?? $0.createdBy }).subtracting(profs.keys)
            if !missing.isEmpty {
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
