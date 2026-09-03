#!/bin/bash
# Deploy local do Constellation neste Mac: build → assina → troca /Applications → reabre.
# Usa o Developer ID automaticamente quando o certificado existir no keychain
# (identidade estável = o macOS PARA de pedir acesso a Documentos a cada deploy).
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"

echo "→ build release"
( cd app/src-tauri && cargo build --release ) 2>&1 | tail -1

cp app/src-tauri/target/release/cardume-app dist/Constellation.app/Contents/MacOS/Constellation

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
