import SwiftUI

/// Inicia uma tarefa DO CELULAR: grava status='requested' na nuvem — o seu
/// Mac (com o projeto aberto) assume em segundos e o agente começa.
struct NewTaskView: View {
    @EnvironmentObject var supa: Supa
    @Environment(\.dismiss) var dismiss
    var onCreated: (String) -> Void

    struct Proj: Identifiable, Decodable {
        let id: String
        let name: String
        let teamId: String
        enum CodingKeys: String, CodingKey { case id, name, teamId = "team_id" }
    }

    @State private var title = ""
    @State private var objective = ""
    @State private var model = ""
    @State private var projects: [Proj] = []
    @State private var projectId = ""
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("O que fazer") {
                    TextField("título curto (ex.: Corrigir filtro de NCM)", text: $title)
                    TextField("descreva o objetivo com detalhes…", text: $objective, axis: .vertical)
                        .lineLimit(4...10)
                }
                .listRowBackground(T.panel)

                Section("Projeto") {
                    Picker("Projeto", selection: $projectId) {
                        ForEach(projects) { p in Text(p.name).tag(p.id) }
                    }
                }
                .listRowBackground(T.panel)

                Section("Versão do modelo") {
                    Picker("Modelo", selection: $model) {
                        Text("Padrão da assinatura").tag("")
                        Text("Opus — o mais capaz").tag("opus")
                        Text("Sonnet — equilíbrio").tag("sonnet")
                        Text("Haiku — o mais veloz").tag("haiku")
                    }
                }
                .listRowBackground(T.panel)

                if !error.isEmpty {
                    Text(error).font(.footnote).foregroundStyle(T.warn)
                        .listRowBackground(Color.clear)
                }

                Section {
                    Button {
                        Task { await create() }
                    } label: {
                        HStack { if busy { ProgressView() }; Text(busy ? "enviando…" : "iniciar no meu Mac ▸").bold() }
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty || projectId.isEmpty)
                    .listRowBackground(T.accent.opacity(title.isEmpty ? 0.3 : 1))
                    .foregroundStyle(.black)
                } footer: {
                    Text("O Constellation aberto no seu Mac assume o pedido em ~6s, cria a worktree e roda o agente. Acompanhe tudo ao vivo aqui.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(T.bg)
            .navigationTitle("Nova tarefa")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("fechar") { dismiss() } } }
            .task { await loadProjects() }
        }
        .preferredColorScheme(.dark)
    }

    private func loadProjects() async {
        if let d = try? await supa.rest("projects?select=id,name,team_id&order=name"),
           let ps = try? JSONDecoder().decode([Proj].self, from: d) {
            await MainActor.run {
                projects = ps
                if projectId.isEmpty { projectId = UserDefaults.standard.string(forKey: "lastProject") ?? ps.first?.id ?? "" }
                if !ps.contains(where: { $0.id == projectId }) { projectId = ps.first?.id ?? "" }
            }
        }
    }

    private func create() async {
        guard let proj = projects.first(where: { $0.id == projectId }), let me = supa.session?.userId else { return }
        busy = true; error = ""
        let t = title.trimmingCharacters(in: .whitespaces)
        var spec: [String: Any] = ["title": t, "objective": objective.trimmingCharacters(in: .whitespacesAndNewlines), "requirements": [], "engine": "claude", "kind": "build"]
        if !model.isEmpty { spec["model"] = model }
        do {
            let d = try await supa.rest("tasks?select=id", method: "POST", json: [
                "local_id": "mob-" + UUID().uuidString.prefix(8).lowercased(),
                "project_id": proj.id, "team_id": proj.teamId,
                "created_by": me, "assignee": me, "claim_mode": "reserved",
                "title": t, "status": "requested", "spec": spec,
            ])
            UserDefaults.standard.set(proj.id, forKey: "lastProject")
            if let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]], let id = arr.first?["id"] as? String {
                dismiss(); onCreated(id)
            } else { dismiss(); onCreated("") }
        } catch { self.error = error.localizedDescription }
        busy = false
    }
}
