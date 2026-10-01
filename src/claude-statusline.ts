// Barra de status do Claude Code → % REAL do plano do Claude no medidor (spec-medidor-v2-statusline).
// FONTE ÚNICA da instalação/remoção: `cardume claude-statusline install|uninstall|status` (o app chama via Rust;
// nós usamos o mesmo CLI pra instalar na máquina do Douglas). Fonte documentada: o JSON que o Claude Code manda no
// stdin da barra de status (`rate_limits.five_hour|seven_day.used_percentage` + `resets_at` em epoch s).
// Nunca chama /api/oauth/usage nem lê o Keychain.
//
// Arquivos:
//   ~/.claude/settings.json                     ← só a chave `statusLine` muda (resto preservado, escrita atômica)
//   ~/.claude/settings.json.starfork-bak        ← cópia exata de antes da instalação
//   ~/.constellation/usage/claude-statusline.mjs   ← o script da barra (gerado aqui; sem dependências)
//   ~/.constellation/usage/claude-statusline.json  ← o que o medidor lê: {v, fiveHour:{pct,resetsAt}, sevenDay, at}
//   ~/.constellation/usage/statusline-prev.json    ← a barra que a pessoa já tinha (encadeada e restaurada)
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SlPaths {
  settings: string;
  backup: string;
  dir: string;
  script: string;
  data: string;
  prev: string;
}

export function slPaths(home: string = homedir()): SlPaths {
  const claude = join(home, ".claude");
  const dir = join(home, ".constellation", "usage");
  return {
    settings: join(claude, "settings.json"),
    backup: join(claude, "settings.json.starfork-bak"),
    dir,
    script: join(dir, "claude-statusline.mjs"),
    data: join(dir, "claude-statusline.json"),
    prev: join(dir, "statusline-prev.json"),
  };
}

/** Marca do comando do Starfork (o Rust usa a MESMA regra: plan_usage::statusline_installed_in). */
export const SL_MARK = "claude-statusline.mjs";
type StatusLine = { type?: string; command?: unknown; padding?: unknown; [k: string]: unknown };
export const isOurs = (sl: unknown): boolean =>
  !!sl && typeof sl === "object" && typeof (sl as StatusLine).command === "string" && ((sl as StatusLine).command as string).includes(SL_MARK);

const q = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
export const slCommand = (node: string, script: string) => `${q(node)} ${q(script)}`;

/** O script da barra. Rápido, sem dependências, NUNCA quebra a barra do Claude (try/catch total → linha mínima). */
export function statuslineScript(): string {
  return `// Starfork — barra de status do Claude Code (gerada por \`cardume claude-statusline install\`; não edite).
// Lê o JSON do stdin, grava a % das janelas em claude-statusline.json (atômico) e imprime uma linha curta —
// ou, se você já tinha uma barra de status, roda ela com o mesmo stdin e imprime a saída dela.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const DIR = dirname(fileURLToPath(import.meta.url));
function win(w) {
  if (!w || typeof w !== "object" || w.used_percentage == null) return null;
  const p = Number(w.used_percentage);
  if (!isFinite(p)) return null;
  const r = Number(w.resets_at);
  return { pct: Math.max(0, Math.min(100, p)), resetsAt: isFinite(r) && r > 0 ? Math.round(r < 1e12 ? r * 1000 : r) : null };
}
function main() {
  let input = "", j = null, line = "Claude";
  try { input = readFileSync(0, "utf8"); } catch {}
  try { j = JSON.parse(input); } catch {}
  try {
    if (j && j.model && j.model.display_name) line = String(j.model.display_name);
    const rl = j && j.rate_limits;
    const f = rl ? win(rl.five_hour) : null, s = rl ? win(rl.seven_day) : null;
    if (f || s) {
      const file = join(DIR, "claude-statusline.json"), tmp = file + "." + process.pid + ".tmp";
      try { writeFileSync(tmp, JSON.stringify({ v: 1, fiveHour: f, sevenDay: s, at: Date.now() })); renameSync(tmp, file); }
      catch { try { unlinkSync(tmp); } catch {} }
      line = [f && "5h " + Math.round(f.pct) + "%", s && "semana " + Math.round(s.pct) + "%"].filter(Boolean).join(" · ");
    }
  } catch {}
  try {
    const prev = JSON.parse(readFileSync(join(DIR, "statusline-prev.json"), "utf8"));
    const cmd = prev && prev.statusLine && prev.statusLine.command;
    if (typeof cmd === "string" && cmd.trim()) {
      const r = spawnSync(cmd, { shell: true, input, encoding: "utf8", timeout: 10000 });
      if (r.stdout) { process.stdout.write(r.stdout); return; }
    }
  } catch {}
  process.stdout.write(line + "\\n");
}
try { main(); } catch { try { process.stdout.write("Claude\\n"); } catch {} }
`;
}

export interface SlResult {
  ok: boolean;
  message: string;
  installed: boolean;
  chained: boolean;
  changed: boolean;
}

type Obj = Record<string, unknown>;
interface Settings { exists: boolean; text: string; obj: Obj }

function readSettings(p: SlPaths): Settings | string {
  if (!existsSync(p.settings)) return { exists: false, text: "", obj: {} };
  let text: string;
  try { text = readFileSync(p.settings, "utf8"); } catch (e) { return `não consegui ler ${p.settings}: ${(e as Error).message}`; }
  if (!text.trim()) return { exists: true, text, obj: {} };
  let v: unknown;
  try { v = JSON.parse(text); } catch { return `${p.settings} não é um JSON válido — não mexi em nada. Corrija o arquivo e tente de novo.`; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return `${p.settings} não é um objeto JSON — não mexi em nada.`;
  return { exists: true, text, obj: v as Obj };
}

/** Escrita atômica (tmp na mesma pasta + rename); segue symlink (dotfiles) e mantém a permissão do original. */
function writeAtomic(file: string, body: string) {
  let target = file;
  try { target = realpathSync(file); } catch { /* ainda não existe */ }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, body);
    try { chmodSync(tmp, statSync(target).mode & 0o777); } catch { /* arquivo novo */ }
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function serialize(obj: Obj, like: string): string {
  const m = /^([ \t]+)"/m.exec(like);
  const indent = m ? m[1] : 2;
  return JSON.stringify(obj, null, indent) + (like && !like.endsWith("\n") ? "" : "\n");
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Obj), kb = Object.keys(b as Obj);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Obj)[k], (b as Obj)[k]));
}

interface Prev { v: 1; existed: boolean; statusLine: StatusLine | null }
function readPrev(p: SlPaths): Prev | null {
  try {
    const v = JSON.parse(readFileSync(p.prev, "utf8")) as Prev;
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}
const chainedOf = (prev: Prev | null) => !!prev?.statusLine && typeof prev.statusLine.command === "string" && !!prev.statusLine.command.trim();

export function install(opts: { home?: string; node?: string } = {}): SlResult {
  const p = slPaths(opts.home);
  const node = opts.node?.trim() || process.execPath;
  const s = readSettings(p);
  if (typeof s === "string") return { ok: false, message: s, installed: false, chained: false, changed: false };
  mkdirSync(p.dir, { recursive: true });
  writeAtomic(p.script, statuslineScript());
  const cmd = slCommand(node, p.script);
  const cur = s.obj.statusLine as StatusLine | undefined;
  if (isOurs(cur)) {
    // idempotente: só atualiza o caminho do node; anterior e backup ficam como estavam
    const chained = chainedOf(readPrev(p));
    if (cur!.command === cmd) return { ok: true, message: "a barra do Starfork já estava instalada", installed: true, chained, changed: false };
    writeAtomic(p.settings, serialize({ ...s.obj, statusLine: { ...cur, command: cmd } }, s.text));
    return { ok: true, message: "barra do Starfork atualizada (node novo)", installed: true, chained, changed: true };
  }
  if (s.exists) writeAtomic(p.backup, s.text);
  else rmSync(p.backup, { force: true }); // backup velho de outra instalação não vale pra esta
  const prev: Prev = { v: 1, existed: s.exists, statusLine: cur && typeof cur === "object" ? cur : null };
  writeAtomic(p.prev, JSON.stringify(prev, null, 2) + "\n");
  const ours: StatusLine = { type: "command", command: cmd };
  if (prev.statusLine && prev.statusLine.padding !== undefined) ours.padding = prev.statusLine.padding;
  writeAtomic(p.settings, serialize({ ...s.obj, statusLine: ours }, s.text));
  const chained = chainedOf(prev);
  return {
    ok: true,
    message: chained ? "barra do Starfork instalada — a sua barra de status continua aparecendo" : "barra do Starfork instalada",
    installed: true, chained, changed: true,
  };
}

export function uninstall(opts: { home?: string } = {}): SlResult {
  const p = slPaths(opts.home);
  const s = readSettings(p);
  if (typeof s === "string") return { ok: false, message: s, installed: false, chained: false, changed: false };
  const prev = readPrev(p);
  const cleanup = () => { for (const f of [p.prev, p.data, p.script]) rmSync(f, { force: true }); };
  if (!isOurs(s.obj.statusLine)) {
    cleanup();
    return { ok: true, message: "a barra do Starfork não estava instalada", installed: false, chained: false, changed: false };
  }
  const next: Obj = { ...s.obj };
  if (prev?.statusLine) next.statusLine = prev.statusLine;
  else delete next.statusLine;
  if (prev && prev.existed === false && Object.keys(next).length === 0) {
    rmSync(p.settings, { force: true });
  } else {
    // nada mais mudou desde a instalação → volta o arquivo EXATO de antes (mesma formatação, byte a byte)
    let bak: string | null = null;
    try { bak = readFileSync(p.backup, "utf8"); } catch { /* sem backup */ }
    let same = false;
    if (bak !== null) { try { same = deepEqual(bak.trim() ? JSON.parse(bak) : {}, next); } catch { same = false; } }
    writeAtomic(p.settings, same && bak !== null ? bak : serialize(next, s.text));
  }
  cleanup();
  return {
    ok: true,
    message: prev?.statusLine ? "barra do Starfork removida — a sua barra de status anterior voltou" : "barra do Starfork removida",
    installed: false, chained: false, changed: true,
  };
}

export interface SlStatus {
  ok: boolean;
  message: string;
  installed: boolean;
  chained: boolean;
  data: unknown;
}

export function status(opts: { home?: string } = {}): SlStatus {
  const p = slPaths(opts.home);
  const s = readSettings(p);
  let data: unknown = null;
  try { data = JSON.parse(readFileSync(p.data, "utf8")); } catch { /* ainda sem dados */ }
  if (typeof s === "string") return { ok: false, message: s, installed: false, chained: false, data };
  const installed = isOurs(s.obj.statusLine);
  const chained = installed && chainedOf(readPrev(p));
  return { ok: true, message: installed ? "instalada" : "não instalada", installed, chained, data };
}
