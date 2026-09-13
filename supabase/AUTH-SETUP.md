# Entrada e assinatura — o que ligar no Supabase (painel) e na Stripe

O app (`app/src/js/44-onboarding.js`) implementa: criar conta · entrar · confirmar e-mail
por **código de 6 dígitos** · link mágico · esqueci a senha (código + senha nova) ·
trocar senha (Conta) · login com GitHub/Google · planos por assento · checkout na Stripe.
Tudo fala com o GoTrue e com as functions que já existem. O que NÃO dá pra fazer pelo
código (é configuração do projeto `fivoakrhazlzcdoocgbg`):

## 1. Templates de e-mail com o CÓDIGO (Authentication → Email Templates)
Inclua `{{ .Token }}` nos templates **Confirm signup**, **Magic Link** e **Reset password**
(pode manter o `{{ .ConfirmationURL }}` — o link continua funcionando como alternativa). Ex.:

```html
<h2>Seu código do Constellation</h2>
<p style="font:600 28px/1 monospace;letter-spacing:.2em">{{ .Token }}</p>
<p>Vale por 10 minutos. Ou abra o link: <a href="{{ .ConfirmationURL }}">confirmar</a></p>
```
Sem o token no e-mail, o app mostra a instrução pra usar o link.

## 2. URLs (Authentication → URL Configuration)
- **Site URL**: o domínio do site (Lovable), ex. `https://constellation.lovable.app`.
- **Redirect URLs** (lista exata):
  - `http://localhost:8788/callback` — login GitHub/Google pelo app (callback local).
  - `https://<site>/confirmado` — destino do link de confirmação.
  - `https://<site>/redefinir-senha` — destino do link "esqueci a senha" (a página lê o
    token do hash e chama `PUT /auth/v1/user`).
- Em **Reset password** o `{{ .ConfirmationURL }}` deve apontar pra `/redefinir-senha`
  (o GoTrue usa o `redirect_to` do pedido; o app manda `recover` sem redirect, então
  vale o Site URL + `/redefinir-senha` se você trocar o template pra
  `{{ .SiteURL }}/redefinir-senha#access_token={{ .TokenHash }}` — ou deixe o padrão
  e use o código no app, que é o caminho principal).

## 3. Providers
- **GitHub**: Authentication → Providers → GitHub (client id/secret de um OAuth App do
  GitHub com callback `https://fivoakrhazlzcdoocgbg.supabase.co/auth/v1/callback`).
- **Google**: idem (já usado antes).

## 4. Planos e Stripe (por assento)
```bash
STRIPE_SECRET_KEY=sk_live_... bash scripts/stripe-setup.sh   # cria Solo R$49 e Time R$39/assento (14 dias grátis)
```
Cole o SQL que ele imprime no SQL Editor (liga a cobrança). Depois publique a function
com o suporte a assentos (quantity):
```bash
supabase functions deploy stripe-checkout --no-verify-jwt --project-ref fivoakrhazlzcdoocgbg
```
(A CLI nesta máquina não tem permissão no projeto — rode com uma conta owner/admin.)

## 5. Site (Lovable)
Rota nova `src/routes/redefinir-senha.tsx` + `src/lib/supabase-public.ts` (URL/anon).
O `routeTree.gen.ts` é regenerado pelo plugin do TanStack no build.
