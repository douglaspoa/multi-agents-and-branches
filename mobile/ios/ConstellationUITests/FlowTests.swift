import XCTest

/// Fluxos de ponta a ponta contra a NUVEM FALSA (mobile/ios/mock/mock-supabase.mjs, que também faz o papel do Mac).
/// Rodar:  node mobile/ios/mock/mock-supabase.mjs &
///         TEST_RUNNER_SHOTS_DIR=/caminho xcodebuild test … -only-testing:ConstellationUITests
/// Cada teste zera a nuvem falsa e o app (DEMO_RESET), entra com um token VENCIDO (prova a renovação) e fotografa.
final class FlowTests: XCTestCase {
    static let mock = "http://127.0.0.1:54399"
    var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = true
        executionTimeAllowance = 240
        ctl("reset")
    }

    // MARK: utilidades

    @discardableResult
    func ctl(_ path: String) -> Data? {
        let sem = DispatchSemaphore(value: 0)
        var out: Data?
        URLSession.shared.dataTask(with: URL(string: Self.mock + "/__ctl/" + path)!) { d, _, _ in out = d; sem.signal() }.resume()
        _ = sem.wait(timeout: .now() + 5)
        return out
    }
    /// escritas que a nuvem falsa recebeu (o que o "Mac" viu)
    func writes(_ table: String) -> [[String: Any]] {
        guard let d = ctl("log?n=400"), let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { return [] }
        return arr.filter { $0["table"] as? String == table }.compactMap { $0["rec"] as? [String: Any] }
    }

    func launch(_ env: [String: String] = [:]) {
        app = XCUIApplication()
        app.launchEnvironment = ["SUPA_URL": Self.mock, "DEMO_SESSION": "1", "DEMO_RESET": "1", "UITEST": "1"].merging(env) { $1 }
        app.launch()
        // alerta de permissão de notificação de outra rodada: permite (os avisos locais aparecem nos prints)
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Permitir", "Allow"] where sb.buttons[label].waitForExistence(timeout: 2) { sb.buttons[label].tap() }
    }

    func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let att = XCTAttachment(data: png, uniformTypeIdentifier: "public.png"); att.name = name; att.lifetime = .keepAlways; add(att)
        if let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
        }
    }

    func text(_ s: String) -> XCUIElement { app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", s)).firstMatch }
    func anyText(_ s: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", s)).firstMatch }
    func waitText(_ s: String, _ t: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(anyText(s).waitForExistence(timeout: t), "não apareceu: \(s)", file: file, line: line)
    }
    func waitGone(_ s: String, _ t: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) {
        let e = anyText(s)
        let exp = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: e)
        XCTAssertEqual(XCTWaiter().wait(for: [exp], timeout: t), .completed, "não sumiu: \(s)", file: file, line: line)
    }
    func scrollTo(_ e: XCUIElement, max: Int = 8) {
        var n = 0
        while !e.isHittable && n < max { app.swipeUp(velocity: .slow); n += 1 }
    }

    // MARK: fluxos

    /// Central ao vivo: websocket conectado, Mac online com o projeto aberto, filtro de projetos, teto e perguntas
    func test01CentralLiveAndMac() {
        launch()
        waitText("AO VIVO", 20)
        waitText("MacBook do Douglas online")
        waitText("Teto de custo")
        shot("01-central-ao-vivo")
        XCTAssertFalse(writes("auth").isEmpty, "entrou com token vencido → renovou")
        // filtro de projeto: menu nativo da barra (antes um carrossel de chips que vazava da tela)
        app.buttons["project-filter"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'api-pagamentos'")).firstMatch.tap()
        waitText("Corrigir arredondamento do Pix")
        shot("02-central-filtro-projeto")
    }

    /// responder a pergunta do agente direto no card + teto de custo; o "Mac" entrega e fecha
    func test02AnswerQuestionAndTeto() {
        launch()
        let opt = app.buttons["mostrar aviso e seguir"]
        XCTAssertTrue(opt.waitForExistence(timeout: 20))
        opt.tap()
        waitText("resposta enviada")
        shot("03-resposta-enviada")
        XCTAssertTrue(writes("questions").contains { $0["answer"] as? String == "mostrar aviso e seguir" && $0["status"] as? String == "answered" })
        let more = app.buttons["Continuar com mais US$ 5"]
        scrollTo(more)
        more.tap()
        waitGone("Teto de custo", 15)
        XCTAssertTrue(writes("questions").contains { ($0["answer"] as? String ?? "").hasPrefix("Continuar com mais") })
        shot("04-teto-respondido")
    }

    /// follow-up do celular com o Mac OFFLINE: fica "na fila"; o Mac volta e entrega (sem duplicar)
    func test03FollowUpQueuedWhileMacOffline() {
        ctl("mac?online=0&ago=720")
        launch(["DEMO_OPEN_TASK": "dddddddd-0000-4000-8000-000000000002"])
        waitText("Mac offline", 20)
        let field = app.descendants(matching: .any).matching(identifier: "composer").firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("troca o texto do botão pra Entrar com Apple")
        app.buttons["enviar"].tap()
        waitText("o Mac entrega quando puder")
        shot("05-follow-up-na-fila-mac-offline")
        ctl("mac?online=1")
        waitGone("o Mac entrega quando puder", 20)
        waitText("Entendido — ajustando agora", 20)
        shot("06-follow-up-entregue")
        let echoes = writes("task_feed").filter { ($0["text"] as? String ?? "").hasPrefix("Você: troca o texto") }
        XCTAssertEqual(echoes.count, 1, "entregue UMA vez")
    }

    /// aprovar com o PORTÃO DE PROVA: pedir a prova; aprovar sem prova exige motivo; o Mac abre o PR
    func test04ApproveWithProofGate() {
        launch(["DEMO_OPEN_TASK": "dddddddd-0000-4000-8000-000000000002", "DEMO_DETAIL_TAB": "1"])
        waitText("feito, mas sem arquivo de prova", 20)
        let ask = app.buttons["Pedir a prova ao agente"]
        scrollTo(ask)
        shot("07-entrega-portao-de-prova")
        ask.tap()
        waitText("pedido de prova enviado", 20)
        let noProof = app.buttons["Aprovar sem prova…"]
        scrollTo(noProof)
        noProof.tap()
        let reason = app.textFields["motivo (obrigatório)"].exists ? app.textFields["motivo (obrigatório)"] : app.textViews.firstMatch
        XCTAssertTrue(reason.waitForExistence(timeout: 5))
        reason.tap(); reason.typeText("cliente validou o vídeo na call")
        shot("08-aprovar-sem-prova-motivo")
        app.buttons["aprovar sem prova e abrir PR"].tap()
        waitText("PR aberto", 20)
        shot("09-pr-aberto")
        XCTAssertTrue(writes("tasks").contains { (($0["spec"] as? [String: Any])?["intent"] as? [String: Any])?["noProofReason"] as? String == "cliente validou o vídeo na call" })
    }

    /// provas publicadas: miniatura de verdade, imagem e VÍDEO tocando no app
    func test05ProofsImageAndVideo() {
        launch(["DEMO_OPEN_TASK": "dddddddd-0000-4000-8000-000000000002", "DEMO_DETAIL_TAB": "1"])
        waitText("Requisitos com prova", 20)
        let vid = app.buttons["vídeo mobile-ios-1-fluxo.mp4"]
        var n = 0
        while !(vid.exists && vid.isHittable) && n < 8 { app.swipeUp(velocity: .slow); n += 1 }   // a galeria é preguiçosa (LazyVGrid)
        XCTAssertTrue(vid.waitForExistence(timeout: 10))
        sleep(2)
        shot("10-galeria-de-provas")
        vid.tap()
        XCTAssertTrue(app.buttons["fechar"].waitForExistence(timeout: 10))
        sleep(3)
        shot("11-prova-video")
        app.buttons["fechar"].tap()
        let img = app.buttons["imagem proof-login.png"]
        scrollTo(img); img.tap()
        XCTAssertTrue(app.buttons["fechar"].waitForExistence(timeout: 10))
        sleep(2)
        shot("12-prova-imagem")
    }

    /// controles do agente à vista: pausar → retomar; abortar pede confirmação
    func test06PauseResume() {
        launch(["DEMO_OPEN_TASK": "dddddddd-0000-4000-8000-000000000001"])
        let pause = app.buttons["pausar o agente"]
        XCTAssertTrue(pause.waitForExistence(timeout: 20))
        shot("13-conversa-ao-vivo")
        pause.tap()
        waitText("Pausada", 20)
        let resume = app.buttons["retomar o agente"]
        XCTAssertTrue(resume.waitForExistence(timeout: 15))
        shot("14-pausada")
        resume.tap()
        XCTAssertTrue(app.buttons["pausar o agente"].waitForExistence(timeout: 20))
        XCTAssertTrue(writes("tasks").contains { (($0["spec"] as? [String: Any])?["intentResult"] as? [String: Any])?["kind"] as? String == "resume" })
    }

    /// conexão caiu: selo honesto (RECONECTANDO), nuvem fora (aviso), volta sozinho; token vencido no meio
    func test07ReconnectAndTokenExpiry() {
        launch()
        waitText("AO VIVO", 20)
        ctl("ws?down=1"); ctl("drop")
        waitText("Reconectando", 15)
        shot("15-reconectando")
        ctl("rest?down=1")
        waitText("Reconectando…", 30)   // REST também fora: a faixa sobe de "reconectando o ao vivo" pra aviso
        shot("16-nuvem-fora")
        ctl("rest?down=0"); ctl("ws?down=0")
        waitText("AO VIVO", 40)
        // token vence com o socket aberto: o servidor fecha o canal; o app renova e segue respondendo
        ctl("expire")
        let opt = app.buttons["bloquear o checkout"]
        XCTAssertTrue(opt.waitForExistence(timeout: 20))
        opt.tap()
        waitText("resposta enviada", 20)
        XCTAssertGreaterThanOrEqual(writes("auth").count, 2, "renovou de novo depois do token vencer")
        waitText("AO VIVO", 30)
        shot("17-voltou-ao-vivo")
    }

    /// nova demanda do celular: o app avisa que o Mac está com OUTRO projeto aberto; no projeto aberto ele assume
    func test08NewTaskFromPhone() {
        launch(["DEMO_NEW": "1"])
        let obj = app.textFields["descreva o objetivo com detalhes…"].exists ? app.textFields["descreva o objetivo com detalhes…"] : app.textViews.firstMatch
        XCTAssertTrue(obj.waitForExistence(timeout: 20))
        obj.tap(); obj.typeText("Mostrar o prazo de entrega no carrinho")
        // projeto que o Mac NÃO está com aberto: o app avisa antes de mandar
        let proj = app.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Projeto'")).firstMatch
        scrollTo(proj)
        if !anyText("loja-web aberto").exists && !anyText("O Mac está com").exists {
            proj.tap(); app.buttons["api-pagamentos"].firstMatch.tap()
        }
        waitText("O Mac está com loja-web aberto", 10)
        shot("18-nova-demanda-outro-projeto")
        proj.tap(); app.buttons["loja-web"].firstMatch.tap()
        waitGone("O Mac está com loja-web aberto", 10)
        shot("18b-nova-demanda")
        let go = app.buttons["iniciar no meu Mac ▸"]
        scrollTo(go)
        go.tap()
        waitText("o Mac assumiu", 25)
        shot("19-demanda-assumida-pelo-mac")
        XCTAssertTrue(writes("tasks").contains { $0["status"] as? String == "requested" })
    }

    /// demais telas
    func test09OtherTabs() {
        launch(["DEMO_TAB": "minhas"])
        waitText("Minhas", 20); sleep(2)
        shot("20-minhas")
        app.terminate()
        launch(["DEMO_TAB": "time"])
        sleep(4)
        shot("21-time")
        app.terminate()
        launch(["DEMO_TAB": "conta"])
        waitText("Conexão com o Mac", 20); sleep(2)
        shot("22-conta-conexao")
    }
}
