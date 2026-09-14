import SwiftUI
import UIKit
import UserNotifications

/// Conta — identidade, pushes, IA padrão, sincronia, senha e sair.
struct SettingsView: View {
    @EnvironmentObject var supa: Supa
    @AppStorage("push.questions") private var pushQuestions = true
    @AppStorage("push.ready") private var pushReady = true
    @AppStorage("push.pr") private var pushPr = true
    @AppStorage("defaultModel") private var defaultModel = ""
    @State private var lastSync: String? = nil
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
                            toggleRow("agente precisa de você", "aprovação bloqueando a execução", $pushQuestions)
                            Rectangle().fill(T.line).frame(height: 1)
                            toggleRow("entrega pronta pra revisar", "todos os requisitos provados", $pushReady)
                            Rectangle().fill(T.line).frame(height: 1)
                            toggleRow("comentário novo no PR", "alguém respondeu no GitHub", $pushPr)
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

                    // sincronia
                    VStack(alignment: .leading, spacing: 10) {
                        kicker("sincronia", T.dim)
                        VStack(alignment: .leading, spacing: 7) {
                            HStack(spacing: 7) {
                                BlinkDot()
                                Text(lastSync.map { "última tarefa atualizada \($0)" } ?? "conectado à nuvem").font(.system(size: 14, weight: .semibold)).foregroundStyle(T.text)
                            }
                            Text("Nada aqui depende de ação manual: este app escreve intenções, o Mac executa e publica sozinho.")
                                .font(.system(size: 12.5)).foregroundStyle(T.dim).fixedSize(horizontal: false, vertical: true)
                        }.card(stroke: T.accent.opacity(0.25), fill: T.accent.opacity(0.05))
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
                    Text("Constellation Mobile 0.3 — companion do orquestrador de agentes")
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
            if let d = try? await supa.rest("tasks?select=updated_at&order=updated_at.desc&limit=1"),
               let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]],
               let at = arr.first?["updated_at"] as? String {
                await MainActor.run { lastSync = agoPt(at) }
            }
            if let td = try? await supa.rest("teams?select=name&order=name&limit=1"),
               let arr = try? JSONSerialization.jsonObject(with: td) as? [[String: Any]], let n = arr.first?["name"] as? String {
                await MainActor.run { teamLine = n }
            }
            if supa.billing == nil { await supa.checkBilling() }
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
