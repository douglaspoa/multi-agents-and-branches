import SwiftUI

/// Tela 01 — Central: a fila na ordem em que ela te cobra.
/// Conexão e Mac no topo (honesto), filtro de projeto, ESPERAM VOCÊ (teto · perguntas · entregas com o
/// portão de prova), EM ÓRBITA (agentes rodando), PR aberto e concluídas hoje. Dados da sincronia única.
struct CentralView: View {
    @EnvironmentObject var supa: Supa
    @EnvironmentObject var router: PushRouter
    @EnvironmentObject var hub: SyncHub
    @State private var showNew = false
    @State private var openTaskId: String? = nil
    @State private var answering: Set<String> = []
    @State private var noProofFor: CloudTask? = nil

    private var visible: [CloudTask] { hub.visible }
    private var qByTask: [String: Question] {
        Dictionary(hub.myQuestions.compactMap { q in q.taskId.map { ($0, q) } }, uniquingKeysWith: { a, _ in a })
    }
    // "esperando VOCÊ" é literal: só o que é SEU (pergunta de demanda alheia o banco recusa — 0013)
    private var waiting: [CloudTask] { visible.filter { qByTask[$0.id] != nil && !$0.isEnded && hub.isMine($0) } }
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
        ZStack(alignment: .top) {
            T.bg.ignoresSafeArea()
            Starfield(seed: 5).frame(height: 420).frame(maxHeight: .infinity, alignment: .top)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    PageHeader(kicker: "Starfork", title: "Central",
                               sub: hub.loaded ? "\(running.count) agente\(running.count == 1 ? "" : "s") em órbita · \(ready.count + waiting.count) esperando você" : "sincronizando com a nuvem…",
                               live: true)
                    ConnBanner(compact: true)
                    ProjectChips()
                    if !hub.loaded { BoardSkeleton() } else {
                        StatRow(items: [
                            .init(value: "\(running.count)", label: "em órbita"),
                            .init(value: "\(ready.count + waiting.count)", label: "esperam você", color: T.accent),
                            .init(value: String(format: "$%.2f", myCost), label: "seu custo"),
                        ])
                        if !waiting.isEmpty || !ready.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                kicker("esperam você", T.accent, count: waiting.count + ready.count, dot: true)
                                ForEach(waiting) { t in questionCard(t) }
                                ForEach(ready) { t in readyCard(t) }
                            }
                        }
                        section("em órbita", T.warn, running, empty: hub.tasks.isEmpty ? "nenhuma demanda ainda — toque no + pra mandar a primeira pro seu Mac" : "nenhum agente rodando agora") { t in orbitCard(t) }
                        section("PR aberto", T.info, prOpen, empty: nil) { t in prCard(t) }
                        section("concluídas hoje", T.dim, doneToday, empty: nil) { t in doneRow(t) }
                    }
                }
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 96)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable { await hub.refresh() }
        }
        .overlay(alignment: .bottomTrailing) { fab }
        .sheet(isPresented: $showNew) { NewTaskView { id in if !id.isEmpty { openTaskId = id } } }
        .sheet(item: $noProofFor) { t in
            if case .unproven(let miss) = ProofGate.gate(t) {
                ApproveNoProofSheet(missing: miss) { reason in
                    Task { _ = await hub.intent(t.id, "openPr", extra: ["noProofReason": reason, "missing": miss.map(\.text)]) }
                }
            }
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

    private var fab: some View {
        Button { showNew = true } label: {
            Image(systemName: "plus").font(.system(size: 22, weight: .bold)).foregroundStyle(T.onAccent)
                .frame(width: 56, height: 56)
                .background(LinearGradient(colors: [T.accent, T.accent2], startPoint: .top, endPoint: .bottom))
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .shadow(color: T.accent.opacity(0.45), radius: 18, y: 6)
        }
        .padding(.trailing, 20).padding(.bottom, 18)
        .accessibilityLabel("nova demanda")
    }

    // ---- seções ----
    @ViewBuilder private func section(_ label: String, _ color: Color, _ list: [CloudTask], empty: String?, @ViewBuilder row: @escaping (CloudTask) -> some View) -> some View {
        if !list.isEmpty || empty != nil {
            VStack(alignment: .leading, spacing: 10) {
                kicker(label, color, count: list.count, dot: true)
                if list.isEmpty, let e = empty {
                    Text(e).font(.system(size: 12.5)).foregroundStyle(T.dim2).padding(.vertical, 6)
                }
                ForEach(list) { t in
                    Button { openTaskId = t.id } label: { row(t) }.buttonStyle(.plain)
                }
            }
        }
    }

    private func projName(_ t: CloudTask) -> String? {
        guard hub.projectFilter == nil, hub.projectChips.count > 1 else { return nil }
        return hub.project(t.projectId)?.name
    }

    // ---- cards ----
    /// EM ÓRBITA: avatar + título + última fala + barra + status · provas · custo · tempo
    private func orbitCard(_ t: CloudTask) -> some View {
        let st = T.status(t.status, flag: t.flag)
        let who = t.issueCode ?? String(t.id.suffix(2))
        let reach = hub.reach(t)
        return HStack(alignment: .top, spacing: 12) {
            Av(name: who, size: 30)
            VStack(alignment: .leading, spacing: 8) {
                Text(t.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                if let f = hub.lastFeed[t.id] {
                    let g = feedGlyph(f.kind)
                    HStack(spacing: 6) {
                        Text(g.0).font(.mono(11)).foregroundStyle(g.1)
                        Text(f.text).font(.mono(11)).foregroundStyle(T.dim).lineLimit(1).truncationMode(.tail)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                ProgressLine(pct: T.pct(t), color: st.1)
                HStack(spacing: 8) {
                    Text(st.0).font(.mono(11)).foregroundStyle(st.1)
                    if let p = t.reqsProved { Text("✓\(p.done)/\(p.total)").font(.mono(11)).foregroundStyle(p.done == p.total ? T.accent : T.dim) }
                    if let n = projName(t) { Text(n).font(.mono(10)).foregroundStyle(T.info).lineLimit(1) }
                    Spacer()
                    Text([fmtUsd(t.costUsd), agoPt(t.updatedAt)].compactMap { $0 }.joined(separator: " · "))
                        .font(.mono(11)).foregroundStyle(T.dim2)
                }
                if hub.isMine(t), t.status == "requested" || t.status == "queued" { ReachNote(reach: reach) }
            }
        }
        .card()
        .rail(agentColor(who))
    }

    /// pergunta com as opções DIRETO no card (e o teto de custo com as duas saídas)
    private func questionCard(_ t: CloudTask) -> some View {
        let q = qByTask[t.id]!
        let teto = q.isTeto
        let color = teto ? T.bad : T.warn
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if teto { Image(systemName: "gauge.with.dots.needle.100percent").foregroundStyle(color) } else { Av(name: q.agent, size: 22) }
                Text(teto ? "TETO DE CUSTO" : "\(q.agent) · perguntou".uppercased()).font(.mono(10, .bold)).kerning(1).foregroundStyle(color)
                Spacer()
                Text(agoPt(q.createdAt)).font(.mono(10.5)).foregroundStyle(T.dim)
            }
            Text(t.title).font(.mono(12)).foregroundStyle(T.dim).lineLimit(1)
            if teto {
                Text("Pausada em \(fmtUsd(t.costUsd) ?? "$0") — nada se perde. Continuar libera mais um teto igual; parar deixa pra você revisar.")
                    .font(.system(size: 13.5)).foregroundStyle(T.text).fixedSize(horizontal: false, vertical: true)
            } else {
                mdText(q.prompt, size: 14, color: T.text)
                    .lineLimit(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if answering.contains(q.id) {
                IntentPill(label: "enviando a resposta…")
            } else {
                ForEach(q.options, id: \.self) { opt in
                    Button { answer(q, opt) } label: {
                        Text(opt).font(.system(size: 13.5, weight: .semibold))
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 13).frame(minHeight: 46)
                            .background((teto && opt.hasPrefix("Parar") ? T.bad : T.accent).opacity(0.12))
                            .foregroundStyle(teto && opt.hasPrefix("Parar") ? T.bad : T.accent)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                    }
                }
                if !teto {
                    Button { openTaskId = t.id } label: {
                        Text("✎ responder com minhas palavras").font(.mono(12)).foregroundStyle(T.dim).frame(minHeight: 32)
                    }
                }
            }
        }
        .card(stroke: color.opacity(0.4))
        .rail(color)
        .contentShape(Rectangle())
        .onTapGesture { openTaskId = t.id }
    }

    /// ESPERAM VOCÊ: entrega pronta — com o PORTÃO DE PROVA (mesma regra do desktop, PR #100)
    private func readyCard(_ t: CloudTask) -> some View {
        let gate = ProofGate.gate(t)
        let nonCode = ["design", "invest"].contains(t.kind)
        return VStack(alignment: .leading, spacing: 10) {
            Text(t.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                switch gate {
                case .unproven(let miss):
                    Text("○ \(miss.count) requisito\(miss.count == 1 ? "" : "s") sem prova").font(.mono(11)).foregroundStyle(T.warn)
                case .proven:
                    Text("✓ todos os requisitos com prova").font(.mono(11)).foregroundStyle(T.accent)
                case .none:
                    Text("✓ entrega pronta pra revisar").font(.mono(11)).foregroundStyle(T.accent)
                }
                Spacer()
                Text("\(t.kind == "invest" ? "Investigador" : t.kind == "design" ? "Designer" : "Coder") · \(agoPt(t.updatedAt))").font(.mono(11)).foregroundStyle(T.dim2)
            }
            if let it = t.spec?.intent {
                IntentPill(label: "o Mac está executando · \(intentLabel(it.kind))")
            } else if nonCode {
                OutlineButton(label: "ver a entrega", full: true) { openTaskId = t.id }
            } else if case .unproven = gate {
                HStack(spacing: 8) {
                    Button { Task { _ = await hub.intent(t.id, "askProof") } } label: {
                        Text("pedir a prova ao agente").font(.system(size: 13.5, weight: .semibold))
                            .frame(maxWidth: .infinity).frame(height: 44)
                            .background(T.accent).foregroundStyle(T.onAccent)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                    }.buttonStyle(.plain)
                    OutlineButton(label: "ver") { openTaskId = t.id }
                }
                Button { noProofFor = t } label: {
                    Text("aprovar sem prova…").font(.mono(12)).foregroundStyle(T.warn).frame(minHeight: 30)
                }
            } else {
                HStack(spacing: 8) {
                    Button { Task { _ = await hub.intent(t.id, "openPr") } } label: {
                        Text("aprovar e abrir PR").font(.system(size: 13.5, weight: .semibold))
                            .frame(maxWidth: .infinity).frame(height: 44)
                            .background(T.accent).foregroundStyle(T.onAccent)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                    }.buttonStyle(.plain)
                    OutlineButton(label: "ver") { openTaskId = t.id }
                }
            }
            if let res = t.spec?.intentResult, t.spec?.intent == nil {
                Text("\(res.ok ? "✓" : "✖") \(intentLabel(res.kind)): \(res.msg ?? (res.ok ? "feito" : "falhou"))")
                    .font(.system(size: 11.5)).foregroundStyle(res.ok ? T.accent : T.bad).fixedSize(horizontal: false, vertical: true)
            }
            ReachNote(reach: hub.reach(t))
        }
        .card(stroke: T.accent.opacity(0.3))
        .rail(T.accent)
        .contentShape(Rectangle())
        .onTapGesture { openTaskId = t.id }
    }

    private func prCard(_ t: CloudTask) -> some View {
        let pr = t.spec?.prInfo
        let open = (pr?.comments ?? []).filter { !($0.answered ?? false) }.count
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(t.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(2)
                Spacer()
                if let n = pr?.number { Text("#\(n)").font(.mono(11.5, .bold)).foregroundStyle(T.info) }
            }
            ProgressLine(pct: 92, color: T.info)
            HStack(spacing: 10) {
                if pr?.decision == "APPROVED" { Text("✓ aprovado").font(.mono(11)).foregroundStyle(T.accent) }
                else if pr?.decision == "CHANGES_REQUESTED" { Text("mudanças pedidas").font(.mono(11)).foregroundStyle(T.warn) }
                else { Text("PR aberto").font(.mono(11)).foregroundStyle(T.info) }
                if open > 0 { Text("\(open) comentário\(open == 1 ? "" : "s") aberto\(open == 1 ? "" : "s")").font(.mono(11)).foregroundStyle(T.warn) }
                if let n = projName(t) { Text(n).font(.mono(10)).foregroundStyle(T.info).lineLimit(1) }
                Spacer()
                Text(agoPt(t.updatedAt)).font(.mono(11)).foregroundStyle(T.dim2)
            }
        }.card().rail(T.info)
    }

    private func doneRow(_ t: CloudTask) -> some View {
        HStack(spacing: 9) {
            Text("✓").font(.mono(12, .bold)).foregroundStyle(T.dim2)
            Text(t.title).font(.system(size: 13)).foregroundStyle(T.dim).lineLimit(1)
            Spacer()
            if let n = t.spec?.prInfo?.number { Text("#\(n)").font(.mono(10.5)).foregroundStyle(T.dim2) }
        }.padding(.vertical, 5)
    }

    // ---- ações ----
    private func answer(_ q: Question, _ opt: String) {
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
