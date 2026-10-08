# Marcas de build do Starfork — `source scripts/build-mark.sh` (deploy-local.sh e package-app.sh).
#
# • write_dev_mark APP ROOT  → APP/Contents/Resources/dev-source.json: "este .app é a instalação de
#   DESENVOLVIMENTO do dono, compilada do fonte ROOT no commit X". O app usa isso pra liberar
#   "Publicar release pro time" e esconder o auto-update (sem depender da env CARDUME_CLI, que o
#   app aberto pelo Finder não recebe). Grave ANTES do codesign: Resources é selado pela assinatura.
# • strip_dev_mark APP       → remove a marca. O portable (colegas) NUNCA pode carregá-la.
# • write_portable_meta ROOT ZIP OUT → OUT (dist/Starfork-portable.json): commit/branch/sujeira do
#   fonte + tamanho do zip. O app só publica se esse commit é o do build instalado e está na main.

# imprime JSON com os campos de git do ROOT + extras (pares chave valor) — node já é requisito do build
_build_mark_json() {
  local root="$1"; shift
  local commit branch dirty=false
  commit=$(git -C "$root" rev-parse HEAD)
  branch=$(git -C "$root" rev-parse --abbrev-ref HEAD)
  # só arquivos versionados: resources/ e dist/ são ignorados; um .rs novo que entra no build
  # aparece como alteração no mod que o referencia
  if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then dirty=true; fi
  # BUILD_DIRTY=true: o chamador viu sujeira ANTES de compilar (limpar depois não lava o binário)
  if [ "${BUILD_DIRTY:-}" = true ]; then dirty=true; fi
  node -e '
    const [commit, branch, dirty, ...kv] = process.argv.slice(1);
    const o = { commit, branch, dirty: dirty === "true", builtAt: new Date().toISOString() };
    for (let i = 0; i < kv.length; i += 2) o[kv[i]] = /^\d+$/.test(kv[i + 1]) ? Number(kv[i + 1]) : kv[i + 1];
    process.stdout.write(JSON.stringify(o, null, 2) + "\n");
  ' "$commit" "$branch" "$dirty" "$@"
}

write_dev_mark() {
  local app="$1" root
  root=$(cd "$2" && pwd -P)
  mkdir -p "$app/Contents/Resources"
  _build_mark_json "$root" source "$root" > "$app/Contents/Resources/dev-source.json"
}

strip_dev_mark() {
  rm -f "$1/Contents/Resources/dev-source.json"
}

# sujeira do checkout agora ("true"/"false") — capture ANTES do build e passe em BUILD_DIRTY
tree_dirty() {
  if [ -n "$(git -C "$1" status --porcelain --untracked-files=no)" ]; then echo true; else echo false; fi
}

write_portable_meta() {
  local root="$1" zip="$2" out="$3" bytes
  bytes=$(wc -c < "$zip" | tr -d ' ')
  _build_mark_json "$root" zipBytes "$bytes" > "$out"
}
