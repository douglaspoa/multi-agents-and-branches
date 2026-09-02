import SwiftUI

/// A tarefa AO VIVO: feed do agente (o Mac publica os passos) + chat direto
/// com o agente + perguntas abertas desta tarefa. Poll de 3s.
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

    @State private var status = ""
    @State private var flag: String? = nil
    @State private var prUrl: String? = nil
    @State private var feed: [FeedItem] = []
    @State private var lastId = 0
    @State private var msg = ""
    @State private var sending = false
    @State private var question: Question? = nil
    @State private var error = ""

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        if feed.isEmpty {
                            Text("esperando o agente… os passos aparecem aqui ao vivo")
                                .font(.footnote).foregroundStyle(T.dim).padding(.top, 30)
                                .frame(maxWidth: .infinity)
                        }
                        ForEach(feed) { f in feedRow(f).id(f.id) }
                    }
                    .padding(12)
                }
                .onChange(of: feed.count) { _, _ in
                    if let last = feed.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            if let q = question { questionBar(q) }
            inputBar
        }
        .background(T.bg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            while !Task.isCancelled {
                await tick()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private var header: some View {
        let st = T.status(status, flag: flag)
        return HStack(spacing: 8) {
            Circle().fill(st.1).frame(width: 8, height: 8)
            Text(st.0).font(.system(.caption, design: .monospaced).bold()).foregroundStyle(st.1)
            if status == "requested" {
                Text("· esperando seu Mac assumir").font(.caption2).foregroundStyle(T.dim)
            }
            Spacer()
            if let pr = prUrl, let url = URL(string: pr) {
                Link("PR ↗", destination: url)
                    .font(.system(.caption, design: .monospaced).bold()).foregroundStyle(T.accent)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .background(T.panel)
    }

    @ViewBuilder
    private func feedRow(_ f: FeedItem) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(icon(f.kind)).font(.caption)
            VStack(alignment: .leading, spacing: 2) {
                Text(f.text)
                    .font(f.kind == "bash" ? .system(.caption, design: .monospaced) : .footnote)
                    .foregroundStyle(color(f.kind))
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    private func icon(_ k: String) -> String {
        switch k {
        case "bash": return "$"
        case "edit", "write": return "✎"
        case "error": return "✖"
        case "done": return "✔"
        case "think": return "·"
        default: return "•"
        }
    }
    private func color(_ k: String) -> Color {
        switch k {
        case "bash": return T.dim
        case "edit", "write": return T.accent
        case "error": return T.bad
        case "done": return T.accent
        case "think": return T.text.opacity(0.85)
        default: return T.dim
        }
    }

    @ViewBuilder
    private func questionBar(_ q: Question) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("❓ \(q.agent.isEmpty ? "agente" : q.agent) pergunta:").font(.caption.bold()).foregroundStyle(T.warn)
            Text(q.prompt).font(.footnote).foregroundStyle(T.text).lineLimit(4)
            if !q.options.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(q.options, id: \.self) { opt in
                            Button(opt) { Task { await answerQuestion(q, text: opt) } }
                                .font(.system(.caption2, design: .monospaced))
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(T.warn.opacity(0.15)).foregroundStyle(T.warn)
                                .clipShape(Capsule())
                        }
                    }
                }
            }
            Text("ou responda no campo abaixo ↓").font(.caption2).foregroundStyle(T.dim)
        }
        .padding(12)
        .background(T.warn.opacity(0.07))
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField(question != nil ? "responda a pergunta…" : "fale com o agente…", text: $msg, axis: .vertical)
                .font(.footnote)
                .padding(10)
                .background(T.panel)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.line))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            Button {
                Task { await send() }
            } label: {
                if sending { ProgressView().tint(T.accent) }
                else { Image(systemName: "paperplane.fill").foregroundStyle(T.accent).font(.title3) }
            }
            .disabled(sending || msg.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(10)
        .background(T.bg)
    }

    private func tick() async {
        // status + PR
        if let d = try? await supa.rest("tasks?select=status,flag,pr_url&id=eq.\(taskId)"),
           let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]], let t = arr.first {
            await MainActor.run {
                status = t["status"] as? String ?? status
                flag = t["flag"] as? String
                prUrl = t["pr_url"] as? String
            }
        }
        // feed incremental
        if let d = try? await supa.rest("task_feed?select=id,agent,kind,text,at&task_id=eq.\(taskId)&id=gt.\(lastId)&order=id&limit=120"),
           let items = try? JSONDecoder().decode([FeedItem].self, from: d), !items.isEmpty {
            await MainActor.run { feed.append(contentsOf: items); if feed.count > 400 { feed.removeFirst(feed.count - 400) }; lastId = items.last!.id }
        }
        // pergunta aberta desta tarefa
        if let d = try? await supa.rest("questions?select=id,agent,prompt,options,created_at&task_id=eq.\(taskId)&status=eq.open&order=id.desc&limit=1"),
           let qs = try? JSONDecoder().decode([Question].self, from: d) {
            await MainActor.run { question = qs.first }
        }
    }

    private func send() async {
        let text = msg.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        do {
            if let q = question {
                await answerQuestion(q, text: text)      // pergunta aberta → responde (turno continua)
            } else {
                _ = try await supa.rest("task_messages", method: "POST", json: ["task_id": taskId, "author": supa.session?.userId ?? "", "body": text])
            }
            await MainActor.run { msg = "" }
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
