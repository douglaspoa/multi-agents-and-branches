import SwiftUI

struct RootView: View {
    @EnvironmentObject var supa: Supa
    @State private var openCount = 0

    var body: some View {
        TabView {
            NavigationStack {
                QuestionsView()
                    .navigationTitle("Precisa de você")
                    .toolbarBackground(T.bg, for: .navigationBar)
            }
            .tabItem { Label("Perguntas", systemImage: "bubble.left.and.exclamationmark.bubble.right") }
            .badge(openCount)

            NavigationStack {
                TasksView()
                    .navigationTitle("Time")
                    .toolbarBackground(T.bg, for: .navigationBar)
            }
            .tabItem { Label("Time", systemImage: "person.3") }

            NavigationStack {
                SettingsView()
                    .navigationTitle("Conta")
                    .toolbarBackground(T.bg, for: .navigationBar)
            }
            .tabItem { Label("Conta", systemImage: "gearshape") }
        }
        .tint(T.accent)
        .task {
            while !Task.isCancelled {
                if let d = try? await supa.rest("questions?select=id&status=eq.open&limit=50"),
                   let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] {
                    await MainActor.run { openCount = arr.count }
                }
                try? await Task.sleep(for: .seconds(7))
            }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var supa: Supa

    var body: some View {
        List {
            Section {
                HStack {
                    Circle().fill(T.accent).frame(width: 34, height: 34)
                        .overlay(Text(String((supa.session?.email ?? "?").prefix(2)).uppercased())
                            .font(.system(.caption, design: .monospaced).bold()).foregroundStyle(.black))
                    VStack(alignment: .leading) {
                        Text(supa.session?.email ?? "").font(.subheadline).foregroundStyle(T.text)
                        Text("mesma conta do Mac — tudo sincronizado").font(.caption2).foregroundStyle(T.dim)
                    }
                }
                .listRowBackground(T.panel)
            }
            Section {
                Button("Sair da conta", role: .destructive) { supa.signOut() }
                    .listRowBackground(T.panel)
            }
            Section {
                Text("Constellation Mobile 0.1 — companion do orquestrador de agentes. As perguntas dos agentes chegam aqui; as respostas voltam pro Mac em segundos.")
                    .font(.caption2).foregroundStyle(T.dim)
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(T.bg)
    }
}
