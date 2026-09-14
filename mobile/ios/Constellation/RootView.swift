import SwiftUI

/// Abas do redesign: Central · Minhas · Time · Conta — barra própria (pílula
/// verde na aba ativa, badge de perguntas abertas na Central).
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

    private let tabs: [(String, String, String)] = [
        ("Central", "circle.grid.2x2.fill", "circle.grid.2x2"),
        ("Minhas", "person.fill", "person"),
        ("Time", "person.2.fill", "person.2"),
        ("Conta", "gearshape.fill", "gearshape"),
    ]

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { CentralView().toolbar(.hidden, for: .navigationBar) }.tag(0)
            NavigationStack { TasksView(mine: true).toolbar(.hidden, for: .navigationBar) }.tag(1)
            NavigationStack { TeamView().toolbar(.hidden, for: .navigationBar) }.tag(2)
            NavigationStack { SettingsView().toolbar(.hidden, for: .navigationBar) }.tag(3)
        }
        .toolbar(.hidden, for: .tabBar)
        .tint(T.accent)
        .safeAreaInset(edge: .bottom, spacing: 0) { tabBar }
        .background(T.bg)
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
                await PushManager.checkQuestionsAndNotify()
                try? await Task.sleep(for: .seconds(7))
            }
        }
    }

    private var tabBar: some View {
        HStack(spacing: 6) {
            ForEach(Array(tabs.enumerated()), id: \.offset) { i, t in
                let on = tab == i
                Button { withAnimation(.easeOut(duration: 0.18)) { tab = i } } label: {
                    VStack(spacing: 5) {
                        ZStack(alignment: .topTrailing) {
                            Image(systemName: on ? t.1 : t.2)
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(on ? T.accent : T.dim2)
                                .frame(width: 24, height: 22)
                                .shadow(color: on ? T.accent.opacity(0.55) : .clear, radius: 8)
                            if i == 0 && openCount > 0 {
                                Text("\(openCount)").font(.mono(9, .bold)).foregroundStyle(.white)
                                    .padding(.horizontal, 4).frame(height: 15).background(T.bad).clipShape(Capsule())
                                    .offset(x: 9, y: -7)
                            }
                        }
                        Text(t.0).font(.system(size: 11, weight: on ? .semibold : .medium)).foregroundStyle(on ? T.accent : T.dim2)
                    }
                    .frame(maxWidth: .infinity).frame(height: 56)
                    .background(on ? T.accent.opacity(0.11) : .clear)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }.buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12).padding(.top, 9).padding(.bottom, 4)
        .background(Color(hex: 0x080a09).opacity(0.94).ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(T.line).frame(height: 1) }
    }
}
