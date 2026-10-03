import SwiftUI

@main
struct ConstellationApp: App {
    @UIApplicationDelegateAdaptor(PushManager.self) var push
    @StateObject private var supa = Supa.shared
    @StateObject private var hub = SyncHub.shared
    @StateObject private var router = PushRouter.shared
    @Environment(\.scenePhase) private var phase

    init() {
        #if DEBUG
        // harness (UI tests / prints): começa do zero — sem sessão, retrato de avisos ou filtro de outra rodada
        if ProcessInfo.processInfo.environment["DEMO_RESET"] == "1", let id = Bundle.main.bundleIdentifier {
            UserDefaults.standard.removePersistentDomain(forName: id)
        }
        #endif
    }

    /// DEBUG: DEMO_ONBOARD=welcome|signup|login|confirm|plans|pay|ready abre o onboarding
    private var demoOnboard: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.environment["DEMO_ONBOARD"] != nil
        #else
        return false
        #endif
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if demoOnboard {
                    OnboardingView()
                } else if supa.session != nil && supa.gate == .open {
                    RootView()
                } else {
                    OnboardingView()
                }
            }
            .environmentObject(supa)
            .environmentObject(router)
            .environmentObject(hub)
            .preferredColorScheme(.dark)
            .background(T.bg)
            .onChange(of: phase) { _, p in
                if p == .background { PushManager.scheduleRefresh() }
                // fundo: fecha o ao vivo e para o polling · frente: reconecta e relê NA HORA
                // (.inactive — central de controle, troca de app — não derruba nada)
                if p == .active { hub.setActive(supa.session != nil) } else if p == .background { hub.setActive(false) }
            }
            .onChange(of: supa.session?.userId) { _, uid in
                if uid == nil { hub.stopAll() } else { hub.setActive(phase == .active) }
            }
            .task {
                // sessão restaurada: confere a assinatura em segundo plano (sem travar)
                if supa.session != nil {
                    hub.setActive(true)
                    await supa.checkBilling()
                }
            }
        }
    }
}
