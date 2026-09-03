#!/bin/bash
# Empacota o Constellation PORTÁVEL: motor bundlado dentro do .app, sem nenhum
# caminho de máquina no Info.plist. Requisitos do dev de destino: macOS + node
# 22.6+ (homebrew ou nvm) + claude CLI + gh — o preflight do app confere tudo.
#
# Uso: scripts/package-app.sh  →  dist/Constellation-portable.zip
set -euo pipefail
cd "$(dirname "$0")/.."

# Xcode completo instalado sem licença aceita quebra o linker (cc exige
# 'sudo xcodebuild -license'). O desktop compila 100% com as CLT — fixamos.
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"

echo "→ 1/4 bundle do motor (esbuild)"
rm -rf app/src-tauri/resources
mkdir -p app/src-tauri/resources/engine app/src-tauri/resources/mcp
npx -y esbuild src/cli.ts --bundle --platform=node --format=esm \
  --outfile=app/src-tauri/resources/engine/cli.mjs --log-level=error
npx -y esbuild src/mcp/server.ts --bundle --platform=node --format=esm \
  --outfile=app/src-tauri/resources/mcp/server.mjs --log-level=error

echo "→ 2/4 binário release"
( cd app/src-tauri && cargo build --release ) >/dev/null

echo "→ 3/4 monta o .app portável"
PORT=dist/Constellation-portable.app
rm -rf "$PORT"
cp -R dist/Constellation.app "$PORT"
cp app/src-tauri/target/release/cardume-app "$PORT/Contents/MacOS/Constellation"
mkdir -p "$PORT/Contents/Resources"
cp -R app/src-tauri/resources/engine "$PORT/Contents/Resources/engine"
cp -R app/src-tauri/resources/mcp "$PORT/Contents/Resources/mcp"
# Info.plist SEM caminhos de máquina: só um PATH genérico (homebrew/local)
/usr/libexec/PlistBuddy -c "Delete :LSEnvironment" "$PORT/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSEnvironment dict" "$PORT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :LSEnvironment:PATH string /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" "$PORT/Contents/Info.plist"
# Assinatura: usa o Developer ID quando existir (conta Apple paga) — identidade
# ESTÁVEL: o macOS lembra as permissões (TCC) entre releases e o app pode ser
# notarizado (fim do "Abrir Mesmo Assim"). Sem o certificado, cai no ad-hoc.
DEVID=$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"')
if [ -n "$DEVID" ]; then
  echo "→ assinando com: $DEVID (hardened runtime)"
  codesign --force --deep --options runtime --timestamp --sign "$DEVID" "$PORT"
  # Notariza se houver um profile 'constellation' salvo no keychain
  # (crie uma vez com: xcrun notarytool store-credentials constellation \
  #    --apple-id SEU_APPLE_ID --team-id SEU_TEAM_ID --password SENHA_DE_APP)
  if xcrun notarytool history --keychain-profile constellation >/dev/null 2>&1; then
    echo "→ notarizando (pode levar alguns minutos)…"
    ditto -c -k --keepParent "$PORT" /tmp/constellation-notarize.zip
    xcrun notarytool submit /tmp/constellation-notarize.zip --keychain-profile constellation --wait
    xcrun stapler staple "$PORT"
    echo "→ notarizado e grampeado ✓ (abre sem Gatekeeper em qualquer Mac)"
  else
    echo "→ sem profile de notarização 'constellation' — pulando (app assinado, mas 1º open pede Abrir Mesmo Assim)"
  fi
else
  echo "→ sem Developer ID no keychain — assinatura ad-hoc (temporária)"
  codesign --force --deep --sign - "$PORT"
fi

echo "→ 4/4 zip (com LEIA-ME de instalação)"
cat > dist/LEIA-ME.txt <<'TXT'
CONSTELLATION — instalação (macOS, Apple Silicon)

1. Arraste Constellation-portable.app para /Applications.
2. Ao abrir, o macOS vai BLOQUEAR ("A Apple não pôde verificar…").
   Isso é o Gatekeeper com apps fora da App Store — o app está íntegro.
   Destrave por UM dos caminhos:

   A) Sem terminal: clique OK (NÃO "Mover para o Lixo") →
      Ajustes do Sistema → Privacidade e Segurança → role até
      "Constellation-portable foi bloqueado…" → Abrir Mesmo Assim.

   B) Terminal (1 linha):
      xattr -dr com.apple.quarantine /Applications/Constellation-portable.app

3. Abra o app: tour de 1 minuto + verificação do ambiente
   (precisa de node, git, claude logado e gh autenticado — a tela
   de Ambiente mostra o comando de correção de cada um).
4. Entrar → criar conta com o E-MAIL DO CONVITE → confirmar pelo
   link do e-mail → entrar → colar o token do convite.

COMO ATUALIZAR (quando receber um zip novo)
1. Feche o Constellation (⌘Q).
2. Descompacte o zip novo e arraste para /Applications,
   SUBSTITUINDO o app antigo.
3. Destrave o Gatekeeper de novo (todo download re-quarentena):
   Ajustes → Privacidade e Segurança → Abrir Mesmo Assim
   — ou no terminal:
   xattr -dr com.apple.quarantine /Applications/Constellation-portable.app
4. Abra. Nada se perde: login, projetos e tarefas continuam
   (ficam fora do .app).

Qual versão estou rodando? Olhe o rodapé do app, canto direito:
"· build dd/mm hh:mm". Ao reportar um problema, informe esse carimbo.
TXT
( cd dist && rm -f Constellation-portable.zip && ditto -c -k --keepParent Constellation-portable.app /tmp/_capp.zip && mkdir -p _pkg && rm -rf _pkg/* && cp -R Constellation-portable.app _pkg/ && cp LEIA-ME.txt _pkg/ && ditto -c -k --sequesterRsrc _pkg Constellation-portable.zip && rm -rf _pkg /tmp/_capp.zip )
echo "✔ dist/Constellation-portable.zip pronto — instale em outro Mac: descompacta, arrasta pra /Applications, abre (botão direito → Abrir na 1ª vez)."

# publica no canal de releases quando as credenciais do owner estão no ambiente
if [ -n "${CONSTELLATION_EMAIL:-}" ] && [ -n "${CONSTELLATION_PASSWORD:-}" ]; then
  echo "→ 5/5 publicando release"
  node scripts/publish-release.mjs "${RELEASE_NOTES:-}" || echo "⚠ publicação falhou (o zip local continua válido)"
else
  echo "ℹ release NÃO publicada (defina CONSTELLATION_EMAIL/CONSTELLATION_PASSWORD pra publicar o ⬆ atualizar)"
fi
