#!/usr/bin/env node
// IA FALSA no lugar do `claude` (NUNCA o de verdade): modo -p (turno de fundo) e interativo (PTY), com os hooks do
// .claude/settings.local.json da pasta, transcript em $CLAUDE_CONFIG_DIR|~/.claude/projects e eco do que se digita.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("9.9.9 (Claude Code FALSO)"); process.exit(0); }
if (argv.includes("--help")) { console.log("--resume --permission-mode --model --append-system-prompt --mcp-config"); process.exit(0); }
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const cfg = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, ".claude");
const enc = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
const tpath = (sid) => { const d = join(cfg, "projects", enc(process.cwd())); mkdirSync(d, { recursive: true }); return join(d, `${sid}.jsonl`); };
const tline = (sid, o) => appendFileSync(tpath(sid), JSON.stringify(o) + "\n");
const log = (m) => { if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, `${new Date().toISOString()} [${process.pid}] ${m}\n`); };
if (argv.includes("-p") || argv.includes("--print")) {
  const sid = val("--resume") || randomUUID();
  log(`-p sid=${sid} cwd=${process.cwd()}`);
  tline(sid, { type: "user", message: { role: "user", content: "turno de fundo (headless)" } });
  tline(sid, { type: "assistant", message: { content: [{ type: "text", text: "FAKE-HEADLESS trabalhando de fundo…" }] } });
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sid }));
  if (process.env.STUB_SLOW_FILE && existsSync(process.env.STUB_SLOW_FILE)) {
    process.on("SIGINT", () => { log(`-p SIGINT sid=${sid}`); process.exit(130); });
    process.on("SIGTERM", () => { log(`-p SIGTERM sid=${sid}`); process.exit(143); });
    setInterval(() => {}, 1000); // turno longo: só sai por sinal
  } else {
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] }, session_id: sid }));
    console.log(JSON.stringify({ type: "result", subtype: "success", result: "ok", session_id: sid, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }));
  }
} else {
  const resume = val("--resume");
  const sid = resume || randomUUID();
  const mode = val("--permission-mode") || "default";
  const model = val("--model") || "";
  const sys = val("--append-system-prompt") || "";
  const vflags = new Set(["--resume", "--permission-mode", "--model", "--append-system-prompt", "--mcp-config", "--disallowedTools"]);
  let first = ""; for (let i = 0; i < argv.length; i++) { if (argv[i] === "--disallowedTools") { while (argv[i + 1] && !argv[i + 1].startsWith("--")) i++; continue; } if (vflags.has(argv[i])) { i++; continue; } if (argv[i].startsWith("--")) continue; first = argv[i]; }
  let hooks = {}; try { hooks = JSON.parse(readFileSync(join(process.cwd(), ".claude", "settings.local.json"), "utf8")).hooks || {}; } catch {}
  const fire = (ev, extra = {}) => {
    for (const g of hooks[ev] || []) for (const h of g.hooks || []) {
      if (g.matcher && g.matcher !== "*" && !(extra.tool_name && g.matcher === extra.tool_name)) continue;
      spawnSync("/bin/sh", ["-c", h.command], { input: JSON.stringify({ session_id: sid, transcript_path: tpath(sid), cwd: process.cwd(), hook_event_name: ev, ...extra }), stdio: ["pipe", "ignore", "ignore"], timeout: (h.timeout || 30) * 1000 });
    }
  };
  const papel = /SUA REVISÃO TEM VEREDITO/.test(sys) ? "revisor" : "construtor";
  log(`interativo sid=${sid} resume=${!!resume} mode=${mode} model=${model} papel=${papel} first=${JSON.stringify(first.slice(0, 80))}`);
  process.stdout.write(`\x1b[1mFAKE-AI\x1b[0m (Claude Code FALSO) sid=${sid.slice(0, 8)} papel=${papel} modo=${mode}${model ? " modelo=" + model : ""}\r\n`);
  if (resume) process.stdout.write(`FAKE-RESUME:${sid}\r\n  (conversa anterior reimpressa pelo --resume)\r\n`);
  fire("SessionStart", { source: resume ? "resume" : "startup" });
  const turn = (msg) => {
    const m = msg.replace(/\x1b\[20[01]~/g, "").trim();
    if (!m) return;
    if (m === "sair") { fire("SessionEnd", { reason: "prompt_input_exit" }); process.exit(0); }
    fire("UserPromptSubmit", { prompt: m });
    tline(sid, { type: "user", message: { role: "user", content: m } });
    process.stdout.write(`\r\n> ${m.slice(0, 200)}\r\n`);
    let reply = `FAKE-ECO:${m.slice(0, 120)}`;
    if (papel === "revisor" && process.env.STUB_REVIEW_MS) { const t = Date.now() + Number(process.env.STUB_REVIEW_MS); while (Date.now() < t) { /* revisando */ } }
    if (papel === "revisor") { writeFileSync(join(process.cwd(), ".cardume", "VEREDITO.md"), process.env.STUB_VEREDITO || "VEREDITO: aprova\n"); reply = "revisei: " + (process.env.STUB_VEREDITO || "VEREDITO: aprova").split("\n")[0]; }
    else if (/^Comece:/.test(m)) { writeFileSync(join(process.cwd(), `feito-${sid.slice(0, 6)}.txt`), "feito pela IA falsa\n"); reply = "construí: feito-*.txt"; }
    process.stdout.write(`\x1b[32m●\x1b[0m ${reply}\r\n`);
    tline(sid, { type: "assistant", message: { content: [{ type: "text", text: reply }] } });
    fire("Stop", { last_assistant_message: reply, stop_hook_active: false });
    process.stdout.write(`FAKE-PROMPT> `);
  };
  process.on("SIGTERM", () => { log(`interativo SIGTERM sid=${sid}`); fire("SessionEnd", { reason: "other" }); process.exit(143); });
  process.on("SIGINT", () => { process.stdout.write("\r\n(Ctrl+C)\r\nFAKE-PROMPT> "); });
  if (first) turn(first); else process.stdout.write(`FAKE-PROMPT> `);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (l) => turn(l));
  rl.on("close", () => process.exit(0));
}
