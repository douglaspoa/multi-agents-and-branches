import SwiftUI

@main
struct ConstellationApp: App {
    @StateObject private var supa = Supa()

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
            .preferredColorScheme(.dark)
            .background(T.bg)
        }
    }
}
