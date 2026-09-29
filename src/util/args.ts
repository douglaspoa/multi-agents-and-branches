/** Flags da linha de comando do `cardume` (o app monta os argumentos — ver lib.rs). */
export interface Args {
  _: string[];
  flags: Record<string, string>;
  multi: Record<string, string[]>;
}

/**
 * Flags de TEXTO/VALOR que o app (lib.rs) sempre manda com valor: o próximo argumento é o valor MESMO que
 * comece com "--" ou seja vazio. Antes, uma mensagem no chat começando com "--" (ex.: "--force não, use
 * rebase") virava a flag "true" e o agente recebia "true"; um requisito "--dry-run deve funcionar" sumia.
 * Exceção: se o próximo é EXATAMENTE outra flag conhecida (ex.: "--repo"), o valor ficou faltando → "".
 */
export const TEXT_FLAGS = new Set([
  "msg", "title", "objective", "requirement", "requirements", "deliverable", "verify", "boundary", "done-when", "cover", "after",
  "ref", "issue", "issue-url", "linked-to", "epic-id", "owns", "off", "id", "agent", "agents", "workflow",
  "model", "models", "base", "pr-base", "branch-type", "auto-pr", "risk", "pr", "kind", "repo", "engine", "approve",
  "plan-approval", "wave", "out", "roles", "clarifications", "bus-policy",
]);

/** Flags SEM valor (booleanas). */
export const BOOL_FLAGS = new Set([
  "json", "no-git", "as-req", "no-start", "light", "hitl", "artifact-proof", "artifact-tests", "no-tests", "no-overlap-check",
]);

const isKnownFlag = (tok: string) => tok.startsWith("--") && (TEXT_FLAGS.has(tok.slice(2)) || BOOL_FLAGS.has(tok.slice(2)) || tok === "--artifact-doc");

export function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      let val: string;
      if (TEXT_FLAGS.has(key)) {
        // texto: consome o próximo (vazio e "--…" inclusos), menos se ele for OUTRA flag conhecida
        val = next !== undefined && !isKnownFlag(next) ? argv[++i] : "";
      } else {
        // demais (booleanas ou desconhecidas): valor só se não parecer flag; "" conta como valor
        val = next !== undefined && !next.startsWith("--") ? argv[++i] : "true";
      }
      a.flags[key] = val;
      (a.multi[key] ??= []).push(val);
    } else {
      a._.push(t);
    }
  }
  return a;
}
