import SwiftUI

@main
struct ConstellationApp: App {
    @UIApplicationDelegateAdaptor(PushManager.self) var push
    @StateObject private var supa = Supa()
    @StateObject private var router = PushRouter.shared
    @Environment(\.scenePhase) private var phase

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
            .preferredColorScheme(.dark)
            .background(T.bg)
            .onChange(of: phase) { _, p in
                if p == .background { PushManager.scheduleRefresh() }
            }
            .task {
                // sessão restaurada: confere a assinatura em segundo plano (sem travar)
                if supa.session != nil { await supa.checkBilling() }
            }
        }
    }
}
