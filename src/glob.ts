// Glob mínimo do Cardume — base da detecção proativa de sobreposição de escopo.
//
// Os `scope.owns` de uma tarefa são padrões como "src/auth/**", "src/*.ts" ou
// um caminho concreto "src/cli.ts". O barramento hoje casa caminho EXATO
// (store.claimsForPath); aqui adicionamos casamento por glob e, principalmente,
// a pergunta que o overlap precisa responder: "dois padrões podem tocar o mesmo
// arquivo?". Zero-dependência, no espírito do resto do núcleo.

/** Normaliza um caminho/padrão: tira "./" inicial e barras duplicadas/finais. */
export function normPath(p: string): string {
  return p
    .trim()
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/g, "");
}

function hasWildcard(glob: string): boolean {
  return /[*?]/.test(glob);
}

/** Trecho literal antes do primeiro curinga (ex.: "src/auth/**" → "src/auth/"). */
function staticPrefix(glob: string): string {
  const i = glob.search(/[*?]/);
  return i === -1 ? glob : glob.slice(0, i);
}

/** Compila um glob em RegExp ancorada. Suporta `**` (cruza `/`), `*` e `?`. */
export function globToRegExp(glob: string): RegExp {
  const g = normPath(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        re += ".*"; // ** cruza diretórios
        i++;
        if (g[i + 1] === "/") i++; // "**/" também casa zero diretórios
      } else {
        re += "[^/]*"; // * não cruza "/"
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

/** O caminho `path` casa com o padrão `pattern`? Um padrão sem curinga também
 * cobre tudo abaixo dele (owns "src/auth" cobre "src/auth/login.ts"). */
export function globMatch(pattern: string, path: string): boolean {
  const pat = normPath(pattern);
  const p = normPath(path);
  if (!pat || !p) return false;
  if (!hasWildcard(pat)) {
    return p === pat || p.startsWith(pat + "/");
  }
  return globToRegExp(pat).test(p);
}

/** Dois padrões de escopo podem colidir no mesmo arquivo? (heurística feita para
 * AVISAR, não bloquear: prefere falso-positivo a deixar passar um conflito.) */
export function globsOverlap(a: string, b: string): boolean {
  const pa = normPath(a);
  const pb = normPath(b);
  if (!pa || !pb) return false;
  // Um padrão casa o outro tratado como caminho concreto (cobre concreto×glob).
  if (globMatch(pa, pb) || globMatch(pb, pa)) return true;
  // Ambos com curinga: comparam-se os prefixos literais em fronteira de caminho.
  const sa = staticPrefix(pa).replace(/\/+$/g, "");
  const sb = staticPrefix(pb).replace(/\/+$/g, "");
  if (!sa || !sb) return true; // um deles começa com curinga (ex.: "**") → cobre tudo
  return sa === sb || sa.startsWith(sb + "/") || sb.startsWith(sa + "/");
}
