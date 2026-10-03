import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * RESOLVEDOR ÚNICO de CLIs instaladas pelo usuário (codex, e o node que um shim `#!/usr/bin/env node` precisa).
 * O MESMO algoritmo vive no Rust (app/src-tauri/src/ai_once.rs → `resolve_tool`) e os dois passam pelo fixture
 * compartilhado tests/fixtures/bin-resolve/cases.json — mudou aqui, muda lá.
 *
 * Por quê: aberto pelo Finder/Dock o app herda PATH mínimo (/usr/bin:/bin:/usr/sbin:/sbin) e o motor procurava o
 * codex só "ao lado do node em uso" + homebrew. No Mac do Roberto (02/10) o codex estava no nvm de OUTRA versão de
 * node (o app escolhe o node que carrega node:sqlite, não "o do codex") → `spawn codex ENOENT` com o codex instalado.
 *
 * Ordem (a primeira que existe ganha):
 *  1. variável de ambiente (CARDUME_CODEX) apontando pra um arquivo;
 *  2. o PATH atual (quem abre pelo terminal usa exatamente o codex do terminal);
 *  3. ao lado do node em uso (CARDUME_NODE, depois o node que roda o motor);
 *  4. gerenciadores de node: nvm (versão mais nova primeiro), fnm, volta, asdf, mise;
 *  5. prefixo global do npm (~/.npmrc `prefix=`, ~/.npm-global, ~/.npm-packages);
 *  6. Homebrew (/opt/homebrew/bin, /usr/local/bin), ~/.local/bin, pnpm, bun, ~/bin;
 *  7. o CLI que vem dentro dos apps da OpenAI (ChatGPT.app / Codex.app → Contents/Resources/codex);
 *  8. LENTO, só se nada acima achou: `$SHELL -lic 'command -v codex'` (timeout, cache) e `npm prefix -g`.
 */

export interface ResolveCtx {
  home: string;
  /** PATH atual (string com o separador do sistema) */
  path: string;
  /** pasta do node em uso (process.execPath / CARDUME_NODE) */
  nodeDirs: string[];
  /** prefixo pras pastas ABSOLUTAS do sistema (/opt/homebrew, /Applications) — "" em produção, pasta fake nos testes */
  root: string;
  /** valor da variável de override (CARDUME_CODEX) */
  override?: string;
  shell?: string;
  /** `npm prefix -g` e o shell de login podem rodar? (testes desligam/injetam) */
  slow?: boolean;
  shellTimeoutMs?: number;
}

export interface Resolution {
  /** caminho absoluto achado (null = não achou em lugar nenhum) */
  bin: string | null;
  /** de onde veio (rótulo curto: "PATH", "nvm", "login shell", …) */
  via: string;
  /** os lugares onde procurou, em ordem — vai na mensagem de "não encontrado" */
  searched: string[];
}

const isFile = (p: string): boolean => {
  try { return statSync(p).isFile(); } catch { return false; }
};
const lsDirs = (p: string): string[] => {
  try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); } catch { return []; }
};

/** "v22.3.0" / "22.3.0" / "node-v20" → [22,3,0]; ordena versões de verdade ("v9" < "v22"). */
export function verKey(s: string): number[] {
  const m = String(s).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [-1, 0, 0];
}
export function newestFirst(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const x = verKey(a), y = verKey(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return b.localeCompare(a);
  });
}

/** `prefix=` do ~/.npmrc (npm i -g instala em <prefix>/bin). */
function npmrcPrefix(home: string): string | null {
  try {
    for (const line of readFileSync(join(home, ".npmrc"), "utf8").split("\n")) {
      const m = line.trim().match(/^prefix\s*=\s*(.+)$/);
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, "").replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home);
        if (v) return v;
      }
    }
  } catch { /* sem .npmrc */ }
  return null;
}

/** Pastas a procurar, em ordem, com o rótulo de cada uma (rápidas — só leitura de disco). */
export function candidateDirs(name: string, c: ResolveCtx): { dir: string; label: string }[] {
  const out: { dir: string; label: string }[] = [];
  const add = (dir: string, label: string) => { if (dir && !out.some((o) => o.dir === dir)) out.push({ dir, label }); };
  const sys = (p: string) => (c.root ? join(c.root, p) : p);
  const h = (...p: string[]) => join(c.home, ...p);
  for (const d of c.path.split(delimiter).filter(Boolean)) add(d, "PATH");
  for (const d of c.nodeDirs) add(d, "ao lado do node em uso");
  for (const v of newestFirst(lsDirs(h(".nvm", "versions", "node")))) add(h(".nvm", "versions", "node", v, "bin"), "nvm");
  for (const base of [h(".local", "share", "fnm", "node-versions"), h(".fnm", "node-versions"), h("Library", "Application Support", "fnm", "node-versions")])
    for (const v of newestFirst(lsDirs(base))) add(join(base, v, "installation", "bin"), "fnm");
  add(h(".volta", "bin"), "volta");
  add(h(".asdf", "shims"), "asdf");
  for (const v of newestFirst(lsDirs(h(".asdf", "installs", "nodejs")))) add(h(".asdf", "installs", "nodejs", v, "bin"), "asdf");
  add(h(".local", "share", "mise", "shims"), "mise");
  for (const v of newestFirst(lsDirs(h(".local", "share", "mise", "installs", "node")))) add(h(".local", "share", "mise", "installs", "node", v, "bin"), "mise");
  const pre = npmrcPrefix(c.home);
  if (pre) add(join(pre, "bin"), "npm prefix (~/.npmrc)");
  add(h(".npm-global", "bin"), "npm global");
  add(h(".npm-packages", "bin"), "npm global");
  add(sys("/opt/homebrew/bin"), "Homebrew");
  add(sys("/usr/local/bin"), "Homebrew/usr/local");
  add(h(".local", "bin"), "~/.local/bin");
  add(h("Library", "pnpm"), "pnpm");
  add(h(".local", "share", "pnpm"), "pnpm");
  add(h(".bun", "bin"), "bun");
  add(h("bin"), "~/bin");
  if (name === "codex") {
    for (const apps of [sys("/Applications"), h("Applications")])
      for (const app of ["Codex.app", "ChatGPT.app"]) add(join(apps, app, "Contents", "Resources"), `app ${app.replace(/\.app$/, "")}`);
  }
  return out;
}

/** Rótulo curto de uma pasta pra mensagem (troca o home por ~). */
const tilde = (p: string, home: string) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);

/** Saída do `$SHELL -lic 'command -v X'` → o caminho (ignora lixo do .zshrc, aliases e funções). */
export function parseShellLookup(out: string, isF: (p: string) => boolean = isFile): string | null {
  const lines = String(out ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse();
  for (const l of lines) if (isAbsolute(l) && isF(l)) return l;
  return null;
}

// cache do shell de login: positivo pro processo inteiro, negativo por 60s (o usuário pode instalar agora)
const shellCache = new Map<string, { bin: string | null; at: number }>();
export function clearResolveCache(): void { shellCache.clear(); resCache.clear(); }

/** `$SHELL -lic 'command -v <name>'` com timeout. Só nomes seguros (sem injeção no -c). */
export function shellLookup(name: string, shell: string | undefined, timeoutMs = 4000, home?: string): string | null {
  if (!shell || !/^[A-Za-z0-9._-]+$/.test(name) || !isFile(shell)) return null;
  const key = `${shell}\0${name}`;
  const hit = shellCache.get(key);
  if (hit && (hit.bin || Date.now() - hit.at < 60_000)) return hit.bin;
  let bin: string | null = null;
  try {
    const r = spawnSync(shell, ["-lic", `command -v ${name}`], {
      encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...(home ? { HOME: home } : {}), TERM: "dumb" },
    });
    bin = parseShellLookup(String(r.stdout ?? ""));
  } catch { bin = null; }
  shellCache.set(key, { bin, at: Date.now() });
  return bin;
}

function npmPrefixG(nodeDirs: string[], path: string): string | null {
  for (const d of [...nodeDirs, ...path.split(delimiter)]) {
    const npm = join(d, "npm");
    if (!isFile(npm)) continue;
    try {
      const r = spawnSync(npm, ["prefix", "-g"], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, PATH: [d, path].join(delimiter) } });
      const p = String(r.stdout ?? "").trim().split("\n").pop()?.trim();
      if (p && isAbsolute(p)) return p;
    } catch { /* segue */ }
  }
  return null;
}

/** O algoritmo, PURO sobre o ctx (os testes passam pastas fake). */
export function resolveIn(name: string, c: ResolveCtx): Resolution {
  const searched: string[] = [];
  const exe = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  if (c.override) {
    searched.push(`CARDUME_${name.toUpperCase()}=${c.override}`);
    if (isFile(c.override)) return { bin: c.override, via: "variável de ambiente", searched };
  }
  const cands = candidateDirs(name, c);
  for (const { dir, label } of cands) {
    for (const n of exe) {
      const p = join(dir, n);
      if (isFile(p)) return { bin: p, via: label, searched: [...searched, ...cands.slice(0, cands.findIndex((x) => x.dir === dir)).map((x) => tilde(x.dir, c.home))] };
    }
  }
  searched.push(...cands.map((x) => tilde(x.dir, c.home)));
  if (c.slow !== false) {
    if (c.shell) {
      searched.push(`shell de login (${c.shell} -lic 'command -v ${name}')`);
      const b = shellLookup(name, c.shell, c.shellTimeoutMs ?? 4000, c.home);
      if (b) return { bin: b, via: "login shell", searched };
    }
    const pre = npmPrefixG(c.nodeDirs, c.path);
    searched.push("npm prefix -g" + (pre ? ` (${tilde(pre, c.home)}/bin)` : ""));
    if (pre) for (const n of exe) { const p = join(pre, "bin", n); if (isFile(p)) return { bin: p, via: "npm prefix -g", searched }; }
  }
  return { bin: null, via: "", searched };
}

/** Contexto REAL desta máquina. */
export function liveCtx(name: string): ResolveCtx {
  const nodeDirs: string[] = [];
  const cn = process.env.CARDUME_NODE;
  if (cn && isFile(cn)) nodeDirs.push(dirname(cn));
  if (!nodeDirs.includes(dirname(process.execPath))) nodeDirs.push(dirname(process.execPath));
  return {
    home: homedir(),
    path: process.env.PATH || "",
    nodeDirs,
    root: "",
    override: process.env[`CARDUME_${name.toUpperCase()}`] || undefined,
    shell: process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : process.platform === "win32" ? undefined : "/bin/bash"),
  };
}

const resCache = new Map<string, { r: Resolution; at: number }>();
/** Resolução com cache de 30s (achou) / 10s (não achou). */
export function resolveToolCached(name: string): Resolution {
  const hit = resCache.get(name);
  if (hit && Date.now() - hit.at < (hit.r.bin ? 30_000 : 10_000) && (!hit.r.bin || isFile(hit.r.bin))) return hit.r;
  const r = resolveIn(name, liveCtx(name));
  resCache.set(name, { r, at: Date.now() });
  return r;
}

/** O binário é um script `#!/usr/bin/env node` (precisa de um node no PATH)? */
export function needsNode(bin: string): boolean {
  try {
    const head = readFileSync(bin, { encoding: "latin1" }).slice(0, 200);
    return head.startsWith("#!") && /\bnode\b/.test(head.split("\n")[0]);
  } catch { return false; }
}

/**
 * PATH pro processo do binário: a pasta dele, a de um node (o que está ao lado dele → o node em uso →
 * o node resolvido pelo mesmo algoritmo) NA FRENTE do PATH herdado. Sem isso o shim do npm morre com
 * "env: node: No such file or directory" (exit 127) quando o app foi aberto pelo Finder.
 */
export function toolPath(bin: string, cur: string | undefined, nodeDirs: string[] = [dirname(process.execPath)]): string {
  const dirs: string[] = [];
  if (bin.includes("/") || bin.includes("\\")) dirs.push(dirname(bin));
  for (const d of nodeDirs) if (!dirs.includes(d)) dirs.push(d);
  const have = (cur || "").split(delimiter).filter(Boolean);
  const hasNode = [...dirs, ...have].some((d) => isFile(join(d, process.platform === "win32" ? "node.exe" : "node")));
  if (!hasNode) {
    const n = resolveToolCached("node").bin;
    if (n) dirs.push(dirname(n));
  }
  return [...dirs.filter((d) => !have.includes(d)), ...have].join(delimiter);
}

/** Codex: caminho absoluto quando achou; "codex" solto quando não (o spawn dá ENOENT e a mensagem lista onde procurou). */
export function codexResolution(): Resolution { return resolveToolCached("codex"); }

/** Mensagem HUMANA de "não achei", com os lugares onde procurou. */
export function notFoundMsg(label: string, install: string, r: Resolution, extra = ""): string {
  const where = r.searched.slice(0, 40).map((s) => `  • ${s}`).join("\n");
  return `${label} não foi encontrado neste computador${extra} Instale com: ${install} (depois confira em Mais › Ambiente) e tente de novo.\n\nProcurei em:\n${where}`;
}

