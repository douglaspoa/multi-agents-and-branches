import SwiftUI

/// Abas do escopo: ◉ Central · ▤ Minhas · ⚉ Time · ◍ Conta.
/// A antiga aba Perguntas virou a 1ª seção da Central — urgência manda.
struct RootView: View {
    @EnvironmentObject var supa: Supa
    @EnvironmentObject var router: PushRouter
    @State private var openCount = 0
    @State private var tab: Int = {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["DEMO_TAB"] {
        case "minhas": return 1
        case "conta": return 3
        case "time": return 2
        default: return 0
        }
        #else
        return 0
        #endif
    }()

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack {
                CentralView()
                    .navigationTitle("Central")
                    .toolbarBackground(T.bg, for: .navigationBar)
            }
            .tabItem { Label("Central", systemImage: "circle.grid.2x2.fill") }.tag(0)
            .badge(openCount)

            NavigationStack {
                TasksView(mine: true)
                    .navigationTitle("Minhas")
                    .toolbarBackground(T.bg, for: .navigationBar)
            }
            .tabItem { Label("Minhas", systemImage: "person.crop.rectangle.stack") }.tag(1)

            NavigationStack {
                TeamView()
                    .navigationTitle("Time")
                    .toolbarBackground(T.bg, for: .navigationBar)
            }
            .tabItem { Label("Time", systemImage: "person.3") }.tag(2)

            NavigationStack {
                SettingsView()
                    .navigationTitle("Conta")
                    .toolbarBackground(T.bg, for: .navigationBar)
            }
            .tabItem { Label("Conta", systemImage: "gearshape") }.tag(3)
        }
        .tint(T.accent)
        .onChange(of: router.goToQuestions) { _, go in
            if go { tab = 0; router.goToQuestions = false }   // pergunta mora na Central
        }
        .onChange(of: router.openTaskId) { _, id in
            if id != nil { tab = 0 } // Central abre o detalhe
        }
        .task {
            while !Task.isCancelled {
                if let d = try? await supa.rest("questions?select=id&status=eq.open&limit=50"),
                   let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] {
                    await MainActor.run { openCount = arr.count }
                }
                // pergunta nova → banner local na hora, mesmo com o app aberto
                await PushManager.checkQuestionsAndNotify()
                try? await Task.sleep(for: .seconds(7))
            }
        }
    }
}
