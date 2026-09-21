#!/bin/bash
# Deploy local do Constellation neste Mac: build → assina → troca /Applications → reabre.
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
# rm antes de copiar: o template dist/Constellation.app já traz Resources/engine, e
# `cp -R origem dest/engine` ANINHA (engine/engine/cli.mjs) deixando o motor velho no lugar.
rm -rf dist/Constellation.app/Contents/Resources/engine dist/Constellation.app/Contents/Resources/mcp
mkdir -p dist/Constellation.app/Contents/Resources
cp -R app/src-tauri/resources/engine dist/Constellation.app/Contents/Resources/engine
cp -R app/src-tauri/resources/mcp dist/Constellation.app/Contents/Resources/mcp

echo "→ build release"
( cd app/src-tauri && cargo build --release ) 2>&1 | tail -1

cp app/src-tauri/target/release/cardume-app dist/Constellation.app/Contents/MacOS/Constellation

# Developer ID quando existir (identidade definitiva); senão ad-hoc.
# NUNCA usar "Apple Development" aqui: sem provisioning profile o Gatekeeper
# marca o app como malware e move pro Lixo (aconteceu — não repetir).
DEVID=$( (security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"') || true )
if [ -n "$DEVID" ]; then
  echo "→ assinando com: $DEVID"
  codesign --force --deep --options runtime --timestamp --sign "$DEVID" dist/Constellation.app
else
  echo "→ sem Developer ID — assinatura ad-hoc (o macOS pode re-pedir permissões)"
  codesign --force --deep --sign - dist/Constellation.app
fi

pkill -x Constellation 2>/dev/null || true
sleep 8   # lock de storage do WebKit: abrir cedo demais mata o webview
rm -rf /Applications/Constellation.app
cp -R dist/Constellation.app /Applications/Constellation.app
xattr -dr com.apple.quarantine /Applications/Constellation.app 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Constellation.app
: > /tmp/constellation-web.log
open /Applications/Constellation.app
echo "→ aberto — acompanhe: tail -f /tmp/constellation-web.log (espere o [boot])"
