import SwiftUI

struct LoginView: View {
    @EnvironmentObject var supa: Supa
    @State private var email = ""
    @State private var pass = ""
    @State private var code = ""
    @State private var useCode = true // padrão: pareamento pelo Mac (sem senha no celular)
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 10) {
                    Image(systemName: "sparkles")
                        .foregroundStyle(T.accent)
                    Text("Constellation")
                        .font(.system(.title2, design: .monospaced).bold())
                        .foregroundStyle(T.text)
                }
                Text("Acompanhe seus agentes e responda do celular.")
                    .font(.footnote)
                    .foregroundStyle(T.dim)

                if !error.isEmpty {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(T.warn)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(T.warn.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("E-MAIL").font(.caption2).foregroundStyle(T.dim).kerning(1)
                    TextField("voce@empresa.com", text: $email)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                        .autocorrectionDisabled()
                        .padding(12).background(T.panel)
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(T.line))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                Picker("", selection: $useCode) {
                    Text("código do Mac").tag(true)
                    Text("senha").tag(false)
                }
                .pickerStyle(.segmented)

                if useCode {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("CÓDIGO DE 6 DÍGITOS").font(.caption2).foregroundStyle(T.dim).kerning(1)
                        TextField("000000", text: $code)
                            .keyboardType(.numberPad)
                            .font(.system(.title2, design: .monospaced).bold())
                            .padding(12).background(T.panel)
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(T.line))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        Text("No Mac: botão da nuvem → Conta → Celular → 📱 gerar código (vale ~5 min).")
                            .font(.caption2).foregroundStyle(T.dim)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("SENHA").font(.caption2).foregroundStyle(T.dim).kerning(1)
                        SecureField("••••••••", text: $pass)
                            .padding(12).background(T.panel)
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(T.line))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }

                Button {
                    Task { await doLogin() }
                } label: {
                    HStack {
                        if busy { ProgressView().tint(.black) }
                        Text(busy ? "entrando…" : "entrar")
                            .font(.system(.body, design: .monospaced).bold())
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .background(T.accent)
                    .foregroundStyle(.black)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .disabled(busy || email.isEmpty || (useCode ? code.count != 6 : pass.count < 6))
                .opacity(busy || email.isEmpty || (useCode ? code.count != 6 : pass.count < 6) ? 0.5 : 1)

                Text("Use a MESMA conta do Constellation no Mac. Criar conta e entrar no time é feito por lá.")
                    .font(.caption2)
                    .foregroundStyle(T.dim)
            }
            .padding(22)
            .card()
            .padding(20)
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T.bg)
        .task {
            #if DEBUG
            // conveniência de dev: login automático via env do simulador
            let env = ProcessInfo.processInfo.environment
            if let e = env["DEMO_EMAIL"], let p = env["DEMO_PASS"], !busy {
                email = e; pass = p; useCode = false
                await doLogin()
            }
            #endif
        }
    }

    private func doLogin() async {
        busy = true; error = ""
        do {
            let mail = email.trimmingCharacters(in: .whitespaces)
            if useCode {
                try await supa.signIn(email: mail, code: code.trimmingCharacters(in: .whitespaces))
            } else {
                try await supa.signIn(email: mail, password: pass)
            }
        }
        catch { self.error = error.localizedDescription }
        busy = false
    }
}
