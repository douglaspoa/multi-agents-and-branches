#!/bin/bash
# e2e do APP de verdade (build de TESTE isolada): identificador e HOME próprios, IA FALSA (nunca o `claude` real —
# com HOME falso ele abriria o popup do Keychain), janela sem foco e fotografada SÓ ela (screencapture -l).
#   scripts/e2e-app/e2e.sh            → compila (cargo --features e2e), monta o ambiente em $E2E_DIR e roda A/B/C/D/R
#   SHELL=/bin/bash scripts/e2e-app/e2e.sh   → o mesmo com bash (teste de fumaça da troca de papel)
# A: tarefa do CLI → ▶ → PTY vivo e digitável · B: "Iniciar épico" (3 tarefas) → 3 PTYs digitáveis, onda 2 armada
# D: onda 2 começa sozinha no PTY · C: turno de FUNDO de verdade (motor headless) → 1ª tecla assume na MESMA sessão
# R: revisor no mesmo terminal (Ajustes › revisor automático ligado no HOME de teste)
set -euo pipefail
W="$(cd "$(dirname "$0")/../.." && pwd)"; H="$W/scripts/e2e-app"
E="${E2E_DIR:-/tmp/sfe2e}"; NODE="$(command -v node)"
rm -rf "$E"; mkdir -p "$E/engine" "$E/mcp" "$E/shots" "$E/home/.constellation" "$E/home/.claude"
( cd "$W" && npx -y esbuild src/cli.ts --bundle --platform=node --format=esm --outfile="$E/engine/cli.mjs" --log-level=error \
  && npx -y esbuild src/mcp/server.ts --bundle --platform=node --format=esm --outfile="$E/mcp/server.mjs" --log-level=error )
swiftc -O "$H/winid.swift" -o "$E/winid"
export TAURI_CONFIG='{"identifier":"dev.starfork.teste-sempre-vivo","productName":"StarforkTeste","app":{"windows":[{"label":"main","title":"Starfork TESTE","width":1280,"height":820,"minWidth":920,"minHeight":600,"titleBarStyle":"Overlay","backgroundThrottling":"disabled","dragDropEnabled":false,"focus":false}]}}'
( cd "$W/app/src-tauri" && CARGO_TARGET_DIR="${E2E_TARGET:-$W/app/src-tauri/target-e2e}" cargo build --release --features e2e )
APP="${E2E_TARGET:-$W/app/src-tauri/target-e2e}/release/cardume-app"
# ---- ambiente: HOME próprio, repo descartável, tarefas criadas pelo CLI (sem termMode — o caso do bug)
printf '[user]\n\tname = Teste\n\temail = teste@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n' > "$E/home/.gitconfig"
echo '{"termRevisorAuto":"1","costCap":50}' > "$E/home/.constellation/settings.json"; echo '{}' > "$E/home/.claude.json"
printf 'sleep 1\nautoload -Uz add-zsh-hook; __lento(){ sleep 0.3 }; add-zsh-hook precmd __lento\nsetopt PROMPT_SUBST; PROMPT="teste@maquina %%1~ %%# "; RPROMPT="[%%D{%%H:%%M:%%S}]"\n' > "$E/home/.zshrc"
printf 'sleep 1\nPROMPT_COMMAND="sleep 0.3"\nPS1="teste@maquina \\W \\$ "\n' > "$E/home/.bash_profile"
cp "$H/fake-claude.mjs" "$E/fake-claude.mjs"; chmod +x "$E/fake-claude.mjs"
export HOME="$E/home" CARDUME_CLAUDE="$E/fake-claude.mjs" CARDUME_NOTIFY=0 STUB_LOG="$E/stub.log" STUB_REVIEW_MS=7000 STUB_SLOW_FILE="$E/slow"
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT ANTHROPIC_API_KEY
git init -q "$E/repo"; ( cd "$E/repo" && echo "# repo de teste" > README.md && git add -A && git commit -qm base )
C() { "$NODE" --disable-warning=ExperimentalWarning "$E/engine/cli.mjs" "$@" --repo "$E/repo" >/dev/null; }
T=(--roles builder --agents Vega --engine claude --approve auto --no-tests --auto-pr no --no-start)
C new --id cli-a --title "Tarefa A criada pelo CLI" "${T[@]}"
for i in 1 2 3; do C new --id onda1-t$i --title "Épico · onda 1 · tarefa $i" "${T[@]}" --epic-id epico-teste --wave 1; done
C new --id onda2-t4 --title "Épico · onda 2 · tarefa 4" "${T[@]}" --epic-id epico-teste --wave 2
C new --id fundo-c --title "Tarefa C rodando de fundo (legado)" "${T[@]}"
C new --id revisor-r --title "Tarefa R com revisor" --roles builder,reviewer --agents Vega,Iris --engine claude --approve auto --no-tests --auto-pr no --no-start
# ---- C: um turno de FUNDO de verdade (motor headless com setsid, como o app faz) num turno longo da IA falsa
touch "$E/slow"
perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV' "$NODE" --disable-warning=ExperimentalWarning "$E/engine/cli.mjs" start fundo-c --repo "$E/repo" > "$E/fundo-c.log" 2>&1 &
sleep 4
: > "$E/report.txt"
CARDUME_REPO="$E/repo" CARDUME_CLI="$E/engine/cli.mjs" CARDUME_NODE="$NODE" STARFORK_E2E_SCRIPT="$H/driver.js" STARFORK_E2E_REPORT="$E/report.txt" "$APP" > "$E/app.log" 2>&1 &
APID=$!; seen=0; t0=$(date +%s)
while :; do
  n=$(wc -l < "$E/report.txt")
  if [ "$n" -gt "$seen" ]; then
    sed -n "$((seen+1)),${n}p" "$E/report.txt" | while IFS= read -r l; do
      echo "$l"
      case "$l" in
        "SHOT "*) w=$("$E/winid" $APID); [ -n "$w" ] && screencapture -x -o -l "$w" "$E/shots/${l#SHOT }.png";;
        "SQL "*) sqlite3 "$E/repo/.cardume/state.sqlite" "${l#SQL }";;
      esac
    done
    seen=$n
  fi
  grep -q '^FIM' "$E/report.txt" && break
  [ $(( $(date +%s) - t0 )) -gt "${E2E_MAX:-600}" ] && { echo "TEMPO ESGOTADO"; break; }
  kill -0 $APID 2>/dev/null || { echo "APP SAIU"; break; }
  sleep 0.5
done
kill $APID 2>/dev/null; sleep 2; kill -9 $APID 2>/dev/null || true
pkill -f "$E/engine/cli.mjs" 2>/dev/null || true; pkill -f "$E/fake-claude.mjs" 2>/dev/null || true; pkill -9 -f "$E/repo/.cardume" 2>/dev/null || true  # shell interativo ignora SIGTERM
echo "prints em $E/shots · relatório em $E/report.txt"
grep -q '^FALHA\|^ERRO' "$E/report.txt" && exit 1 || exit 0
