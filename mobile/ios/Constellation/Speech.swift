import SwiftUI
import Speech
import AVFoundation

/// Ditado por voz → texto (pt-BR). O agente recebe TEXTO — a fala é só o
/// jeito mais rápido de responder no celular.
@MainActor
final class SpeechDictation: NSObject, ObservableObject {
    @Published var recording = false
    @Published var denied = false

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "pt-BR"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var baseText = ""
    var onText: ((String) -> Void)?

    func toggle(current: String) {
        if recording { stop() } else { start(current: current) }
    }

    private func start(current: String) {
        SFSpeechRecognizer.requestAuthorization { auth in
            DispatchQueue.main.async {
                guard auth == .authorized else { self.denied = true; return }
                AVAudioApplication.requestRecordPermission { ok in
                    DispatchQueue.main.async {
                        guard ok else { self.denied = true; return }
                        self.begin(current: current)
                    }
                }
            }
        }
    }

    private func begin(current: String) {
        stop()
        baseText = current.isEmpty ? "" : current + " "
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            request = req
            let input = engine.inputNode
            let fmt = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buf, _ in
                req.append(buf)
            }
            engine.prepare()
            try engine.start()
            recording = true
            task = recognizer?.recognitionTask(with: req) { [weak self] result, err in
                guard let self else { return }
                DispatchQueue.main.async {
                    if let r = result {
                        self.onText?(self.baseText + r.bestTranscription.formattedString)
                    }
                    if err != nil || (result?.isFinal ?? false) { self.stop() }
                }
            }
        } catch { stop() }
    }

    func stop() {
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.cancel()
        request = nil; task = nil
        recording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// Botão de microfone pra qualquer campo de texto: segura o ditado e vai
/// preenchendo o binding em tempo real.
struct MicButton: View {
    @Binding var text: String
    @StateObject private var dict = SpeechDictation()

    var body: some View {
        Button {
            dict.onText = { t in text = t }
            dict.toggle(current: text)
        } label: {
            Image(systemName: dict.recording ? "waveform.circle.fill" : "mic.fill")
                .font(.system(size: dict.recording ? 22 : 16))
                .foregroundStyle(dict.recording ? T.warn : T.dim)
                .symbolEffect(.pulse, isActive: dict.recording)
        }
        .alert("Sem acesso ao microfone", isPresented: $dict.denied) {
            Button("Abrir Ajustes") {
                if let u = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(u)
                }
            }
            Button("Agora não", role: .cancel) {}
        } message: {
            Text("Libere microfone e reconhecimento de fala nos Ajustes pra responder por voz.")
        }
    }
}
