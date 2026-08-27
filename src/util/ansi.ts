// Cores ANSI ecoando a pele "Terminal" do Cardume (verde de fósforo).
const wrap = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;

export const c = {
  green: wrap("32"),
  greenB: wrap("92"),
  yellow: wrap("33"),
  cyan: wrap("36"),
  red: wrap("31"),
  magenta: wrap("35"),
  dim: wrap("90"),
  bold: wrap("1"),
  inverse: wrap("7"),
  white: wrap("37"),
};

/** Bloco invertido estilo tmux/seleção. */
export function block(s: string): string {
  return `\x1b[42m\x1b[30m ${s} \x1b[0m`;
}

/** Cor por status de agente. */
export function statusColor(status: string): (s: string) => string {
  switch (status) {
    case "running":
    case "done":
      return c.green;
    case "thinking":
      return c.cyan;
    case "review":
      return c.yellow;
    case "conflict":
    case "error":
      return c.red;
    default:
      return c.dim;
  }
}

/** Símbolo por tipo de evento. */
export function eventGlyph(type: string): string {
  const map: Record<string, string> = {
    status: "◆",
    think: "…",
    read: "‹",
    edit: "±",
    write: "+",
    bash: "$",
    note: "»",
    claim: "⊞",
    collision: "⚠",
    error: "✖",
    done: "✔",
  };
  return map[type] ?? "·";
}
