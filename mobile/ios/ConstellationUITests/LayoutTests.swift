import XCTest

/// Layout no tamanho do aparelho real (16/17 Pro Max · 17 · SE): nada vaza pro lado, nada rola de lado
/// (exceto carrosséis de chips marcados com o identificador "carousel"), e o compositor do chat fica
/// visível e digitável COM o teclado aberto. Roda contra a nuvem falsa (mock/mock-supabase.mjs).
final class LayoutTests: XCTestCase {
    var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = true
        executionTimeAllowance = 300
        ctl("reset")
    }

    @discardableResult
    func ctl(_ path: String) -> Data? {
        let sem = DispatchSemaphore(value: 0)
        var out: Data?
        URLSession.shared.dataTask(with: URL(string: FlowTests.mock + "/__ctl/" + path)!) { d, _, _ in out = d; sem.signal() }.resume()
        _ = sem.wait(timeout: .now() + 5)
        return out
    }

    func launch(_ env: [String: String] = [:], textSize: String? = nil) {
        app = XCUIApplication()
        if let textSize { app.launchArguments += ["-UIPreferredContentSizeCategoryName", textSize] }
        app.launchEnvironment = ["SUPA_URL": FlowTests.mock, "DEMO_SESSION": "1", "DEMO_RESET": "1", "UITEST": "1"].merging(env) { $1 }
        app.launch()
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Permitir", "Allow"] where sb.buttons[label].waitForExistence(timeout: 1) { sb.buttons[label].tap() }
    }

    func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let att = XCTAttachment(data: png, uniformTypeIdentifier: "public.png"); att.name = name; att.lifetime = .keepAlways; add(att)
        if let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
        }
    }

    func anyText(_ s: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", s)).firstMatch }

    /// todo elemento visível cabe na largura da tela (fora dos carrosséis "carousel")
    func assertNoOverflow(_ screen: String, file: StaticString = #filePath, line: UInt = #line) {
        guard let root = try? app.windows.firstMatch.snapshot() else { return XCTFail("sem snapshot", file: file, line: line) }
        let w = root.frame.width
        var bad: [String] = []
        func walk(_ s: XCUIElementSnapshot, inCarousel: Bool, path: String = "") {
            let carousel = inCarousel || s.identifier == "carousel"
            let here = path + "/\(s.elementType.rawValue)" + (s.identifier.isEmpty ? "" : "#\(s.identifier)")
            let f = s.frame
            // o que importa: texto, controle ou contêiner de rolagem do APP (o fundo/separador que o UIKit
            // estende além da célula e o escurecimento do sistema não são conteúdo)
            let meaningful = !s.label.isEmpty || [.scrollView, .collectionView, .table, .textField, .textView, .button, .staticText].contains(s.elementType)
            if !carousel, meaningful, !s.identifier.contains("Dimming"), f.width > 0, f.height > 0, f.maxY > 0, f.minY < root.frame.height,
               s.elementType != .window, s.elementType != .application, s.elementType != .keyboard {
                if f.width > w + 1 || f.minX < -1 || f.maxX > w + 1 {
                    bad.append("\(here) '\(String(s.label.prefix(50)))' x=\(Int(f.minX))…\(Int(f.maxX)) w=\(Int(f.width))")
                }
            }
            for c in s.children { walk(c, inCarousel: carousel, path: here) }
        }
        walk(root, inCarousel: false)
        XCTAssertTrue(bad.isEmpty, "\(screen): \(bad.count) elemento(s) vazam da largura \(Int(w)):\n" + bad.prefix(12).joined(separator: "\n"), file: file, line: line)
    }

    /// arrastar de lado NÃO move a página (só o carrossel)
    func assertNoSideScroll(_ screen: String, anchor: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        guard anchor.waitForExistence(timeout: 10) else { return XCTFail("\(screen): âncora não apareceu", file: file, line: line) }
        let before = anchor.frame.minX
        let w = app.windows.firstMatch.frame
        // arrasta EM CIMA da âncora (linha sem botão) — arrastar sobre um botão de resposta o acionaria
        let y = anchor.frame.midY / w.height
        let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: y))
        let end = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: y))
        start.press(forDuration: 0.05, thenDragTo: end)
        sleep(1)
        XCTAssertEqual(anchor.frame.minX, before, accuracy: 1, "\(screen): a página andou de lado (largura \(Int(w.width)))", file: file, line: line)
    }

    // MARK: testes

    /// Central e Minhas com textos LONGOS (título, branch, projeto, Mac): nada vaza, nada rola de lado
    func test01NoHorizontalOverflowMainScreens() {
        ctl("long")
        launch()
        XCTAssertTrue(anyText("Central").waitForExistence(timeout: 20))
        sleep(3)
        assertNoOverflow("Central")
        assertNoSideScroll("Central", anchor: app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", " online")).firstMatch)
        shot("L01-central-longos")
        app.terminate()

        launch(["DEMO_TAB": "minhas"])
        XCTAssertTrue(anyText("Minhas").waitForExistence(timeout: 20))
        sleep(3)
        assertNoOverflow("Minhas")
        assertNoSideScroll("Minhas", anchor: app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", " online")).firstMatch)
        shot("L02-minhas-longos")
        app.terminate()

        launch(["DEMO_TAB": "time"])
        sleep(5)
        assertNoOverflow("Time")
        shot("L03-time-longos")
        app.terminate()

        launch(["DEMO_TAB": "conta"])
        sleep(4)
        assertNoOverflow("Conta")
        shot("L04-conta")
    }

    /// detalhe com feed longo (URL/hash/caminho sem espaço) e a aba de provas
    func test02NoHorizontalOverflowDetail() {
        ctl("long")
        launch(["DEMO_OPEN_TASK": "dddddddd-0000-4000-8000-000000000001"])
        XCTAssertTrue(anyText("passou sem erro").waitForExistence(timeout: 20))
        sleep(2)
        assertNoOverflow("Detalhe · feed")
        shot("L05-detalhe-feed-longo")
        app.terminate()
        launch(["DEMO_OPEN_TASK": "dddddddd-0000-4000-8000-000000000002", "DEMO_DETAIL_TAB": "1"])
        sleep(6)
        assertNoOverflow("Detalhe · provas")
        shot("L06-detalhe-provas-longo")
    }

    /// o bug do aparelho: abrir a tarefa, tocar no campo, TECLADO ABERTO — o compositor fica visível
    /// acima do teclado (sem barra de abas por cima), digita e envia; o chat rola até a mensagem nova
    func test03ComposerAboveKeyboard() {
        launch(["DEMO_OPEN_TASK": "dddddddd-0000-4000-8000-000000000001"])
        let field = app.descendants(matching: .any).matching(identifier: "composer").firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 20), "compositor não apareceu")
        // nenhuma barra de abas no detalhe
        XCTAssertFalse(app.tabBars.firstMatch.exists && app.tabBars.firstMatch.isHittable, "barra de abas visível no detalhe")
        XCTAssertTrue(field.isHittable, "compositor coberto")
        field.tap()
        let kb = app.keyboards.firstMatch
        XCTAssertTrue(kb.waitForExistence(timeout: 8), "teclado não abriu")
        sleep(1)
        XCTAssertLessThanOrEqual(field.frame.maxY, kb.frame.minY + 1, "o teclado cobre o compositor")
        XCTAssertTrue(field.isHittable)
        field.typeText("troca o rótulo do frete pra Entrega estimada")
        let send = app.buttons["enviar"]
        XCTAssertTrue(send.isHittable, "botão enviar coberto")
        XCTAssertTrue(send.frame.maxY <= kb.frame.minY + 1 && send.frame.maxX <= app.windows.firstMatch.frame.width, "botão enviar fora da vista")
        assertNoOverflow("Detalhe · teclado aberto")
        shot("L07-compositor-teclado-aberto")
        send.tap()
        let bubble = anyText("Entrega estimada")
        XCTAssertTrue(bubble.waitForExistence(timeout: 10), "mensagem não apareceu no chat")
        XCTAssertTrue(bubble.isHittable, "o chat não rolou até a mensagem nova")
        XCTAssertLessThanOrEqual(bubble.frame.maxY, (kb.exists ? kb.frame.minY : app.windows.firstMatch.frame.maxY), "mensagem nova escondida")
        shot("L08-mensagem-enviada")
    }

    /// Dynamic Type GRANDE (acessibilidade L): tudo cresce e continua cabendo na largura
    func test04LargeDynamicType() {
        ctl("long")
        let big = "UICTContentSizeCategoryAccessibilityL"
        launch(textSize: big)
        XCTAssertTrue(anyText("Central").waitForExistence(timeout: 20))
        sleep(3)
        assertNoOverflow("Central · texto grande")
        shot("L09-central-texto-grande")
        app.terminate()
        launch(["DEMO_TAB": "minhas"], textSize: big)
        sleep(5)
        assertNoOverflow("Minhas · texto grande")
        shot("L10-minhas-texto-grande")
        app.terminate()
        launch(["DEMO_OPEN_TASK": "dddddddd-0000-4000-8000-000000000001"], textSize: big)
        sleep(6)
        assertNoOverflow("Detalhe · texto grande")
        shot("L11-detalhe-texto-grande")
        app.terminate()
        launch(["DEMO_TAB": "conta"], textSize: big)
        sleep(4)
        assertNoOverflow("Conta · texto grande")
        shot("L12-conta-texto-grande")
    }
}
