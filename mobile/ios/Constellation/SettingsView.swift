import SwiftUI
import UIKit
import UserNotifications

/// Tela 10 — Conta: identidade, pushes, device e a regra de ouro da sincronia.
struct SettingsView: View {
    @EnvironmentObject var supa: Supa
    @AppStorage("push.questions") private var pushQuestions = true
    @AppStorage("push.ready") private var pushReady = true
    @AppStorage("push.pr") private var pushPr = true
    @State private var lastSync: String? = nil
    @State private var notifDenied = false

    var body: some View {
        List {
            Section {
                HStack(spacing: 10) {
                    Av(name: supa.session?.email ?? "?", size: 36)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(supa.session?.email ?? "").font(.subheadline).foregroundStyle(T.text)
                        Text("mesma conta do Mac — tudo sincronizado").font(.caption2).foregroundStyle(T.dim)
                    }
                }
                .listRowBackground(T.panel)
            }
            Section("Quais pushes chegam") {
                if notifDenied {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("⚠ notificações DESLIGADAS nos Ajustes do iPhone")
                            .font(.caption.bold()).foregroundStyle(T.warn)
                        Text("sem isso nenhum push chega — nem a pergunta do agente")
                            .font(.caption2).foregroundStyle(T.dim)
                        Button("abrir Ajustes e ligar") {
                            if let u = URL(string: UIApplication.openNotificationSettingsURLString) {
                                UIApplication.shared.open(u)
                            }
                        }
                        .font(.caption.bold()).foregroundStyle(T.accent)
                    }
                    .listRowBackground(T.warn.opacity(0.08))
                }
                Toggle("agente precisa de você", isOn: $pushQuestions)
                Toggle("entrega pronta pra revisar", isOn: $pushReady)
                Toggle("comentário novo no PR", isOn: $pushPr)
            }
            .listRowBackground(T.panel)
            .tint(T.accent)
            Section("Sincronia") {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        BlinkDot()
                        Text(lastSync.map { "última tarefa atualizada \($0)" } ?? "conectado à nuvem")
                            .font(.caption).foregroundStyle(T.text2)
                    }
                    Text("nada aqui depende de ação manual: o Mac publica sozinho e este app só escreve intenções — o Mac executa.")
                        .font(.caption2).foregroundStyle(T.dim)
                }
                .listRowBackground(T.panel)
            }
            Section {
                Button("Sair da conta", role: .destructive) { supa.signOut() }
                    .listRowBackground(T.panel)
            }
            Section {
                Text("Constellation Mobile 0.2 — companion do orquestrador de agentes.")
                    .font(.caption2).foregroundStyle(T.dim)
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(T.bg)
        .task {
            let st = await UNUserNotificationCenter.current().notificationSettings()
            await MainActor.run { notifDenied = st.authorizationStatus == .denied }
            if let d = try? await supa.rest("tasks?select=updated_at&order=updated_at.desc&limit=1"),
               let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]],
               let at = arr.first?["updated_at"] as? String {
                await MainActor.run { lastSync = agoPt(at) }
            }
        }
    }
}
