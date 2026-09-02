import SwiftUI

/// A tarefa AO VIVO: feed do agente (o Mac publica os passos) + chat direto
/// com o agente + perguntas abertas desta tarefa. Poll de 3s.
struct TaskDetailView: View {
    @EnvironmentObject var supa: Supa
    let taskId: String
    let title: String

    struct FeedItem: Identifiable, Decodable {
        let id: Int
        let agent: String
        let kind: String
        let text: String
        let at: String
    }

    @State private var status = ""
    @State private var flag: String? = nil
    @State private var prUrl: String? = nil
    @State private var previewUrl: String? = nil
    @State private var feed: [FeedItem] = []
    @State private var lastId = 0
    @State private var msg = ""
    @State private var sending = false
    @State private var question: Question? = nil
    @State private var error = ""
    @State private var ticked = false   // 1º ciclo de dados completo → sai o esqueleto
    @State private var localPreview: String? = nil   // agente anunciou 🌐 no Mac (URL local)
    @State private var requestingTunnel = false

    var body: some View {
        VStack(spacing: 0) {
            header
            previewBar
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        if feed.isEmpty && !ticked {
                            FeedSkeleton().padding(.top, 12)
                        } else if feed.isEmpty {
                            Text("esperando o agente… os passos aparecem aqui ao vivo")
                                .font(.footnote).foregroundStyle(T.dim).padding(.top, 30)
                                .frame(maxWidth: .infinity)
                        }
                        ForEach(feed) { f in feedRow(f).id(f.id) }
                    }
                    .padding(12)
                }
                .onChange(of: feed.count) { _, _ in
                    if let last = feed.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            if let q = question { questionBar(q) }
            inputBar
        }
        .background(T.bg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            while !Task.isCancelled {
                await tick()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private var header: some View {
        let st = T.status(status, flag: flag)
        return HStack(spacing: 8) {
            Circle().fill(st.1).frame(width: 8, height: 8)
            Text(st.0).font(.system(.caption, design: .monospaced).bold()).foregroundStyle(st.1)
            if status == "requested" {
                Text("· esperando seu Mac assumir").font(.caption2).foregroundStyle(T.dim)
            }
            Spacer()
            if let pv = previewUrl, let url = URL(string: pv) {
                Link(destination: url) {
                    Label("preview", systemImage: "globe")
                        .font(.system(.caption, design: .monospaced).bold())
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(T.accent.opacity(0.15)).foregroundStyle(T.accent)
                        .clipShape(Capsule())
                }
            }
            if let pr = prUrl, let url = URL(string: pr) {
                Link("PR ↗", destination: url)
                    .font(.system(.caption, design: .monospaced).bold()).foregroundStyle(T.accent)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .background(T.panel)
    }

    /// Barra do preview — impossível não ver: abrir quando o túnel existe,
    /// pedir o túnel DAQUI quando só há a URL local do Mac, e o estado criando.
    @ViewBuilder
    private var previewBar: some View {
        if let pv = previewUrl, let url = URL(string: pv) {
            HStack(spacing: 0) {
                Link(destination: url) {
                    HStack {
                        Image(systemName: "play.rectangle.fill")
                        Text("abrir preview ao vivo").bold()
                        Spacer()
                        Image(systemName: "arrow.up.right")
                    }
                    .font(.system(.subheadline, design: .monospaced))
                    .padding(.horizontal, 14).padding(.vertical, 11)
                }
                Button {
                    Task { await requestTunnelClose() }
                } label: {
                    Image(systemName: "xmark")
                        .font(.subheadline.bold())
                        .padding(.horizontal, 14).padding(.vertical, 13)
                        .background(Color.black.opacity(0.18))
                }
            }
            .background(T.accent).foregroundStyle(.black)
        } else if requestingTunnel {
            HStack {
                ProgressView().tint(T.accent).scaleEffect(0.8)
                Text("criando acesso do celular… (~10s)").font(.footnote)
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(T.accent.opacity(0.10)).foregroundStyle(T.accent)
        } else if localPreview != nil {
            Button {
                Task { await requestTunnel() }
            } label: {
                HStack {
                    Image(systemName: "iphone.radiowaves.left.and.right")
                    Text("o agente subiu um preview no Mac — tocar pra abrir aqui").font(.footnote).bold()
                    Spacer()
                }
                .padding(.horizontal, 14).padding(.vertical, 11)
                .background(T.accent.opacity(0.12)).foregroundStyle(T.accent)
            }
        }
    }

    /// Fechar DO celular: escreve tunnelClose; o Mac mata o túnel e limpa a URL.
    private func requestTunnelClose() async {
        if let d = try? await supa.rest("tasks?select=spec&id=eq.\(taskId)"),
           let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]],
           var spec = arr.first?["spec"] as? [String: Any] {
            spec["tunnelClose"] = ISO8601DateFormatter().string(from: Date())
            spec["previewUrl"] = nil
            _ = try? await supa.rest("tasks?id=eq.\(taskId)", method: "PATCH", json: ["spec": spec])
        }
        await MainActor.run { previewUrl = nil }
    }

    /// Escreve a intenção na nuvem; o Mac cria o túnel e publica previewUrl.
    private func requestTunnel() async {
        requestingTunnel = true
        if let d = try? await supa.rest("tasks?select=spec&id=eq.\(taskId)"),
           let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]],
           var spec = arr.first?["spec"] as? [String: Any] {
            spec["tunnelWanted"] = ISO8601DateFormatter().string(from: Date())
            _ = try? await supa.rest("tasks?id=eq.\(taskId)", method: "PATCH", json: ["spec": spec])
        }
        // o poll (tick) troca requestingTunnel quando previewUrl chegar; teto de 45s
        Task { try? await Task.sleep(for: .seconds(45)); await MainActor.run { requestingTunnel = false } }
    }

    @ViewBuilder
    private func feedRow(_ f: FeedItem) -> some View {
        if f.kind == "bash" {
            // comando em bloco de código, como no terminal
            HStack(alignment: .top, spacing: 6) {
                Text("$").font(.system(.caption, design: .monospaced).bold()).foregroundStyle(T.accent.opacity(0.7))
                Text(f.text).font(.system(.caption, design: .monospaced)).foregroundStyle(T.text.opacity(0.75))
                    .textSelection(.enabled)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Color.black.opacity(0.35))
            .clipShape(RoundedRectangle(cornerRadius: 7))
        } else {
            feedTextRow(f)
        }
    }

    @ViewBuilder
    private func feedTextRow(_ f: FeedItem) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(icon(f.kind)).font(.caption).foregroundStyle(color(f.kind).opacity(0.8))
            VStack(alignment: .leading, spacing: 2) {
                // linha com URL (ex.: '🌐 preview: http://…' ou '📱 preview no celular: https://…') vira link
                if let r = f.text.range(of: #"https?://[^\s]+"#, options: .regularExpression),
                   let url = URL(string: String(f.text[r])) {
                    Link(destination: url) {
                        Text(f.text)
                            .font(.footnote)
                            .foregroundStyle(T.accent)
                            .underline()
                            .multilineTextAlignment(.leading)
                    }
                } else {
                    Text(f.text)
                        .font(.footnote)
                        .foregroundStyle(color(f.kind))
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
    }

    private func icon(_ k: String) -> String {
        switch k {
        case "bash": return "$"
        case "edit", "write": return "✎"
        case "error": return "✖"
        case "done": return "✔"
        case "think": return "·"
        default: return "•"
        }
    }
    private func color(_ k: String) -> Color {
        switch k {
        case "bash": return T.dim
        case "edit", "write": return T.accent
        case "error": return T.bad
        case "done": return T.accent
        case "think": return T.text.opacity(0.85)
        default: return T.dim
        }
    }

    @ViewBuilder
    private func questionBar(_ q: Question) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("❓ \(q.agent.isEmpty ? "agente" : q.agent) pergunta:").font(.caption.bold()).foregroundStyle(T.warn)
            Text(q.prompt).font(.footnote).foregroundStyle(T.text).lineLimit(4)
            if !q.options.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(q.options, id: \.self) { opt in
                            Button(opt) { Task { await answerQuestion(q, text: opt) } }
                                .font(.system(.caption2, design: .monospaced))
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(T.warn.opacity(0.15)).foregroundStyle(T.warn)
                                .clipShape(Capsule())
                        }
                    }
                }
            }
            Text("ou responda no campo abaixo ↓").font(.caption2).foregroundStyle(T.dim)
        }
        .padding(12)
        .background(T.warn.opacity(0.07))
    }

    static let designPrompt = """
    MODO DESIGN — refine o VISUAL desta entrega comigo, agindo como um designer sênior de produto:
    1) Suba o ambiente (siga o .cardume/RUNBOOK.md) e ANUNCIE "🌐 preview: <url da tela em questão>" pra eu acompanhar ao vivo (também vejo do celular).
    2) Faça um DIAGNÓSTICO visual objetivo da tela atual (hierarquia, espaçamento, tipografia, cores, estados vazios, consistência com o design system JÁ EXISTENTE no projeto) e liste os 3 piores problemas.
    3) ANTES de mexer, pergunte via mcp__cardume__ask_human o que priorizar — sempre com OPÇÕES CONCRETAS (nunca "o que você quer mudar?"). Se referência visual ajudar, peça.
    4) Aplique em ITERAÇÕES CURTAS: um ajuste por vez, re-anuncie o preview e pergunte "melhorou? sigo?" com opções.
    5) Só finalize quando eu aprovar explicitamente; ao final, screenshot antes/depois nos artefatos.
    """

    /// paleta "/" — mesmas skills do desktop
    static let skills: [(String, String, String)] = [
        ("design", "refinar o visual comigo — diagnóstico, opções e iterações com preview", designPrompt),
        ("preview", "subir o ambiente e me dar o link ao vivo", "Suba o ambiente local desta branch AGORA (siga o .cardume/RUNBOOK.md) e ANUNCIE \"🌐 preview: <url da tela desta tarefa>\". Mantenha rodando e re-anuncie se trocar de página."),
        ("requisitos", "verificar cada requisito e gerar as provas", "Verifique AGORA cada requisito do TASK.yaml, um a um: diga se está cumprido, linke a evidência real (print e/ou teste) e gere/atualize .cardume/artifacts/requirements.json. Se algum não estiver cumprido, me pergunte via ask_human antes de finalizar."),
        ("testes", "rodar a suíte real e anexar a saída", "Rode os testes REAIS na suíte do projeto pra esta branch (comandos do .cardume/RUNBOOK.md). Salve .cardume/artifacts/tests.md com os comandos e a SAÍDA literal. Falhou algo? Investigue e corrija antes de me responder."),
        ("provas", "provar na UI real com screenshots", "Prove que a entrega funciona NA UI REAL: suba o ambiente (RUNBOOK), execute o fluxo desta tarefa de ponta a ponta e capture screenshots reais em .cardume/artifacts/. Anuncie o 🌐 preview enquanto estiver de pé."),
        ("resumo", "estado atual em 1 minuto de leitura", "Me dê um resumo executivo do estado ATUAL desta tarefa: o que já foi feito (com os arquivos), o que falta, riscos/decisões em aberto. NÃO execute nada novo."),
        ("segurança", "auditar riscos no diff da branch", "Audite o diff desta branch com olhar de segurança: injeção, authz/escopo de tenant, segredos, dados sensíveis em log. Achados por severidade com arquivo:linha e correção proposta — me apresente via ask_human antes de corrigir."),
    ]

    /// skills filtradas pelo que foi digitado depois da barra ("/de" → design)
    private var skillMatches: [(String, String, String)] {
        guard msg.hasPrefix("/"), !msg.contains(" ") else { return [] }
        let q = msg.dropFirst().folding(options: .diacriticInsensitive, locale: .init(identifier: "pt")).lowercased()
        return Self.skills.filter { q.isEmpty || $0.0.folding(options: .diacriticInsensitive, locale: .init(identifier: "pt")).lowercased().hasPrefix(q) }
    }

    private var inputBar: some View {
        VStack(spacing: 0) {
            if !skillMatches.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(skillMatches, id: \.0) { s in
                        Button {
                            msg = ""
                            Task { _ = try? await supa.rest("task_messages", method: "POST", json: ["task_id": taskId, "author": supa.session?.userId ?? "", "body": s.2]) }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("/" + s.0).font(.system(.footnote, design: .monospaced).bold()).foregroundStyle(T.accent)
                                Text(s.1).font(.caption2).foregroundStyle(T.dim)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                        }
                        Divider().overlay(T.line)
                    }
                }
                .background(T.panel)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.line))
                .padding(.horizontal, 10).padding(.bottom, 6)
            }
            inputRow
        }
    }

    private var inputRow: some View {
        HStack(spacing: 8) {
            Button {
                msg = msg.hasPrefix("/") ? "" : "/"
            } label: {
                Text("/")
                    .font(.system(.body, design: .monospaced).bold())
                    .frame(width: 36, height: 36)
                    .background(msg.hasPrefix("/") ? T.accent : T.panel)
                    .foregroundStyle(msg.hasPrefix("/") ? .black : T.accent)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.line))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            TextField(question != nil ? "responda a pergunta…" : "fale com o agente… ( / skills )", text: $msg, axis: .vertical)
                .font(.footnote)
                .padding(10)
                .background(T.panel)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.line))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            Button {
                Task { await send() }
            } label: {
                Group {
                    if sending { ProgressView().tint(.black) }
                    else { Image(systemName: "paperplane.fill").font(.body) }
                }
                .frame(width: 40, height: 36)
                .background(msg.trimmingCharacters(in: .whitespaces).isEmpty ? T.panel : T.accent)
                .foregroundStyle(msg.trimmingCharacters(in: .whitespaces).isEmpty ? T.dim : .black)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .disabled(sending || msg.trimmingCharacters(in: .whitespaces).isEmpty || msg.hasPrefix("/"))
        }
        .padding(10)
        .background(T.bg)
    }

    private func tick() async {
        // status + PR
        if let d = try? await supa.rest("tasks?select=status,flag,pr_url,spec&id=eq.\(taskId)"),
           let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]], let t = arr.first {
            await MainActor.run {
                status = t["status"] as? String ?? status
                flag = t["flag"] as? String
                prUrl = t["pr_url"] as? String
                previewUrl = (t["spec"] as? [String: Any])?["previewUrl"] as? String
                if previewUrl != nil { requestingTunnel = false }
            }
        }
        // feed incremental
        if let d = try? await supa.rest("task_feed?select=id,agent,kind,text,at&task_id=eq.\(taskId)&id=gt.\(lastId)&order=id&limit=120"),
           let items = try? JSONDecoder().decode([FeedItem].self, from: d), !items.isEmpty {
            await MainActor.run {
                feed.append(contentsOf: items); if feed.count > 400 { feed.removeFirst(feed.count - 400) }; lastId = items.last!.id
                // agente anunciou preview local no Mac → oferece criar o acesso daqui
                for it in items {
                    if let r = it.text.range(of: #"🌐 preview:\s*(https?://[^\s]+)"#, options: .regularExpression) {
                        localPreview = String(it.text[r]).replacingOccurrences(of: "🌐 preview:", with: "").trimmingCharacters(in: .whitespaces)
                    }
                }
            }
        }
        // pergunta aberta desta tarefa
        if let d = try? await supa.rest("questions?select=id,agent,prompt,options,created_at&task_id=eq.\(taskId)&status=eq.open&order=id.desc&limit=1"),
           let qs = try? JSONDecoder().decode([Question].self, from: d) {
            await MainActor.run { question = qs.first }
        }
        await MainActor.run { if !ticked { withAnimation(.easeOut(duration: 0.25)) { ticked = true } } }
    }

    private func send() async {
        let text = msg.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        do {
            if let q = question {
                await answerQuestion(q, text: text)      // pergunta aberta → responde (turno continua)
            } else {
                _ = try await supa.rest("task_messages", method: "POST", json: ["task_id": taskId, "author": supa.session?.userId ?? "", "body": text])
            }
            await MainActor.run { msg = "" }
        } catch { self.error = error.localizedDescription }
        sending = false
    }

    private func answerQuestion(_ q: Question, text: String) async {
        _ = try? await supa.rest("questions?id=eq.\(q.id)", method: "PATCH", json: [
            "status": "answered", "answer": text,
            "answered_by": supa.session?.userId ?? "",
            "answered_at": ISO8601DateFormatter().string(from: Date()),
        ])
        await MainActor.run { question = nil; msg = "" }
    }
}
