#!/bin/bash
# e2e do COMANDO no APP de verdade (build de TESTE isolada: identificador e HOME próprios, IA FALSA, janela sem foco,
# fotografada SÓ ela). Prova o caminho inteiro: chat → comando_plan (Rust) → planejador → plano → cartões.
#   scripts/e2e-app/comando/e2e-comando.sh
set -euo pipefail
W="$(cd "$(dirname "$0")/../../.." && pwd)"; H="$W/scripts/e2e-app"; HC="$H/comando"
E="${E2E_DIR:-/tmp/sfe2e-comando}"; NODE="$(command -v node)"
rm -rf "$E"; mkdir -p "$E/engine" "$E/shots" "$E/home/.constellation" "$E/home/.claude"
( cd "$W" && npx -y esbuild src/cli.ts --bundle --platform=node --format=esm --outfile="$E/engine/cli.mjs" --log-level=error )
swiftc -O "$H/winid.swift" -o "$E/winid"
export TAURI_CONFIG='{"identifier":"dev.starfork.teste-comando","productName":"StarforkTeste","app":{"windows":[{"label":"main","title":"Starfork TESTE","width":1280,"height":820,"minWidth":920,"minHeight":600,"titleBarStyle":"Overlay","backgroundThrottling":"disabled","dragDropEnabled":false,"focus":false}]}}'
( cd "$W/app/src-tauri" && CARGO_TARGET_DIR="${E2E_TARGET:-$W/app/src-tauri/target-e2e}" cargo build --release --features e2e )
APP="${E2E_TARGET:-$W/app/src-tauri/target-e2e}/release/cardume-app"
printf '[user]\n\tname = Teste\n\temail = teste@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n' > "$E/home/.gitconfig"
echo '{"costCap":50}' > "$E/home/.constellation/settings.json"; echo '{}' > "$E/home/.claude.json"
cp "$HC/fake-claude.mjs" "$E/fake-claude.mjs"; chmod +x "$E/fake-claude.mjs"
export HOME="$E/home" CARDUME_CLAUDE="$E/fake-claude.mjs" CARDUME_NOTIFY=0 STUB_LOG="$E/stub.log"
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT ANTHROPIC_API_KEY
git init -q "$E/repo"; ( cd "$E/repo" && echo "# repo de teste" > README.md && git add -A && git commit -qm base )
T=(--roles builder --agents Vega --engine claude --approve auto --no-tests --auto-pr no --no-start)
N=("Relatório mensal de vendas por região" "Migração do cadastro de clientes" "Painel de estoque por depósito" "Integração com a transportadora" "Revisão das permissões de acesso" "Cache das consultas de catálogo")
for i in $(seq 1 42); do "$NODE" --disable-warning=ExperimentalWarning "$E/engine/cli.mjs" new --id "t$i" --title "${N[$((i % 6))]} — parte $i, com um título comprido de propósito" "${T[@]}" --repo "$E/repo" >/dev/null; done
# t3 editou código de verdade e entregou uma imagem: é o que o "abre o código / abre a imagem" vai abrir no app
WT3="$(git -C "$E/repo" worktree list --porcelain | sed -n 's/^worktree \(.*\/t3\)$/\1/p' | head -1)"
if [ -n "$WT3" ]; then
  mkdir -p "$WT3/src" "$WT3/.cardume/artifacts"
  printf 'export function frete(cep: string) {\n  return cep.startsWith("9") ? 12 : 25;\n}\n' > "$WT3/src/frete.ts"
  printf 'export const versao = 2;\n' > "$WT3/src/versao.ts"
  ( cd "$WT3" && git add src && git commit -qm "frete por CEP" )
  printf 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGNk+M+AFTBhFx6VGFESAOHfAQ8sqQb4AAAAAElFTkSuQmCC' | base64 -d > "$WT3/.cardume/artifacts/proof-1.png"
  printf '# testes\n\n3 passaram\n' > "$WT3/.cardume/artifacts/tests.md"
fi
: > "$E/report.txt"; : > "$E/stub.log"
mkdir -p "$E/site"; printf '<html><body><h1>Pedidos</h1><button id="exp">Exportar CSV</button><script>document.body.insertAdjacentHTML("beforeend","<p id=js>renderizado por JS</p>")</script></body></html>' > "$E/site/pedidos.html"
( cd "$E/site" && exec /usr/bin/python3 -m http.server 4191 --bind 127.0.0.1 >/dev/null 2>&1 ) & SITE=$!
CARDUME_REPO="$E/repo" CARDUME_CLI="$E/engine/cli.mjs" CARDUME_NODE="$NODE" STARFORK_E2E_SCRIPT="$HC/driver.js" STARFORK_E2E_REPORT="$E/report.txt" "$APP" > "$E/app.log" 2>&1 &
APID=$!; seen=0; t0=$(date +%s)
while :; do
  n=$(wc -l < "$E/report.txt")
  if [ "$n" -gt "$seen" ]; then
    sed -n "$((seen+1)),${n}p" "$E/report.txt" | while IFS= read -r l; do echo "$l"; case "$l" in "SHOT "*) w=$("$E/winid" $APID); [ -n "$w" ] && screencapture -x -o -l "$w" "$E/shots/${l#SHOT }.png";; esac; done
    seen=$n
  fi
  grep -q '^FIM' "$E/report.txt" && break
  [ $(( $(date +%s) - t0 )) -gt "${E2E_MAX:-1500}" ] && { echo "TEMPO ESGOTADO"; break; }
  kill -0 $APID 2>/dev/null || { echo "APP SAIU"; break; }
  sleep 0.5
done
kill $APID 2>/dev/null; sleep 2; kill -9 $APID 2>/dev/null || true
kill $SITE 2>/dev/null || true; pkill -f "http.server 4191" 2>/dev/null || true
FOTO=$(grep '^FOTO ' "$E/report.txt" | head -1 || true)
if [ -n "$FOTO" ]; then set -- $FOTO; PNG="$2"; HTM="$3"
  if [ -s "$PNG" ] && [ "$(wc -c < "$PNG")" -gt 2000 ] && grep -q 'renderizado por JS' "$HTM" && grep -q 'Exportar CSV' "$HTM"; then echo "OK   foto de página: PNG de $(wc -c < "$PNG" | tr -d ' ') bytes e HTML com o que o JavaScript desenhou" | tee -a "$E/report.txt"; cp "$PNG" "$E/shots/pagina-fotografada.png"
  else echo "FALHA foto de página: arquivo vazio ou HTML sem o conteúdo esperado" | tee -a "$E/report.txt"; fi
else echo "FALHA foto de página: o app não devolveu a foto" | tee -a "$E/report.txt"; fi
pkill -f "$E/engine/cli.mjs" 2>/dev/null || true
echo "--- o que o APP mandou pra IA (um por pedido)"; cut -c1-260 "$E/stub.log"
"$NODE" -e '
const L=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse), Pl=L.filter(x=>!x.agente), Ag=L.filter(x=>x.agente);
const ruim=Pl.filter(x=>!x.temPedido||!x.temRegras||!x.temFormato||x.sysLen>=40000||x.promptLen>40000);
console.log((Pl.length>=5&&!ruim.length?"OK   ":"FALHA ")+"planejador: o pedido e as regras chegaram inteiros nas "+Pl.length+" chamadas · regras "+Math.max(0,...Pl.map(x=>x.sysLen))+" de 40000 · maior pedido "+Math.max(0,...Pl.map(x=>x.promptLen))+" de 40000");
const ruimA=Ag.filter(x=>!x.temContexto||!x.sysOk||!x.acoesOk||!/mcp__starfork__agir/.test(x.allowed||"")||!/mcp__starfork__olhar_pagina/.test(x.allowed||""));
console.log((Ag.length>=12&&!ruimA.length?"OK   ":"FALHA ")+"agente: "+Ag.length+" chamadas com contexto, instrução, lista de ações e ferramentas liberadas");
const comSessao=Ag.filter(x=>x.resume==="fake-ag-1").length;
console.log((comSessao>=6?"OK   ":"FALHA ")+"agente: retoma a mesma conversa ("+comSessao+" de "+Ag.length+" chamadas com a sessão anterior)");
if(ruim.length||Pl.length<5||ruimA.length||Ag.length<8||comSessao<6) process.exit(1);' "$E/stub.log" | tee -a "$E/report.txt"
echo "prints em $E/shots · relatório em $E/report.txt"
grep -q '^FALHA\|^ERRO\|TEMPO ESGOTADO\|APP SAIU' "$E/report.txt" && exit 1 || exit 0
