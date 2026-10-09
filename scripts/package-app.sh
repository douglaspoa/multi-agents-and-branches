#!/bin/bash
# Empacota o Starfork PORTÁVEL: motor bundlado dentro do .app, sem nenhum
# caminho de máquina no Info.plist. Requisitos do dev de destino: macOS + node
# 22.6+ (homebrew ou nvm) + claude CLI + gh — o preflight do app confere tudo.
#
# Uso: scripts/package-app.sh  →  dist/Starfork-portable.zip
#      (+ cópia dist/Constellation-portable.zip: nome antigo, pros clientes em update)
set -euo pipefail
cd "$(dirname "$0")/.."

# Xcode completo instalado sem licença aceita quebra o linker (cc exige
# 'sudo xcodebuild -license'). O desktop compila 100% com as CLT — fixamos.
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"

source scripts/build-mark.sh
# o pacote "diz" de qual commit veio (dist/Starfork-portable.json) — apaga o antigo já: pacote
# que falhar no meio não pode ficar com o carimbo do anterior
rm -f dist/Starfork-portable.json
PKG_HEAD=$(git rev-parse HEAD)
PKG_DIRTY=$(tree_dirty .)

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
# template: dist/Starfork.app (gerado pelo scripts/deploy-local.sh; máquina só
# com o template antigo dist/Constellation.app → usa ele e renomeia no plist)
TPL=dist/Starfork.app; [ -d "$TPL" ] || TPL=dist/Constellation.app
PORT=dist/Starfork-portable.app
rm -rf "$PORT" dist/Constellation-portable.app
cp -R "$TPL" "$PORT"
rm -f "$PORT/Contents/MacOS/Constellation"
for k in CFBundleName CFBundleDisplayName CFBundleExecutable; do
  /usr/libexec/PlistBuddy -c "Set :$k Starfork" "$PORT/Contents/Info.plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$k string Starfork" "$PORT/Contents/Info.plist"
done
cp app/src-tauri/target/release/cardume-app "$PORT/Contents/MacOS/Starfork"
mkdir -p "$PORT/Contents/Resources"
# rm ANTES de copiar: o template dist/Starfork.app pode já trazer Resources/engine|mcp,
# e `cp -R origem dest/engine` ANINHA (engine/engine/cli.mjs) deixando o motor ANTIGO em
# engine/cli.mjs — que é justamente o que o app carrega. Sem isto, o rebuild ship motor velho.
rm -rf "$PORT/Contents/Resources/engine" "$PORT/Contents/Resources/mcp"
cp -R app/src-tauri/resources/engine "$PORT/Contents/Resources/engine"
cp -R app/src-tauri/resources/mcp "$PORT/Contents/Resources/mcp"
# o template dist/Starfork.app vem do deploy-local e carrega a marca de instalação DEV:
# colega NÃO é instalação dev (sumiria o auto-update dele) — remove ANTES de assinar
strip_dev_mark "$PORT"
# Info.plist SEM caminhos de máquina: só um PATH genérico (homebrew/local)
/usr/libexec/PlistBuddy -c "Delete :LSEnvironment" "$PORT/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSEnvironment dict" "$PORT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :LSEnvironment:PATH string /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" "$PORT/Contents/Info.plist"
# Assinatura: usa o Developer ID quando existir (conta Apple paga) — identidade
# ESTÁVEL: o macOS lembra as permissões (TCC) entre releases e o app pode ser
# notarizado (fim do "Abrir Mesmo Assim"). Sem o certificado, cai no ad-hoc.
DEVID=$( (security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"') || true )
if [ -n "$DEVID" ]; then
  echo "→ assinando com: $DEVID (hardened runtime)"
  codesign --force --deep --options runtime --timestamp --sign "$DEVID" "$PORT"
  # Notariza se houver um profile 'constellation'. Procura PRIMEIRO no chaveiro de LOGIN (arquivo explícito):
  # o chaveiro "Itens locais" desta máquina some com itens ("Chaves Não Encontradas") e o perfil já
  # desapareceu 2x (28/09 e 02/10). Crie uma vez com:
  #   xcrun notarytool store-credentials constellation --apple-id SEU_APPLE_ID --team-id SUB6889LA9 \
  #     --keychain "$HOME/Library/Keychains/login.keychain-db"
  LOGIN_KC="$HOME/Library/Keychains/login.keychain-db"
  NKC=()
  if xcrun notarytool history --keychain-profile constellation --keychain "$LOGIN_KC" >/dev/null 2>&1; then NKC=(--keychain "$LOGIN_KC");
  elif ! xcrun notarytool history --keychain-profile constellation >/dev/null 2>&1; then NKC=(none); fi
  if [ "${NKC[0]:-}" != "none" ]; then
    echo "→ notarizando (pode levar alguns minutos)…"
    ditto -c -k --keepParent "$PORT" /tmp/constellation-notarize.zip
    xcrun notarytool submit /tmp/constellation-notarize.zip --keychain-profile constellation ${NKC[@]+"${NKC[@]}"} --wait
    xcrun stapler staple "$PORT"
    echo "→ notarizado e grampeado ✓ (abre sem Gatekeeper em qualquer Mac)"
  else
    echo "⚠⚠ SEM NOTARIZAÇÃO: o perfil 'constellation' sumiu do chaveiro — o zip abre com bloqueio do Gatekeeper."
    echo "   Recrie: xcrun notarytool store-credentials constellation --apple-id SEU_APPLE_ID --team-id SUB6889LA9 --keychain \"$LOGIN_KC\""
  fi
else
  echo "→ sem Developer ID no keychain — assinatura ad-hoc (temporária)"
  codesign --force --deep --sign - "$PORT"
fi

echo "→ 4/4 zip (com LEIA-ME de instalação)"
cat > dist/LEIA-ME.txt <<'TXT'
STARFORK — instalação (macOS, Apple Silicon)

1. Arraste Starfork.app para /Applications (substituindo o antigo
   Starfork.app ou Constellation.app, se houver — pode apagar o Constellation.app).
2. Ao abrir, o macOS vai BLOQUEAR ("A Apple não pôde verificar…").
   Isso é o Gatekeeper com apps fora da App Store — o app está íntegro.
   Destrave por UM dos caminhos:

   A) Sem terminal: clique OK (NÃO "Mover para o Lixo") →
      Ajustes do Sistema → Privacidade e Segurança → role até
      "Starfork foi bloqueado…" → Abrir Mesmo Assim.

   B) Terminal (1 linha):
      xattr -dr com.apple.quarantine /Applications/Starfork.app

   Na 1ª execução o macOS também pergunta se o Starfork pode acessar
   a pasta Documentos (é onde ficam os repositórios) — clique Permitir.
   Ele pergunta UMA vez por app; mantendo o nome Starfork.app nas
   atualizações, a permissão fica guardada.
3. Abra o app: tour de 1 minuto + verificação do ambiente
   (precisa de node, git, claude logado e gh autenticado — a tela
   de Ambiente mostra o comando de correção de cada um).
4. Entrar → criar conta com o E-MAIL DO CONVITE → confirmar pelo
   link do e-mail → entrar → colar o token do convite.

COMO ATUALIZAR (quando receber um zip novo)
1. Feche o Starfork (⌘Q).
2. Descompacte o zip novo e arraste para /Applications,
   SUBSTITUINDO o app antigo.
3. Destrave o Gatekeeper de novo (todo download re-quarentena):
   Ajustes → Privacidade e Segurança → Abrir Mesmo Assim
   — ou no terminal:
   xattr -dr com.apple.quarantine /Applications/Starfork.app
4. Abra. Nada se perde: login, projetos e tarefas continuam
   (ficam fora do .app).

Qual versão estou rodando? Olhe o rodapé do app, canto direito:
"· build dd/mm hh:mm". Ao reportar um problema, informe esse carimbo.
TXT
# dentro do zip o app se chama Starfork.app: mesmo nome do instalado → substitui no lugar e o macOS
# mantém as permissões (Documentos etc.) em vez de perguntar de novo pra um "Starfork-portable".
# Constellation-portable.zip = o MESMO zip com o nome antigo: clientes antigos em update
# (ou links velhos) continuam achando o release.
( cd dist && rm -f Starfork-portable.zip Constellation-portable.zip && mkdir -p _pkg && rm -rf _pkg/* && cp -R Starfork-portable.app _pkg/Starfork.app && cp LEIA-ME.txt _pkg/ && ditto -c -k --sequesterRsrc _pkg Starfork-portable.zip && cp Starfork-portable.zip Constellation-portable.zip && rm -rf _pkg )
if [ "$(git rev-parse HEAD)" != "$PKG_HEAD" ]; then
  echo "✖ o checkout mudou de commit durante o empacotamento — rode scripts/package-app.sh de novo" >&2; exit 1
fi
BUILD_DIRTY=$PKG_DIRTY write_portable_meta . dist/Starfork-portable.zip dist/Starfork-portable.json
echo "✔ dist/Starfork-portable.zip pronto — instale em outro Mac: descompacta, arrasta pra /Applications, abre (botão direito → Abrir na 1ª vez)."

# publicar NÃO é daqui: a release do time sai só pelo botão "Publicar release pro time" do app
# instalado pelo deploy-local — ele confere commit/main/sujeira e o zip no canal antes de avisar
# o time (o antigo scripts/publish-release.mjs pulava tudo isso e foi removido).
echo "ℹ pra mandar pro time: no app, Publicar release pro time (só sai se este pacote é da main)."
