// node --test src/memory.test.ts  (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Brain, buildContext, extractJson, extractLinks, looksSecret, parseFrontmatter, parseLegacyMemory,
  parseNote, relevantNotes, serializeNote, slugify, terms, type Note,
} from "./memory.ts";

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "brain-"));
  mkdirSync(join(d, ".cardume"), { recursive: true });
  return join(d, ".cardume");
};

const note = (slug: string, title: string, body: string, extra: Partial<Note> = {}): Note => ({
  slug, title, type: "contexto", tags: [], updated: "2026-09-28", by: "x", origem: "pessoa", body,
  links: extractLinks(body), scope: "local", mtimeMs: 0, ...extra,
});

test("slugify: sem acento, minúsculo, hífens", () => {
  assert.equal(slugify("Usar pnpm, nunca npm!"), "usar-pnpm-nunca-npm");
  assert.equal(slugify("Decisão de Arquitetura"), "decisao-de-arquitetura");
  assert.equal(slugify("   "), "nota");
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
  assert.equal(r[0], "checkout");
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
  assert.equal(n.by, "destilador · tarefa b");
  assert.equal(n.origem, "agente");
  assert.match(n.updated, /^\d{4}-\d{2}-\d{2}$/);
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
  assert.equal(b.write({ title: "chave", body: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx", by: "x" }), null);
  assert.equal(b.write({ title: "token", body: "use o token: ghp_abcdefghijklmnopqrstuvwxyz123456", by: "x" }), null);
  assert.ok(looksSecret("-----BEGIN RSA PRIVATE KEY-----"));
  assert.ok(!looksSecret("Use pnpm e rode os testes com pnpm test"));
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
