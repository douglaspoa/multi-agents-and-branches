import SwiftUI

/// A aba mais importante: perguntas ABERTAS dos agentes (ask_human).
/// Responder aqui → o Mac entrega a resposta ao agente e o turno continua.
struct QuestionsView: View {
    @EnvironmentObject var supa: Supa
    @State private var questions: [Question] = []
    @State private var loaded = false
    @State private var answering: String? = nil
    @State private var freeText = ""
    @State private var error = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if !loaded {
                    QuestionCardSkeleton()
                    QuestionCardSkeleton()
                }
                if !error.isEmpty {
                    Text(error).font(.footnote).foregroundStyle(T.warn)
                }
                if loaded && questions.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "checkmark.circle")
                            .font(.largeTitle).foregroundStyle(T.accent)
                        Text("Nenhum agente esperando você")
                            .foregroundStyle(T.text).font(.headline)
                        Text("Quando um agente perguntar algo (ask_human), aparece aqui na hora — responda e ele continua sozinho.")
                            .font(.footnote).foregroundStyle(T.dim)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 80)
                }
                ForEach(questions) { q in
                    questionCard(q)
                }
            }
            .padding(14)
            .animation(.easeOut(duration: 0.25), value: loaded)
        }
        .background(T.bg)
        .refreshable { await load() }
        .task {
            await load()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await load()
            }
        }
    }

    @ViewBuilder
    private func questionCard(_ q: Question) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(q.agent.isEmpty ? "agente" : q.agent)
                    .font(.system(.caption, design: .monospaced).bold())
                    .foregroundStyle(T.warn)
                Spacer()
                Text(agoPt(q.createdAt)).font(.caption2).foregroundStyle(T.dim)
            }
            if let t = q.task?.title {
                Text(t).font(.caption).foregroundStyle(T.dim).lineLimit(1)
            }
            Text(q.prompt)
                .font(.callout)
                .foregroundStyle(T.text)

            if !q.options.isEmpty {
                VStack(spacing: 8) {
                    ForEach(q.options, id: \.self) { opt in
                        Button {
                            Task { await answer(q, text: opt) }
                        } label: {
                            Text(opt)
                                .font(.system(.footnote, design: .monospaced))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10)
                                .background(T.accent.opacity(0.12))
                                .foregroundStyle(T.accent)
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(T.accent.opacity(0.4)))
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .disabled(answering == q.id)
                    }
                }
            }
            HStack(spacing: 8) {
                TextField("ou responda com suas palavras…", text: $freeText, axis: .vertical)
                    .font(.footnote)
                    .padding(9)
                    .background(T.bg)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(T.line))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                Button {
                    let t = freeText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty else { return }
                    Task { await answer(q, text: t) }
                } label: {
                    if answering == q.id { ProgressView().tint(T.accent) }
                    else { Image(systemName: "paperplane.fill").foregroundStyle(T.accent) }
                }
                .disabled(answering == q.id)
            }
        }
        .card()
        .overlay(alignment: .leading) {
            Rectangle().fill(T.warn).frame(width: 3)
                .clipShape(RoundedRectangle(cornerRadius: 2))
        }
    }

    private func load() async {
        do {
            let data = try await supa.rest("questions?select=id,agent,prompt,options,created_at,tasks(title)&status=eq.open&order=created_at.desc&limit=30")
            let qs = try JSONDecoder().decode([Question].self, from: data)
            await MainActor.run { self.questions = qs; self.loaded = true; self.error = "" }
        } catch {
            await MainActor.run { if self.loaded { self.error = error.localizedDescription } ; self.loaded = true }
        }
    }

    private func answer(_ q: Question, text: String) async {
        answering = q.id
        do {
            _ = try await supa.rest("questions?id=eq.\(q.id)", method: "PATCH", json: [
                "status": "answered", "answer": text,
                "answered_by": supa.session?.userId ?? "",
                "answered_at": ISO8601DateFormatter().string(from: Date()),
            ])
            freeText = ""
            await load()
        } catch {
            self.error = error.localizedDescription
        }
        answering = nil
    }
}
