#!/bin/bash
# Deploy local do Starfork neste Mac: build → assina → troca /Applications → reabre.
# Usa o Developer ID automaticamente quando o certificado existir no keychain
# (identidade estável = o macOS PARA de pedir acesso a Documentos a cada deploy).
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"

# Motor bundlado tem que entrar no .app JUNTO do binário — senão o deploy troca só
# o Rust e o app roda com o cli.mjs/server.mjs ANTIGOS (mudança de TS não chega).
echo "→ bundle do motor (esbuild)"
rm -rf app/src-tauri/resources
mkdir -p app/src-tauri/resources/engine app/src-tauri/resources/mcp
npx -y esbuild src/cli.ts --bundle --platform=node --format=esm \
  --outfile=app/src-tauri/resources/engine/cli.mjs --log-level=error
npx -y esbuild src/mcp/server.ts --bundle --platform=node --format=esm \
  --outfile=app/src-tauri/resources/mcp/server.mjs --log-level=error
# Template do .app: dist/Starfork.app. Máquina que só tem o template antigo
# (dist/Constellation.app, de antes do rename) → migra uma vez. O bundle id
# (dev.constellation.app) NÃO muda: localStorage, permissões e notificações seguem.
APP=dist/Starfork.app
if [ ! -d "$APP" ] && [ -d dist/Constellation.app ]; then
  echo "→ migrando o template dist/Constellation.app → $APP"
  cp -R dist/Constellation.app "$APP"
  rm -f "$APP/Contents/MacOS/Constellation"
fi
PL="$APP/Contents/Info.plist"
for k in CFBundleName CFBundleDisplayName CFBundleExecutable; do
  /usr/libexec/PlistBuddy -c "Set :$k Starfork" "$PL" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$k string Starfork" "$PL"
done

# rm antes de copiar: o template já traz Resources/engine, e
# `cp -R origem dest/engine` ANINHA (engine/engine/cli.mjs) deixando o motor velho no lugar.
rm -rf "$APP/Contents/Resources/engine" "$APP/Contents/Resources/mcp"
mkdir -p "$APP/Contents/Resources"
cp -R app/src-tauri/resources/engine "$APP/Contents/Resources/engine"
cp -R app/src-tauri/resources/mcp "$APP/Contents/Resources/mcp"

echo "→ build release"
( cd app/src-tauri && cargo build --release ) 2>&1 | tail -1

mkdir -p "$APP/Contents/MacOS"
cp app/src-tauri/target/release/cardume-app "$APP/Contents/MacOS/Starfork"

# Marca de instalação DEV (raiz do fonte + commit/branch) — ANTES de assinar: Resources é selado
# pelo codesign. É ela que libera "Publicar release pro time" no app aberto pelo Finder (sem CARDUME_CLI).
source scripts/build-mark.sh
write_dev_mark "$APP" .
echo "→ marca dev: $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))"

# Developer ID quando existir (identidade definitiva); senão ad-hoc.
# NUNCA usar "Apple Development" aqui: sem provisioning profile o Gatekeeper
# marca o app como malware e move pro Lixo (aconteceu — não repetir).
DEVID=$( (security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"') || true )
if [ -n "$DEVID" ]; then
  echo "→ assinando com: $DEVID"
  codesign --force --deep --options runtime --timestamp --sign "$DEVID" "$APP"
else
  echo "→ sem Developer ID — assinatura ad-hoc (o macOS pode re-pedir permissões)"
  codesign --force --deep --sign - "$APP"
fi

# mata o app pelos dois nomes (o instalado pode ainda ser o Constellation.app de antes do rename)
pkill -x Starfork 2>/dev/null || true
pkill -x Constellation 2>/dev/null || true
sleep 8   # lock de storage do WebKit: abrir cedo demais mata o webview
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if [ -d /Applications/Constellation.app ]; then
  "$LSREG" -u /Applications/Constellation.app 2>/dev/null || true
  rm -rf /Applications/Constellation.app
fi
rm -rf /Applications/Starfork.app
cp -R "$APP" /Applications/Starfork.app
xattr -dr com.apple.quarantine /Applications/Starfork.app 2>/dev/null || true
"$LSREG" -f /Applications/Starfork.app
: > /tmp/constellation-web.log
open /Applications/Starfork.app
echo "→ aberto — acompanhe: tail -f /tmp/constellation-web.log (espere o [boot])"
