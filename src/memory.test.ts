// node --test src/memory.test.ts  (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Brain, buildContext, extractJson, extractLinks, harvestWorktree, looksSecret, parseFrontmatter, parseLegacyMemory,
  parseNote, relevantNotes, seedWorktree, serializeNote, slugify, terms, type Note, type Scope,
} from "./memory.ts";

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "brain-"));
  mkdirSync(join(d, ".cardume"), { recursive: true });
  return join(d, ".cardume");
};

const note = (slug: string, title: string, body: string, extra: Partial<Note> = {}): Note => ({
  slug, title, type: "contexto", tags: [], updated: "2026-09-28", by: "x", origem: "pessoa", atualizadaPor: "", extra: {}, body,
  links: extractLinks(body), scope: "local", mtimeMs: 0, ...extra,
});

test("slugify: sem acento, minúsculo, hífens", () => {
  assert.equal(slugify("Usar pnpm, nunca npm!"), "usar-pnpm-nunca-npm");
  assert.equal(slugify("Decisão de Arquitetura"), "decisao-de-arquitetura");
  assert.equal(slugify("   "), "nota");
  assert.match(slugify("日本語のメモ"), /^nota-[0-9a-f]{8}$/);
  assert.notEqual(slugify("日本語のメモ"), slugify("中文笔记"));
});

test("frontmatter: escalares, listas [a, b] e lista em bloco", () => {
  const { data, body } = parseFrontmatter("---\ntitle: \"Olá: mundo\"\ntype: regra\ntags: [ferramentas, ci]\nalias:\n  - um\n  - dois\n---\ncorpo aqui\n");
  assert.equal(data.title, "Olá: mundo");
  assert.deepEqual(data.tags, ["ferramentas", "ci"]);
  assert.deepEqual(data.alias, ["um", "dois"]);
  assert.equal(body.trim(), "corpo aqui");
});

test("nota sem frontmatter: título vem do # ou do slug; tipo padrão contexto", () => {
  const n = parseNote("# Checkout\ntexto", "checkout");
  assert.equal(n.title, "Checkout");
  assert.equal(n.type, "contexto");
});

test("serialize → parse é ida e volta (compatível com Obsidian)", () => {
  const src = { title: "Usar pnpm, nunca npm", type: "regra" as const, tags: ["ferramentas"], updated: "2026-09-28", by: "Douglas (chat da tarefa checkout-unico)", origem: "pessoa" as const, body: "Rodar `pnpm i`. Ver [[ferramentas]] e [[ci]]." };
  const txt = serializeNote(src);
  assert.ok(txt.startsWith("---\ntitle: Usar pnpm, nunca npm\ntype: regra\n"), txt);
  const n = parseNote(txt, "usar-pnpm-nunca-npm");
  assert.equal(n.title, src.title);
  assert.equal(n.type, "regra");
  assert.deepEqual(n.tags, ["ferramentas"]);
  assert.equal(n.by, src.by);
  assert.deepEqual(n.links, ["ferramentas", "ci"]);
  // título com ": " é citado
  assert.match(serializeNote({ ...src, title: "API: timeout" }), /title: "API: timeout"/);
});

test("links: [[alvo|apelido]], [[alvo#seção]] e acentos viram slug", () => {
  assert.deepEqual(extractLinks("ver [[Decisão Pagamento|pagto]] e [[ci#jobs]] e [[ci]]"), ["decisao-pagamento", "ci"]);
});

test("relevância: termos da tarefa + 1 salto de links + regras sempre", () => {
  const notes = [
    note("checkout", "Checkout único", "O checkout usa o gateway X. Ver [[gateway-x]]."),
    note("gateway-x", "Gateway X", "Timeout de 30s no sandbox."),
    note("login", "Login social", "Google e GitHub."),
    note("pnpm", "Usar pnpm, nunca npm", "Lockfile do pnpm.", { type: "regra" }),
  ];
  const r = relevantNotes(notes, "Refazer a tela de checkout").map((n) => n.slug);
  assert.equal(r[0], "pnpm", "regras vêm primeiro (reservam espaço)");
  assert.equal(r[1], "checkout");
  assert.ok(r.includes("gateway-x"), "1 salto de link");
  assert.ok(r.includes("pnpm"), "regra entra sempre");
  assert.ok(!r.includes("login"));
  assert.deepEqual(terms("a de pra checkout Checkout"), ["checkout"]);
});

test("contexto tem teto: índice + notas até o limite, nunca o cérebro inteiro", () => {
  const notes = Array.from({ length: 200 }, (_, i) => note(`n${i}`, `Nota checkout ${i}`, "checkout ".repeat(200)));
  const ctx = buildContext(notes, "checkout", { index: 1000, notes: 3000 });
  assert.ok(ctx.length < 1000 + 3000 + 600, String(ctx.length));
  assert.match(ctx, /mais \d+ nota/);
  assert.equal(buildContext([], "x"), "");
});

test("Brain.write: cria, deduplica (atualiza a existente) e deixa rastro", () => {
  const dir = tmp();
  const b = new Brain(dir);
  const r1 = b.write({ title: "Usar pnpm, nunca npm", type: "regra", tags: ["ferramentas"], body: "Aqui sempre use pnpm. Ver [[ferramentas]].", by: "Douglas (chat da tarefa a)", origem: "pessoa" });
  assert.equal(r1?.action, "created");
  assert.equal(r1?.scope, "local");
  const r2 = b.write({ title: "Sempre usar pnpm, nunca npm", type: "regra", body: "Sempre use pnpm aqui.", by: "destilador · tarefa b", origem: "agente" });
  assert.equal(r2?.action, "updated");
  assert.equal(r2?.slug, r1?.slug);
  const files = readdirSync(join(dir, "memoria")).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 1);
  const n = parseNote(readFileSync(join(dir, "memoria", files[0]), "utf8"), "x");
  // o autor continua sendo a pessoa (sem selo "nova" do agente); quem anexou fica no rastro
  assert.equal(n.by, "Douglas (chat da tarefa a)");
  assert.equal(n.origem, "pessoa");
  assert.equal(n.type, "regra");
  assert.equal(n.atualizadaPor, "destilador · tarefa b");
  assert.match(n.body, /Sempre use pnpm aqui\./);
  assert.match(n.updated, /^\d{4}-\d{2}-\d{2}$/);
  // repetir o mesmo aprendizado não muda nada
  assert.equal(b.write({ title: "Sempre usar pnpm, nunca npm", body: "Sempre use pnpm aqui.", by: "z", origem: "agente" })?.action, "unchanged");
});

test("anexos repetidos não fazem a nota crescer sem limite; chaves do Obsidian são preservadas", () => {
  const dir = tmp();
  mkdirSync(join(dir, "memoria"), { recursive: true });
  writeFileSync(join(dir, "memoria", "deploy.md"), "---\ntitle: Deploy\ntype: contexto\ntags: []\nupdated: 2026-09-01\nby: Ana\norigem: pessoa\naliases: [publicar, subir]\ncssclasses: wide\n---\nDeploy pelo CI.\n");
  const b = new Brain(dir);
  for (let i = 0; i < 80; i++) b.write({ title: "Deploy", body: `passo ${i} ${"x".repeat(60)} termo${i}`, by: "agente" });
  const txt = readFileSync(join(dir, "memoria", "deploy.md"), "utf8");
  const n = parseNote(txt, "deploy");
  assert.ok(Array.from(n.body).length <= 3000, String(n.body.length));
  assert.deepEqual(n.extra.aliases, ["publicar", "subir"]);
  assert.equal(n.extra.cssclasses, "wide");
  assert.equal(n.by, "Ana");
});

test("só-local: o dedup não casa nem altera nota do time", () => {
  const dir = tmp();
  mkdirSync(join(dir, "memoria", "time"), { recursive: true });
  const team = serializeNote({ title: "Usar pnpm", type: "regra", tags: [], updated: "2026-09-01", by: "Ana", origem: "pessoa", body: "Sempre pnpm." });
  writeFileSync(join(dir, "memoria", "time", "usar-pnpm.md"), team);
  writeFileSync(join(dir, "memoria.json"), JSON.stringify({ mode: "so-local" }));
  const r = new Brain(dir).write({ title: "Usar pnpm", body: "Sempre pnpm, nunca npm.", by: "x" });
  assert.equal(r?.action, "created");
  assert.equal(r?.scope, "local");
  assert.equal(readFileSync(join(dir, "memoria", "time", "usar-pnpm.md"), "utf8"), team);
});

test("regras nunca saem do contexto por causa de notas menos importantes; corte zera o espaço", () => {
  const rule = note("pnpm", "Usar pnpm", "Sempre pnpm.", { type: "regra" });
  const big = Array.from({ length: 5 }, (_, i) => note(`c${i}`, `Checkout ${i}`, "checkout ".repeat(80)));
  const ctx = buildContext([...big, rule], "checkout", { index: 2000, notes: 1200 });
  assert.match(ctx.split("### Notas relevantes")[1], /Usar pnpm/);
  const huge = note("h", "Checkout gigante", "checkout ".repeat(2000));
  const c2 = buildContext([huge, note("x", "Checkout curto", "checkout")], "checkout", { index: 2000, notes: 1000 });
  const notesPart = c2.split("### Notas relevantes pra agora\n")[1];
  assert.ok(Array.from(notesPart).length <= 1000, String(notesPart.length));
  assert.ok(!notesPart.includes("Checkout curto"), "depois do corte não entra mais nada");
});

test("dedup: citar uma nota por [[link]] não faz a nota nova virar duplicata dela", () => {
  const b = new Brain(tmp());
  b.write({ title: "Aqui sempre use pnpm, nunca npm", type: "regra", body: "Aqui sempre use pnpm, nunca npm", by: "x" });
  const r = b.write({ title: "Gateway dá timeout no sandbox", type: "gotcha", body: "Use PAY_MOCK=1. Ver [[aqui-sempre-use-pnpm-nunca-npm]].", by: "y" });
  assert.equal(r?.action, "created");
  assert.equal(b.list().length, 2);
});

test("Brain.write: segredo é descartado", () => {
  const b = new Brain(tmp());
  assert.equal(b.write({ title: "chave", body: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx", by: "x" })?.action, "secret");
  assert.equal(b.write({ title: "token", body: "use o token: ghp_abcdefghijklmnopqrstuvwxyz123456", by: "x" })?.action, "secret");
  assert.equal(b.list().length, 0);
});

test("modo: time quando existe o espelho, escolha explícita vence, só-local esconde o time", () => {
  const dir = tmp();
  const b = new Brain(dir);
  assert.equal(b.mode(), "local");
  mkdirSync(join(dir, "memoria", "time"), { recursive: true });
  writeFileSync(join(dir, "memoria", "time", "ci.md"), serializeNote({ title: "CI", type: "contexto", tags: [], updated: "2026-09-28", by: "Ana", origem: "pessoa", body: "GitHub Actions." }));
  assert.equal(b.mode(), "time");
  assert.equal(b.write({ title: "Nova decisão", type: "decisão", body: "Usar Postgres.", by: "x" })?.scope, "time");
  assert.equal(b.list().length, 2);
  writeFileSync(join(dir, "memoria.json"), JSON.stringify({ mode: "so-local" }));
  assert.equal(b.mode(), "so-local");
  assert.equal(b.list().length, 0);
  assert.equal(b.targetScope(), "local");
});

test("migração do MEMORY.md: cada regra vira nota; texto solto vira contexto; nada se perde", () => {
  const dir = tmp();
  const legacy = "# Memória\n\n- Sempre rodar os testes com pnpm _(aprendido 2026-09-01)_\n- Nunca commitar na main _(aprendido 2026-09-02)_\nTexto solto sobre o projeto\nque continua aqui.\n";
  writeFileSync(join(dir, "MEMORY.md"), legacy);
  const items = parseLegacyMemory(legacy);
  assert.deepEqual(items.map((i) => i.type), ["contexto", "regra", "regra", "contexto"]);
  const b = new Brain(dir);
  const notes = b.list();
  assert.equal(notes.length, 4);
  assert.ok(!existsSync(join(dir, "MEMORY.md")));
  assert.ok(existsSync(join(dir, "MEMORY.md.migrado")), "o original fica guardado");
  const all = notes.map((n) => n.body).join("\n");
  for (const frag of ["Sempre rodar os testes com pnpm", "Nunca commitar na main", "Texto solto sobre o projeto", "que continua aqui."]) assert.ok(all.includes(frag), frag);
  const r = notes.find((n) => n.body.includes("pnpm"))!;
  assert.equal(r.type, "regra");
  assert.equal(r.updated, "2026-09-01");
  // contexto do agente contém a regra
  assert.match(b.context("qualquer tarefa"), /Sempre rodar os testes com pnpm/);
});

test("extractJson: bloco ```json, objeto solto e array", () => {
  assert.deepEqual(extractJson('ok ```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('[{"t":"x"}]'), [{ t: "x" }]);
  assert.equal(extractJson("SKIP"), null);
});

// ---------------------------------------------------------------------------
// fixture DOURADO: o mesmo arquivo é conferido pelo cargo test (memoria.rs) — TS e Rust não divergem
// ---------------------------------------------------------------------------
const GOLD = fileURLToPath(new URL("../tests/fixtures/memoria-golden/", import.meta.url));

test("golden: contexto idêntico ao esperado (mesmo fixture do Rust)", () => {
  for (const c of JSON.parse(readFileSync(join(GOLD, "cases.json"), "utf8"))) {
    const notes = c.notes.map((p: string) => { const [sc, f] = p.split("/"); return parseNote(readFileSync(join(GOLD, "notes", p), "utf8"), f.slice(0, -3), sc as Scope, 0); });
    assert.equal(buildContext(notes, c.query, { index: c.index, notes: c.notes_cap }), readFileSync(join(GOLD, c.expected), "utf8"), c.name);
  }
});

test("golden: migração, slugs e filtro de segredo", () => {
  assert.deepEqual(parseLegacyMemory(readFileSync(join(GOLD, "legacy.md"), "utf8")), JSON.parse(readFileSync(join(GOLD, "legacy-expected.json"), "utf8")));
  for (const [inp, out] of JSON.parse(readFileSync(join(GOLD, "slugs.json"), "utf8"))) assert.equal(slugify(inp), out, inp);
  const sec = JSON.parse(readFileSync(join(GOLD, "secrets.json"), "utf8"));
  for (const s of sec.secret) assert.ok(looksSecret(s), s);
  for (const s of sec.benign) assert.ok(!looksSecret(s), s);
});

// ---------------------------------------------------------------------------
// worktree: semear + colher
// ---------------------------------------------------------------------------
const setupWt = () => {
  const main = tmp();
  const wt = mkdtempSync(join(tmpdir(), "wt-"));
  const b = new Brain(main);
  b.write({ title: "Usar pnpm", type: "regra", body: "Sempre pnpm.", by: "Ana", origem: "pessoa" });
  b.write({ title: "Deploy", type: "contexto", body: "Deploy pelo CI.", by: "Ana", origem: "pessoa" });
  const manifest = seedWorktree(b, wt);
  return { main, wt, b, manifest, wdir: join(wt, ".cardume", "memoria") };
};
const later = (p: string) => { const t = new Date(Date.now() + 5000); utimesSync(p, t, t); };

test("colheita: nota mudada pelo agente entra com rastro; 2ª colheita é no-op", () => {
  const { main, wt, manifest, wdir } = setupWt();
  assert.deepEqual(Object.keys(manifest).sort(), ["local/deploy", "local/usar-pnpm"]);
  writeFileSync(join(wdir, "deploy.md"), "---\ntitle: Deploy\ntype: contexto\n---\nDeploy pelo CI, com aprovação manual em produção.\n");
  later(join(wdir, "deploy.md"));
  writeFileSync(join(wdir, "gateway-timeout.md"), "---\ntitle: Gateway dá timeout\ntype: gotcha\n---\nUse PAY_MOCK=1. Ver [[usar-pnpm]].\n");
  const r = harvestWorktree(main, wt, manifest, "agente · tarefa t1");
  assert.deepEqual(r.written.map((w) => `${w.action}:${w.slug}`).sort(), ["created:gateway-timeout", "updated:deploy"]);
  const dep = parseNote(readFileSync(join(main, "memoria", "deploy.md"), "utf8"), "deploy");
  assert.match(dep.body, /aprovação manual/);
  assert.equal(dep.by, "Ana");
  assert.equal(dep.atualizadaPor, "agente · tarefa t1");
  const gw = parseNote(readFileSync(join(main, "memoria", "gateway-timeout.md"), "utf8"), "gateway-timeout");
  assert.equal(gw.by, "agente · tarefa t1");
  assert.equal(gw.origem, "agente");
  const m1 = statSync(join(main, "memoria", "deploy.md")).mtimeMs;
  const r2 = harvestWorktree(main, wt, r.manifest, "agente · tarefa t1");
  assert.equal(r2.written.length, 0);
  assert.equal(statSync(join(main, "memoria", "deploy.md")).mtimeMs, m1);
});

test("colheita: não ressuscita nota apagada no principal nem reverte nota do time puxada depois", () => {
  const { main, wt, manifest } = setupWt();
  // humano apagou "deploy" na aba; a cópia da worktree continua igual à semeada
  rmSync(join(main, "memoria", "deploy.md"));
  // nota do time chegou da nuvem DEPOIS da semeadura (a worktree nem tem)
  mkdirSync(join(main, "memoria", "time"), { recursive: true });
  writeFileSync(join(main, "memoria", "time", "ci.md"), "---\ntitle: CI\n---\nGitHub Actions.\n");
  const r = harvestWorktree(main, wt, manifest, "agente");
  assert.equal(r.written.length, 0);
  assert.ok(!existsSync(join(main, "memoria", "deploy.md")));
  assert.equal(readFileSync(join(main, "memoria", "time", "ci.md"), "utf8"), "---\ntitle: CI\n---\nGitHub Actions.\n");
});

test("colheita: principal mais novo (humano editou depois) vence; segredo é descartado", () => {
  const { main, wt, manifest, wdir } = setupWt();
  writeFileSync(join(wdir, "usar-pnpm.md"), "---\ntitle: Usar pnpm\ntype: regra\n---\nversão do agente\n");
  const mine = "---\ntitle: Usar pnpm\ntype: regra\n---\nversão do humano\n";
  writeFileSync(join(main, "memoria", "usar-pnpm.md"), mine);
  later(join(main, "memoria", "usar-pnpm.md"));
  writeFileSync(join(wdir, "chaves.md"), "---\ntitle: Chaves\n---\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx\n");
  const r = harvestWorktree(main, wt, manifest, "agente");
  assert.equal(r.written.length, 0);
  assert.deepEqual(r.secrets, ["local/chaves"]);
  assert.equal(readFileSync(join(main, "memoria", "usar-pnpm.md"), "utf8"), mine);
  assert.ok(!existsSync(join(main, "memoria", "chaves.md")));
});

test("semeadura: só-local não leva o time; symlink e .obsidian/ ficam de fora", () => {
  const main = tmp();
  mkdirSync(join(main, "memoria", "time"), { recursive: true });
  mkdirSync(join(main, "memoria", ".obsidian"), { recursive: true });
  writeFileSync(join(main, "memoria", ".obsidian", "app.json"), "{}");
  writeFileSync(join(main, "memoria", "a.md"), "---\ntitle: A\n---\na\n");
  writeFileSync(join(main, "memoria", "time", "t.md"), "---\ntitle: T\n---\nt\n");
  symlinkSync("/etc/hosts", join(main, "memoria", "link.md"));
  writeFileSync(join(main, "memoria.json"), JSON.stringify({ mode: "so-local" }));
  const wt = mkdtempSync(join(tmpdir(), "wt-"));
  const m = seedWorktree(new Brain(main), wt);
  assert.deepEqual(Object.keys(m), ["local/a"]);
  assert.ok(!existsSync(join(wt, ".cardume", "memoria", "time")));
  assert.ok(!existsSync(join(wt, ".cardume", "memoria", ".obsidian")));
  assert.ok(!existsSync(join(wt, ".cardume", "memoria", "link.md")));
});
