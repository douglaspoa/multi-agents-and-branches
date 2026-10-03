import XCTest
@testable import Constellation

/// Regras puras do companion. O portão de prova e os rótulos de status são conferidos contra o DESKTOP:
/// mesmo fixture dourado (tests/fixtures/proof-gate-golden.json, gerado pelo app/tests/mobile-orca.test.mjs)
/// e o STATUS_META lido direto do app/src/js/00-util.js — mudou lá, este teste acusa.
final class LogicTests: XCTestCase {
    /// arquivo do desktop embutido no bundle de testes (project.yml → resources)
    private func repoFile(_ name: String) throws -> URL {
        let parts = name.split(separator: ".")
        return try XCTUnwrap(Bundle(for: LogicTests.self).url(forResource: String(parts[0]), withExtension: String(parts[1])), "\(name) fora do bundle de testes")
    }

    // MARK: portão de prova ≡ desktop

    struct GoldCase: Decodable {
        struct L: Decodable { let req: String?; let status: String?; let evidence: [String]?; let note: String? }
        struct R: Decodable { let text: String; let st: String; let evidence: [String]; let note: String }
        let name: String; let reqs: [String]; let list: [L]?; let norm: [String]; let rows: [R]; let gate: String; let missing: [String]
    }

    func testProofGateMatchesDesktopGolden() throws {
        let data = try Data(contentsOf: try repoFile("proof-gate-golden.json"))
        let cases = try JSONDecoder().decode([GoldCase].self, from: data)
        XCTAssertGreaterThanOrEqual(cases.count, 6)
        for c in cases {
            let list = c.list?.map { ReqProof(req: $0.req, status: $0.status, evidence: $0.evidence, note: $0.note) }
            XCTAssertEqual(c.reqs.map(ProofGate.norm), c.norm, "reqNorm — \(c.name)")
            let rows = ProofGate.rows(c.reqs, list)
            XCTAssertEqual(rows.map(\.st.rawValue), c.rows.map(\.st), "estado — \(c.name)")
            XCTAssertEqual(rows.map(\.evidence), c.rows.map(\.evidence), "evidência — \(c.name)")
            XCTAssertEqual(rows.map(\.note), c.rows.map(\.note), "nota — \(c.name)")
            let g = ProofGate.gate(rows)
            switch g {
            case .none: XCTAssertEqual(c.gate, "none", c.name)
            case .proven: XCTAssertEqual(c.gate, "proven", c.name)
            case .unproven(let miss):
                XCTAssertEqual(c.gate, "unproven", c.name)
                XCTAssertEqual(miss.map(\.text), c.missing, c.name)
            }
        }
    }

    func testStatusLabelsMatchDesktopStatusMeta() throws {
        let src = try String(contentsOf: try repoFile("00-util.js"), encoding: .utf8)
        let block = src.components(separatedBy: "const STATUS_META={")[1].components(separatedBy: "};")[0]
        let re = try NSRegularExpression(pattern: #"^\s*'?([\w-]+)'?:\s*\{\s*pt:'([^']+)'"#, options: [.anchorsMatchLines])
        let ns = block as NSString
        let hits = re.matches(in: block, range: NSRange(location: 0, length: ns.length))
        XCTAssertGreaterThan(hits.count, 15)
        for h in hits {
            let key = ns.substring(with: h.range(at: 1)), pt = ns.substring(with: h.range(at: 2))
            XCTAssertEqual(StatusMeta.label(key), pt, "STATUS_META[\(key)]")
        }
    }

    // MARK: presença do Mac

    private func row(_ seenAgo: TimeInterval, online: Bool? = true, open: String? = "github.com/acme/loja-web", locals: [String] = ["github.com/acme/loja-web", "github.com/acme/api"], now: Date) -> DesktopPresence {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return DesktopPresence(deviceId: "d-1", deviceName: "MacBook", openRemote: open, openLegacy: open, openProject: open?.components(separatedBy: "/").last,
                               localRemotes: locals, running: 2, online: online, lastSeenAt: f.string(from: now.addingTimeInterval(-seenAgo)))
    }

    func testMacStatus() {
        let now = Date()
        XCTAssertEqual(MacStatus.eval(rows: [row(30, now: now)], fallbackLastSeen: nil, now: now), .online(name: "MacBook", openProject: "loja-web", running: 2))
        if case .offline(let d) = MacStatus.eval(rows: [row(400, now: now)], fallbackLastSeen: nil, now: now) {
            XCTAssertEqual(d!.timeIntervalSince1970, now.addingTimeInterval(-400).timeIntervalSince1970, accuracy: 1)
        } else { XCTFail("400s sem batimento = offline") }
        if case .offline = MacStatus.eval(rows: [row(5, online: false, now: now)], fallbackLastSeen: nil, now: now) {} else { XCTFail("fechou o app = offline na hora") }
        XCTAssertEqual(MacStatus.eval(rows: [], fallbackLastSeen: now.addingTimeInterval(-20), now: now), .online(name: "Mac", openProject: nil, running: 0), "sem a 0030: last_seen do perfil")
        if case .offline = MacStatus.eval(rows: [], fallbackLastSeen: now.addingTimeInterval(-1000), now: now) {} else { XCTFail() }
        XCTAssertEqual(MacStatus.eval(rows: [], fallbackLastSeen: nil, now: now), .unknown)
    }

    func testMacReach() {
        let now = Date()
        let rows = [row(10, now: now)]
        let st = MacStatus.eval(rows: rows, fallbackLastSeen: nil, now: now)
        XCTAssertEqual(MacReach.eval(projectRemote: "github.com/acme/loja-web.git", rows: rows, status: st, now: now), .here)
        XCTAssertEqual(MacReach.eval(projectRemote: "GitHub.com/acme/api/", rows: rows, status: st, now: now), .otherProject("loja-web"))
        XCTAssertEqual(MacReach.eval(projectRemote: "github.com/acme/outro", rows: rows, status: st, now: now), .notOnMac)
        XCTAssertEqual(MacReach.eval(projectRemote: "x", rows: [], status: .online(name: "Mac", openProject: nil, running: 0), now: now), .unknown, "online pelo perfil: não promete projeto")
        XCTAssertEqual(MacReach.eval(projectRemote: "x", rows: rows, status: .unknown, now: now), .unknown)
    }

    // MARK: conexão

    func testBackoffGrowsWithJitterAndCap() {
        XCTAssertEqual(Backoff.delay(attempt: 0, rnd: 1), 0.5, accuracy: 0.001)
        XCTAssertEqual(Backoff.delay(attempt: 0, rnd: 0), 0.25, accuracy: 0.001)
        XCTAssertEqual(Backoff.delay(attempt: 3, rnd: 1), 4, accuracy: 0.001)
        XCTAssertEqual(Backoff.delay(attempt: 50, rnd: 1), 30, accuracy: 0.001, "teto de 30s")
        for n in 0..<20 { let d = Backoff.delay(attempt: n); XCTAssertGreaterThan(d, 0.2); XCTAssertLessThanOrEqual(d, 30) }
    }

    func testConnSummaryIsHonest() {
        let now = Date()
        XCTAssertEqual(ConnSummary.make(network: false, rt: .live, restFails: 0, lastOk: now, mac: .online(name: "M", openProject: nil, running: 0), now: now).title, "sem internet")
        XCTAssertEqual(ConnSummary.make(network: true, rt: .retrying(attempt: 2, at: now), restFails: 3, lastOk: now, mac: .unknown, now: now).title, "reconectando…")
        let off = ConnSummary.make(network: true, rt: .live, restFails: 0, lastOk: now, mac: .offline(lastSeen: now.addingTimeInterval(-720)), now: now)
        XCTAssertEqual(off.title, "Mac offline"); XCTAssertTrue(off.detail.contains("há 12min")); XCTAssertEqual(off.level, .warn)
        let ok = ConnSummary.make(network: true, rt: .live, restFails: 0, lastOk: now, mac: .online(name: "MacBook", openProject: "loja-web", running: 1), now: now)
        XCTAssertEqual(ok.level, .ok); XCTAssertEqual(ok.detail, "MacBook online · loja-web aberto")
        XCTAssertEqual(ConnSummary.make(network: true, rt: .unavailable("x"), restFails: 0, lastOk: now, mac: .unknown, now: now).title, "atualizando a cada 5s")
    }

    func testParseISOFromPostgres() {
        XCTAssertNotNil(parseISO("2026-10-03T01:02:03.123456+00:00"))
        XCTAssertNotNil(parseISO("2026-10-03T01:02:03Z"))
        XCTAssertNotNil(parseISO("2026-10-03T01:02:03.5Z"))
        XCTAssertNil(parseISO("ontem"))
    }

    // MARK: avisos por transição

    private func task(_ id: String, _ status: String, owner: String = "me", pr: String? = nil, intentFail: String? = nil, reqs: [String]? = nil) throws -> CloudTask {
        var spec: [String: Any] = ["kind": "build"]
        if let reqs { spec["requirements"] = reqs }
        if let at = intentFail { spec["intentResult"] = ["kind": "openPr", "ok": false, "msg": "checagem falhou", "at": at] }
        var j: [String: Any] = ["id": id, "title": "Demanda \(id)", "status": status, "assignee": owner, "created_by": owner, "updated_at": "2026-10-03T10:00:00Z", "spec": spec]
        if let pr { j["pr_url"] = pr }
        return try JSONDecoder().decode(CloudTask.self, from: JSONSerialization.data(withJSONObject: j))
    }

    func testTransitionsNotifyOnlyNewThingsOfMine() throws {
        let mine: (CloudTask) -> Bool = { ($0.assignee ?? $0.createdBy) == "me" }
        let prev: [String: TaskSnap] = [
            "a": TaskSnap(status: "running", flag: nil, prUrl: nil, intentAt: nil, intentOk: nil),
            "b": TaskSnap(status: "running", flag: nil, prUrl: nil, intentAt: nil, intentOk: nil),
            "c": TaskSnap(status: "review", flag: nil, prUrl: nil, intentAt: nil, intentOk: nil),
            "d": TaskSnap(status: "running", flag: nil, prUrl: nil, intentAt: nil, intentOk: nil),
            "e": TaskSnap(status: "review", flag: nil, prUrl: nil, intentAt: nil, intentOk: nil),
        ]
        let ts = [try task("a", "review", reqs: ["x"]), try task("b", "error"), try task("c", "review", pr: "https://g/pr/1"),
                  try task("d", "review", owner: "ana"), try task("e", "review", intentFail: "2026-10-03T10:01:00Z")]
        let qs = [Transitions.QSnap(id: "q1", taskId: "a", agent: "coder", prompt: "posso?", options: ["sim"]),
                  Transitions.QSnap(id: "q2", taskId: "b", agent: "Starfork", prompt: "teto", options: ["Continuar com mais US$ 5", "Parar aqui"]),
                  Transitions.QSnap(id: "q3", taskId: "d", agent: "coder", prompt: "da Ana", options: [])]
        let n = Transitions.diff(prev: prev, tasks: ts, prevQ: [], questions: qs, isMine: mine, firstLoad: false)
        let kinds = n.map { "\($0.kind.rawValue):\($0.taskId)" }
        XCTAssertEqual(Set(kinds), ["ready:a", "error:b", "prOpened:c", "intentFailed:e", "question:a", "teto:b"])
        XCTAssertTrue(n.first { $0.kind == .ready }!.body.contains("0/1 com prova"))
        XCTAssertEqual(Transitions.diff(prev: prev, tasks: ts, prevQ: [], questions: qs, isMine: mine, firstLoad: true), [], "1ª carga não avisa o passado")
        XCTAssertTrue(Transitions.diff(prev: prev, tasks: ts, prevQ: ["q1", "q2", "q3"], questions: qs, isMine: mine, firstLoad: false).allSatisfy { $0.kind != .question && $0.kind != .teto }, "pergunta já vista não repete")
        XCTAssertEqual(Transitions.prefKey(.teto), "push.questions"); XCTAssertEqual(Transitions.prefKey(.error), "push.errors")
    }

    // MARK: modelos

    func testDecodingIsLenient() throws {
        let j = #"{"id":"t","title":"x","status":"paused","updated_at":"2026-10-03T10:00:00Z","spec":{"budgetUsd":"5","requirements":["a"]},"requirements_proof":{"list":null}}"#
        let t = try JSONDecoder().decode(CloudTask.self, from: Data(j.utf8))
        XCTAssertEqual(t.spec?.budgetUsd, 5, "teto como texto não derruba o spec")
        XCTAssertNil(t.requirementsProof?.list, "requirements.json ainda não publicado")
        XCTAssertEqual(t.reqsProved?.done, 0); XCTAssertEqual(t.reqsProved?.total, 1)
        XCTAssertEqual(StatusMeta.label("paused"), "pausada")
        XCTAssertTrue(Teto.isTeto(agent: "Starfork", options: ["Continuar com mais US$ 5", "Parar aqui"]))
        XCTAssertFalse(Teto.isTeto(agent: "coder", options: ["Continuar com mais US$ 5"]))
    }

    func testOutboxBubbleText() {
        XCTAssertEqual(OutMsg(id: 1, body: "[req] botão azul", deliveredAt: nil, createdAt: nil).shown, "requisito: botão azul")
        XCTAssertEqual(OutMsg(id: 2, body: "[img] t/img.jpg | olha", deliveredAt: nil, createdAt: nil).shown, "📷 imagem: olha")
        XCTAssertEqual(OutMsg(id: 3, body: "oi", deliveredAt: nil, createdAt: nil).shown, "oi")
    }
}
