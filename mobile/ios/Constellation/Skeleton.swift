import SwiftUI

/// Shimmer estilo Facebook: gradiente claro varrendo os placeholders.
struct Shimmer: ViewModifier {
    @State private var phase: CGFloat = -1.5

    func body(content: Content) -> some View {
        content
            .overlay(
                GeometryReader { geo in
                    LinearGradient(
                        colors: [.clear, Color.white.opacity(0.09), .clear],
                        startPoint: .leading, endPoint: .trailing
                    )
                    .frame(width: geo.size.width * 1.6)
                    .offset(x: geo.size.width * phase)
                }
                .allowsHitTesting(false)
            )
            .clipped()
            .onAppear {
                withAnimation(.linear(duration: 1.15).repeatForever(autoreverses: false)) {
                    phase = 1.5
                }
            }
    }
}

extension View {
    func shimmer() -> some View { modifier(Shimmer()) }
}

/// Bloco cinza de placeholder (linha de texto falsa).
struct Bone: View {
    var w: CGFloat? = nil
    var h: CGFloat = 12
    var body: some View {
        RoundedRectangle(cornerRadius: h / 2.5)
            .fill(Color.white.opacity(0.07))
            .frame(width: w, height: h)
    }
}

/// Cartão-esqueleto de tarefa (mesma silhueta do card real).
struct TaskCardSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Bone(w: 260, h: 14)
            Bone(w: 170, h: 14)
            HStack(spacing: 8) {
                Circle().fill(Color.white.opacity(0.07)).frame(width: 7, height: 7)
                Bone(w: 70, h: 9)
                Spacer()
                Bone(w: 34, h: 9)
                Bone(w: 24, h: 9)
            }
        }
        .card()
        .shimmer()
    }
}

/// Cartão-esqueleto de pergunta.
struct QuestionCardSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Bone(w: 60, h: 10); Spacer(); Bone(w: 28, h: 9) }
            Bone(h: 12)
            Bone(w: 240, h: 12)
            Bone(w: 190, h: 30)
            Bone(w: 150, h: 30)
        }
        .card()
        .shimmer()
    }
}

/// Linhas-esqueleto do feed ao vivo.
struct FeedSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(0..<7, id: \.self) { i in
                HStack(spacing: 8) {
                    Bone(w: 10, h: 10)
                    Bone(w: [230, 180, 260, 150, 210, 240, 170][i], h: 11)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(4)
        .shimmer()
    }
}

/// Lista de esqueletos com os títulos de seção (aba Minhas/Time carregando).
struct BoardSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Bone(w: 130, h: 10)
            TaskCardSkeleton()
            Bone(w: 170, h: 10).padding(.top, 6)
            TaskCardSkeleton()
            TaskCardSkeleton()
            TaskCardSkeleton()
        }
    }
}
