// Padrões do time (redesenho "Semana"): o motor por trás das abas Skills e Memória.
//  - "usada em": só as notas que entraram no bloco "Notas relevantes" contam (o índice não), e o uso fica em _uso.json;
//  - "sempre em tarefas de UI/código/todas" vira regra no bloco de skills do papel;
//  - `/nome` no terminal: a skill do projeto fora do git ganha um link na worktree (sem pisar na pasta do repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain, mergeUse, parseNote, usedNotes } from "./memory.ts";
import { quandoRule, roleLearningContext } from "./learn.ts";
import { linkProjectSkills } from "./terminal-integrado.ts";

const note = (slug: string, title: string, type: string, body: string) =>
  parseNote(`---\ntitle: ${title}\ntype: ${type}\ntags: []\nupdated: 2026-10-10\nby: Ana\norigem: pessoa\n---\n${body}\n`, slug, "local", 1);

test("usedNotes: regras sempre + as que batem com o pedido; nota sem relação fica de fora", () => {
  const ns = [note("frete", "Frete grátis acima de R$ 199", "regra", "no carrinho"), note("cupom", "Cupom vale sobre subtotal", "decisão", "cupom e frete"), note("cores", "Paleta do site", "contexto", "verde e cinza")];
  const u = usedNotes(ns, "aplicar cupom no carrinho").map((n) => n.slug);
  assert.ok(u.includes("frete"), "regra entra sempre");
  assert.ok(u.includes("cupom"));
  assert.ok(!u.includes("cores"));
});

test("mergeUse: tarefa mais recente primeiro, sem repetir, no máximo 12 por nota", () => {
  let m = mergeUse({}, "LOJA-1", [{ scope: "time", slug: "frete" }], 1);
  m = mergeUse(m, "LOJA-2", [{ scope: "time", slug: "frete" }], 2);
  m = mergeUse(m, "LOJA-1", [{ scope: "time", slug: "frete" }], 3);
  assert.deepEqual(m["time:frete"].map((x) => x.task), ["LOJA-1", "LOJA-2"]);
  for (let i = 0; i < 20; i++) m = mergeUse(m, "T" + i, [{ scope: "time", slug: "frete" }], 10 + i);
  assert.equal(m["time:frete"].length, 12);
  assert.deepEqual(mergeUse(null as never, "x", [], 1), {});
});

test("Brain.context(query, tarefa) grava o uso em _uso.json; amostra não conta", () => {
  const d = mkdtempSync(join(tmpdir(), "sf-padroes-"));
  try {
    const b = new Brain(d);
    mkdirSync(b.root, { recursive: true });
    writeFileSync(join(b.root, "frete.md"), "---\ntitle: Frete grátis acima de R$ 199\ntype: regra\ntags: []\nupdated: 2026-10-10\nby: Ana\norigem: pessoa\n---\ncarrinho\n");
    assert.match(b.context("carrinho", "loja-12"), /Frete grátis/);
    const u = JSON.parse(readFileSync(join(b.root, "_uso.json"), "utf8"));
    assert.equal(u["local:frete"][0].task, "loja-12");
    b.context("carrinho", "amostra-loja-12-1");
    assert.equal(JSON.parse(readFileSync(join(b.root, "_uso.json"), "utf8"))["local:frete"].length, 1);
    assert.equal(b.list().length, 1, "_uso.json não vira nota");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("quandoRule + roleLearningContext: 'sempre' vira regra; 'só quando pedir' fica como estava", () => {
  assert.equal(quandoRule(undefined), "");
  assert.match(quandoRule("UI"), /SEMPRE/);
  assert.match(quandoRule("codigo"), /código/);
  assert.match(quandoRule("todas"), /toda tarefa/);
  const ctx = roleLearningContext({ skills: [{ name: "acessibilidade", description: "contraste", quando: "UI" }, { name: "textos", description: "tom" }], owned: [], notes: [] });
  assert.match(ctx, /\*\*acessibilidade\*\*: contraste — PADRÃO DO PROJETO/);
  assert.match(ctx, /\*\*textos\*\*: tom\n/);
});

test("linkProjectSkills: liga a skill do projeto fora do git na worktree e nunca pisa na pasta do repo", () => {
  const d = mkdtempSync(join(tmpdir(), "sf-padroes-sk-"));
  try {
    const repo = join(d, "repo"), wt = join(repo, ".cardume", "worktrees", "loja-12");
    mkdirSync(join(repo, ".claude", "skills", "impeccable"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "impeccable", "SKILL.md"), "---\nname: impeccable\ndescription: telas\n---\nx\n");
    mkdirSync(join(repo, ".claude", "skills", "sem-md"), { recursive: true });
    mkdirSync(join(wt, ".claude", "skills", "testes-carrinho"), { recursive: true });
    mkdirSync(join(repo, ".claude", "skills", "testes-carrinho"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "testes-carrinho", "SKILL.md"), "---\nname: testes-carrinho\n---\n");
    const made = linkProjectSkills(repo, wt);
    assert.deepEqual(made, [".claude/skills/impeccable"]);
    assert.ok(lstatSync(join(wt, ".claude", "skills", "impeccable")).isSymbolicLink());
    assert.ok(existsSync(join(wt, ".claude", "skills", "impeccable", "SKILL.md")), "o link resolve");
    assert.deepEqual(linkProjectSkills(repo, wt), [], "segunda vez: nada novo");
    assert.deepEqual(linkProjectSkills(repo, repo), []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
