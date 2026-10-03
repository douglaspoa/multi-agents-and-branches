import SwiftUI
import UserNotifications

/// Abas: Central · Minhas · Time · Conta — TabView nativo (badge de perguntas abertas na Central).
struct RootView: View {
    @EnvironmentObject var supa: Supa
    @EnvironmentObject var router: PushRouter
    @EnvironmentObject var hub: SyncHub
    /// perguntas abertas de demandas MINHAS (antes contava as do time inteiro)
    private var openCount: Int { hub.myQuestions.count }
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
        // barra de abas NATIVA (antes: barra própria num .safeAreaInset do TabView inteiro — ela subia com o
        // teclado e cobria o compositor do chat em toda tela empilhada). O detalhe esconde a barra.
        TabView(selection: $tab) {
            NavigationStack { CentralView() }
                .tabItem { Label("Central", systemImage: "square.grid.2x2.fill") }
                .badge(openCount)
                .tag(0)
            NavigationStack { TasksView(mine: true) }
                .tabItem { Label("Minhas", systemImage: "person.crop.circle") }
                .tag(1)
            NavigationStack { TeamView() }
                .tabItem { Label("Time", systemImage: "person.2.fill") }
                .tag(2)
            NavigationStack { SettingsView() }
                .tabItem { Label("Conta", systemImage: "gearshape.fill") }
                .tag(3)
        }
        .tint(T.accent)
        .onChange(of: tab) { _, _ in Haptic.select() }
        .onChange(of: router.goToQuestions) { _, go in
            if go { tab = 0; router.goToQuestions = false }   // pergunta mora na Central
        }
        .onChange(of: router.openTaskId) { _, id in
            if id != nil { tab = 0 } // Central abre o detalhe
        }
        .toastHost()
        .onAppear { PushManager.requestAuthorization() }   // já logado: a permissão vem com contexto
        .onChange(of: openCount) { _, n in UNUserNotificationCenter.current().setBadgeCount(n) }
    }
}
