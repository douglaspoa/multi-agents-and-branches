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
import { dirname, isAbsolute, join } from "node:path";

export interface SlPaths {
  claudeDir: string;
  settings: string;
  backup: string;
  dir: string;
  script: string;
  data: string;
  prev: string;
}

/** Pasta de config do Claude Code: `CLAUDE_CONFIG_DIR` (como o próprio Claude Code), senão `~/.claude`. Com `home`
 *  explícito (testes) o ambiente NÃO é lido — um teste nunca toca a config real. Mesma regra do Rust
 *  (plan_usage::claude_config_dir). */
export function claudeConfigDir(home?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (home) return join(home, ".claude");
  const d = env.CLAUDE_CONFIG_DIR?.trim();
  return d ? d : join(homedir(), ".claude");
}

export function slPaths(home?: string, claudeDir?: string): SlPaths {
  const claude = claudeDir || claudeConfigDir(home);
  const dir = join(home || homedir(), ".constellation", "usage");
  return {
    claudeDir: claude,
    settings: join(claude, "settings.json"),
    backup: join(claude, "settings.json.starfork-bak"),
    dir,
    script: join(dir, "claude-statusline.mjs"),
    data: join(dir, "claude-statusline.json"),
    prev: join(dir, "statusline-prev.json"),
  };
}

/** Marca do comando do Starfork (o Rust usa a MESMA regra: plan_usage::statusline_installed_in; golden
 *  tests/fixtures/plan-usage-golden/statusline.json). */
export const SL_MARK = "claude-statusline.mjs";
type StatusLine = { type?: string; command?: unknown; padding?: unknown; [k: string]: unknown };
export const isOurs = (sl: unknown): boolean =>
  !!sl && typeof sl === "object" && typeof (sl as StatusLine).command === "string" && ((sl as StatusLine).command as string).includes(SL_MARK);

const q = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
export const slCommand = (node: string, script: string) => `${q(node)} ${q(script)}`;
/** 1º argumento do comando (o node): entre aspas (com \\x → x) ou até o 1º espaço. Mesma regra do Rust
 *  (plan_usage::statusline_node_in). */
export function nodeOfCommand(cmd: string): string | null {
  const t = cmd.trimStart();
  if (!t) return null;
  if (t[0] !== '"') return t.split(/\s/)[0] || null;
  let out = "";
  for (let i = 1; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && i + 1 < t.length) { out += t[++i]; continue; }
    if (ch === '"') return out;
    out += ch;
  }
  return null;
}

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
      // como o Claude Code: no Windows a barra roda pelo bash (Git Bash); sem bash, cai na linha do Starfork
      const r = process.platform === "win32"
        ? spawnSync("bash", ["-c", cmd], { input, encoding: "utf8", timeout: 2000, windowsHide: true })
        : spawnSync(cmd, { shell: true, input, encoding: "utf8", timeout: 2000 });
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

function readSettingsFile(file: string): Settings | string {
  if (!existsSync(file)) return { exists: false, text: "", obj: {} };
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) { return `não consegui ler ${file}: ${(e as Error).message}`; }
  if (!text.trim()) return { exists: true, text, obj: {} };
  let v: unknown;
  try { v = JSON.parse(text); } catch { return `${file} não é um JSON válido — não mexi em nada. Corrija o arquivo e tente de novo.`; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return `${file} não é um objeto JSON — não mexi em nada.`;
  return { exists: true, text, obj: v as Obj };
}
const readSettings = (p: SlPaths) => readSettingsFile(p.settings);

class SlError extends Error {}
const changedMsg = (p: SlPaths) => `${p.settings} mudou enquanto eu mexia (outro programa salvou?) — não mexi em nada. Tente de novo.`;
/** O settings.json ainda é o que foi lido? (null = não existia) */
function stillSame(p: SlPaths, s: Settings): boolean {
  let cur: string | null = null;
  try { cur = existsSync(p.settings) ? readFileSync(p.settings, "utf8") : null; } catch { return false; }
  return cur === (s.exists ? s.text : null);
}

/** Escrita atômica (tmp na mesma pasta + rename); segue symlink (dotfiles) e mantém a permissão do original.
 *  `guard` roda logo antes do rename: false → aborta sem tocar no arquivo. */
function writeAtomic(file: string, body: string, guard?: () => boolean, guardMsg?: string) {
  let target = file;
  try { target = realpathSync(file); } catch { /* ainda não existe */ }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, body);
    try { chmodSync(tmp, statSync(target).mode & 0o777); } catch { /* arquivo novo */ }
    if (guard && !guard()) throw new SlError(guardMsg || "arquivo mudou");
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
/** Gancho SÓ de teste: roda logo antes de conferir se o settings.json mudou (simula outro programa salvando). */
export const slTestHooks: { beforeCommit?: () => void } = {};
const guardSame = (p: SlPaths, s: Settings) => () => { slTestHooks.beforeCommit?.(); return stillSame(p, s); };
const writeSettings = (p: SlPaths, s: Settings, body: string) => writeAtomic(p.settings, body, guardSame(p, s), changedMsg(p));

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

/** A barra de antes: `had` = a chave existia; `statusLine` = o valor EXATO (objeto, texto, null…). */
interface Prev { v: 1; existed: boolean; had: boolean; statusLine: unknown }
function readPrev(p: SlPaths): Prev | null {
  try {
    const v = JSON.parse(readFileSync(p.prev, "utf8")) as Partial<Prev>;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    // formato antigo (sem `had`): a chave existia se havia valor
    return { v: 1, existed: v.existed !== false, had: typeof v.had === "boolean" ? v.had : v.statusLine != null, statusLine: v.statusLine ?? null };
  } catch { return null; }
}
/** Sem statusline-prev.json (apagado/corrompido): a barra de antes vem do backup, se ele tiver. */
function prevOrBackup(p: SlPaths): Prev | null {
  const prev = readPrev(p);
  if (prev) return prev;
  const b = readSettingsFile(p.backup);
  if (typeof b === "string" || !b.exists) return null;
  const had = Object.prototype.hasOwnProperty.call(b.obj, "statusLine");
  return { v: 1, existed: true, had, statusLine: had ? b.obj.statusLine : null };
}
const chainedOf = (prev: Prev | null) => {
  const sl = prev?.statusLine as StatusLine | null | undefined;
  return !!sl && typeof sl === "object" && typeof sl.command === "string" && !!sl.command.trim();
};
const fail = (message: string): SlResult => ({ ok: false, message, installed: false, chained: false, changed: false });
const errMsg = (e: unknown) => (e instanceof SlError ? e.message : "não consegui mexer na barra de status: " + ((e as Error)?.message ?? String(e)));

export function install(opts: { home?: string; claudeDir?: string; node?: string } = {}): SlResult {
  const p = slPaths(opts.home, opts.claudeDir);
  const node = opts.node?.trim() || process.execPath;
  if (!isAbsolute(node) || !existsSync(node)) return fail(`node não encontrado: ${node}`);
  const s = readSettings(p);
  if (typeof s === "string") return fail(s);
  try {
    mkdirSync(p.dir, { recursive: true });
    writeAtomic(p.script, statuslineScript());
    const cmd = slCommand(node, p.script);
    const cur = s.obj.statusLine as StatusLine | undefined;
    if (isOurs(cur)) {
      // idempotente: só atualiza o caminho do node; anterior e backup ficam como estavam
      const chained = chainedOf(prevOrBackup(p));
      if (cur!.command === cmd) return { ok: true, message: "a barra do Starfork já estava instalada", installed: true, chained, changed: false };
      writeSettings(p, s, serialize({ ...s.obj, statusLine: { ...cur, command: cmd } }, s.text));
      return { ok: true, message: "barra do Starfork atualizada (node novo)", installed: true, chained, changed: true };
    }
    if (s.exists) writeAtomic(p.backup, s.text);
    else rmSync(p.backup, { force: true }); // backup velho de outra instalação não vale pra esta
    const had = Object.prototype.hasOwnProperty.call(s.obj, "statusLine");
    const prev: Prev = { v: 1, existed: s.exists, had, statusLine: had ? s.obj.statusLine : null };
    writeAtomic(p.prev, JSON.stringify(prev, null, 2) + "\n");
    const ours: StatusLine = { type: "command", command: cmd };
    if (cur && typeof cur === "object" && cur.padding !== undefined) ours.padding = cur.padding;
    writeSettings(p, s, serialize({ ...s.obj, statusLine: ours }, s.text));
    const chained = chainedOf(prev);
    return {
      ok: true,
      message: chained ? "barra do Starfork instalada — a sua barra de status continua aparecendo" : "barra do Starfork instalada",
      installed: true, chained, changed: true,
    };
  } catch (e) {
    return fail(errMsg(e));
  }
}

export function uninstall(opts: { home?: string; claudeDir?: string } = {}): SlResult {
  const p = slPaths(opts.home, opts.claudeDir);
  const s = readSettings(p);
  if (typeof s === "string") return fail(s);
  const cleanup = (all: boolean) => { for (const f of [p.prev, p.data, p.script, ...(all ? [p.backup] : [])]) rmSync(f, { force: true }); };
  if (!isOurs(s.obj.statusLine)) {
    cleanup(false);
    return { ok: true, message: "a barra do Starfork não estava instalada", installed: false, chained: false, changed: false };
  }
  try {
    const prev = prevOrBackup(p);
    const next: Obj = { ...s.obj };
    if (prev?.had) next.statusLine = prev.statusLine;
    else delete next.statusLine;
    if (prev && prev.existed === false && Object.keys(next).length === 0) {
      if (!guardSame(p, s)()) throw new SlError(changedMsg(p));
      rmSync(p.settings, { force: true });
    } else {
      // nada mais mudou desde a instalação → volta o arquivo EXATO de antes (mesma formatação, byte a byte)
      let bak: string | null = null;
      try { bak = readFileSync(p.backup, "utf8"); } catch { /* sem backup */ }
      let same = false;
      if (bak !== null) { try { same = deepEqual(bak.trim() ? JSON.parse(bak) : {}, next); } catch { same = false; } }
      writeSettings(p, s, same && bak !== null ? bak : serialize(next, s.text));
    }
    cleanup(true);
    return {
      ok: true,
      message: chainedOf(prev) ? "barra do Starfork removida — a sua barra de status anterior voltou" : "barra do Starfork removida",
      installed: false, chained: false, changed: true,
    };
  } catch (e) {
    return fail(errMsg(e));
  }
}

export interface SlStatus {
  ok: boolean;
  message: string;
  installed: boolean;
  chained: boolean;
  /** o node gravado no comando da barra existe (false → precisa reparar: instalar de novo) */
  nodeOk: boolean;
  node: string | null;
  /** settings do projeto aberto que definem a própria statusLine (ela substitui a do Starfork nesse projeto) */
  overriddenBy: string[];
  data: unknown;
}

/** `.claude/settings.json` / `.claude/settings.local.json` do repo que definem `statusLine` (precedência maior). */
export function projectOverrides(repo?: string): string[] {
  if (!repo) return [];
  return ["settings.json", "settings.local.json"].map((f) => join(repo, ".claude", f)).filter((f) => {
    const s = readSettingsFile(f);
    return typeof s !== "string" && s.exists && Object.prototype.hasOwnProperty.call(s.obj, "statusLine");
  });
}

export function status(opts: { home?: string; claudeDir?: string; repo?: string } = {}): SlStatus {
  const p = slPaths(opts.home, opts.claudeDir);
  const s = readSettings(p);
  let data: unknown = null;
  try { data = JSON.parse(readFileSync(p.data, "utf8")); } catch { /* ainda sem dados */ }
  const overriddenBy = projectOverrides(opts.repo);
  if (typeof s === "string") return { ok: false, message: s, installed: false, chained: false, nodeOk: false, node: null, overriddenBy, data };
  const installed = isOurs(s.obj.statusLine);
  const node = installed ? nodeOfCommand(String((s.obj.statusLine as StatusLine).command)) : null;
  const nodeOk = !!node && isAbsolute(node) && existsSync(node);
  const chained = installed && chainedOf(prevOrBackup(p));
  return { ok: true, message: installed ? (nodeOk ? "instalada" : "instalada, mas o node sumiu — precisa reparar") : "não instalada", installed, chained, nodeOk, node, overriddenBy, data };
}
