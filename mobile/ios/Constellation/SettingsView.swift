import SwiftUI
import UIKit
import UserNotifications

/// Conta — identidade, pushes, IA padrão, sincronia, senha e sair.
struct SettingsView: View {
    @EnvironmentObject var supa: Supa
    @AppStorage("push.questions") private var pushQuestions = true
    @AppStorage("push.ready") private var pushReady = true
    @AppStorage("push.pr") private var pushPr = true
    @AppStorage("push.errors") private var pushErrors = true
    @EnvironmentObject var hub: SyncHub
    @AppStorage("defaultModel") private var defaultModel = ""
    @State private var notifDenied = false
    @State private var teamLine = ""
    @State private var showPass = false
    @State private var newPass = ""
    @State private var newPass2 = ""
    @State private var passMsg = ""
    @State private var busy = false

    private var planLabel: String {
        guard let b = supa.billing else { return "" }
        if b.org { return "Organização" }
        switch b.plan { case "team": return "Time"; case "individual": return "Solo"; default: return b.plan ?? "" }
    }

    var body: some View {
        Form {
            // identidade
            Section {
                HStack(spacing: 12) {
                    Av(name: supa.session?.email ?? "?", size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(supa.session?.email ?? "").font(.ui(16, .semibold)).foregroundStyle(T.text).lineLimit(1).truncationMode(.middle)
                        Text([teamLine, planLabel].filter { !$0.isEmpty }.joined(separator: " · ").ifEmpty("mesma conta do Mac"))
                            .font(.ui(13)).foregroundStyle(T.dim).lineLimit(2)
                    }
                }
                .padding(.vertical, 4)
                .rowStyle()
            }

            // conexão — o estado REAL (antes: "conectado à nuvem" fixo)
            Section {
                ConnStatusRow().rowStyle()
                LabeledContent("Ao vivo", value: { switch hub.rt { case .live: "conectado"; case .connecting: "conectando…"; case .retrying(let n, _): "reconectando · tentativa \(n + 1)"; case .unavailable: "a cada 5s"; case .idle: "pausado" } }()).rowStyle()
                LabeledContent("Mac", value: { switch hub.macStatus { case .online(let n, let p, let r): "\(n) online" + (p.map { " · \($0)" } ?? "") + (r > 0 ? " · \(r) rodando" : ""); case .offline(let d): "offline" + (d.map { " · visto \(agoPtDate($0))" } ?? ""); case .unknown: "sem notícia ainda" } }()).rowStyle()
                LabeledContent("Presença", value: hub.presenceFromTable ? "batimento a cada 45s" : "último acesso do perfil").rowStyle()
                LabeledContent("Última leitura", value: hub.lastOk.map { agoPtDate($0) } ?? "—").rowStyle()
            } header: { SectionHead(title: "Conexão com o Mac", symbol: "desktopcomputer") } footer: {
                Text("Nada aqui depende de ação manual: este app escreve intenções, o Mac executa e publica sozinho. Sem rede, tudo fica na fila e segue quando voltar.")
            }

            // pushes
            Section {
                if notifDenied {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Notificações desligadas nos Ajustes", systemImage: "bell.slash.fill").font(.ui(14, .semibold)).foregroundStyle(T.warn)
                        Text("Sem isso nenhum push chega — nem a pergunta do agente.").font(.ui(13)).foregroundStyle(T.dim)
                        Button("Abrir Ajustes") {
                            if let u = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(u) }
                        }.font(.ui(14, .semibold)).tint(T.accent)
                    }.rowStyle()
                }
                toggleRow("Agente precisa de você", "pergunta do agente e teto de custo", $pushQuestions)
                toggleRow("Entrega pronta pra revisar", "o agente terminou · PR aberto", $pushReady)
                toggleRow("Agente travou", "erro, conflito ou o Mac não conseguiu executar", $pushErrors)
                toggleRow("PR integrado", "merge feito", $pushPr)
            } header: { SectionHead(title: "Notificações", symbol: "bell.badge") }

            // IA padrão (mesma escolha do Mac: Configurações → IA padrão)
            Section {
                Picker("IA padrão", selection: $defaultModel) {
                    Text("Padrão da assinatura").tag("")
                    ForEach(AIModel.all) { m in Text(m.name).tag(m.id) }
                }
                .pickerStyle(.navigationLink)
                .rowStyle()
            } header: { SectionHead(title: "Novas demandas", symbol: "cpu") } footer: {
                Text(defaultModel.isEmpty ? "Usando o padrão da assinatura. Escolha um modelo pra ele já vir marcado ao criar demandas." : "Novas demandas nascem com \(AIModel.named(defaultModel)).")
            }

            // senha
            Section {
                DisclosureGroup(isExpanded: $showPass) {
                    SecureField("Nova senha (mínimo 8)", text: $newPass).textContentType(.newPassword)
                    SecureField("Repita a nova senha", text: $newPass2).textContentType(.newPassword)
                    if !passMsg.isEmpty { Text(passMsg).font(.ui(13)).foregroundStyle(passMsg.hasPrefix("✓") ? T.accent : T.warn) }
                    Button(busy ? "Salvando…" : "Salvar nova senha") {
                        Task {
                            busy = true; passMsg = ""
                            do { try await supa.updatePassword(newPass); passMsg = "✓ senha trocada"; newPass = ""; newPass2 = ""; Haptic.success() }
                            catch { passMsg = error.localizedDescription; Haptic.error() }
                            busy = false
                        }
                    }
                    .disabled(busy || newPass.count < 8 || newPass != newPass2)
                    .tint(T.accent)
                } label: { Label("Trocar senha", systemImage: "key.fill").foregroundStyle(T.text) }
                .tint(T.dim)
                .rowStyle()
            } header: { SectionHead(title: "Segurança", symbol: "lock") }

            Section {
                Button(role: .destructive) { Haptic.warning(); supa.signOut() } label: {
                    Label("Sair da conta", systemImage: "rectangle.portrait.and.arrow.right").frame(maxWidth: .infinity, alignment: .leading)
                }
                .tint(T.bad)
                .rowStyle()
            } footer: {
                Text("Starfork Mobile \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") — companion do orquestrador de agentes")
            }
        }
        .scrollContentBackground(.hidden)
        .background(T.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Conta")
        .navigationBarTitleDisplayMode(.large)
        .task {
            let st = await UNUserNotificationCenter.current().notificationSettings()
            await MainActor.run { notifDenied = st.authorizationStatus == .denied }
            if let td = try? await supa.rest("teams?select=name&order=name&limit=1"),
               let arr = try? JSONSerialization.jsonObject(with: td) as? [[String: Any]], let n = arr.first?["name"] as? String {
                await MainActor.run { teamLine = n }
            }
            if supa.billing == nil { await supa.checkBilling() }
        }
    }

    private func toggleRow(_ t: String, _ sub: String, _ on: Binding<Bool>) -> some View {
        Toggle(isOn: on) {
            VStack(alignment: .leading, spacing: 2) {
                Text(t).font(.ui(16)).foregroundStyle(T.text)
                Text(sub).font(.ui(12)).foregroundStyle(T.dim)
            }
        }
        .tint(T.accent)
        .onChange(of: on.wrappedValue) { _, _ in Haptic.select() }
        .rowStyle()
    }
}

extension String { func ifEmpty(_ s: String) -> String { isEmpty ? s : self } }
