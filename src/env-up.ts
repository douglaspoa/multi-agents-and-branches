/**
 * "Subir ambiente" (spec-canvas-workspace, F1): o lugar da tela branca da prévia.
 *
 * `cardume env detect --wt <pasta>`  → como ligar o projeto (JSON)
 * `cardume env up --wt <pasta> --task <id> [--port N]` → SUPERVISOR: instala o que falta, liga o site numa porta
 *     própria da worktree, espera responder e fica vivo enquanto ele roda. Progresso = 1 JSON por linha no stdout
 *     (o Starfork repassa como evento pra tela); log técnico em `.cardume/logs/env.log` (só aparece em "ver detalhes").
 * `cardume env down|status --wt <pasta>` → derruba / diz se está no ar (lê `.cardume/env-run.json`).
 *
 * Sem processo órfão: o supervisor é líder do próprio grupo (o app sobe com setsid), o site roda NO MESMO grupo, e
 * quando o stdin fecha (o app saiu ou caiu) ele mata o grupo inteiro. O app ainda varre os pids registrados no boot.
 * Ordem da detecção (decisão da mesa): `.cardume/env.json` → scripts do package.json (dev/start/serve) → Procfile →
 * docker compose → (python óbvio) → página estática (`index.html` → "Ver a página funcionando") → nada (sem página).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, createWriteStream, type WriteStream, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";

export type EnvKind = "env.json" | "script" | "procfile" | "compose" | "python" | "static" | "none";
export interface EnvPlan {
  kind: EnvKind;
  web: boolean;            // tem página pra ver? (false = o painel "Meu app" nem aparece)
  cwd: string;             // pasta relativa à worktree
  cmd?: string;            // comando (shell) — ausente no estático (o próprio supervisor serve)
  install?: string;        // instalação quando faltam as dependências
  framework?: string;      // vite | next | astro | nuxt | angular | cra | gatsby | remix | sveltekit
  pm?: string;             // npm | pnpm | yarn | bun
  script?: string;         // dev | start | serve
  port?: number;           // porta FIXA (env.json / compose) — senão a da worktree
  path?: string;           // caminho inicial ("/agenda")
  env?: Record<string, string>;
  label: string;           // o que mostrar em "ver detalhes" (nunca na cara)
}

const FRONT_DIRS = [".", "frontend", "web", "app", "client", "ui", "site"];
const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const relOk = (r: string) => !!r && !r.startsWith("/") && !/(^|[\\/])\.\.([\\/]|$)/.test(r) && !/^[A-Za-z]:/.test(r);

/** Gerenciador de pacotes pelo lockfile (na pasta ou na raiz). */
export function packageManager(dir: string, root: string): string {
  const has = (f: string) => isFile(join(dir, f)) || isFile(join(root, f));
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  return "npm";
}
/** Framework pelas dependências (o que decide a flag de porta). */
export function frameworkOf(pkg: any): string | undefined {
  const dep = (n: string) => !!(pkg?.dependencies?.[n] || pkg?.devDependencies?.[n]);
  if (dep("@sveltejs/kit")) return "sveltekit";
  if (dep("next")) return "next";
  if (dep("astro")) return "astro";
  if (dep("nuxt") || dep("nuxt3")) return "nuxt";
  if (dep("@angular/cli") || dep("@angular/core")) return "angular";
  if (dep("@remix-run/dev") || dep("@react-router/dev")) return "remix";
  if (dep("gatsby")) return "gatsby";
  if (dep("react-scripts")) return "cra";
  if (dep("vite")) return "vite";
  return undefined;
}
const runScript = (pm: string, s: string) => (pm === "npm" ? `npm run ${s}` : pm === "bun" ? `bun run ${s}` : `${pm} ${s}`);
const installCmd = (pm: string) => (pm === "npm" ? "npm install" : `${pm} install`);

/** Porta "da casa" desta worktree: estável por tarefa, longe das portas comuns (3000/5173/8080). */
export function portFor(taskId: string): number {
  let h = 2166136261;
  for (const ch of String(taskId)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return 4100 + ((h >>> 0) % 800);
}

/** Primeira porta do compose mapeada pro host ("8080:80", "127.0.0.1:3000:3000", - 5000). */
export function composePort(text: string): number | undefined {
  const m = String(text).match(/^\s*-\s*["']?(?:[\d.]+:)?(\d{2,5}):\d{2,5}/m);
  return m ? Number(m[1]) : undefined;
}

/** Como ligar o projeto. Puro sobre o disco (testado). */
export function detectEnv(wt: string): EnvPlan {
  // 1) o que a pessoa/agente declarou
  const ej = readJson(join(wt, ".cardume", "env.json"));
  if (ej && typeof ej === "object") {
    if (ej.web === false) return { kind: "none", web: false, cwd: ".", label: "o projeto declara que não tem página (.cardume/env.json)" };
    const cwd = typeof ej.cwd === "string" && relOk(ej.cwd) ? ej.cwd : ".";
    if (typeof ej.cmd === "string" && ej.cmd.trim()) {
      const env: Record<string, string> = {};
      if (ej.env && typeof ej.env === "object") for (const [k, v] of Object.entries(ej.env)) if (/^[A-Z_][A-Z0-9_]*$/i.test(k)) env[k] = String(v);
      return { kind: "env.json", web: true, cwd, cmd: ej.cmd.trim(), install: typeof ej.install === "string" ? ej.install : undefined,
        port: Number.isInteger(ej.port) && ej.port > 0 && ej.port < 65536 ? ej.port : undefined,
        path: typeof ej.path === "string" && ej.path.startsWith("/") ? ej.path : undefined, env, label: ej.cmd.trim() };
    }
  }
  // 2) scripts do package.json (na raiz ou numa pasta de front comum)
  for (const d of FRONT_DIRS) {
    const dir = d === "." ? wt : join(wt, d);
    const pkg = readJson(join(dir, "package.json")); if (!pkg) continue;
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const script = ["dev", "start", "serve"].find((s) => typeof scripts[s] === "string" && scripts[s].trim());
    if (!script) continue;
    const pm = packageManager(dir, wt);
    const needsInstall = !isDir(join(dir, "node_modules")) && !isDir(join(wt, "node_modules"));
    return { kind: "script", web: true, cwd: d, pm, script, cmd: runScript(pm, script), install: needsInstall ? installCmd(pm) : undefined,
      framework: frameworkOf(pkg), label: `${runScript(pm, script)}${d === "." ? "" : " (em " + d + "/)"}` };
  }
  // 3) Procfile (linha web:)
  if (isFile(join(wt, "Procfile"))) {
    const web = readFileSync(join(wt, "Procfile"), "utf8").split("\n").map((l) => l.match(/^web:\s*(.+)$/)).find(Boolean);
    if (web) return { kind: "procfile", web: true, cwd: ".", cmd: web[1].trim(), label: web[1].trim() };
  }
  // 4) docker compose
  for (const f of ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]) {
    if (!isFile(join(wt, f))) continue;
    const port = composePort(readFileSync(join(wt, f), "utf8"));
    return { kind: "compose", web: port != null, cwd: ".", cmd: `docker compose -f ${f} up`, port, label: `docker compose (${f})` };
  }
  // 5) python óbvio (o mesmo palpite do preview antigo)
  const py = process.platform === "win32" ? "python" : "python3";
  if (isFile(join(wt, "manage.py"))) return { kind: "python", web: true, cwd: ".", cmd: `${py} manage.py runserver 127.0.0.1:$PORT`, framework: "django", label: "python manage.py runserver" };
  for (const [file, mod] of [["main.py", "main:app"], ["app/main.py", "app.main:app"]] as const) {
    if (isFile(join(wt, file)) && /FastAPI\(/.test(readFileSync(join(wt, file), "utf8")))
      return { kind: "python", web: true, cwd: ".", cmd: `${py} -m uvicorn ${mod} --host 127.0.0.1 --port $PORT`, framework: "fastapi", label: `uvicorn ${mod}` };
  }
  // 6) página estática (sem servidor): o supervisor serve a pasta — "Ver a página funcionando"
  for (const d of [".", "public", "docs", "site", "dist"]) {
    const dir = d === "." ? wt : join(wt, d);
    if (isFile(join(dir, "index.html"))) return { kind: "static", web: true, cwd: d, label: `página estática (${d === "." ? "" : d + "/"}index.html)` };
  }
  return { kind: "none", web: false, cwd: ".", label: "nada pra ligar: o projeto não tem página" };
}

/** Comando final com a porta: PORT sempre no env; a flag do framework só quando o script chama a CLI dele direto
 *  (um "dev": "turbo dev" ou "concurrently …" quebraria com um --port pendurado). */
export function commandFor(plan: EnvPlan, port: number, pkgScript?: string): { cmd: string; env: Record<string, string> } {
  const env: Record<string, string> = { PORT: String(port), BROWSER: "none", NO_COLOR: "1", FORCE_COLOR: "0", ...(plan.env || {}) };
  let cmd = String(plan.cmd || "").replace(/\$PORT\b|\$\{PORT\}/g, String(port));
  if (plan.kind === "script" && plan.framework && pkgScript) {
    const s = pkgScript.trim();
    const direct: Record<string, RegExp> = {
      vite: /^vite(\s|$)/, sveltekit: /^vite(\s+dev)?(\s|$)/, remix: /^(remix vite:dev|react-router dev|vite)(\s|$)/,
      next: /^next dev(\s|$)/, astro: /^astro dev(\s|$)/, nuxt: /^(nuxt|nuxi) dev(\s|$)/, angular: /^ng serve(\s|$)/, gatsby: /^gatsby develop(\s|$)/,
    };
    const flags: Record<string, string> = {
      vite: `--port ${port} --strictPort --host 127.0.0.1`, sveltekit: `--port ${port} --strictPort --host 127.0.0.1`, remix: `--port ${port}`,
      next: `-p ${port}`, astro: `--port ${port} --host 127.0.0.1`, nuxt: `--port ${port}`, angular: `--port ${port}`, gatsby: `-p ${port}`,
    };
    const re = direct[plan.framework];
    if (re && re.test(s) && flags[plan.framework]) cmd += (plan.pm === "npm" ? " -- " : " ") + flags[plan.framework];
  }
  return { cmd, env };
}

/** Uma porta livre a partir da preferida (a da worktree), tentando as seguintes. */
export async function freePort(pref: number, tries = 40): Promise<number> {
  for (let p = pref; p < pref + tries; p++) {
    const ok = await new Promise<boolean>((res) => { const s = netServer(); s.once("error", () => res(false)); s.listen(p, "127.0.0.1", () => s.close(() => res(true))); });
    if (ok) return p;
  }
  throw new Error("nenhuma porta livre perto de " + pref);
}

/** URL local anunciada na saída do servidor ("Local: http://localhost:5174/"). */
export function announcedUrl(line: string): string | null {
  const m = String(line).replace(/\x1b\[[0-9;]*m/g, "").match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(\/[^\s"'<>]*)?/);
  return m ? `http://127.0.0.1:${m[1]}${m[2] || "/"}` : null;
}

/** Erro técnico → frase de gente (a tela mostra a frase; o log fica em "ver detalhes"). */
export function humanEnvError(log: string, code: number | null): { code: string; msg: string } {
  const t = String(log || "");
  if (/EADDRINUSE|address already in use|port .* (is )?(already )?in use/i.test(t)) return { code: "port", msg: "A porta do site já está ocupada por outro programa." };
  if (/command not found|not recognized as an internal|ENOENT.*spawn|: not found/i.test(t)) return { code: "notfound", msg: "Falta um programa no computador pra ligar este projeto (o comando não foi encontrado)." };
  if (/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Could not resolve|Failed to resolve import|ModuleNotFoundError/i.test(t)) return { code: "deps", msg: "Falta instalar uma parte do projeto (uma dependência não foi encontrada)." };
  if (/SyntaxError|TypeError|ReferenceError|error TS\d+|Traceback/i.test(t)) return { code: "code", msg: "O site não ligou por um erro no código." };
  if (/npm ERR!|ERR_PNPM|error An unexpected error|yarn.*error/i.test(t)) return { code: "install", msg: "A instalação das dependências falhou." };
  if (/docker.*(daemon|Cannot connect)|Is the docker daemon running/i.test(t)) return { code: "docker", msg: "O Docker não está ligado neste computador." };
  return { code: code == null ? "timeout" : "exit", msg: code == null ? "O site não respondeu a tempo." : "O site fechou sozinho logo depois de ligar." };
}

// ---------- servidor estático ("Ver a página funcionando") ----------
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm" };
/** Caminho pedido → arquivo DENTRO da pasta (nunca fora: sem `..`, sem link pra cima). null = 404. */
export function staticFile(root: string, urlPath: string): string | null {
  let p: string; try { p = decodeURIComponent(String(urlPath || "/").split("?")[0].split("#")[0]); } catch { return null; }
  if (p.includes("\0")) return null;
  const base = resolve(root); const full = resolve(base, "." + normalize("/" + p));
  if (full !== base && !full.startsWith(base + sep)) return null;
  if (isDir(full)) return isFile(join(full, "index.html")) ? join(full, "index.html") : null;
  return isFile(full) ? full : null;
}
export function serveStatic(root: string, port: number): Promise<Server> {
  const srv = createServer((req, res) => {
    const f = staticFile(root, req.url || "/");
    if (!f) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("não encontrado"); return; }
    res.writeHead(200, { "content-type": MIME[extname(f).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" });
    createReadStream(f).pipe(res);
  });
  return new Promise((ok, bad) => { srv.once("error", bad); srv.listen(port, "127.0.0.1", () => ok(srv)); });
}

/** O site respondeu? (qualquer resposta HTTP vale — 404 numa rota também é "no ar") */
export function probe(url: string, ms = 1500): Promise<boolean> {
  return new Promise((ok) => {
    let done = false; const fin = (v: boolean) => { if (!done) { done = true; ok(v); } };
    try {
      const r = request(url, { method: "GET", timeout: ms }, (res) => { res.resume(); fin(true); });
      r.on("timeout", () => { r.destroy(); fin(false); }); r.on("error", () => fin(false)); r.end();
    } catch { fin(false); }
  });
}

// ---------- supervisor ----------
export interface UpOpts { wt: string; taskId: string; port?: number; waitMs?: number; plan?: EnvPlan;
  /** modo biblioteca (testes): progresso por callback, sem mexer nos sinais do processo; o site roda em grupo PRÓPRIO */
  out?: (o: Record<string, unknown>) => void;
  /** recebe o "parar" assim que existe (o CLI precisa derrubar o site mesmo se o app sair no meio da subida) */
  ctl?: { stop?: (why: string) => Promise<void> } }
export interface EnvRun { code: number; url?: string; stop: () => Promise<void> }
const runFile = (wt: string) => join(wt, ".cardume", "env-run.json");
const logFile = (wt: string) => join(wt, ".cardume", "logs", "env.log");

/** Sobe o ambiente e devolve quando ele está NO AR (code 0) ou falhou (code ≠ 0). `stop()` derruba tudo. */
export async function envStart(o: UpOpts): Promise<EnvRun> {
  const lib = !!o.out;
  const out = o.out || ((x) => console.log(JSON.stringify(x)));
  const wt = resolve(o.wt);
  const plan = o.plan || detectEnv(wt);
  out({ ev: "step", step: "detect", kind: plan.kind, label: plan.label, web: plan.web });
  const noop = async () => {};
  if (!plan.web) { out({ ev: "fail", code: "noweb", msg: "Este projeto não tem uma página pra mostrar." }); return { code: 2, stop: noop }; }
  mkdirSync(join(wt, ".cardume", "logs"), { recursive: true });
  const log: WriteStream = createWriteStream(logFile(wt), { flags: "w" });
  const tail: string[] = [];
  const note = (s: string) => { for (const l of String(s).split(/\r?\n/)) { if (!l) continue; tail.push(l.slice(0, 400)); if (tail.length > 80) tail.shift(); } log.write(s.endsWith("\n") ? s : s + "\n"); };
  const dir = plan.cwd === "." ? wt : join(wt, plan.cwd);
  let child: ChildProcess | null = null; let srv: Server | null = null; let dying = false; let ready = false;
  const port = plan.port ?? (o.port || await freePort(portFor(o.taskId)));
  const pathPart = plan.path || "/";
  let url = `http://127.0.0.1:${port}${pathPart}`;
  writeFileSync(runFile(wt), JSON.stringify({ pid: process.pid, port, url, kind: plan.kind, startedAt: Date.now() }));
  const clean = () => { try { rmSync(runFile(wt), { force: true }); } catch { /* */ } };
  // mata o GRUPO do site (sh → npm → node → esbuild…): o site nasce líder do próprio grupo e o pid dele sai no
  // progresso ({ev:'child'}) — o app registra e também derruba esse grupo (parar, sair do app, varredura no boot),
  // então nem um SIGKILL no supervisor deixa o site órfão.
  const killSite = (sig: NodeJS.Signals) => {
    const pid = child?.pid; if (!pid) return;
    if (process.platform === "win32") { try { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* */ } return; }
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* */ } }
  };
  const stop = (why: string) => new Promise<void>((done) => {
    if (dying) { done(); return; } dying = true; note(`[starfork] parando (${why})`); clean();
    try { srv?.close(); } catch { /* */ }
    const c = child; killSite("SIGTERM");
    if (!c || c.exitCode !== null || c.signalCode) { log.end(); done(); return; }
    const t = setTimeout(() => { killSite("SIGKILL"); }, 1200);
    c.once("close", () => { clearTimeout(t); log.end(); done(); });
  });
  if (o.ctl) o.ctl.stop = stop;
  const sh = (cmd: string, env: Record<string, string>) => {
    note(`$ ${cmd}   (em ${plan.cwd})`);
    const c = spawn(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/C", cmd] : ["-c", cmd],
      { cwd: dir, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env, PATH: [join(dir, "node_modules", ".bin"), join(wt, "node_modules", ".bin"), process.env.PATH || ""].join(process.platform === "win32" ? ";" : ":") } });
    if (c.pid) out({ ev: "child", pid: c.pid });
    return c;
  };
  const fail = (code: string, msg: string, extra?: string): EnvRun => { out({ ev: "fail", code, msg, tail: (tail.slice(-40).join("\n") + (extra ? "\n" + extra : "")).trim() }); clean(); return { code: 1, stop: () => stop("falhou") }; };
  try {
    // instalar o que falta (só quando falta)
    if (plan.install) {
      out({ ev: "step", step: "install" });
      const ic = sh(plan.install, { CI: "1" }); child = ic;
      ic.stdout?.on("data", (b) => note(String(b))); ic.stderr?.on("data", (b) => note(String(b)));
      const code = await new Promise<number | null>((r) => ic.on("close", (c) => r(c)));
      child = null;
      if (dying) return { code: 0, stop: noop };
      if (code !== 0) { const h = humanEnvError(tail.join("\n"), code); log.end(); return fail("install", h.code === "notfound" ? h.msg : "A instalação das dependências falhou."); }
    }
    out({ ev: "step", step: "start", port });
    let exited: number | null | undefined;
    if (plan.kind === "static") {
      srv = await serveStatic(dir, port); note(`[starfork] servindo ${dir} em ${url}`);
    } else {
      const pkg = plan.kind === "script" ? readJson(join(dir, "package.json")) : null;
      const { cmd, env } = commandFor(plan, port, pkg?.scripts?.[plan.script || ""]);
      const c = sh(cmd, env); child = c;
      const onOut = (b: Buffer) => { const s = String(b); note(s); if (!ready) for (const l of s.split("\n")) { const a = announcedUrl(l); if (a) { const ap = Number(new URL(a).port); if (ap && ap !== port && !url.includes(":" + ap + "/")) { url = `http://127.0.0.1:${ap}${pathPart}`; note(`[starfork] o servidor anunciou outra porta: ${ap}`); } } } };
      c.stdout?.on("data", onOut); c.stderr?.on("data", onOut);
      c.once("close", (code) => { exited = code;
        if (dying || !ready) return; // antes de "no ar", a espera abaixo trata
        out({ ev: "exit", code, msg: "O site parou.", tail: tail.slice(-40).join("\n") }); log.end(); clean();
        if (!lib) setTimeout(() => process.exit(0), 50);
      });
    }
    // esperar o site responder (antes de mostrar qualquer coisa)
    out({ ev: "step", step: "wait", url });
    const limit = Date.now() + (o.waitMs ?? 120_000);
    while (Date.now() < limit && exited === undefined && !dying) {
      if (await probe(url)) { ready = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (dying) return { code: 0, stop: noop };
    if (!ready) {
      const h = humanEnvError(tail.join("\n"), exited === undefined ? null : exited);
      await stop("não respondeu"); dying = true;
      return fail(h.code, h.msg);
    }
    writeFileSync(runFile(wt), JSON.stringify({ pid: process.pid, port, url, kind: plan.kind, startedAt: Date.now(), ready: true }));
    out({ ev: "ready", url, port, kind: plan.kind });
    return { code: 0, url, stop: () => stop("pedido") };
  } catch (e) {
    try { log.end(); } catch { /* */ }
    return fail("start", "Não consegui ligar o site.", String((e as Error)?.message || e));
  }
}

/** CLI: sobe e fica SUPERVISIONANDO até parar (stdin fechado = o Starfork saiu/caiu → derruba o grupo). */
export async function envUp(o: UpOpts): Promise<number> {
  const ctl: { stop?: (why: string) => Promise<void> } = {}; let bye = false;
  const quit = (why: string) => { if (bye) return; bye = true; Promise.resolve(ctl.stop?.(why)).catch(() => {}).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 2500); };
  process.stdin.on("end", () => quit("stdin")); process.stdin.on("close", () => quit("stdin")); process.stdin.on("error", () => quit("stdin")); process.stdin.resume();
  process.on("SIGTERM", () => quit("SIGTERM")); process.on("SIGINT", () => quit("SIGINT"));
  const run = await envStart({ ...o, ctl });
  if (run.code !== 0) return run.code;
  await new Promise<never>(() => {});
  return 0;
}

/** Estado pelo arquivo de execução (pid vivo?). */
export function envStatus(wt: string): { running: boolean; url?: string; port?: number; pid?: number; ready?: boolean } {
  const r = readJson(runFile(resolve(wt)));
  if (!r || !Number.isInteger(r.pid)) return { running: false };
  let alive = false; try { process.kill(r.pid, 0); alive = true; } catch { /* */ }
  return { running: alive, url: r.url, port: r.port, pid: r.pid, ready: !!r.ready };
}
export function envDown(wt: string): boolean {
  const st = envStatus(wt); if (!st.running || !st.pid) return false;
  try { process.kill(process.platform === "win32" ? st.pid : -st.pid, "SIGTERM"); } catch { try { process.kill(st.pid, "SIGTERM"); } catch { /* */ } }
  return true;
}

export async function envCli(a: { _: string[]; flags: Record<string, string> }): Promise<number> {
  const sub = a._[1]; const wt = a.flags.wt || process.cwd();
  if (sub === "detect") { console.log(JSON.stringify(detectEnv(resolve(wt)))); return 0; }
  if (sub === "status") { console.log(JSON.stringify(envStatus(wt))); return 0; }
  if (sub === "down") { console.log(JSON.stringify({ stopped: envDown(wt) })); return 0; }
  if (sub === "up") {
    if (!existsSync(wt)) { console.log(JSON.stringify({ ev: "fail", code: "nowt", msg: "A pasta desta demanda não existe mais." })); return 1; }
    const port = Number(a.flags.port) || undefined;
    return envUp({ wt, taskId: a.flags.task || wt, port });
  }
  console.error("✕ use: cardume env detect|up|down|status --wt <pasta> [--task <id>] [--port N]");
  return 1;
}
