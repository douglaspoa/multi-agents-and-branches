import SwiftUI

/// Inicia uma tarefa DO CELULAR com as mesmas opções do desktop: modo
/// (feature/fix/design/investigação), requisitos, issue, entregáveis, modelo.
/// Grava status='requested' na nuvem — o Mac do dono assume e roda.
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

    enum Mode: String, CaseIterable, Identifiable {
        case feature = "Feature", fix = "Fix", design = "Design", invest = "Investigação"
        var id: String { rawValue }
        var branchType: String { switch self { case .feature: "feat"; case .fix: "fix"; case .design: "design"; case .invest: "invest" } }
        var kind: String { switch self { case .design: "design"; case .invest: "invest"; default: "build" } }
        var hint: String {
            switch self {
            case .feature: "implementa e abre caminho pro PR"
            case .fix: "correção com prova real + testes por padrão"
            case .design: "mockups/UX antes do código — gera DESIGN.md, sem PR"
            case .invest: "acha a CAUSA RAIZ com evidência — gera INVESTIGATION.md, sem PR"
            }
        }
    }

    @State private var mode: Mode = .feature
    @State private var title = ""
    @State private var objective = ""
    @State private var reqs: [String] = []
    @State private var newReq = ""
    @State private var issue = ""
    @State private var model = ""
    @State private var artDoc = false
    @State private var artProof = true
    @State private var artTests = false
    @State private var autoPr = "ask"
    @State private var projects: [Proj] = []
    @State private var projectId = ""
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Tipo", selection: $mode) {
                        // rótulo curto — "Investigação" espremia os 4 segmentos
                        ForEach(Mode.allCases) { m in Text(m == .invest ? "Invest." : m.rawValue).tag(m) }
                    }
                    .pickerStyle(.segmented)
                    Text(mode.hint).font(.caption2).foregroundStyle(T.dim)
                }
                .listRowBackground(T.panel)
                .onChange(of: mode) { _, m in
                    switch m {
                    case .fix: artProof = true; artTests = true; artDoc = false; autoPr = "ask"
                    case .design, .invest: artProof = false; artTests = false; artDoc = true; autoPr = "no"
                    case .feature: artProof = true; artTests = false; artDoc = false; autoPr = "ask"
                    }
                }

                Section("O que fazer") {
                    TextField("título curto (ou deixe o agente te surpreender)", text: $title)
                    TextField(mode == .invest ? "o que investigar? sintoma, onde acontece…" : "descreva o objetivo com detalhes…", text: $objective, axis: .vertical)
                        .lineLimit(4...10)
                }
                .listRowBackground(T.panel)

                Section("Requisitos (critérios de aceite)") {
                    ForEach(Array(reqs.enumerated()), id: \.offset) { i, r in
                        HStack {
                            Text("• " + r).font(.footnote)
                            Spacer()
                            Button { reqs.remove(at: i) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(T.dim) }
                        }
                    }
                    HStack {
                        TextField("ex.: testar na UI real com prints", text: $newReq)
                            .font(.footnote)
                            .onSubmit { addReq() }
                        Button { addReq() } label: { Image(systemName: "plus.circle.fill").foregroundStyle(T.accent) }
                            .disabled(newReq.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                .listRowBackground(T.panel)

                Section("Issue (aparece no nome da branch)") {
                    TextField("código — ex.: FND-853", text: $issue)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                }
                .listRowBackground(T.panel)

                if mode == .feature || mode == .fix {
                    Section("Entregáveis exigidos") {
                        Toggle("Prova real (prints/execução na UI)", isOn: $artProof)
                        Toggle("Testes na suíte do projeto", isOn: $artTests)
                        Toggle("Documento de arquitetura", isOn: $artDoc)
                    }
                    .listRowBackground(T.panel)
                    .tint(T.accent)

                    Section("Pull request ao concluir") {
                        Picker("PR", selection: $autoPr) {
                            Text("Perguntar quando pronta").tag("ask")
                            Text("Abrir sozinho (sem pendências)").tag("auto")
                            Text("Não abrir").tag("no")
                        }
                    }
                    .listRowBackground(T.panel)
                }

                Section("Projeto e modelo") {
                    Picker("Projeto", selection: $projectId) {
                        ForEach(projects) { p in Text(p.name).tag(p.id) }
                    }
                    Picker("Modelo", selection: $model) {
                        Text("Padrão da assinatura").tag("")
                        Text("Opus — o mais capaz").tag("opus")
                        Text("Sonnet — equilíbrio").tag("sonnet")
                        Text("Haiku — o mais veloz").tag("haiku")
                    }
                }
                .listRowBackground(T.panel)

                if !error.isEmpty {
                    Text(error).font(.footnote).foregroundStyle(T.warn).listRowBackground(Color.clear)
                }

                Section {
                    Button {
                        Task { await create() }
                    } label: {
                        HStack { if busy { ProgressView() }; Text(busy ? "enviando…" : "iniciar no meu Mac ▸").bold() }
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(busy || objective.trimmingCharacters(in: .whitespaces).isEmpty || projectId.isEmpty)
                    .listRowBackground(T.accent.opacity(objective.isEmpty ? 0.3 : 1))
                    .foregroundStyle(.black)
                } footer: {
                    Text("O Constellation aberto no seu Mac assume em ~6s, cria a branch \(mode.branchType)/\(issue.isEmpty ? "" : issue.uppercased() + "-")… e roda o agente. Acompanhe ao vivo aqui.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(T.bg)
            .navigationTitle("Nova demanda")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("fechar") { dismiss() } } }
            .task { await loadProjects() }
        }
        .preferredColorScheme(.dark)
    }

    private func addReq() {
        let r = newReq.trimmingCharacters(in: .whitespaces)
        guard !r.isEmpty else { return }
        reqs.append(r); newReq = ""
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
        var t = title.trimmingCharacters(in: .whitespaces)
        let obj = objective.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { t = String(obj.prefix(70)) }
        var spec: [String: Any] = [
            "title": t, "objective": obj,
            "requirements": reqs, "engine": "claude",
            "kind": mode.kind, "branchType": mode.branchType,
            "proof": artProof, "tests": artTests,
            "autoPr": mode == .design || mode == .invest ? "no" : autoPr,
        ]
        if artDoc || mode == .design || mode == .invest {
            spec["doc"] = mode == .design ? "DESIGN.md" : mode == .invest ? "INVESTIGATION.md" : "ARCHITECTURE.md"
        }
        if !model.isEmpty { spec["model"] = model }
        let code = issue.trimmingCharacters(in: .whitespaces).uppercased()
        if !code.isEmpty { spec["issueCode"] = code }
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
