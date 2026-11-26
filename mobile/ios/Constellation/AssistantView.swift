import SwiftUI
import Speech
import AVFoundation

/// ASSISTENTE POR VOZ: você fala, o Starfork do seu Mac faz e responde em voz alta — e volta a ouvir.
/// A fala vira texto aqui no iPhone, vai pela nuvem (comando_msgs) pro Comando do Mac — que age no projeto aberto
/// lá — e a resposta volta em texto curto, lido pela voz do iPhone. Sem digitar; o campo de texto é só reserva.
@MainActor
final class Assistant: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    enum Phase: Equatable { case off, listening, thinking, speaking }
    struct Line: Identifiable, Equatable { let id = UUID(); let mine: Bool; let text: String; var warn = false }

    @Published var phase: Phase = .off
    @Published var partial = ""
    @Published var lines: [Line] = []
    @Published var denied = false
    /// conversa ligada: depois de responder, volta a ouvir sozinho
    @Published var active = false

    weak var supa: Supa?
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "pt-BR"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let synth = AVSpeechSynthesizer()
    private var lastChange = Date()
    private var watcher: Task<Void, Never>?
    private var work: Task<Void, Never>?
    private var emptyRounds = 0
    private var gen = 0

    override init() { super.init(); synth.delegate = self }

    // MARK: ligar / desligar
    func toggle() {
        if phase == .speaking { synth.stopSpeaking(at: .immediate); if active { listen() } else { phase = .off }; return }
        if active { stop(); return }
        SFSpeechRecognizer.requestAuthorization { auth in
            DispatchQueue.main.async {
                guard auth == .authorized else { self.denied = true; return }
                AVAudioApplication.requestRecordPermission { ok in
                    DispatchQueue.main.async {
                        guard ok else { self.denied = true; return }
                        self.active = true; self.emptyRounds = 0
                        UIApplication.shared.isIdleTimerDisabled = true
                        Haptic.tap()
                        self.listen()
                    }
                }
            }
        }
    }

    func stop() {
        active = false; gen += 1
        work?.cancel(); work = nil
        stopEngine()
        synth.stopSpeaking(at: .immediate)
        phase = .off; partial = ""
        UIApplication.shared.isIdleTimerDisabled = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: ouvir
    private func listen() {
        guard active else { phase = .off; return }
        stopEngine()
        partial = ""; lastChange = Date(); phase = .listening
        let myGen = gen
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            request = req
            let input = engine.inputNode
            let fmt = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buf, _ in req.append(buf) }
            engine.prepare()
            try engine.start()
            task = recognizer?.recognitionTask(with: req) { [weak self] result, err in
                DispatchQueue.main.async {
                    guard let self, self.gen == myGen, self.phase == .listening else { return }
                    if let r = result {
                        let t = r.bestTranscription.formattedString
                        if t != self.partial { self.partial = t; self.lastChange = Date() }
                        if r.isFinal { self.endUtterance() }
                    } else if err != nil { self.endUtterance() }
                }
            }
            // a fala acaba quando o texto para de mudar por um instante
            watcher = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    guard let self, self.gen == myGen, self.phase == .listening else { return }
                    if AssistLogic.utteranceDone(text: self.partial, lastChange: self.lastChange) { self.endUtterance(); return }
                }
            }
        } catch {
            stop()
            say("Não consegui abrir o microfone.", warn: true, speak: false)
        }
    }

    private func endUtterance() {
        guard phase == .listening else { return }
        let text = partial.trimmingCharacters(in: .whitespacesAndNewlines)
        stopEngine()
        guard AssistLogic.worthSending(text) else {
            // nada dito: volta a ouvir (o reconhecedor do iOS encerra sozinho de tempos em tempos)
            emptyRounds += 1
            if emptyRounds >= 20 { stop(); say("Parei de ouvir por silêncio. Toque pra falar de novo.", warn: false, speak: false); return }
            let myGen = gen
            Task { try? await Task.sleep(nanoseconds: 300_000_000); if self.gen == myGen, self.active { self.listen() } }
            return
        }
        emptyRounds = 0
        send(text)
    }

    private func stopEngine() {
        watcher?.cancel(); watcher = nil
        if engine.isRunning { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
        request?.endAudio(); task?.cancel()
        request = nil; task = nil
    }

    // MARK: mandar pro Mac e esperar
    func send(_ raw: String) {
        let text = String(raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
        guard AssistLogic.worthSending(text), let supa else { return }
        stopEngine()
        partial = ""
        lines.append(.init(mine: true, text: text))
        phase = .thinking
        Haptic.select()
        gen += 1
        let myGen = gen
        work = Task { [weak self] in
            do {
                let reply = try await Self.ask(supa, text)
                guard let self, self.gen == myGen else { return }
                self.say(reply, warn: false, speak: true)
            } catch {
                guard let self, self.gen == myGen, !Task.isCancelled else { return }
                self.say(Self.explain(error), warn: true, speak: true)
            }
        }
    }

    enum AskError: Error { case macOff, tooLong, noTable }

    /// grava a fala, espera o Mac pegar e responder (a resposta é a linha `bot` com reply_to = a fala)
    private static func ask(_ supa: Supa, _ text: String) async throws -> String {
        let made: Data
        do { made = try await supa.rest("comando_msgs", method: "POST", json: ["role": "user", "body": text]) }
        catch Supa.SupaError.missingTable { throw AskError.noTable }
        guard let row = ((try? JSONSerialization.jsonObject(with: made)) as? [[String: Any]])?.first, let id = (row["id"] as? NSNumber)?.int64Value else {
            throw Supa.SupaError.api("a nuvem não confirmou o pedido")
        }
        let t0 = Date()
        var picked = false
        while true {
            try await Task.sleep(nanoseconds: 900_000_000)
            try Task.checkCancellation()
            if let d = try? await supa.rest("comando_msgs?select=body&reply_to=eq.\(id)&role=eq.bot&order=id&limit=1"),
               let r = ((try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]])?.first, let body = r["body"] as? String {
                return body
            }
            if !picked, let d = try? await supa.rest("comando_msgs?select=state&id=eq.\(id)"),
               let r = ((try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]])?.first, let st = r["state"] as? String, st != "novo" {
                picked = true
            }
            switch AssistLogic.wait(elapsed: Date().timeIntervalSince(t0), picked: picked) {
            case .keep: continue
            case .macOff:
                // tira da fila: o Mac não pode executar isso horas depois, quando abrir
                _ = try? await supa.rest("comando_msgs?id=eq.\(id)&state=eq.novo", method: "PATCH", json: ["state": "erro"])
                throw AskError.macOff
            case .tooLong: throw AskError.tooLong
            }
        }
    }

    private static func explain(_ e: Error) -> String {
        switch e {
        case AskError.macOff: return "Seu Mac não pegou o pedido. O Starfork precisa estar aberto nele, com a conta conectada."
        case AskError.tooLong: return "O Mac ainda está trabalhando nisso. Pergunte de novo daqui a pouco."
        case AskError.noTable: return "O assistente ainda não foi ligado na nuvem da sua conta."
        case Supa.SupaError.offline: return "Sem internet agora. Tente de novo quando voltar."
        default: return "Não consegui falar com o Mac. Tente de novo."
        }
    }

    // MARK: falar
    private func say(_ text: String, warn: Bool, speak: Bool) {
        lines.append(.init(mine: false, text: text, warn: warn))
        if warn { Haptic.warning() }
        guard speak else { if phase != .listening { phase = .off }; return }
        phase = .speaking
        try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
        let u = AVSpeechUtterance(string: AssistLogic.speakable(text))
        u.voice = Self.bestVoice
        u.rate = AVSpeechUtteranceDefaultSpeechRate * 1.04
        synth.speak(u)
    }

    /// a melhor voz em português do aparelho (Premium > Aprimorada > padrão)
    private static let bestVoice: AVSpeechSynthesisVoice? = {
        let pt = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "pt-BR" }
        return pt.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: "pt-BR")
    }()

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in
            guard self.phase == .speaking else { return }
            if self.active { self.listen() } else { self.phase = .off }
        }
    }
}

struct AssistantView: View {
    @EnvironmentObject var supa: Supa
    @EnvironmentObject var hub: SyncHub
    @StateObject private var a = Assistant()
    @State private var typed = ""
    @FocusState private var typing: Bool

    private var title: String {
        switch a.phase {
        case .off: return a.active ? "…" : "Toque e fale"
        case .listening: return "Ouvindo"
        case .thinking: return "Fazendo no seu Mac"
        case .speaking: return "Respondendo"
        }
    }
    private var hint: String {
        switch a.phase {
        case .off: return "Peça o que quiser: como estão as tarefas, crie uma demanda, responda um agente, abra o PR."
        case .listening: return a.partial.isEmpty ? "Pode falar." : a.partial
        case .thinking: return "O Comando está atendendo no projeto aberto no Mac."
        case .speaking: return "Toque pra interromper."
        }
    }
    private var color: Color {
        switch a.phase {
        case .off: return T.accent
        case .listening: return T.warn
        case .thinking: return T.info
        case .speaking: return T.accent
        }
    }
    private var icon: String {
        switch a.phase {
        case .off: return "mic.fill"
        case .listening: return "waveform"
        case .thinking: return "ellipsis"
        case .speaking: return "speaker.wave.2.fill"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if a.lines.isEmpty {
                            Text("Fale com o Starfork como fala com uma pessoa do time. Ele age no projeto que estiver aberto no seu Mac e pede confirmação antes de qualquer coisa sem volta.")
                                .font(.ui(15)).foregroundStyle(T.dim)
                                .padding(.top, 8)
                        }
                        ForEach(a.lines) { l in
                            Text(l.text)
                                .font(.ui(16))
                                .foregroundStyle(l.mine ? T.onAccent : (l.warn ? T.warn : T.text))
                                .padding(.horizontal, 14).padding(.vertical, 10)
                                .background(l.mine ? T.accent : T.panel)
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                                .frame(maxWidth: .infinity, alignment: l.mine ? .trailing : .leading)
                                .id(l.id)
                                .accessibilityLabel((l.mine ? "Você: " : "Starfork: ") + l.text)
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                }
                .onChange(of: a.lines.count) { _, _ in
                    if let last = a.lines.last { withAnimation(T.still ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }

            VStack(spacing: 12) {
                Text(title).font(.ui(20, .semibold)).foregroundStyle(T.text)
                    .accessibilityIdentifier("assist.title")
                Text(hint).font(.ui(15)).foregroundStyle(T.dim)
                    .multilineTextAlignment(.center).lineLimit(3)
                    .frame(maxWidth: .infinity, minHeight: 58, alignment: .top)
                    .accessibilityIdentifier("assist.hint")
                Button { typing = false; a.toggle() } label: {
                    ZStack {
                        Circle().fill(color.opacity(0.16)).frame(width: 132, height: 132)
                        Circle().fill(color).frame(width: 96, height: 96)
                        Image(systemName: icon).font(.system(size: 36, weight: .semibold)).foregroundStyle(T.onAccent)
                            .symbolEffect(.pulse, isActive: !T.still && a.phase != .off)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("assist.mic")
                .accessibilityLabel(a.active ? "Encerrar a conversa por voz" : "Falar com o Starfork")
                if a.active {
                    Button("Encerrar a conversa") { a.stop() }
                        .font(.ui(15, .medium)).foregroundStyle(T.dim)
                        .frame(minHeight: 44)
                }
                // reserva: digitar (lugar barulhento, simulador)
                HStack(spacing: 8) {
                    TextField("ou escreva aqui", text: $typed, axis: .vertical)
                        .lineLimit(1...3).font(.ui(16)).foregroundStyle(T.text)
                        .focused($typing)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .background(T.panel).clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(T.line))
                        .accessibilityIdentifier("assist.field")
                    Button {
                        let t = typed; typed = ""; typing = false; a.send(t)
                    } label: {
                        Image(systemName: "arrow.up").font(.ui(16, .bold)).foregroundStyle(T.onAccent)
                            .frame(width: 44, height: 44).background(T.accent).clipShape(Circle())
                    }
                    .disabled(!AssistLogic.worthSending(typed) || a.phase == .thinking)
                    .opacity(AssistLogic.worthSending(typed) && a.phase != .thinking ? 1 : 0.4)
                    .accessibilityIdentifier("assist.send")
                    .accessibilityLabel("Enviar")
                }
            }
            .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 12)
            .background(T.panel2)
        }
        .background(T.bg.ignoresSafeArea())
        .navigationTitle("Assistente")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            a.supa = supa
            #if DEBUG
            if let t = ProcessInfo.processInfo.environment["DEMO_ASSIST"], !t.isEmpty, a.lines.isEmpty { a.send(t) }
            #endif
        }
        .onDisappear { a.stop() }
        .alert("Sem acesso ao microfone", isPresented: $a.denied) {
            Button("Abrir Ajustes") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
            Button("Agora não", role: .cancel) {}
        } message: {
            Text("Libere microfone e reconhecimento de fala nos Ajustes pra conversar por voz.")
        }
    }
}
