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
: > "$E/report.txt"; : > "$E/stub.log"
CARDUME_REPO="$E/repo" CARDUME_CLI="$E/engine/cli.mjs" CARDUME_NODE="$NODE" STARFORK_E2E_SCRIPT="$HC/driver.js" STARFORK_E2E_REPORT="$E/report.txt" "$APP" > "$E/app.log" 2>&1 &
APID=$!; seen=0; t0=$(date +%s)
while :; do
  n=$(wc -l < "$E/report.txt")
  if [ "$n" -gt "$seen" ]; then
    sed -n "$((seen+1)),${n}p" "$E/report.txt" | while IFS= read -r l; do echo "$l"; case "$l" in "SHOT "*) w=$("$E/winid" $APID); [ -n "$w" ] && screencapture -x -o -l "$w" "$E/shots/${l#SHOT }.png";; esac; done
    seen=$n
  fi
  grep -q '^FIM' "$E/report.txt" && break
  [ $(( $(date +%s) - t0 )) -gt "${E2E_MAX:-300}" ] && { echo "TEMPO ESGOTADO"; break; }
  kill -0 $APID 2>/dev/null || { echo "APP SAIU"; break; }
  sleep 0.5
done
kill $APID 2>/dev/null; sleep 2; kill -9 $APID 2>/dev/null || true
pkill -f "$E/engine/cli.mjs" 2>/dev/null || true
echo "--- o que o APP mandou pra IA (um por pedido)"; cut -c1-260 "$E/stub.log"
"$NODE" -e '
const L=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse), Pl=L.filter(x=>!x.agente), Ag=L.filter(x=>x.agente);
const ruim=Pl.filter(x=>!x.temPedido||!x.temRegras||!x.temFormato||x.sysLen>=40000||x.promptLen>40000);
console.log((Pl.length>=5&&!ruim.length?"OK   ":"FALHA ")+"planejador: o pedido e as regras chegaram inteiros nas "+Pl.length+" chamadas · regras "+Math.max(0,...Pl.map(x=>x.sysLen))+" de 40000 · maior pedido "+Math.max(0,...Pl.map(x=>x.promptLen))+" de 40000");
const ruimA=Ag.filter(x=>!x.temContexto||!x.sysOk||!x.acoesOk||!/mcp__starfork__agir/.test(x.allowed||""));
console.log((Ag.length>=8&&!ruimA.length?"OK   ":"FALHA ")+"agente: "+Ag.length+" chamadas com contexto, instrução, lista de ações e ferramentas liberadas");
const comSessao=Ag.filter(x=>x.resume==="fake-ag-1").length;
console.log((comSessao>=6?"OK   ":"FALHA ")+"agente: retoma a mesma conversa ("+comSessao+" de "+Ag.length+" chamadas com a sessão anterior)");
if(ruim.length||Pl.length<5||ruimA.length||Ag.length<8||comSessao<6) process.exit(1);' "$E/stub.log" | tee -a "$E/report.txt"
echo "prints em $E/shots · relatório em $E/report.txt"
grep -q '^FALHA\|^ERRO\|TEMPO ESGOTADO\|APP SAIU' "$E/report.txt" && exit 1 || exit 0
