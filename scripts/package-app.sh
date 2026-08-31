#!/bin/bash
# Empacota o Constellation PORTÁVEL: motor bundlado dentro do .app, sem nenhum
# caminho de máquina no Info.plist. Requisitos do dev de destino: macOS + node
# 22.6+ (homebrew ou nvm) + claude CLI + gh — o preflight do app confere tudo.
#
# Uso: scripts/package-app.sh  →  dist/Constellation-portable.zip
set -euo pipefail
cd "$(dirname "$0")/.."

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
codesign --force --deep --sign - "$PORT"

echo "→ 4/4 zip"
( cd dist && rm -f Constellation-portable.zip && ditto -c -k --keepParent Constellation-portable.app Constellation-portable.zip )
echo "✔ dist/Constellation-portable.zip pronto — instale em outro Mac: descompacta, arrasta pra /Applications, abre (botão direito → Abrir na 1ª vez)."
