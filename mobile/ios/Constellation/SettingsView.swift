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
        ZStack(alignment: .top) {
            T.bg.ignoresSafeArea()
            Starfield(seed: 21).frame(height: 360).frame(maxHeight: .infinity, alignment: .top)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    PageHeader(kicker: "Companion", title: "Conta", sub: "mesma conta do Mac — tudo sincronizado")
                    // identidade
                    HStack(spacing: 12) {
                        ZStack {
                            Circle().stroke(T.pink.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [3, 3])).frame(width: 48, height: 48)
                            Av(name: supa.session?.email ?? "?", size: 38)
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            Text(supa.session?.email ?? "").font(.system(size: 14.5, weight: .semibold)).foregroundStyle(T.text).lineLimit(1).minimumScaleFactor(0.8)
                            Text([teamLine, planLabel, "sincronizado com o Mac"].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.system(size: 11.5)).foregroundStyle(T.dim).lineLimit(2)
                        }
                    }.card()

                    // pushes
                    VStack(alignment: .leading, spacing: 10) {
                        kicker("quais pushes chegam", T.dim)
                        VStack(spacing: 0) {
                            if notifDenied {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("⚠ notificações desligadas nos Ajustes do iPhone").font(.system(size: 13, weight: .semibold)).foregroundStyle(T.warn)
                                    Text("sem isso nenhum push chega — nem a pergunta do agente").font(.system(size: 11.5)).foregroundStyle(T.dim)
                                    Button("abrir Ajustes e ligar") {
                                        if let u = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(u) }
                                    }.font(.system(size: 12.5, weight: .semibold)).foregroundStyle(T.accent)
                                }
                                .padding(14).frame(maxWidth: .infinity, alignment: .leading).background(T.warn.opacity(0.08))
                                Rectangle().fill(T.line).frame(height: 1)
                            }
                            toggleRow("agente precisa de você", "pergunta do agente e teto de custo", $pushQuestions)
                            Rectangle().fill(T.line).frame(height: 1)
                            toggleRow("entrega pronta pra revisar", "o agente terminou · PR aberto", $pushReady)
                            Rectangle().fill(T.line).frame(height: 1)
                            toggleRow("agente travou", "erro, conflito ou o Mac não conseguiu executar", $pushErrors)
                            Rectangle().fill(T.line).frame(height: 1)
                            toggleRow("PR integrado", "merge feito", $pushPr)
                        }
                        .background(T.panel).overlay(RoundedRectangle(cornerRadius: 16).stroke(T.line)).clipShape(RoundedRectangle(cornerRadius: 16))
                    }

                    // IA padrão (mesma escolha do Mac: Configurações → IA padrão)
                    VStack(alignment: .leading, spacing: 10) {
                        kicker("IA padrão das novas demandas", T.dim)
                        VStack(alignment: .leading, spacing: 10) {
                            Text(defaultModel.isEmpty ? "Usando o padrão da assinatura. Escolha um modelo pra ele já vir marcado ao criar demandas." : "Novas demandas nascem com \(AIModel.named(defaultModel)).")
                                .font(.system(size: 12.5)).foregroundStyle(T.dim).fixedSize(horizontal: false, vertical: true)
                            FlowChips(items: [("", "padrão")] + AIModel.all.map { ($0.id, $0.name) }, selected: $defaultModel)
                        }.card()
                    }

                    // sincronia — o estado REAL (antes: "conectado à nuvem" fixo)
                    VStack(alignment: .leading, spacing: 10) {
                        kicker("conexão com o Mac", T.dim)
                        ConnBanner()
                        VStack(alignment: .leading, spacing: 8) {
                            diag("ao vivo", { switch hub.rt { case .live: "conectado (websocket)"; case .connecting: "conectando…"; case .retrying(let n, _): "reconectando · tentativa \(n + 1)"; case .unavailable: "indisponível — atualizando a cada 5s"; case .idle: "pausado" } }())
                            diag("Mac", { switch hub.macStatus { case .online(let n, let p, let r): "\(n) online" + (p.map { " · \($0) aberto" } ?? "") + (r > 0 ? " · \(r) rodando" : ""); case .offline(let d): "offline" + (d.map { " · visto \(agoPtDate($0))" } ?? ""); case .unknown: "sem notícia ainda" } }())
                            diag("presença", hub.presenceFromTable ? "batimento do app (a cada 45s)" : "último acesso do perfil (migration 0030 pendente)")
                            diag("última leitura", hub.lastOk.map { agoPtDate($0) } ?? "—")
                            Text("Nada aqui depende de ação manual: este app escreve intenções, o Mac executa e publica sozinho. Sem rede, tudo fica na fila e segue quando voltar.")
                                .font(.system(size: 12)).foregroundStyle(T.dim).fixedSize(horizontal: false, vertical: true)
                        }.card()
                    }

                    // senha
                    VStack(alignment: .leading, spacing: 10) {
                        kicker("segurança", T.dim)
                        VStack(alignment: .leading, spacing: 10) {
                            Button { withAnimation { showPass.toggle() } } label: {
                                HStack {
                                    Text("Trocar senha").font(.system(size: 14, weight: .semibold)).foregroundStyle(T.text)
                                    Spacer()
                                    Image(systemName: showPass ? "chevron.up" : "chevron.right").font(.system(size: 11, weight: .bold)).foregroundStyle(T.dim2)
                                }
                            }.buttonStyle(.plain)
                            if showPass {
                                Field(label: "Nova senha", placeholder: "mínimo 8 caracteres", text: $newPass, secure: true, content: .newPassword)
                                Field(label: "Repita", placeholder: "de novo", text: $newPass2, secure: true, content: .newPassword)
                                if !passMsg.isEmpty { Text(passMsg).font(.system(size: 12.5)).foregroundStyle(passMsg.hasPrefix("✓") ? T.accent : T.warn) }
                                Button {
                                    Task {
                                        busy = true; passMsg = ""
                                        do { try await supa.updatePassword(newPass); passMsg = "✓ senha trocada"; newPass = ""; newPass2 = "" }
                                        catch { passMsg = error.localizedDescription }
                                        busy = false
                                    }
                                } label: {
                                    Text(busy ? "salvando…" : "Salvar nova senha").font(.system(size: 14, weight: .semibold))
                                        .frame(maxWidth: .infinity).frame(height: 44)
                                        .background(newPass.count >= 8 && newPass == newPass2 ? T.accent : T.panel2)
                                        .foregroundStyle(newPass.count >= 8 && newPass == newPass2 ? T.onAccent : T.dim2)
                                        .clipShape(RoundedRectangle(cornerRadius: 11))
                                }.buttonStyle(.plain).disabled(busy || newPass.count < 8 || newPass != newPass2)
                            }
                        }.card()
                    }

                    OutlineButton(label: "Sair da conta", height: 48, full: true, color: T.bad, stroke: T.bad.opacity(0.4), fill: T.bad.opacity(0.08)) { supa.signOut() }
                    Text("Starfork Mobile \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") — companion do orquestrador de agentes")
                        .font(.system(size: 11.5)).foregroundStyle(T.dim2)
                }
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 40)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
        }
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

    private func diag(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top) {
            Text(k).font(.mono(11)).foregroundStyle(T.dim).frame(width: 96, alignment: .leading)
            Text(v).font(.system(size: 12.5)).foregroundStyle(T.text2).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    private func toggleRow(_ t: String, _ s: String, _ on: Binding<Bool>) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(t).font(.system(size: 14.5, weight: .medium)).foregroundStyle(T.text)
                Text(s).font(.system(size: 11.5)).foregroundStyle(T.dim)
            }
            Spacer()
            Toggle("", isOn: on).labelsHidden().tint(T.accent)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
    }
}

/// chips que quebram linha (modelos de IA)
struct FlowChips: View {
    let items: [(String, String)]
    @Binding var selected: String
    var body: some View {
        let rows = stride(from: 0, to: items.count, by: 3).map { Array(items[$0..<min($0 + 3, items.count)]) }
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 8) {
                    ForEach(row, id: \.0) { it in
                        Button { selected = it.0 } label: { Chip(label: it.1, on: selected == it.0) }.buttonStyle(.plain)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }
}
