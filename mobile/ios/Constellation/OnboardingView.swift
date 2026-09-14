import SwiftUI
import UIKit

/// Onboarding do redesign: Boas-vindas → Criar conta / Entrar → Confirmar e-mail
/// (código de 6 dígitos) → Planos → Pagamento (Stripe no Safari) → Pronto.
/// Mesmos endpoints do desktop (app/src/js/44-onboarding.js).
struct OnboardingView: View {
    @EnvironmentObject var supa: Supa
    @Environment(\.scenePhase) private var scene

    enum Step { case welcome, signup, login, confirm, newpass, plans, pay, ready }
    @State private var step: Step = {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["DEMO_ONBOARD"] {
        case "signup": return .signup
        case "login": return .login
        case "confirm": return .confirm
        case "newpass": return .newpass
        case "plans": return .plans
        case "pay": return .pay
        case "ready": return .ready
        default: return .welcome
        }
        #else
        return .welcome
        #endif
    }()
    @State private var name = ""
    @State private var email = UserDefaults.standard.string(forKey: "sb.email") ?? ""
    @State private var pass = ""
    @State private var pass2 = ""
    @State private var code = ""
    @State private var confirmType = "signup"     // signup · magiclink · recovery
    @State private var msg = ""
    @State private var ok = false                  // msg é sucesso (verde)?
    @State private var busy = false
    @State private var resendAt = Date.distantPast
    @State private var planKey = "team"
    @State private var interval = "month"
    @State private var seats = 5
    @State private var waiting = false
    @FocusState private var codeFocus: Bool

    var body: some View {
        ZStack {
            T.bg.ignoresSafeArea()
            Starfield(seed: step == .welcome ? 3 : 11)
            content
                .transition(.opacity)
        }
        .preferredColorScheme(.dark)
        .onAppear { syncWithGate() }
        .onChange(of: supa.gate) { _, _ in syncWithGate() }
        .onChange(of: scene) { _, p in if p == .active, waiting { Task { await recheck(silent: true) } } }
        .task(id: waiting) {
            // depois de abrir a Stripe, o app reconhece a assinatura sozinho
            while waiting && !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await recheck(silent: true)
            }
        }
    }

    private func syncWithGate() {
        #if DEBUG
        if ProcessInfo.processInfo.environment["DEMO_ONBOARD"] != nil { return }
        #endif
        switch supa.gate {
        case .needsPlan: if step != .pay && step != .plans { go(.plans) }
        case .ready: waiting = false; go(.ready)
        default: break
        }
    }
    private func go(_ s: Step) { withAnimation(.easeOut(duration: 0.22)) { step = s; msg = ""; ok = false } }

    @ViewBuilder private var content: some View {
        switch step {
        case .welcome: welcome
        case .signup: signup
        case .login: login
        case .confirm: confirm
        case .newpass: newpass
        case .plans: plans
        case .pay: pay
        case .ready: ready
        }
    }

    // MARK: - moldura comum: topo "← voltar" + rolagem + CTA fixa embaixo

    private func frame<C: View, B: View>(back: Step? = nil, backLabel: String = "voltar", @ViewBuilder _ body: () -> C, @ViewBuilder cta: () -> B) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let back {
                        Button { go(back) } label: {
                            Text("← \(backLabel)").font(.system(size: 14)).foregroundStyle(T.dim)
                        }.buttonStyle(.plain)
                    }
                    body()
                }
                .padding(.horizontal, 22).padding(.top, 14).padding(.bottom, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            VStack(spacing: 10) { cta() }
                .padding(.horizontal, 22).padding(.top, 10).padding(.bottom, 8)
        }
    }

    private func stepKicker(_ n: Int) -> some View {
        Text("PASSO \(n) DE 3").font(.mono(10, .medium)).kerning(1.6).foregroundStyle(T.accent)
    }
    private func h2(_ t: String) -> some View {
        Text(t).font(.system(size: 30, weight: .semibold)).kerning(-0.75).foregroundStyle(T.text)
            .fixedSize(horizontal: false, vertical: true)
    }
    private func p(_ t: String) -> some View {
        Text(t).font(.system(size: 14.5)).foregroundStyle(T.dim).lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
    }
    @ViewBuilder private var msgView: some View {
        if !msg.isEmpty {
            Text(msg).font(.system(size: 13)).foregroundStyle(ok ? T.accent : T.warn)
                .padding(11).frame(maxWidth: .infinity, alignment: .leading)
                .background((ok ? T.accent : T.warn).opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
    private func primary(_ label: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().tint(T.onAccent) }
                Text(busy ? "um instante…" : label).font(.system(size: 15, weight: .semibold))
            }
            .frame(maxWidth: .infinity).frame(height: 50)
            .background(enabled && !busy ? T.accent : T.panel)
            .foregroundStyle(enabled && !busy ? T.onAccent : T.dim2)
            .clipShape(RoundedRectangle(cornerRadius: 13))
            .shadow(color: enabled ? T.accent.opacity(0.28) : .clear, radius: 18, y: 6)
        }
        .buttonStyle(.plain)
        .disabled(!enabled || busy)
    }
    private func link(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(label).font(.system(size: 13)).foregroundStyle(T.accent) }.buttonStyle(.plain)
    }

    // MARK: - Boas-vindas

    private var welcome: some View {
        frame {
            VStack(alignment: .leading, spacing: 16) {
                HStack { Spacer(); OrbitIcon(glyph: "C", size: 58); Spacer() }.padding(.top, 26)
                VStack(spacing: 10) {
                    Text("CONSTELLATION").font(.mono(10, .medium)).kerning(2.2).foregroundStyle(T.accent.opacity(0.8))
                    Text("Sua equipe de agentes,\nno bolso").font(.system(size: 30, weight: .semibold)).kerning(-0.75)
                        .foregroundStyle(T.text).multilineTextAlignment(.center)
                    Text("Você escreve a demanda daqui. O Mac executa, testa e abre o PR sozinho.")
                        .font(.system(size: 14.5)).foregroundStyle(T.dim).multilineTextAlignment(.center).lineSpacing(3)
                }.frame(maxWidth: .infinity)
                VStack(spacing: 8) {
                    feature("Escreva a demanda em 30 segundos, com requisitos claros")
                    feature("Acompanhe cada agente em órbita, com custo em tempo real")
                    feature("Aprove a entrega e o PR abre sozinho")
                }.padding(.top, 8)
            }
        } cta: {
            primary("Criar conta") { go(.signup) }
            OutlineButton(label: "Já tenho conta", height: 48, full: true) { go(.login) }
            Text("Ao continuar você aceita os termos e a privacidade.").font(.system(size: 11)).foregroundStyle(T.dim2)
        }
    }
    private func feature(_ t: String) -> some View {
        HStack(spacing: 12) {
            Text("◆").font(.system(size: 10)).foregroundStyle(T.accent)
            Text(t).font(.system(size: 13.5)).foregroundStyle(T.text2).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }.card(radius: 14, pad: 14)
    }

    // MARK: - Criar conta

    private var strength: Int {
        var s = 0
        if pass.count >= 8 { s += 1 }
        if pass.rangeOfCharacter(from: .decimalDigits) != nil { s += 1 }
        if pass.rangeOfCharacter(from: .uppercaseLetters) != nil { s += 1 }
        if pass.rangeOfCharacter(from: .punctuationCharacters.union(.symbols)) != nil { s += 1 }
        return s
    }
    private var signupOk: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && email.contains("@") && pass.count >= 8 }
    private var signup: some View {
        frame(back: .welcome) {
            stepKicker(1)
            h2("Criar conta")
            p("Use o e-mail do trabalho — é assim que a gente liga você ao time certo.")
            msgView
            Field(label: "Nome", placeholder: "como o time te chama", text: $name, content: .name)
            Field(label: "E-mail de trabalho", placeholder: "voce@empresa.com", text: $email, keyboard: .emailAddress, content: .emailAddress)
            VStack(alignment: .leading, spacing: 8) {
                Field(label: "Senha", placeholder: "mínimo 8 caracteres", text: $pass, secure: true, content: .newPassword)
                HStack(spacing: 4) {
                    ForEach(0..<4, id: \.self) { i in
                        Capsule().fill(i < strength ? T.accent.opacity(0.5 + Double(strength) * 0.12) : Color.white.opacity(0.1)).frame(height: 3)
                    }
                }
                Text(pass.isEmpty ? "use 8+ caracteres" : strength >= 3 ? "senha forte" : strength == 2 ? "razoável — misture números e símbolos" : "fraca — use 8+ caracteres")
                    .font(.system(size: 11.5)).foregroundStyle(T.dim2)
            }
        } cta: {
            primary("Continuar", enabled: signupOk) { Task { await doSignup() } }
            HStack(spacing: 4) {
                Text("Já tem conta?").font(.system(size: 12.5)).foregroundStyle(T.dim)
                link("entrar") { go(.login) }
            }
        }
    }

    // MARK: - Entrar

    private var login: some View {
        frame(back: .welcome) {
            Text("BEM-VINDO DE VOLTA").font(.mono(10, .medium)).kerning(1.6).foregroundStyle(T.accent)
            h2("Entrar")
            p("Mesma conta do Constellation no Mac — tudo sincronizado.")
            msgView
            Field(label: "E-mail", placeholder: "voce@empresa.com", text: $email, keyboard: .emailAddress, content: .username)
            Field(label: "Senha", placeholder: "••••••••", text: $pass, secure: true, content: .password,
                  trailing: { AnyView(link("esqueci") { Task { await doRecover() } }) })
        } cta: {
            primary("Entrar", enabled: email.contains("@") && pass.count >= 6) { Task { await doLogin() } }
            OutlineButton(label: "Enviar link mágico por e-mail", height: 46, full: true) { Task { await doMagic() } }
                .disabled(!email.contains("@")).opacity(email.contains("@") ? 1 : 0.5)
            HStack(spacing: 4) {
                Text("Ainda não tem conta?").font(.system(size: 12.5)).foregroundStyle(T.dim)
                link("criar agora") { go(.signup) }
            }
        }
    }

    // MARK: - Confirmar e-mail (código de 6 dígitos)

    private var confirm: some View {
        frame(back: confirmType == "signup" ? .signup : .login) {
            VStack(spacing: 14) {
                OrbitIcon(glyph: "✦", size: 44).padding(.top, 30)
                if confirmType == "signup" { stepKicker(2) }
                Text(confirmType == "recovery" ? "Código de recuperação" : "Confirme o e-mail")
                    .font(.system(size: 28, weight: .semibold)).kerning(-0.6).foregroundStyle(T.text).multilineTextAlignment(.center)
                VStack(spacing: 3) {
                    Text("Mandamos um código de 6 dígitos de \(confirmType == "recovery" ? "recuperação" : confirmType == "magiclink" ? "acesso" : "confirmação") para")
                        .font(.system(size: 14.5)).foregroundStyle(T.dim).multilineTextAlignment(.center)
                    Text(email).font(.mono(13.5, .medium)).foregroundStyle(T.text)
                }
                msgView
                codeBoxes.padding(.top, 8)
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let left = max(0, Int(resendAt.timeIntervalSince(ctx.date).rounded(.up)))
                    HStack(spacing: 4) {
                        Text("não chegou?").font(.system(size: 13)).foregroundStyle(T.dim)
                        if left > 0 {
                            Text(String(format: "reenviar em 0:%02d", left)).font(.system(size: 13)).foregroundStyle(T.accent.opacity(0.7))
                        } else {
                            link("reenviar código") { Task { await doResend() } }
                        }
                    }
                }
            }.frame(maxWidth: .infinity)
        } cta: {
            primary("Confirmar", enabled: code.count == 6) { Task { await doVerify() } }
        }
        .onAppear { codeFocus = true }
    }

    private var codeBoxes: some View {
        ZStack {
            TextField("", text: $code)
                .keyboardType(.numberPad).textContentType(.oneTimeCode)
                .focused($codeFocus)
                .opacity(0.02).frame(width: 1, height: 1)
                .onChange(of: code) { _, v in
                    let d = String(v.filter { $0.isNumber }.prefix(6))
                    if d != v { code = d }
                    if d.count == 6 { Task { await doVerify() } }
                }
            HStack(spacing: 8) {
                ForEach(0..<6, id: \.self) { i in
                    let ch = i < code.count ? String(Array(code)[i]) : ""
                    let cur = i == code.count
                    Text(ch).font(.mono(22, .bold)).foregroundStyle(T.text)
                        .frame(width: 46, height: 52)
                        .background(ch.isEmpty ? T.panel : T.accent.opacity(0.08))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(ch.isEmpty && !cur ? T.line : T.accent, lineWidth: cur ? 1.5 : 1))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { codeFocus = true }
        }
    }

    // MARK: - Nova senha (após recuperação)

    private var newpass: some View {
        frame {
            Text("RECUPERAÇÃO").font(.mono(10, .medium)).kerning(1.6).foregroundStyle(T.accent)
            h2("Nova senha")
            p("Escolha uma senha nova para \(email).")
            msgView
            Field(label: "Nova senha", placeholder: "mínimo 8 caracteres", text: $pass, secure: true, content: .newPassword)
            Field(label: "Repita a senha", placeholder: "de novo", text: $pass2, secure: true, content: .newPassword)
        } cta: {
            primary("Salvar e entrar", enabled: pass.count >= 8 && pass == pass2) { Task { await doNewPass() } }
        }
    }

    // MARK: - Planos

    struct PlanDef { let key: String; let name: String; let who: String; let hot: Bool; let feats: [String] }
    private let planDefs: [PlanDef] = [
        PlanDef(key: "individual", name: "Solo", who: "1 pessoa, 1 repo", hot: false, feats: ["1 agente por vez, sem fila", "Branch + worktree isolada por tarefa", "Histórico de 30 dias"]),
        PlanDef(key: "team", name: "Time", who: "squads de 3 a 12", hot: true, feats: ["Agentes em paralelo, sem limite de fila", "Workflows e personas compartilhados", "Daily automática e custo por pessoa", "Preferências do projeto sincronizadas"]),
        PlanDef(key: "enterprise", name: "Organização", who: "vários times e repos", hot: false, feats: ["Tudo do Time, sem teto de assentos", "SSO, auditoria e política por repo", "Chaves de modelo próprias (BYOK)", "Suporte dedicado"]),
    ]
    private func planRow(_ key: String, _ iv: String) -> Supa.BillingPlan? { supa.plans.first { $0.plan == key && $0.interval == iv } }
    private func price(_ key: String, _ iv: String) -> Int {
        if let p = planRow(key, iv) { return p.amountCents }
        let fb: [String: [String: Int]] = ["individual": ["month": 4900, "year": 3900], "team": ["month": 3900, "year": 3100]]
        return fb[key]?[iv] ?? 0
    }
    private func perSeat(_ key: String) -> Bool { planRow(key, interval).map { $0.perSeat ?? false } ?? (key == "team") }
    private func seatsOf(_ key: String) -> Int {
        if key == "team", let p = planRow(key, interval), !(p.perSeat ?? false) { return p.seats ?? 1 }
        return key == "team" ? seats : 1
    }
    private var total: Int { perSeat(planKey) ? price(planKey, interval) * seatsOf(planKey) : price(planKey, interval) }
    private var trialDays: Int { planRow(planKey, interval)?.trialDays ?? 14 }
    private func brl(_ cents: Int) -> String {
        let v = Double(cents) / 100
        let f = NumberFormatter(); f.numberStyle = .currency; f.locale = Locale(identifier: "pt_BR"); f.maximumFractionDigits = cents % 100 == 0 ? 0 : 2
        return f.string(from: NSNumber(value: v)) ?? "R$ \(cents / 100)"
    }

    private var plans: some View {
        frame(back: supa.session == nil ? .welcome : nil) {
            HStack {
                if supa.session != nil { link("sair da conta") { supa.signOut(); go(.welcome) } }
                Spacer()
                stepKicker(3)
            }
            h2("Escolha o plano")
            p("Você paga pelos assentos. O custo dos modelos é cobrado à parte, sempre visível na tarefa.")
            msgView
            // mensal / anual
            HStack(spacing: 4) {
                seg("mensal", on: interval == "month") { interval = "month" }
                seg("anual", badge: "-20%", on: interval == "year") { interval = "year" }
            }
            .padding(4).background(T.panel).overlay(RoundedRectangle(cornerRadius: 14).stroke(T.line)).clipShape(RoundedRectangle(cornerRadius: 14))
            ForEach(planDefs, id: \.key) { d in planCard(d) }
            if planKey == "team" && perSeat("team") {
                HStack(spacing: 14) {
                    VStack(alignment: .leading, spacing: 3) {
                        fieldLabel("Assentos")
                        Text("quem escreve demanda no time").font(.system(size: 11.5)).foregroundStyle(T.dim2)
                    }
                    Spacer()
                    HStack(spacing: 0) {
                        stepBtn("−") { seats = max(1, seats - 1) }
                        Text("\(seats)").font(.mono(16, .bold)).foregroundStyle(T.text).frame(width: 40)
                        stepBtn("+") { seats = min(planRow("team", interval)?.seats ?? 12, seats + 1) }
                    }
                }.card(radius: 14)
            }
            if planKey != "enterprise" {
                VStack(alignment: .leading, spacing: 4) {
                    fieldLabel("Total")
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(brl(total)).font(.system(size: 26, weight: .semibold)).kerning(-0.5).foregroundStyle(T.text)
                        Text("/mês").font(.system(size: 13)).foregroundStyle(T.dim)
                    }
                    Text((perSeat(planKey) && seatsOf(planKey) > 1 ? "\(seatsOf(planKey)) assentos × \(brl(price(planKey, interval))) por mês · " : "") + "custo de modelo à parte" + (interval == "year" ? " · cobrado anualmente" : ""))
                        .font(.system(size: 11.5)).foregroundStyle(T.dim2)
                }.card(radius: 14)
            }
        } cta: {
            if planKey == "enterprise" {
                primary("Falar com vendas") {
                    if let u = URL(string: "mailto:vendas@constellation.ai?subject=Plano%20Organiza%C3%A7%C3%A3o%20Constellation") { UIApplication.shared.open(u) }
                }
            } else {
                primary("Continuar para o pagamento", enabled: !supa.plans.isEmpty) { go(.pay) }
                Text(supa.plans.isEmpty ? "cobrança ainda não ativada neste backend" : "\(trialDays) dias grátis · cancele quando quiser")
                    .font(.system(size: 11.5)).foregroundStyle(T.dim2)
            }
        }
        .task { if supa.plans.isEmpty { await supa.checkBilling() } }
    }
    private func seg(_ t: String, badge: String? = nil, on: Bool, _ a: @escaping () -> Void) -> some View {
        Button(action: a) {
            HStack(spacing: 6) {
                Text(t).font(.system(size: 14, weight: .semibold))
                if let badge { Text(badge).font(.mono(10, .bold)).padding(.horizontal, 5).padding(.vertical, 2).background(T.accent.opacity(on ? 0.25 : 0.14)).foregroundStyle(T.accent).clipShape(Capsule()) }
            }
            .foregroundStyle(on ? T.onAccent : T.text2)
            .frame(maxWidth: .infinity).frame(height: 40)
            .background(on ? T.accent : .clear).clipShape(RoundedRectangle(cornerRadius: 11))
        }.buttonStyle(.plain)
    }
    private func stepBtn(_ t: String, _ a: @escaping () -> Void) -> some View {
        Button(action: a) {
            Text(t).font(.system(size: 18, weight: .semibold)).foregroundStyle(T.text)
                .frame(width: 38, height: 38).background(Color.white.opacity(0.06)).overlay(RoundedRectangle(cornerRadius: 10).stroke(T.line)).clipShape(RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain)
    }
    private func planCard(_ d: PlanDef) -> some View {
        let on = planKey == d.key
        let ent = d.key == "enterprise"
        return Button { planKey = d.key } label: {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    ZStack {
                        Circle().stroke(on ? T.accent.opacity(0.5) : T.lineHard, style: StrokeStyle(lineWidth: 1, dash: [3, 3])).frame(width: 34, height: 34)
                        Circle().fill(on ? T.accent : T.dim2).frame(width: 10, height: 10)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 8) {
                            Text(d.name).font(.system(size: 18, weight: .semibold)).foregroundStyle(T.text)
                            if d.hot { Text("MAIS USADO").font(.mono(9, .bold)).kerning(0.8).padding(.horizontal, 7).padding(.vertical, 3).background(T.accent).foregroundStyle(T.onAccent).clipShape(RoundedRectangle(cornerRadius: 6)) }
                        }
                        Text(d.who).font(.system(size: 12)).foregroundStyle(T.dim)
                    }
                    Spacer(minLength: 6)
                    VStack(alignment: .trailing, spacing: 2) {
                        if ent {
                            Text("sob consulta").font(.system(size: 15, weight: .semibold)).foregroundStyle(T.text)
                            Text("fale com vendas").font(.mono(10)).foregroundStyle(T.dim2)
                        } else {
                            Text(brl(price(d.key, interval))).font(.system(size: 24, weight: .semibold)).kerning(-0.5).foregroundStyle(on ? T.accent : T.text)
                            Text(perSeat(d.key) || d.key != "team" ? "por \(d.key == "team" ? "assento" : "pessoa")/mês" : "por time/mês").font(.mono(10)).foregroundStyle(T.dim2)
                        }
                    }
                }
                Rectangle().fill(T.line).frame(height: 1)
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(d.feats, id: \.self) { f in
                        HStack(alignment: .top, spacing: 9) {
                            Text("◆").font(.system(size: 9)).foregroundStyle(on ? T.accent : T.dim2).padding(.top, 3)
                            Text(f).font(.system(size: 13)).foregroundStyle(T.text2).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .card(radius: 18, stroke: on ? T.accent.opacity(0.6) : T.line, pad: 16, fill: on ? T.accent.opacity(0.05) : T.panel)
        }.buttonStyle(.plain)
    }

    // MARK: - Pagamento (Stripe no navegador)

    private var pay: some View {
        let def = planDefs.first { $0.key == planKey }
        let first = Calendar.current.date(byAdding: .day, value: trialDays, to: Date()) ?? Date()
        let df = DateFormatter(); df.dateFormat = "dd/MM/yyyy"
        return frame(back: .plans, backLabel: "planos") {
            Text("PAGAMENTO SEGURO").font(.mono(10, .medium)).kerning(1.6).foregroundStyle(T.accent)
            h2("Pagamento")
            msgView
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Circle().fill(T.accent).frame(width: 8, height: 8)
                    Text("\(def?.name ?? planKey) · \(interval == "year" ? "anual" : "mensal")").font(.system(size: 15, weight: .semibold)).foregroundStyle(T.text)
                }
                if perSeat(planKey) { sumRow("Assento", "\(brl(price(planKey, interval)))/mês") }
                sumRow("Assentos", "\(seatsOf(planKey))")
                sumRow("Após o teste", "\(brl(total))/\(interval == "year" ? "mês (anual)" : "mês")")
                Rectangle().fill(T.line).frame(height: 1)
                HStack { Text("Cobrado hoje").font(.system(size: 14)).foregroundStyle(T.text2); Spacer(); Text("R$ 0,00").font(.system(size: 18, weight: .semibold)).foregroundStyle(T.accent) }
                Text("Primeira cobrança em \(df.string(from: first)). Custo de modelo é medido por tarefa e cobrado no mês seguinte.")
                    .font(.system(size: 11.5)).foregroundStyle(T.dim2).fixedSize(horizontal: false, vertical: true)
            }.card(radius: 16, pad: 16)
            HStack(spacing: 6) {
                ForEach(["Cartão", "Pix", "Boleto/NF"], id: \.self) { m in
                    Text(m).font(.system(size: 12.5, weight: .medium)).foregroundStyle(T.text2)
                        .padding(.horizontal, 12).frame(height: 32).background(T.panel).overlay(Capsule().stroke(T.line)).clipShape(Capsule())
                }
            }
            p("O pagamento acontece numa página segura da Stripe, no Safari — o cartão nunca passa pelo app. Cartão, Pix e boleto ficam disponíveis lá.")
            if waiting {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) { ProgressView().tint(T.accent); Text("esperando a confirmação da Stripe…").font(.mono(12)).foregroundStyle(T.accent) }
                    HStack(spacing: 4) {
                        Text("Concluiu o pagamento? O app reconhece sozinho.").font(.system(size: 12)).foregroundStyle(T.dim)
                        link("verificar agora") { Task { await recheck(silent: false) } }
                    }
                }.card(radius: 14, stroke: T.accent.opacity(0.3), fill: T.accent.opacity(0.05))
            }
        } cta: {
            primary("Começar teste de \(trialDays) dias") { Task { await doCheckout() } }
            Text("Sem cobrança agora. Avisamos 3 dias antes de renovar.").font(.system(size: 11.5)).foregroundStyle(T.dim2)
        }
    }
    private func sumRow(_ l: String, _ v: String) -> some View {
        HStack { Text(l).font(.system(size: 13.5)).foregroundStyle(T.dim); Spacer(); Text(v).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(T.text) }
    }

    // MARK: - Pronto

    private var ready: some View {
        let b = supa.billing
        let plan = b?.plan == "team" ? "Time" : b?.plan == "enterprise" ? "Organização" : "Solo"
        let seatsTxt = (b?.seats).map { "\($0) assento\($0 == 1 ? "" : "s") no plano \(plan)." } ?? "Plano \(plan) ativo."
        return frame {
            VStack(spacing: 14) {
                OrbitIcon(glyph: "✓", size: 58).padding(.top, 36)
                Text("Constelação ativa").font(.system(size: 30, weight: .semibold)).kerning(-0.75).foregroundStyle(T.text)
                Text((b?.status == "trialing" ? "Teste de \(trialDays) dias começou. " : "") + seatsTxt)
                    .font(.system(size: 14.5)).foregroundStyle(T.dim).multilineTextAlignment(.center)
            }.frame(maxWidth: .infinity)
            VStack(spacing: 8) {
                stepRow(1, T.accent, "Parear com o Mac que executa as tarefas")
                stepRow(2, T.cyan, "Conectar o repositório e escrever a primeira demanda")
                stepRow(3, T.purple, "Convidar o time — assentos livres: \(max(0, (b?.seats ?? 1) - 1))")
            }.padding(.top, 10)
        } cta: {
            primary("Abrir a Central") { supa.gate = .open }
        }
    }
    private func stepRow(_ n: Int, _ c: Color, _ t: String) -> some View {
        HStack(spacing: 12) {
            Text("\(n)").font(.mono(12, .bold)).foregroundStyle(T.onAccent).frame(width: 28, height: 28).background(c).clipShape(RoundedRectangle(cornerRadius: 8))
            Text(t).font(.system(size: 13.5)).foregroundStyle(T.text2).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }.card(radius: 14)
    }

    // MARK: - ações

    private func run(_ f: () async throws -> Void) async {
        busy = true; msg = ""; ok = false
        do { try await f() } catch { msg = error.localizedDescription }
        busy = false
    }
    private func doSignup() async {
        await run {
            let e = email.trimmingCharacters(in: .whitespaces).lowercased()
            try await supa.signUp(name: name.trimmingCharacters(in: .whitespaces), email: e, password: pass)
            UserDefaults.standard.set(e, forKey: "sb.email")
            if supa.session != nil { await supa.checkBilling(); return }
            confirmType = "signup"; code = ""; resendAt = Date().addingTimeInterval(60); go(.confirm)
        }
    }
    private func doLogin() async {
        await run {
            let e = email.trimmingCharacters(in: .whitespaces).lowercased()
            try await supa.signIn(email: e, password: pass)
            UserDefaults.standard.set(e, forKey: "sb.email")
            await supa.checkBilling()
        }
    }
    private func doRecover() async {
        guard email.contains("@") else { msg = "digite o e-mail primeiro."; return }
        await run {
            let e = email.trimmingCharacters(in: .whitespaces).lowercased()
            try await supa.recover(email: e)
            UserDefaults.standard.set(e, forKey: "sb.email")
            confirmType = "recovery"; code = ""; resendAt = Date().addingTimeInterval(60); go(.confirm)
        }
    }
    private func doMagic() async {
        await run {
            let e = email.trimmingCharacters(in: .whitespaces).lowercased()
            try await supa.magicLink(email: e)
            UserDefaults.standard.set(e, forKey: "sb.email")
            confirmType = "magiclink"; code = ""; resendAt = Date().addingTimeInterval(60); go(.confirm)
        }
    }
    private func doResend() async {
        await run {
            let e = email.trimmingCharacters(in: .whitespaces).lowercased()
            switch confirmType {
            case "signup": try await supa.resendSignup(email: e)
            case "recovery": try await supa.recover(email: e)
            default: try await supa.magicLink(email: e)
            }
            resendAt = Date().addingTimeInterval(60); msg = "✓ código reenviado"; ok = true
        }
    }
    private func doVerify() async {
        guard code.count == 6, !busy else { return }
        await run {
            let e = email.trimmingCharacters(in: .whitespaces).lowercased()
            try await supa.verify(type: confirmType, email: e, code: code)
            if confirmType == "recovery" { pass = ""; pass2 = ""; go(.newpass); return }
            await supa.checkBilling()
        }
        if !msg.isEmpty { code = ""; codeFocus = true }
    }
    private func doNewPass() async {
        await run {
            try await supa.updatePassword(pass)
            await supa.checkBilling()
        }
    }
    private func doCheckout() async {
        guard let p = planRow(planKey, interval) else { msg = "plano não encontrado no backend."; return }
        await run {
            var teamId: String? = nil
            if planKey == "team" {
                teamId = await supa.myTeamId()
                if teamId == nil { throw Supa.SupaError.api("pra assinar o plano Time, crie ou entre num time primeiro (no Mac: Conta → Sua organização). Ou comece com o Solo.") }
            }
            let url = try await supa.checkoutUrl(planId: p.id, teamId: teamId, seats: (planKey == "team" && (p.perSeat ?? false)) ? seats : 1)
            await MainActor.run { UIApplication.shared.open(url) }
            waiting = true
        }
    }
    private func recheck(silent: Bool) async {
        await supa.checkBilling(afterCheckout: true)
        if supa.gate == .ready || supa.gate == .open { waiting = false; go(.ready); supa.gate = .ready }
        else if !silent { msg = "ainda não chegou a confirmação — tente de novo em alguns segundos." }
    }
}
