/** Flags da linha de comando do `cardume` (o app monta os argumentos — ver lib.rs). */
export interface Args {
  _: string[];
  flags: Record<string, string>;
  multi: Record<string, string[]>;
}

/**
 * Flags de TEXTO LIVRE: o valor é o próximo argumento SEMPRE, mesmo que comece com "--" ou seja vazio.
 * Antes, uma mensagem no chat começando com "--" (ex.: "--force não, use rebase") virava a flag "true"
 * e o agente recebia a mensagem "true"; um requisito "--dry-run deve funcionar" sumia da tarefa.
 */
const TEXT_FLAGS = new Set([
  "msg", "title", "objective", "requirement", "requirements", "deliverable", "verify", "boundary", "done-when", "cover", "after",
]);

export function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      const val = TEXT_FLAGS.has(key)
        ? (next !== undefined ? argv[++i] : "true")
        : (next && !next.startsWith("--") ? argv[++i] : "true");
      a.flags[key] = val;
      (a.multi[key] ??= []).push(val);
    } else {
      a._.push(t);
    }
  }
  return a;
}
