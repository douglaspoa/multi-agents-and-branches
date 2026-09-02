import SwiftUI

@main
struct ConstellationApp: App {
    @UIApplicationDelegateAdaptor(PushManager.self) var push
    @StateObject private var supa = Supa()
    @StateObject private var router = PushRouter.shared
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            Group {
                if supa.session == nil {
                    LoginView()
                } else {
                    RootView()
                }
            }
            .environmentObject(supa)
            .environmentObject(router)
            .preferredColorScheme(.dark)
            .background(T.bg)
            .onChange(of: phase) { _, p in
                if p == .background { PushManager.scheduleRefresh() }
            }
        }
    }
}
