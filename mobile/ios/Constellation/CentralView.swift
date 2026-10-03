import SwiftUI

/// Central — a fila na ordem em que ela te cobra (mesma decisão da barra lateral do desktop):
/// ESPERANDO VOCÊ primeiro (perguntas · teto · entregas prontas com o portão de prova), depois RODANDO,
/// PR aberto e concluídas hoje. Lista nativa inset-grouped, swipe pra pausar/parar/aprovar, puxar pra atualizar.
struct CentralView: View {
    @EnvironmentObject var supa: Supa
    @EnvironmentObject var router: PushRouter
    @EnvironmentObject var hub: SyncHub
    @State private var showNew = false
    @State private var openTaskId: String? = nil
    @State private var answering: Set<String> = []
    @State private var noProofFor: CloudTask? = nil
    @State private var stopFor: CloudTask? = nil

    private var visible: [CloudTask] { hub.visible }
    private var qByTask: [String: Question] {
        Dictionary(hub.myQuestions.compactMap { q in q.taskId.map { ($0, q) } }, uniquingKeysWith: { a, _ in a })
    }
    // "esperando VOCÊ" é literal: só o que é SEU (pergunta de demanda alheia o banco recusa — 0013)
    private var waiting: [CloudTask] {
        visible.filter { qByTask[$0.id] != nil && !$0.isEnded && hub.isMine($0) }
            .sorted { (qByTask[$0.id]?.isTeto == true ? 0 : 1) < (qByTask[$1.id]?.isTeto == true ? 0 : 1) }
    }
    private var running: [CloudTask] {
        visible.filter { t in (qByTask[t.id] == nil || !hub.isMine(t)) && !t.isEnded
            && ["running", "thinking", "queued", "requested", "plan-review", "error", "conflict", "paused"].contains(t.status) }
    }
    private var ready: [CloudTask] { visible.filter { !$0.isEnded && ["review", "delivered"].contains($0.status) && $0.prUrl == nil && qByTask[$0.id] == nil } }
    private var prOpen: [CloudTask] { visible.filter { !$0.isEnded && $0.prUrl != nil && !["merged", "done"].contains($0.status) } }
    private var doneToday: [CloudTask] {
        visible.filter { t in t.isEnded && (parseISO(t.updatedAt).map { Calendar.current.isDateInToday($0) } ?? false) }.prefix(8).map { $0 }
    }
    private var myCost: Double { visible.filter { hub.isMine($0) }.compactMap(\.costUsd).reduce(0, +) }

    var body: some View {
        List {
            Section {
                ConnStatusRow().rowStyle()
                ProjectFilterNote().rowStyle()
                if hub.loaded && !visible.isEmpty { stats.rowStyle() }
            }
            if !hub.loaded {
                Section { ForEach(0..<3, id: \.self) { _ in TaskRowSkeleton().rowStyle() } }
            } else if visible.isEmpty {
                Section {
                    EmptyBoard(title: "Nenhuma demanda ainda",
                               message: hub.projectFilter == nil ? "Mande a primeira daqui: o seu Mac assume, o agente trabalha e cada requisito volta com prova."
                                                                 : "Nada neste projeto. Troque o filtro ou crie uma demanda.",
                               symbol: "sparkles", action: ("Nova demanda", { showNew = true }))
                    .listRowBackground(Color.clear)
                }
            } else {
                if !waiting.isEmpty || !ready.isEmpty {
                    Section {
                        ForEach(waiting) { t in questionRow(t).rowStyle().taskSwipes(t, teto: qByTask[t.id]?.isTeto == true, onStop: { stopFor = $0 }, onNoProof: { noProofFor = $0 }) }
                        ForEach(ready) { t in readyRow(t).rowStyle().taskSwipes(t, onStop: { stopFor = $0 }, onNoProof: { noProofFor = $0 }) }
                    } header: {
                        SectionHead(title: "Esperando você", symbol: "hand.raised.fill", color: T.warn, count: waiting.count + ready.count)
                    }
                }
                Section {
                    if running.isEmpty {
                        Text("Nenhum agente rodando agora").font(.ui(14)).foregroundStyle(T.dim).rowStyle()
                    }
                    ForEach(running) { t in
                        NavigationLink(value: TaskRef(id: t.id)) {
                            VStack(alignment: .leading, spacing: 8) {
                                TaskRow(task: t, project: projName(t), lastLine: hub.lastFeed[t.id]?.text)
                                if hub.isMine(t), t.status == "requested" || t.status == "queued" { ReachNote(reach: hub.reach(t)) }
                            }
                        }
                        .rowStyle()
                        .taskSwipes(t, onStop: { stopFor = $0 }, onNoProof: { noProofFor = $0 })
                    }
                } header: {
                    SectionHead(title: "Rodando", symbol: "bolt.fill", color: T.accent, count: running.count)
                }
                if !prOpen.isEmpty {
                    Section {
                        ForEach(prOpen) { t in
                            NavigationLink(value: TaskRef(id: t.id)) { prRow(t) }.rowStyle()
                        }
                    } header: { SectionHead(title: "PR aberto", symbol: "arrow.triangle.pull", color: T.info, count: prOpen.count) }
                }
                if !doneToday.isEmpty {
                    Section {
                        ForEach(doneToday) { t in
                            NavigationLink(value: TaskRef(id: t.id)) {
                                HStack(spacing: 8) {
                                    Image(systemName: "checkmark.seal.fill").foregroundStyle(T.cyan)
                                    Text(t.title).font(.ui(14)).foregroundStyle(T.text2).lineLimit(1)
                                }
                            }.rowStyle()
                        }
                    } header: { SectionHead(title: "Concluídas hoje", symbol: "checkmark.seal", count: doneToday.count) }
                }
            }
        }
        .appList()
        .refreshable { await hub.refresh(); Haptic.select() }
        .navigationTitle("Central")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { ProjectFilterMenu() }
            ToolbarItem(placement: .topBarTrailing) { NewTaskToolbarButton { showNew = true } }
        }
        .sheet(isPresented: $showNew) { NewTaskView { id in if !id.isEmpty { openTaskId = id } } }
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
            TaskDetailView(taskId: r.id, title: hub.tasks.first(where: { $0.id == r.id })?.title ?? "Tarefa")
        }
        .navigationDestination(item: $openTaskId) { id in
            TaskDetailView(taskId: id, title: hub.tasks.first(where: { $0.id == id })?.title ?? "Tarefa")
        }
        .onChange(of: router.openTaskId) { _, id in if let id { openTaskId = id; router.openTaskId = nil } }
        .task {
            #if DEBUG
            if openTaskId == nil, let tid = ProcessInfo.processInfo.environment["DEMO_OPEN_TASK"], !tid.isEmpty {
                while !hub.loaded { try? await Task.sleep(for: .milliseconds(150)) }
                openTaskId = tid == "auto" ? (running.first ?? prOpen.first ?? ready.first ?? hub.tasks.first)?.id
                    : tid == "ready" ? (ready.first ?? hub.tasks.first)?.id
                    : tid == "pr" ? (prOpen.first ?? hub.tasks.first)?.id
                    : tid
            }
            if ProcessInfo.processInfo.environment["DEMO_NEW"] == "1" { showNew = true }
            #endif
            if let id = router.openTaskId { openTaskId = id; router.openTaskId = nil }
        }
    }

    // ---- resumo: 3 números de relance ----
    private var stats: some View {
        HStack(spacing: 0) {
            stat("\(running.count)", "rodando", T.text)
            Divider().overlay(T.line)
            stat("\(ready.count + waiting.count)", "esperam você", (ready.count + waiting.count) > 0 ? T.warn : T.text)
            Divider().overlay(T.line)
            stat(String(format: "$%.2f", myCost), "seu custo", T.text)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }
    private func stat(_ v: String, _ l: String, _ c: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(v).font(.ui(20, .semibold)).monospacedDigit().foregroundStyle(c).lineLimit(1).minimumScaleFactor(0.6)
            Text(l).font(.ui(12)).foregroundStyle(T.dim).lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 6)
    }

    private func projName(_ t: CloudTask) -> String? {
        guard hub.projectFilter == nil, hub.projectChips.count > 1 else { return nil }
        return hub.project(t.projectId)?.name
    }

    // ---- linhas que pedem você ----
    /// pergunta com as opções DIRETO na linha (e o teto de custo com as duas saídas)
    private func questionRow(_ t: CloudTask) -> some View {
        let q = qByTask[t.id]!
        let teto = q.isTeto
        let color = teto ? T.bad : T.warn
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                StatusWord(info: StatusInfo.of(t, waiting: true, teto: teto))
                Spacer(minLength: 6)
                Text(agoPt(q.createdAt)).font(.ui(12)).foregroundStyle(T.dim2)
            }
            Text(t.title).font(.ui(16, .semibold)).foregroundStyle(T.text).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if teto {
                Text("Pausada em \(fmtUsd(t.costUsd) ?? "$0") — nada se perde. Continuar libera mais um teto igual; parar deixa pra você revisar.")
                    .font(.ui(14)).foregroundStyle(T.text2).fixedSize(horizontal: false, vertical: true)
            } else {
                HStack(alignment: .top, spacing: 8) {
                    Av(name: q.agent.isEmpty ? "agente" : q.agent, size: 22)
                    mdText(q.prompt, size: 15, color: T.text)
                        .lineLimit(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if answering.contains(q.id) {
                IntentPill(label: "enviando a resposta…")
            } else {
                ForEach(q.options, id: \.self) { opt in
                    let stop = teto && opt.hasPrefix("Parar")
                    Button { answer(q, opt) } label: {
                        Text(opt).font(.ui(15, .semibold)).multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 4)
                    }
                    .buttonStyle(.bordered).buttonBorderShape(.roundedRectangle(radius: 12))
                    .tint(stop ? T.bad : T.accent)
                }
                if !teto {
                    Button { openTaskId = t.id } label: {
                        IconText(symbol: "square.and.pencil", text: "Responder com minhas palavras").font(.ui(13, .medium))
                    }
                    .buttonStyle(.borderless).tint(T.text2)
                }
            }
        }
        .padding(.vertical, 6)
        .overlay(alignment: .leading) { railBar(color) }
        .contentShape(Rectangle())
        .onTapGesture { openTaskId = t.id }
    }

    /// entrega pronta — com o PORTÃO DE PROVA (mesma regra do desktop, PR #100)
    private func readyRow(_ t: CloudTask) -> some View {
        let gate = ProofGate.gate(t)
        let nonCode = ["design", "invest"].contains(t.kind)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                StatusWord(info: StatusInfo.of(t))
                Spacer(minLength: 6)
                if let c = fmtUsd(t.costUsd) { Text(c).font(.mono(12)).monospacedDigit().foregroundStyle(T.text2) }
            }
            Text(t.title).font(.ui(16, .semibold)).foregroundStyle(T.text).lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            Group {
                switch gate {
                case .unproven(let miss):
                    IconText(symbol: "exclamationmark.circle.fill", text: "\(miss.count) requisito\(miss.count == 1 ? "" : "s") sem prova").foregroundStyle(T.warn)
                case .proven:
                    IconText(symbol: "checkmark.seal.fill", text: "Todos os requisitos com prova").foregroundStyle(T.accent)
                case .none:
                    IconText(symbol: "checkmark.circle", text: "Entrega pronta pra revisar").foregroundStyle(T.accent)
                }
            }
            .font(.ui(13, .medium))
            if let it = t.spec?.intent {
                IntentPill(label: "o Mac está executando · \(intentLabel(it.kind))")
            } else if nonCode {
                Button("Ver a entrega") { openTaskId = t.id }.buttonStyle(.bordered).tint(T.text2)
            } else if case .unproven = gate {
                HStack(spacing: 8) {
                    Button { Haptic.tap(); Task { _ = await hub.intent(t.id, "askProof") } } label: {
                        Text("Pedir a prova ao agente").font(.ui(14, .semibold)).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).tint(T.accent).foregroundStyle(T.onAccent)
                    Button("Ver") { openTaskId = t.id }.buttonStyle(.bordered).tint(T.text2)
                }
                Button { Haptic.warning(); noProofFor = t } label: {
                    Text("Aprovar sem prova…").font(.ui(13, .medium))
                }.buttonStyle(.borderless).tint(T.warn)
            } else {
                HStack(spacing: 8) {
                    Button { Haptic.success(); Task { _ = await hub.intent(t.id, "openPr") } } label: {
                        Text("Aprovar e abrir PR").font(.ui(14, .semibold)).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).tint(T.accent).foregroundStyle(T.onAccent)
                    Button("Ver") { openTaskId = t.id }.buttonStyle(.bordered).tint(T.text2)
                }
            }
            if let res = t.spec?.intentResult, t.spec?.intent == nil {
                IconText(symbol: res.ok ? "checkmark" : "xmark", text: "\(intentLabel(res.kind)): \(res.msg ?? (res.ok ? "feito" : "falhou"))", lines: 3)
                    .font(.ui(12)).foregroundStyle(res.ok ? T.accent : T.bad).fixedSize(horizontal: false, vertical: true)
            }
            ReachNote(reach: hub.reach(t))
        }
        .controlSize(.regular)
        .padding(.vertical, 6)
        .overlay(alignment: .leading) { railBar(T.accent) }
        .contentShape(Rectangle())
        .onTapGesture { openTaskId = t.id }
    }

    private func prRow(_ t: CloudTask) -> some View {
        let pr = t.spec?.prInfo
        let open = (pr?.comments ?? []).filter { !($0.answered ?? false) }.count
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if pr?.decision == "APPROVED" {
                    IconText(symbol: "checkmark.circle.fill", text: "Aprovado").foregroundStyle(T.accent)
                } else if pr?.decision == "CHANGES_REQUESTED" {
                    IconText(symbol: "exclamationmark.bubble.fill", text: "Mudanças pedidas").foregroundStyle(T.warn)
                } else {
                    IconText(symbol: "arrow.triangle.pull", text: "PR aberto").foregroundStyle(T.info)
                }
                Spacer(minLength: 6)
                if let n = pr?.number { Text("#\(n)").font(.mono(12, .semibold)).foregroundStyle(T.info) }
            }
            .font(.ui(12, .semibold))
            Text(t.title).font(.ui(16, .semibold)).foregroundStyle(T.text).lineLimit(2)
            HStack(spacing: 10) {
                ProofBadge(proved: t.reqsProved)
                if open > 0 { IconText(symbol: "text.bubble", text: "\(open)").font(.ui(12)).foregroundStyle(T.warn).accessibilityLabel("\(open) comentários abertos") }
                if let n = projName(t) { IconText(symbol: "folder", text: n).font(.ui(12)).foregroundStyle(T.dim).lineLimit(1).truncationMode(.middle) }
                Spacer(minLength: 0)
                Text(agoPt(t.updatedAt)).font(.ui(12)).foregroundStyle(T.dim2)
            }
        }
        .padding(.vertical, 4)
    }

    private func railBar(_ c: Color) -> some View {
        Capsule().fill(c).frame(width: 3).padding(.vertical, 4).offset(x: -12)
            .accessibilityHidden(true)
    }

    // ---- ações ----
    private func answer(_ q: Question, _ opt: String) {
        Haptic.success()
        answering.insert(q.id)
        Task {
            _ = await hub.answer(q, opt)
            answering.remove(q.id)
        }
    }
}

func intentLabel(_ k: String) -> String {
    switch k {
    case "openPr": return "abrir PR"
    case "merge": return "merge"
    case "pause": return "pausar"
    case "resume": return "retomar"
    case "stop": return "parar o turno"
    case "abort": return "abortar"
    case "fixComment": return "aplicar correção"
    case "askProof": return "pedir a prova"
    default: return k
    }
}
