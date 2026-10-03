import Foundation

// Regras PURAS do companion (sem SwiftUI/rede) — testadas em ConstellationTests.
// Cada uma espelha uma fonte única do desktop; mudou lá, muda aqui (e o teste acusa a divergência):
//  - ProofGate  ↔ app/src/js/21-pull-request.js (@prova-gate) + 23-kanban (reqNorm/matchReqProofs) + 27 (reqRows)
//  - StatusMeta ↔ app/src/js/00-util.js (STATUS_META)
//  - MacStatus  ↔ app/src/js/48-presenca-mobile.js (batimento do Mac a cada 45s)

// MARK: - portão de prova (PR #100: "prova antes de promessa")

enum ProofGate {
    enum St: String { case ok, blk, na }
    struct Row: Equatable { let text: String; let st: St; let evidence: [String]; let note: String }
    enum Gate: Equatable { case none, proven, unproven(missing: [Row]) }

    /// mesmo reqNorm do desktop: minúsculas, sem acento, só [a-z0-9] separados por 1 espaço
    static func norm(_ s: String?) -> String {
        let f = (s ?? "").lowercased().folding(options: .diacriticInsensitive, locale: Locale(identifier: "en_US_POSIX"))
        var out = ""; var gap = false
        for ch in f.unicodeScalars {
            let ok = ("a"..."z").contains(ch) || ("0"..."9").contains(ch)
            if ok { if gap && !out.isEmpty { out.append(" ") }; out.unicodeScalars.append(ch); gap = false } else { gap = true }
        }
        return out
    }

    /// casa cada requisito do spec com o item do requirements.json:
    /// exato normalizado → mesmo tamanho? por índice → contém (nas duas direções)
    static func match(_ reqs: [String], _ list: [ReqProof]?) -> [ReqProof?] {
        guard let list else { return reqs.map { _ in nil } }
        var byNorm: [String: ReqProof] = [:]
        for r in list { byNorm[norm(r.req)] = r }   // o último vence, como no JS
        return reqs.enumerated().map { i, r in
            let n = norm(r)
            if let hit = byNorm[n] { return hit }
            if list.count == reqs.count, i < list.count { return list[i] }
            return list.first { x in let m = norm(x.req); return !m.isEmpty && (n.isEmpty || m.contains(n) || n.contains(m)) } // JS: "x".includes("") é true
        }
    }

    static func rows(_ reqs: [String], _ list: [ReqProof]?) -> [Row] {
        let m = match(reqs, list)
        return reqs.enumerated().map { i, r in
            let p = m[i]
            let st: St = p == nil ? .na : (p?.status == "done" ? .ok : .blk)
            return Row(text: r, st: st, evidence: p?.evidence ?? [], note: p?.note ?? "")
        }
    }

    /// sem prova = não está "feito" OU está "feito" sem nenhum arquivo de evidência
    static func gate(_ rows: [Row]) -> Gate {
        if rows.isEmpty { return .none }
        let missing = rows.filter { $0.st != .ok || $0.evidence.isEmpty }
        return missing.isEmpty ? .proven : .unproven(missing: missing)
    }

    static func gate(_ t: CloudTask) -> Gate {
        let reqs = t.spec?.requirements ?? []
        return gate(rows(reqs, t.requirementsProof?.list))
    }

    /// requisitos COM PROVA (feito + evidência) / total — o "2/3 com prova" do card
    static func proved(_ t: CloudTask) -> (done: Int, total: Int)? {
        let reqs = t.spec?.requirements ?? []
        guard !reqs.isEmpty else { return nil }
        let r = rows(reqs, t.requirementsProof?.list)
        return (r.filter { $0.st == .ok && !$0.evidence.isEmpty }.count, reqs.count)
    }
}

// MARK: - status (espelho do STATUS_META do desktop)

enum StatusMeta {
    static let running: Set<String> = ["running", "thinking", "queued", "requested", "plan-review"]
    static let ended: Set<String> = ["merged", "done", "aborted", "cancelled"]
    static func label(_ s: String) -> String {
        switch s {
        case "draft": return "rascunho"
        case "backlog", "queued": return "na fila"
        case "plan-review": return "plano pra aprovar"
        case "running", "thinking": return "rodando"
        case "asking": return "aguardando você"
        case "paused": return "pausada"
        case "review", "delivered": return "pronta pra revisar"
        case "pr-open": return "PR aberto"
        case "done", "closed": return "concluída"
        case "merged": return "integrada"
        case "error": return "erro"
        case "conflict": return "conflito"
        case "blocked": return "bloqueada"
        case "aborted": return "interrompida"
        case "cancelled": return "cancelada"
        case "waiting": return "na espera"
        case "requested": return "esperando o Mac"
        default: return s.isEmpty ? "—" : s
        }
    }
}

// MARK: - teto de custo (pergunta sintética do 53-teto-protecao)

enum Teto {
    /// a pergunta do teto chega como pergunta comum do agente "Starfork" com a opção "Continuar com mais …"
    static func isTeto(agent: String, options: [String]) -> Bool {
        agent == "Starfork" && options.contains { $0.hasPrefix("Continuar com mais") }
    }
}

// MARK: - reconexão (backoff exponencial com jitter cheio)

enum Backoff {
    /// atraso da tentativa `attempt` (0 = primeira): base·2^n com teto, jitter cheio [0.5·d, d]
    /// (metade fixa: nunca reconecta em 0s — evita martelar o servidor quando ele volta)
    static func delay(attempt: Int, base: Double = 0.5, cap: Double = 30, rnd: Double = Double.random(in: 0...1)) -> Double {
        let d = min(cap, base * pow(2, Double(max(0, min(attempt, 16)))))
        return d * (0.5 + 0.5 * rnd)
    }
}

// MARK: - presença do Mac

struct DesktopPresence: Decodable, Equatable {
    let deviceId: String
    let deviceName: String?
    let openRemote: String?
    let openLegacy: String?
    let openProject: String?
    let localRemotes: [String]?
    let running: Int?
    let online: Bool?
    let lastSeenAt: String
    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id", deviceName = "device_name", openRemote = "open_remote", openLegacy = "open_legacy"
        case openProject = "open_project", localRemotes = "local_remotes", running, online, lastSeenAt = "last_seen_at"
    }
}

enum MacStatus: Equatable {
    case unknown
    case online(name: String, openProject: String?, running: Int)
    case offline(lastSeen: Date?)

    /// o Mac bate a cada 45s; 150s sem batimento = offline (folga pra 2 batimentos perdidos + relógio)
    static let onlineWindow: TimeInterval = 150

    static func eval(rows: [DesktopPresence], fallbackLastSeen: Date?, now: Date = Date()) -> MacStatus {
        let parsed = rows.compactMap { r -> (DesktopPresence, Date)? in parseISO(r.lastSeenAt).map { (r, $0) } }
        if let best = parsed.filter({ $0.0.online != false && now.timeIntervalSince($0.1) < onlineWindow }).max(by: { $0.1 < $1.1 }) {
            return .online(name: best.0.deviceName ?? "Mac", openProject: best.0.openProject, running: best.0.running ?? 0)
        }
        if let last = parsed.map(\.1).max() { return .offline(lastSeen: last) }
        // sem a tabela (migration 0030 não aplicada): profiles.last_seen_at, que o Mac já grava a cada 60s
        if let fb = fallbackLastSeen {
            return now.timeIntervalSince(fb) < onlineWindow ? .online(name: "Mac", openProject: nil, running: 0) : .offline(lastSeen: fb)
        }
        return .unknown
    }

    var isOnline: Bool { if case .online = self { return true }; return false }
}

/// o Mac consegue agir NESTA demanda? (ele só atende o projeto aberto — 42-nuvem-sync-mobile: cloudTaskIds)
enum MacReach: Equatable {
    case here                 // Mac online com o projeto aberto
    case otherProject(String) // online, mas com outro projeto aberto (nome do aberto)
    case notOnMac             // nenhum Mac seu tem este projeto clonado
    case offline(Date?)       // Mac desligado/dormindo
    case unknown              // sem dados de presença (não promete nada)

    static func normRemote(_ s: String?) -> String {
        var r = (s ?? "").lowercased().trimmingCharacters(in: .whitespaces)
        if r.hasSuffix(".git") { r.removeLast(4) }
        while r.hasSuffix("/") { r.removeLast() }
        return r
    }

    static func eval(projectRemote: String?, rows: [DesktopPresence], status: MacStatus, now: Date = Date()) -> MacReach {
        switch status {
        case .unknown: return .unknown
        case .offline(let d): return .offline(d)
        case .online:
            let live = rows.filter { r in r.online != false && (parseISO(r.lastSeenAt).map { now.timeIntervalSince($0) < MacStatus.onlineWindow } ?? false) }
            guard !live.isEmpty else { return .unknown } // online pelo fallback: não sabemos o projeto aberto
            let want = normRemote(projectRemote)
            if want.isEmpty { return .here }
            if live.contains(where: { normRemote($0.openRemote) == want || normRemote($0.openLegacy) == want }) { return .here }
            if live.contains(where: { ($0.localRemotes ?? []).map(normRemote).contains(want) }) {
                return .otherProject(live.first?.openProject ?? "outro projeto")
            }
            return .notOnMac
        }
    }
}

func parseISO(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    if let d = f.date(from: s) { return d }
    // Postgres devolve "2026-10-03T01:02:03.123456+00:00" (6 casas) — corta pra 3
    if let r = s.range(of: #"\.\d+"#, options: .regularExpression) {
        let frac = String(s[r].prefix(4))
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s.replacingCharacters(in: r, with: frac))
    }
    return nil
}

// MARK: - estado da conexão (o que o banner diz — HONESTO)

enum RTState: Equatable {
    case idle, connecting, live
    case retrying(attempt: Int, at: Date)
    case unavailable(String)  // servidor recusou o ao vivo (ex.: tabela fora da publicação) → polling
}

struct ConnSummary: Equatable {
    enum Level: Equatable { case ok, info, warn, bad }
    let level: Level
    let title: String
    let detail: String

    static func make(network: Bool, rt: RTState, restFails: Int, lastOk: Date?, mac: MacStatus, now: Date = Date()) -> ConnSummary {
        let since = lastOk.map { "atualizado \(agoPtDate($0, now: now))" } ?? "sem dados ainda"
        if !network {
            return ConnSummary(level: .bad, title: "sem internet", detail: "mostrando o último estado (\(since)) — reconecta sozinho quando a rede voltar")
        }
        if restFails >= 2 {
            if case .retrying(let n, _) = rt {
                return ConnSummary(level: .warn, title: "reconectando…", detail: "tentativa \(n + 1) · \(since)")
            }
            return ConnSummary(level: .warn, title: "a nuvem não responde", detail: "tentando de novo · \(since)")
        }
        switch mac {
        case .offline(let d):
            let seen = d.map { "visto \(agoPtDate($0, now: now))" } ?? "nunca visto"
            return ConnSummary(level: .warn, title: "Mac offline", detail: "\(seen) — mensagens e pedidos ficam na fila até ele voltar")
        default: break
        }
        switch rt {
        case .live:
            if case .online(let name, let proj, _) = mac {
                return ConnSummary(level: .ok, title: "ao vivo", detail: "\(name) online" + (proj.map { " · \($0) aberto" } ?? ""))
            }
            return ConnSummary(level: .ok, title: "ao vivo", detail: since)
        case .connecting:
            return ConnSummary(level: .info, title: "conectando…", detail: since)
        case .retrying(let n, _):
            return ConnSummary(level: .info, title: "reconectando o ao vivo", detail: "tentativa \(n + 1) · atualizando a cada 5s enquanto isso")
        case .unavailable:
            return ConnSummary(level: .info, title: "atualizando a cada 5s", detail: "o ao vivo não está disponível nesta nuvem")
        case .idle:
            return ConnSummary(level: .info, title: "pausado", detail: since)
        }
    }
}

func agoPtDate(_ d: Date, now: Date = Date()) -> String {
    let s = now.timeIntervalSince(d)
    if s < 60 { return "agora" }
    if s < 3600 { return "há \(Int(s / 60))min" }
    if s < 86400 { return "há \(Int(s / 3600))h" }
    return "há \(Int(s / 86400))d"
}

// MARK: - avisos por transição (agente terminou · travou · perguntou · teto · PR)

struct TaskSnap: Codable, Equatable {
    let status: String
    let flag: String?
    let prUrl: String?
    let intentAt: String?
    let intentOk: Bool?
}

struct Notice: Equatable {
    enum Kind: String { case ready, error, merged, prOpened, intentFailed, question, teto }
    let kind: Kind
    let taskId: String
    let title: String
    let body: String
    var questionId: String? = nil
    /// carimbo (updated_at da tarefa) — a mesma demanda pode ficar pronta de novo depois de um ajuste
    var stamp: String = ""
    var key: String { "\(kind.rawValue)|\(taskId)|\(questionId ?? "")|\(stamp)" }
}

enum Transitions {
    struct QSnap: Equatable { let id: String; let taskId: String?; let agent: String; let prompt: String; let options: [String] }

    /// compara o retrato anterior com o novo. `prev` vazio (1ª carga) = não avisa nada do passado.
    static func diff(prev: [String: TaskSnap], tasks: [CloudTask], prevQ: Set<String>, questions: [QSnap],
                     isMine: (CloudTask) -> Bool, firstLoad: Bool) -> [Notice] {
        if firstLoad { return [] }
        var out: [Notice] = []
        let byId = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for t in tasks where isMine(t) {
            guard let p = prev[t.id] else { continue }
            let name = String(t.title.prefix(120))
            let wasReady = ["review", "delivered"].contains(p.status)
            if ["review", "delivered"].contains(t.status) && !wasReady && t.flag != "closed" {
                let g = ProofGate.proved(t)
                let tail = g.map { $0.done == $0.total ? " · \($0.total)/\($0.total) com prova" : " · \($0.done)/\($0.total) com prova" } ?? ""
                out.append(Notice(kind: .ready, taskId: t.id, title: "Entrega pronta pra revisar", body: name + tail, stamp: t.updatedAt))
            }
            if ["error", "conflict"].contains(t.status) && !["error", "conflict"].contains(p.status) {
                out.append(Notice(kind: .error, taskId: t.id, title: t.status == "conflict" ? "Conflito na demanda" : "O agente travou", body: name, stamp: t.updatedAt))
            }
            if ["merged", "done"].contains(t.status) && !["merged", "done"].contains(p.status) {
                out.append(Notice(kind: .merged, taskId: t.id, title: "Integrada ✓", body: name, stamp: t.updatedAt))
            }
            if t.prUrl != nil && p.prUrl == nil && !["merged", "done"].contains(t.status) {
                out.append(Notice(kind: .prOpened, taskId: t.id, title: "PR aberto", body: name, stamp: t.updatedAt))
            }
            if let r = t.spec?.intentResult, r.ok == false, let at = r.at, at != p.intentAt {
                out.append(Notice(kind: .intentFailed, taskId: t.id, title: "O Mac não conseguiu: \(r.kind)", body: r.msg ?? name, stamp: t.updatedAt))
            }
        }
        for q in questions where !prevQ.contains(q.id) {
            guard let tid = q.taskId, let t = byId[tid], isMine(t) else { continue }
            if Teto.isTeto(agent: q.agent, options: q.options) {
                out.append(Notice(kind: .teto, taskId: tid, title: "Teto de custo atingido", body: String(t.title.prefix(120)) + " — continuar ou parar?", questionId: q.id))
            } else {
                out.append(Notice(kind: .question, taskId: tid, title: "Precisa de você — \(q.agent.isEmpty ? "agente" : q.agent)", body: String(q.prompt.prefix(160)), questionId: q.id))
            }
        }
        return out
    }

    static func snap(_ t: CloudTask) -> TaskSnap {
        TaskSnap(status: t.status, flag: t.flag, prUrl: t.prUrl, intentAt: t.spec?.intentResult?.at, intentOk: t.spec?.intentResult?.ok)
    }

    /// preferência de push que governa cada aviso (Conta → quais pushes chegam)
    static func prefKey(_ k: Notice.Kind) -> String {
        switch k {
        case .question, .teto: return "push.questions"
        case .ready, .prOpened: return "push.ready"
        case .merged: return "push.pr"
        case .error, .intentFailed: return "push.errors"
        }
    }
}

// MARK: - fila de mensagens do celular (o que o Mac ainda não entregou)

struct OutMsg: Identifiable, Decodable, Equatable {
    let id: Int
    let body: String
    let deliveredAt: String?
    let createdAt: String?
    enum CodingKeys: String, CodingKey { case id, body, deliveredAt = "delivered_at", createdAt = "created_at" }
    /// texto que aparece na bolha (sem o prefixo de requisito; foto vira legenda)
    var shown: String {
        if body.hasPrefix("[img]") {
            let cap = body.components(separatedBy: "|").dropFirst().joined(separator: "|").trimmingCharacters(in: .whitespaces)
            return "📷 imagem" + (cap.isEmpty ? "" : ": " + cap)
        }
        if body.hasPrefix("[req]") { return "requisito: " + body.dropFirst(5).trimmingCharacters(in: .whitespaces) }
        return body
    }
}
