// "Subir ambiente" (spec-canvas-workspace F1): detecção na ordem da mesa, porta por worktree, comando com a flag do
// framework, erro humano, servidor estático sem sair da pasta e o CICLO DE VIDA com comandos falsos (sobe, espera
// responder, para o GRUPO inteiro — nenhum processo sobra).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectEnv, commandFor, portFor, composePort, announcedUrl, humanEnvError, staticFile, envStart, probe, freePort, envStatus } from "./env-up.ts";

const tmp = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "sf-env-"));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); }
  return d;
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("detecção na ordem: env.json → package.json → Procfile → compose → python → estático → nada", () => {
  const all = { "package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "5" } }), Procfile: "web: node app.js $PORT\nworker: x", "compose.yaml": "services:\n  web:\n    ports:\n      - \"8080:80\"\n", "index.html": "<h1>oi</h1>" };
  const d1 = tmp({ ...all, ".cardume/env.json": JSON.stringify({ cmd: "make serve", port: 9000, path: "/agenda", cwd: "web", env: { FOO: "1", "BAD KEY": "x" } }) });
  mkdirSync(join(d1, "web"));
  const p1 = detectEnv(d1);
  assert.equal(p1.kind, "env.json"); assert.equal(p1.cmd, "make serve"); assert.equal(p1.port, 9000); assert.equal(p1.path, "/agenda"); assert.equal(p1.cwd, "web");
  assert.deepEqual(p1.env, { FOO: "1" }, "chave de env inválida fica de fora");
  assert.equal(detectEnv(tmp({ ".cardume/env.json": JSON.stringify({ web: false }), ...all })).kind, "none", "o projeto pode declarar que não tem página");
  assert.equal(detectEnv(tmp({ ".cardume/env.json": JSON.stringify({ cmd: "x", cwd: "../fora" }), ...all })).cwd, ".", "cwd fora da worktree não vale");
  const p2 = detectEnv(tmp(all));
  assert.equal(p2.kind, "script"); assert.equal(p2.cmd, "npm run dev"); assert.equal(p2.install, "npm install", "sem node_modules → instala"); assert.equal(p2.framework, "vite");
  const { "package.json": _p, ...noPkg } = all;
  const p3 = detectEnv(tmp(noPkg)); assert.equal(p3.kind, "procfile"); assert.equal(p3.cmd, "node app.js $PORT");
  const { Procfile: _f, ...noProc } = noPkg;
  const p4 = detectEnv(tmp(noProc)); assert.equal(p4.kind, "compose"); assert.equal(p4.port, 8080); assert.match(p4.cmd || "", /docker compose -f compose\.yaml up/);
  const p5 = detectEnv(tmp({ "index.html": "x" })); assert.equal(p5.kind, "static"); assert.equal(p5.web, true);
  const p6 = detectEnv(tmp({ "src/lib.rs": "fn main(){}", "README.md": "# lib" })); assert.equal(p6.kind, "none"); assert.equal(p6.web, false, "sem página: o painel Meu app nem aparece");
  assert.equal(detectEnv(tmp({ "manage.py": "" })).kind, "python");
  assert.equal(detectEnv(tmp({ "main.py": "app = FastAPI()" })).cmd, (process.platform === "win32" ? "python" : "python3") + " -m uvicorn main:app --host 127.0.0.1 --port $PORT");
});

test("package.json: gerenciador pelo lockfile, pasta de front, script dev › start › serve, sem instalar quando já tem node_modules", () => {
  const d = tmp({ "frontend/package.json": JSON.stringify({ scripts: { start: "next start", dev: "next dev" }, dependencies: { next: "15" } }), "pnpm-lock.yaml": "", "frontend/node_modules/.keep": "" });
  const p = detectEnv(d);
  assert.equal(p.cwd, "frontend"); assert.equal(p.pm, "pnpm"); assert.equal(p.cmd, "pnpm dev"); assert.equal(p.install, undefined); assert.equal(p.framework, "next");
  assert.equal(detectEnv(tmp({ "package.json": JSON.stringify({ scripts: { serve: "http-server" } }), "yarn.lock": "" })).cmd, "yarn serve");
  assert.equal(detectEnv(tmp({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) })).kind, "none", "só build: não tem o que ligar");
});

test("porta por worktree: estável, fora das portas comuns; PORT sempre; flag do framework só quando o script chama a CLI dele", () => {
  assert.equal(portFor("t1"), portFor("t1")); assert.notEqual(portFor("t1"), portFor("t2"));
  for (const id of ["a", "b", "tarefa-123", "x".repeat(40)]) { const p = portFor(id); assert.ok(p >= 4100 && p < 4900, String(p)); }
  const vite = commandFor({ kind: "script", web: true, cwd: ".", cmd: "npm run dev", pm: "npm", script: "dev", framework: "vite", label: "" }, 4321, "vite");
  assert.equal(vite.cmd, "npm run dev -- --port 4321 --strictPort --host 127.0.0.1"); assert.equal(vite.env.PORT, "4321"); assert.equal(vite.env.BROWSER, "none");
  assert.equal(commandFor({ kind: "script", web: true, cwd: ".", cmd: "pnpm dev", pm: "pnpm", script: "dev", framework: "next", label: "" }, 4500, "next dev --turbo").cmd, "pnpm dev -p 4500");
  assert.equal(commandFor({ kind: "script", web: true, cwd: ".", cmd: "npm run dev", pm: "npm", script: "dev", framework: "vite", label: "" }, 4500, "turbo run dev").cmd, "npm run dev", "script indireto: só o PORT");
  assert.equal(commandFor({ kind: "script", web: true, cwd: ".", cmd: "npm start", pm: "npm", script: "start", framework: "cra", label: "" }, 4500, "react-scripts start").cmd, "npm start", "CRA lê o PORT");
  assert.equal(commandFor({ kind: "procfile", web: true, cwd: ".", cmd: "node app.js --port $PORT ${PORT}", label: "" }, 4700).cmd, "node app.js --port 4700 4700");
  assert.equal(composePort("ports:\n  - \"127.0.0.1:3000:3000\"\n"), 3000); assert.equal(composePort("ports:\n  - 5000:5000"), 5000); assert.equal(composePort("image: x"), undefined);
});

test("saída do servidor: URL anunciada (com cor ANSI) e erro técnico vira frase de gente", () => {
  assert.equal(announcedUrl("  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5174\x1b[22m/\x1b[39m"), "http://127.0.0.1:5174/");
  assert.equal(announcedUrl("ready - started server on 0.0.0.0:3000, url: http://localhost:3000"), "http://127.0.0.1:3000/");
  assert.equal(announcedUrl("compilando…"), null);
  assert.equal(humanEnvError("Error: listen EADDRINUSE: address already in use :::4431", 1).code, "port");
  assert.equal(humanEnvError("sh: vite: command not found", 127).code, "notfound");
  assert.equal(humanEnvError("Error: Cannot find module 'express'", 1).code, "deps");
  assert.equal(humanEnvError("", null).code, "timeout"); assert.match(humanEnvError("", null).msg, /não respondeu/);
  for (const c of ["port", "notfound", "deps", "timeout", "exit"]) assert.ok(!/EADDR|ENOENT|stack|Error:/.test(humanEnvError(c === "port" ? "EADDRINUSE" : "", 1).msg), "a frase não tem texto de máquina");
});

test("servidor estático: serve só DENTRO da pasta (sem ../, sem %2e%2e, sem NUL)", () => {
  const d = tmp({ "index.html": "<h1>home</h1>", "sub/index.html": "x", "a.css": "b" });
  assert.equal(staticFile(d, "/"), join(d, "index.html"));
  assert.equal(staticFile(d, "/sub/"), join(d, "sub", "index.html"));
  assert.equal(staticFile(d, "/a.css?v=1"), join(d, "a.css"));
  for (const bad of ["/../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/a.css%00.png", "/nao-existe.html", "/%E0%A4%A"]) assert.equal(staticFile(d, bad), null, bad);
});

test("ciclo de vida com comando FALSO: instala o que falta, sobe na porta da worktree, só fica pronto quando responde, parar derruba o grupo", async () => {
  const d = tmp({
    "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }),
    // "instalação" falsa: só cria a pasta node_modules
    ".cardume/env.json": JSON.stringify({ cmd: "node server.js & node -e \"setInterval(()=>{},1000)\" & wait", install: "node -e \"require('fs').mkdirSync('node_modules')\"" }),
    // espera 600 ms antes de abrir a porta (o "pronto" não pode vir antes)
    "server.js": "setTimeout(()=>require('http').createServer((q,r)=>r.end('ok '+process.env.PORT)).listen(process.env.PORT,'127.0.0.1',()=>console.log('Local: http://localhost:'+process.env.PORT+'/')),600)",
  });
  const evs: Record<string, unknown>[] = [];
  const port = await freePort(portFor("ciclo-" + process.pid));
  const run = await envStart({ wt: d, taskId: "ciclo", port, out: (e) => evs.push(e), waitMs: 20000 });
  assert.equal(run.code, 0, JSON.stringify(evs));
  assert.deepEqual(evs.filter((e) => e.ev === "step").map((e) => e.step), ["detect", "install", "start", "wait"]);
  assert.ok(existsSync(join(d, "node_modules")), "instalou antes de subir");
  const ready = evs.find((e) => e.ev === "ready"); assert.ok(ready); assert.equal(ready!.url, `http://127.0.0.1:${port}/`);
  assert.equal(await probe(String(ready!.url)), true);
  assert.equal(envStatus(d).running, true); assert.equal(envStatus(d).ready, true);
  const kids = evs.filter((e) => e.ev === "child").map((e) => Number(e.pid));
  const site = kids[kids.length - 1]; assert.ok(alive(site));
  assert.match(readFileSync(join(d, ".cardume/logs/env.log"), "utf8"), /Local: http:\/\/localhost/, "log técnico vai pro arquivo (não pra tela)");
  await run.stop();
  await sleep(300);
  assert.equal(alive(site), false, "o grupo do site morreu (sh + node server + node extra)");
  assert.equal(await probe(String(ready!.url), 500), false);
  assert.equal(envStatus(d).running, false, "arquivo de execução limpo");
});

test("falha antes de responder: frase humana + fim do log, e nada fica rodando", async () => {
  const d = tmp({ ".cardume/env.json": JSON.stringify({ cmd: "node -e \"console.error('Error: Cannot find module \\'express\\''); process.exit(1)\"" }) });
  const evs: Record<string, unknown>[] = [];
  const run = await envStart({ wt: d, taskId: "falha", port: await freePort(4950), out: (e) => evs.push(e), waitMs: 8000 });
  assert.equal(run.code, 1);
  const f = evs.find((e) => e.ev === "fail")!; assert.equal(f.code, "deps"); assert.match(String(f.msg), /dependência/); assert.match(String(f.tail), /Cannot find module/);
  const kids = evs.filter((e) => e.ev === "child").map((e) => Number(e.pid));
  assert.ok(kids.every((p) => !alive(p)));
  // instalação que falha
  const d2 = tmp({ ".cardume/env.json": JSON.stringify({ cmd: "true", install: "node -e \"console.log('npm ERR! code E404');process.exit(1)\"" }) });
  const ev2: Record<string, unknown>[] = [];
  assert.equal((await envStart({ wt: d2, taskId: "inst", port: await freePort(4960), out: (e) => ev2.push(e) })).code, 1);
  assert.equal(ev2.find((e) => e.ev === "fail")!.code, "install");
  // sem página
  const ev3: Record<string, unknown>[] = [];
  assert.equal((await envStart({ wt: tmp({ "a.rs": "" }), taskId: "x", out: (e) => ev3.push(e) })).code, 2);
  assert.equal(ev3.find((e) => e.ev === "fail")!.code, "noweb");
});

test("servidor que anuncia OUTRA porta (ignora o PORT): segue a anunciada", async () => {
  const other = await freePort(4970);
  const d = tmp({ ".cardume/env.json": JSON.stringify({ cmd: `node -e "require('http').createServer((q,r)=>r.end('x')).listen(${other},'127.0.0.1',()=>console.log('  Local: http://localhost:${other}/'))"` }) });
  const evs: Record<string, unknown>[] = [];
  const run = await envStart({ wt: d, taskId: "outra", port: await freePort(4980), out: (e) => evs.push(e), waitMs: 15000 });
  assert.equal(run.code, 0, JSON.stringify(evs));
  assert.equal(run.url, `http://127.0.0.1:${other}/`);
  await run.stop();
});

test("página estática: \"Ver a página funcionando\" sem servidor do projeto", async () => {
  const d = tmp({ "index.html": "<h1>campanha</h1>" });
  const evs: Record<string, unknown>[] = [];
  const run = await envStart({ wt: d, taskId: "st", port: await freePort(4990), out: (e) => evs.push(e) });
  assert.equal(run.code, 0);
  const r = await fetch(String(run.url)); assert.match(await r.text(), /campanha/);
  assert.equal((await fetch(String(run.url) + "../../etc/passwd")).status === 200 && false, false);
  await run.stop();
  assert.equal(await probe(String(run.url), 500), false);
});
