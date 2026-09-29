// node --test src/paths-windows.test.ts  (npm test)
// Caminhos com "\" (Windows): o motor partia caminho só por "/" em dois lugares.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refName } from "./orchestrator.ts";
import { browserProfileFor, lastSeg } from "./engine/claude.ts";

test("anexo com caminho do Windows vira só o nome do arquivo em refs/", () => {
  assert.equal(refName("C:\\Users\\ana\\Desktop\\spec.pdf", []), "spec.pdf");
  assert.equal(refName("/Users/ana/spec.pdf", []), "spec.pdf");
  // mesmo nome de duas origens → prefixa a pasta (nos dois separadores)
  assert.equal(refName("C:\\repo\\.cardume\\artifacts\\t2\\ARCHITECTURE.md", ["ARCHITECTURE.md"]), "t2-ARCHITECTURE.md");
  assert.equal(refName("/r/.cardume/artifacts/t3/ARCHITECTURE.md", ["ARCHITECTURE.md"]), "t3-ARCHITECTURE.md");
  assert.equal(refName("pasta/", []), "pasta");
});

test("filtro de cópia do perfil do Chrome reconhece o lockfile com separador do Windows", () => {
  assert.equal(lastSeg("C:\\Users\\ana\\.constellation\\browser\\repo\\lockfile"), "lockfile");
  assert.equal(lastSeg("/home/ana/.constellation/browser/repo/SingletonLock"), "SingletonLock");
});

test("perfil do navegador é UM por repo mesmo com worktree em caminho do Windows", () => {
  const home = mkdtempSync(join(tmpdir(), "starfork-prof-"));
  const old = process.env.HOME, oldUp = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home; // Node usa USERPROFILE no Windows
  try {
    const a = browserProfileFor("C:\\dev\\loja\\.cardume\\worktrees\\t1", "t1");
    const b = browserProfileFor("C:\\dev\\loja\\.cardume\\worktrees\\t2", "t2");
    assert.equal(a, b, "antes: cada tarefa ganhava um perfil (login perdido a cada tarefa)");
    assert.match(a, /C_dev_loja$/);
  } finally {
    if (old === undefined) delete process.env.HOME; else process.env.HOME = old;
    if (oldUp === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUp;
    rmSync(home, { recursive: true, force: true });
  }
});
