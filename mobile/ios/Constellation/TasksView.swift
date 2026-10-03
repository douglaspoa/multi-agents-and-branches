import SwiftUI

/// Minhas — seu quadro por estado (Rodando · Review · Backlog · Feitas) num controle segmentado;
/// o que espera você fica no topo de "Rodando". `mine=false` mostra o quadro inteiro (com o dono na linha).
struct TasksView: View {
    @EnvironmentObject var supa: Supa
    @EnvironmentObject var router: PushRouter
    @EnvironmentObject var hub: SyncHub
    var mine = false
    @State private var profiles: [String: Profile] = [:]
    @State private var showNew = false
    @State private var openTaskId: String? = nil
    @State private var filter = 0   // 0 rodando · 1 review · 2 backlog · 3 feitas
    @State private var noProofFor: CloudTask? = nil
    @State private var stopFor: CloudTask? = nil

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
    private let names = ["Rodando", "Review", "Backlog", "Feitas"]
    private let empties: [(String, String, String)] = [
        ("Nenhum agente rodando", "Quando você mandar uma demanda, ela aparece aqui enquanto o agente trabalha no seu Mac.", "bolt.slash"),
        ("Nada esperando review", "Entregas prontas chegam aqui com a prova de cada requisito.", "checkmark.seal"),
        ("Backlog vazio", "Rascunhos e demandas na fila aparecem aqui.", "tray"),
        ("Nada concluído ainda", "Demandas integradas ficam guardadas aqui.", "archivebox"),
    ]

    var body: some View {
        List {
            Section {
                ConnStatusRow().rowStyle()
                ProjectFilterNote().rowStyle()
            }
            Section {
                Picker("Estado", selection: $filter) {
                    ForEach(0..<4, id: \.self) { i in Text(names[i]).tag(i) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .accessibilityIdentifier("estado")
            }
            if !loaded {
                Section { ForEach(0..<3, id: \.self) { _ in TaskRowSkeleton().rowStyle() } }
            } else {
                let list = filter == 3 ? Array(lists[3].prefix(40)) : lists[filter]
                if list.isEmpty {
                    Section {
                        EmptyBoard(title: empties[filter].0, message: empties[filter].1, symbol: empties[filter].2,
                                   action: filter == 0 ? ("Nova demanda", { showNew = true }) : nil)
                            .listRowBackground(Color.clear)
                    }
                } else {
                    let w = filter == 0 ? list.filter { openQ.contains($0.id) } : []
                    let rest = filter == 0 ? list.filter { !openQ.contains($0.id) } : list
                    if !w.isEmpty {
                        Section {
                            ForEach(w) { t in row(t) }
                        } header: { SectionHead(title: "Esperando você", symbol: "hand.raised.fill", color: T.warn, count: w.count) }
                    }
                    Section {
                        ForEach(rest) { t in row(t) }
                    } header: {
                        SectionHead(title: names[filter], count: rest.count)
                    }
                }
            }
        }
        .appList()
        .animation(.easeOut(duration: 0.2), value: filter)
        .onChange(of: filter) { _, _ in Haptic.select() }
        .refreshable { await hub.refresh(); Haptic.select() }
        .navigationTitle(mine ? "Minhas" : "Quadro")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { ProjectFilterMenu() }
            ToolbarItem(placement: .topBarTrailing) { NewTaskToolbarButton { showNew = true } }
        }
        .sheet(isPresented: $showNew) {
            NewTaskView { createdId in if !createdId.isEmpty { openTaskId = createdId } }
        }
        .sheet(item: $noProofFor) { t in
            if case .unproven(let miss) = ProofGate.gate(t) {
                ApproveNoProofSheet(missing: miss) { reason in
                    Task { _ = await hub.intent(t.id, "openPr", extra: ["noProofReason": reason, "missing": miss.map(\.text)]) }
                }
            }
        }
        .confirmationDialog("Parar o turno do agente?", isPresented: Binding(get: { stopFor != nil }, set: { if !$0 { stopFor = nil } }), titleVisibility: .visible, presenting: stopFor) { t in
            Button("Parar o turno", role: .destructive) { Task { _ = await hub.intent(t.id, "stop") } }
            Button("Cancelar", role: .cancel) {}
        } message: { _ in Text("O agente termina o que está fazendo agora e a demanda volta pra você revisar.") }
        .navigationDestination(for: TaskRef.self) { r in
            TaskDetailView(taskId: r.id, title: tasks.first(where: { $0.id == r.id })?.title ?? "Tarefa")
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

    private func row(_ t: CloudTask) -> some View {
        let isWaiting = openQ.contains(t.id)
        let teto = hub.myQuestions.contains { $0.taskId == t.id && $0.isTeto }
        let owner: String? = mine ? nil : (t.assignee ?? t.createdBy).flatMap { profiles[$0] }.map { $0.name ?? $0.email ?? "" }
        return NavigationLink(value: TaskRef(id: t.id)) {
            TaskRow(task: t, waiting: isWaiting, teto: teto,
                    project: hub.projectFilter == nil && hub.projectChips.count > 1 ? hub.project(t.projectId)?.name : nil,
                    owner: owner)
        }
        .rowStyle()
        .taskSwipes(t, teto: teto, onStop: { stopFor = $0 }, onNoProof: { noProofFor = $0 })
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
