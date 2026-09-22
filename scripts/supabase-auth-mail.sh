#!/usr/bin/env bash
# E-mails de autenticação do Constellation (código de 6 dígitos, visual do produto).
#
#   scripts/supabase-auth-mail.sh check    # mostra o estado atual (templates com {{ .Token }}? SMTP próprio? validade do código)
#   scripts/supabase-auth-mail.sh apply    # sobe supabase/templates/*.html + assuntos + código válido por 10 min
#   scripts/supabase-auth-mail.sh smtp     # liga SMTP próprio (Resend etc.) — precisa das vars SMTP_* abaixo
#
# Precisa de SUPABASE_ACCESS_TOKEN de uma conta OWNER/ADMIN do projeto (https://supabase.com/dashboard/account/tokens).
# Sem a env, usa o token da CLI (`supabase login` com a conta dona do projeto).
#
# SMTP (só pro subcomando smtp):  SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM SMTP_NAME
#   ex. Resend: SMTP_HOST=smtp.resend.com SMTP_PORT=465 SMTP_USER=resend SMTP_PASS=re_xxx SMTP_FROM=no-reply@seu-dominio.com
set -euo pipefail
REF="${PROJECT_REF:-fivoakrhazlzcdoocgbg}"
API="https://api.supabase.com/v1/projects/$REF/config/auth"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# sem env, usa o token da CLI logada (`supabase login`) — o keychain guarda em base64 com prefixo go-keyring
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ] && [ "$(uname)" = Darwin ]; then
  SUPABASE_ACCESS_TOKEN=$(security find-generic-password -s "Supabase CLI" -w 2>/dev/null | python3 -c 'import sys,base64; r=sys.stdin.read().strip(); r=r.split(":",1)[1] if r.startswith("go-keyring-base64:") else r; print(base64.b64decode(r+"="*(-len(r)%4)).decode().strip())' 2>/dev/null || true)
fi
: "${SUPABASE_ACCESS_TOKEN:?defina SUPABASE_ACCESS_TOKEN (ou faça 'supabase login' com uma conta owner do projeto $REF)}"
auth=(-H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json")

check(){
  local tmp; tmp=$(mktemp); curl -sf "${auth[@]}" "$API" -o "$tmp"
  python3 - "$tmp" <<'PY2'
import json,sys
d=json.load(open(sys.argv[1]))
print("validade do código (mailer_otp_exp):", d.get("mailer_otp_exp"), "s  |  tamanho:", d.get("mailer_otp_length"))
for k in ("recovery","confirmation","magic_link","invite"):
    c=d.get("mailer_templates_%s_content" % k) or ""
    tok="COM" if ".Token" in c else "SEM"
    print("%-13s: %s {{ .Token }}  | assunto: %r  | %d bytes" % (k, tok, d.get("mailer_subjects_%s" % k), len(c)))
print("aviso de senha trocada:", d.get("mailer_notifications_password_changed_enabled"))
print("SMTP próprio:", d.get("smtp_host") or "NÃO (SMTP padrão do Supabase — só entrega pra membros do projeto, ~2 e-mails/h)")
print("limite e-mails/h:", d.get("rate_limit_email_sent"), "| site_url:", d.get("site_url"))
print("redirects:", d.get("uri_allow_list"))
print("providers: google", d.get("external_google_enabled"), "| github", d.get("external_github_enabled"))
PY2
  rm -f "$tmp"
}

apply(){
  python3 - "$DIR" <<'PY' > /tmp/sb-auth-mail.json
import json,sys,pathlib
t=pathlib.Path(sys.argv[1])/"supabase/templates"
rd=lambda n:(t/f"{n}.html").read_text()
print(json.dumps({
  "mailer_otp_length": 6,
  "mailer_otp_exp": 600,
  "mailer_subjects_recovery": "{{ .Token }} é seu código pra redefinir a senha · Constellation",
  "mailer_templates_recovery_content": rd("recovery"),
  "mailer_subjects_confirmation": "{{ .Token }} é seu código pra confirmar o e-mail · Constellation",
  "mailer_templates_confirmation_content": rd("confirmation"),
  "mailer_subjects_magic_link": "{{ .Token }} é seu código de acesso · Constellation",
  "mailer_templates_magic_link_content": rd("magic_link"),
  "mailer_subjects_invite": "Você foi convidado pro Constellation",
  "mailer_templates_invite_content": rd("invite"),
  "mailer_notifications_password_changed_enabled": True,
  "mailer_subjects_password_changed_notification": "Sua senha foi alterada · Constellation",
  "mailer_templates_password_changed_notification_content": rd("password_changed"),
}))
PY
  curl -sf -X PATCH "${auth[@]}" "$API" --data-binary @/tmp/sb-auth-mail.json >/dev/null && echo "✓ templates + assuntos + código de 10 min aplicados em $REF"
  rm -f /tmp/sb-auth-mail.json
  check
}

smtp(){
  : "${SMTP_HOST:?}" "${SMTP_PORT:?}" "${SMTP_USER:?}" "${SMTP_PASS:?}" "${SMTP_FROM:?}"
  python3 - <<PY > /tmp/sb-smtp.json
import json,os
print(json.dumps({"smtp_host":"$SMTP_HOST","smtp_port":int("$SMTP_PORT"),"smtp_user":"$SMTP_USER","smtp_pass":"$SMTP_PASS",
  "smtp_admin_email":"$SMTP_FROM","smtp_sender_name":"${SMTP_NAME:-Constellation}","smtp_max_frequency":10,"rate_limit_email_sent":200}))
PY
  curl -sf -X PATCH "${auth[@]}" "$API" --data-binary @/tmp/sb-smtp.json >/dev/null && echo "✓ SMTP próprio ligado ($SMTP_HOST, remetente $SMTP_FROM)"
  rm -f /tmp/sb-smtp.json
}

case "${1:-check}" in check) check;; apply) apply;; smtp) smtp;; *) echo "uso: $0 check|apply|smtp"; exit 2;; esac
