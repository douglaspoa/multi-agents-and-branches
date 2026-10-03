import SwiftUI
import UIKit

// Peças nativas do redesign v0.5 (iOS de verdade: List inset-grouped, large titles, SF Symbols,
// swipe actions, haptics). Tudo em Dynamic Type; nada com largura fixa que possa vazar da tela.

// MARK: - haptics

enum Haptic {
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    static func tap() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    static func select() { UISelectionFeedbackGenerator().selectionChanged() }
}

// MARK: - status em PALAVRA (não só um ponto)

struct StatusInfo {
    let word: String
    let symbol: String
    let color: Color

    static func of(_ t: CloudTask, waiting: Bool = false, teto: Bool = false) -> StatusInfo {
        if teto { return .init(word: "Teto de custo", symbol: "gauge.with.dots.needle.100percent", color: T.bad) }
        if waiting { return .init(word: "Esperando você", symbol: "questionmark.bubble.fill", color: T.warn) }
        if t.flag == "closed" { return .init(word: "Concluída", symbol: "checkmark.seal.fill", color: T.dim) }
        if t.prUrl != nil && !["merged", "done"].contains(t.status) && !t.isEnded {
            return .init(word: "PR aberto", symbol: "arrow.triangle.pull", color: T.info)
        }
        let label = StatusMeta.label(t.status)
        let word = label.prefix(1).uppercased() + label.dropFirst()
        let (sym, c): (String, Color) = {
            switch t.status {
            case "running", "thinking": return ("bolt.fill", T.accent)
            case "queued", "requested", "backlog": return ("clock.fill", T.warn)
            case "plan-review": return ("list.bullet.clipboard.fill", T.warn)
            case "paused": return ("pause.circle.fill", T.warn)
            case "review", "delivered": return ("checkmark.circle.fill", T.accent)
            case "merged", "done": return ("checkmark.seal.fill", T.cyan)
            case "error", "conflict": return ("exclamationmark.triangle.fill", T.bad)
            case "draft": return ("square.dashed", T.dim)
            default: return ("circle.fill", T.dim)
            }
        }()
        return .init(word: word, symbol: sym, color: c)
    }
}

struct StatusWord: View {
    let info: StatusInfo
    var body: some View {
        // HStack e não Label: dentro de List o Label vira coluna de ícone separada do texto
        HStack(spacing: 5) {
            Image(systemName: info.symbol).font(.ui(11, .semibold))
            Text(info.word).font(.ui(12, .semibold)).lineLimit(1)
        }
        .foregroundStyle(info.color)
        .accessibilityElement(children: .combine)
    }
}

/// "3/4 com prova" — o diferencial: prova por requisito
struct ProofBadge: View {
    let proved: (done: Int, total: Int)?
    var body: some View {
        if let p = proved, p.total > 0 {
            let all = p.done == p.total
            HStack(spacing: 4) {
                Image(systemName: all ? "checkmark.seal.fill" : "checkmark.seal").font(.ui(11))
                Text("\(p.done)/\(p.total) com prova").font(.ui(12, .medium)).monospacedDigit().lineLimit(1)
            }
            .foregroundStyle(all ? T.accent : T.text2)
            .accessibilityLabel("\(p.done) de \(p.total) requisitos com prova")
        }
    }
}

// MARK: - linha de tarefa (Central · Minhas · Time)

struct TaskRow: View {
    let task: CloudTask
    var waiting = false
    var teto = false
    var project: String? = nil
    var owner: String? = nil
    var lastLine: String? = nil
    @Environment(\.dynamicTypeSize) private var dts

    var body: some View {
        let st = StatusInfo.of(task, waiting: waiting, teto: teto)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                StatusWord(info: st)
                    .layoutPriority(1)
                Spacer(minLength: 6)
                if let c = fmtUsd(task.costUsd) {
                    Text(c).font(.mono(12)).monospacedDigit().foregroundStyle(T.text2).lineLimit(1)
                        .accessibilityLabel("custo \(c)")
                }
            }
            Text(task.title)
                .font(.ui(16, .semibold)).foregroundStyle(T.text)
                .lineLimit(dts.isAccessibilitySize ? 4 : 2)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let lastLine, !lastLine.isEmpty {
                Text(softBreak(lastLine)).font(.mono(11)).foregroundStyle(T.dim).lineLimit(1).truncationMode(.tail)
            }
            if dts.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 3) {
                    ProofBadge(proved: task.reqsProved)
                    if let owner { IconText(symbol: "person.fill", text: owner).font(.ui(12)).foregroundStyle(T.dim) }
                    if let project { IconText(symbol: "folder", text: project).font(.ui(12)).foregroundStyle(T.dim) }
                    Text(agoPt(task.updatedAt)).font(.ui(12)).foregroundStyle(T.dim2)
                }
            } else {
                // prova · código · tempo numa linha (nada espreme); projeto/dono na de baixo, truncando no meio
                HStack(spacing: 10) {
                    ProofBadge(proved: task.reqsProved).fixedSize()
                    if let c = task.issueCode, c.count <= 14 { Text(c).font(.mono(11, .medium)).foregroundStyle(T.info).fixedSize() }
                    Spacer(minLength: 8)
                    Text(agoPt(task.updatedAt)).font(.ui(12)).foregroundStyle(T.dim2).fixedSize()
                }
                if owner != nil || project != nil {
                    HStack(spacing: 12) {
                        if let owner { IconText(symbol: "person.fill", text: owner) }
                        if let project { IconText(symbol: "folder", text: project) }
                    }
                    .font(.ui(12)).foregroundStyle(T.dim)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// ícone + texto em linha (o Label, dentro de List, separa o ícone numa coluna)
struct IconText: View {
    let symbol: String
    let text: String
    var lines: Int? = 1
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Image(systemName: symbol).imageScale(.small)
            Text(text).lineLimit(lines).truncationMode(.middle)
        }
    }
}

/// cabeçalho de seção da lista: símbolo + nome + contagem
struct SectionHead: View {
    let title: String
    var symbol: String? = nil
    var color: Color = T.dim
    var count: Int? = nil
    var body: some View {
        HStack(spacing: 6) {
            if let symbol { Image(systemName: symbol).foregroundStyle(color) }
            Text(title).foregroundStyle(color == T.dim ? T.text2 : color)
            if let count, count > 0 {
                Text("\(count)").monospacedDigit().foregroundStyle(T.dim)
            }
        }
        .font(.ui(13, .semibold))
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - conexão: indicador calmo ("Mac online · loja-web" / "reconectando" / "Mac offline · visto há 12min")

struct ConnStatusRow: View {
    @EnvironmentObject var hub: SyncHub
    var body: some View {
        let s = hub.summary
        let c: Color = s.level == .ok ? T.accent : s.level == .info ? T.info : s.level == .warn ? T.warn : T.bad
        let (icon, title, detail) = lines(s)
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.ui(15, .semibold)).foregroundStyle(c)
                .frame(width: 34, height: 34)
                .background(c.opacity(0.14), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.ui(14, .semibold)).foregroundStyle(T.text).lineLimit(2).truncationMode(.middle)
                Text(detail).font(.ui(12)).foregroundStyle(T.dim).lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if s.level == .ok {
                LiveTag()
            } else {
                Button { Haptic.tap(); hub.wake() } label: { Text("Tentar").font(.ui(13, .semibold)) }
                    .buttonStyle(.bordered).tint(c).controlSize(.small)
                    .accessibilityLabel("tentar reconectar agora")
            }
        }
        .animation(.easeOut(duration: 0.2), value: s)
        .accessibilityElement(children: .contain)
    }

    private func lines(_ s: ConnSummary) -> (String, String, String) {
        if !hub.network { return ("wifi.slash", "Sem internet", s.detail) }
        if s.level == .warn, case .offline(let d) = hub.macStatus {
            return ("moon.zzz.fill", "Mac offline" + (d.map { " · visto \(agoPtDate($0))" } ?? ""), "mensagens e pedidos ficam na fila até ele voltar")
        }
        if s.level == .warn { return ("arrow.triangle.2.circlepath", cap(s.title), s.detail) }
        if case .online(let name, let proj, let running) = hub.macStatus {
            let what = [proj.map { "\($0) aberto" }, running > 0 ? "\(running) rodando" : nil].compactMap { $0 }.joined(separator: " · ")
            if s.level == .ok { return ("desktopcomputer", "\(name) online", what.isEmpty ? "ao vivo" : what) }
            return ("arrow.triangle.2.circlepath", cap(s.title), "\(name) online" + (what.isEmpty ? "" : " · " + what))
        }
        return (s.level == .ok ? "desktopcomputer" : "arrow.triangle.2.circlepath", cap(s.title), s.detail)
    }
    private func cap(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }
}

// MARK: - filtro de projeto (menu da barra — substitui o carrossel de chips que vazava)

struct ProjectFilterMenu: View {
    @EnvironmentObject var hub: SyncHub
    var body: some View {
        let ps = hub.projectChips
        if ps.count > 1 || hub.projectFilter != nil {
            Menu {
                Picker("Projeto", selection: Binding(get: { hub.projectFilter }, set: { v in Haptic.select(); withAnimation { hub.projectFilter = v } })) {
                    Label("Todos os projetos", systemImage: "square.stack.3d.up").tag(String?.none)
                    ForEach(ps) { p in
                        let n = hub.tasks.filter { $0.projectId == p.id && !$0.isEnded }.count
                        Text("\(p.name) · \(n)").tag(String?.some(p.id))
                    }
                }
            } label: {
                Label(hub.projectFilter.flatMap { hub.project($0)?.name } ?? "Projetos",
                      systemImage: hub.projectFilter == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
            }
            .accessibilityIdentifier("project-filter")
            .accessibilityLabel(hub.projectFilter.flatMap { "filtro de projeto: " + (hub.project($0)?.name ?? "") } ?? "filtrar por projeto")
        }
    }
}

/// faixa "filtrando: projeto X" (o filtro não fica escondido no menu)
struct ProjectFilterNote: View {
    @EnvironmentObject var hub: SyncHub
    var body: some View {
        if let pf = hub.projectFilter, let p = hub.project(pf) {
            HStack(spacing: 8) {
                Image(systemName: "folder.fill").foregroundStyle(T.info)
                Text("Só \(p.name)").font(.ui(13, .medium)).foregroundStyle(T.text2).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                Button("Ver todos") { Haptic.select(); withAnimation { hub.projectFilter = nil } }
                    .font(.ui(13, .semibold)).buttonStyle(.borderless).tint(T.accent)
            }
        }
    }
}

// MARK: - estado vazio de verdade

struct EmptyBoard: View {
    let title: String
    let message: String
    var symbol = "sparkles"
    var action: (String, () -> Void)? = nil
    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol).foregroundStyle(T.text)
        } description: {
            Text(message).foregroundStyle(T.dim)
        } actions: {
            if let action {
                Button(action.0, action: action.1).buttonStyle(.borderedProminent).tint(T.accent).foregroundStyle(T.onAccent)
            }
        }
    }
}

/// linha-esqueleto (carregando) com a mesma silhueta da TaskRow
struct TaskRowSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack { Bone(w: 80, h: 10); Spacer(); Bone(w: 40, h: 10) }
            Bone(h: 14)
            Bone(w: 160, h: 10)
        }
        .padding(.vertical, 6)
        .shimmer()
    }
}

extension View {
    /// linha de lista no tom do app (superfície verde-escura, não cinza do sistema)
    func rowStyle() -> some View { listRowBackground(T.panel) }
    /// lista inset-grouped no fundo tingido do app
    func appList() -> some View {
        listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(T.bg)
            .environment(\.defaultMinListRowHeight, 44)
    }
}

// MARK: - navegação e ações de linha (swipe) compartilhadas

/// destino de navegação: detalhe da tarefa
struct TaskRef: Hashable { let id: String }

/// swipe actions nativas numa linha de tarefa MINHA: pausar · parar (rodando) · retomar (pausada) ·
/// aprovar / pedir prova (pronta pra revisar). O portão de prova vale aqui também.
struct TaskSwipes: ViewModifier {
    @EnvironmentObject var hub: SyncHub
    let task: CloudTask
    var teto = false
    let onStop: (CloudTask) -> Void
    let onNoProof: (CloudTask) -> Void

    func body(content: Content) -> some View {
        let t = task
        let mine = hub.isMine(t)
        let busy = t.spec?.intent != nil
        let ready = ["review", "delivered"].contains(t.status) && t.prUrl == nil && !["design", "invest"].contains(t.kind)
        let gate = ProofGate.gate(t)
        content
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if mine && !busy && t.isLive {
                    Button { Haptic.warning(); onStop(t) } label: { Label("Parar", systemImage: "stop.fill") }.tint(T.bad)
                    Button { Haptic.tap(); Task { _ = await hub.intent(t.id, "pause") } } label: { Label("Pausar", systemImage: "pause.fill") }.tint(.orange)
                }
                if mine && !busy && ready, case .unproven = gate {
                    Button { Haptic.tap(); Task { _ = await hub.intent(t.id, "askProof") } } label: { Label("Pedir prova", systemImage: "checkmark.seal") }.tint(T.info)
                }
            }
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                if mine && !busy && t.status == "paused" && !teto {
                    Button { Haptic.success(); Task { _ = await hub.intent(t.id, "resume") } } label: { Label("Retomar", systemImage: "play.fill") }.tint(T.accent2)
                }
                if mine && !busy && ready {
                    Button {
                        if case .unproven = gate { Haptic.warning(); onNoProof(t) }
                        else { Haptic.success(); Task { _ = await hub.intent(t.id, "openPr") } }
                    } label: { Label("Aprovar", systemImage: "checkmark.circle.fill") }.tint(T.accent2)
                }
            }
    }
}

extension View {
    func taskSwipes(_ t: CloudTask, teto: Bool = false, onStop: @escaping (CloudTask) -> Void, onNoProof: @escaping (CloudTask) -> Void) -> some View {
        modifier(TaskSwipes(task: t, teto: teto, onStop: onStop, onNoProof: onNoProof))
    }
}

/// botão "+" da barra (nova demanda) — substitui o FAB que cobria a última linha
struct NewTaskToolbarButton: View {
    let action: () -> Void
    var body: some View {
        Button { Haptic.tap(); action() } label: { Image(systemName: "plus") }
            .accessibilityLabel("nova demanda")
    }
}
