// 21/10, usuário real: o `claude` do npm apontava pra um bin/claude.exe sem permissão de execução (postinstall
// não rodou) e o app escolhia esse em vez do ~/.local/bin/claude que funciona — todo chat dava "sem permissão".
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRunnable } from "./engine/claude.ts";

test("claudeRunnable: só serve o que dá pra executar de verdade", () => {
  const d = mkdtempSync(join(tmpdir(), "sf-claude-"));
  const ok = join(d, "ok"); writeFileSync(ok, "#!/bin/sh\necho ok\n"); chmodSync(ok, 0o755);
  const semX = join(d, "claude.exe"); writeFileSync(semX, "binário sem +x"); chmodSync(semX, 0o644);
  const vazio = join(d, "vazio"); writeFileSync(vazio, ""); chmodSync(vazio, 0o755);
  const link = join(d, "claude"); symlinkSync(semX, link);
  const linkOk = join(d, "claude-ok"); symlinkSync(ok, linkOk);
  assert.equal(claudeRunnable(ok), true);
  assert.equal(claudeRunnable(linkOk), true, "link pra executável serve");
  assert.equal(claudeRunnable(semX), false, "existe mas sem permissão de execução");
  assert.equal(claudeRunnable(link), false, "o caso do usuário: link do npm pra claude.exe sem +x");
  assert.equal(claudeRunnable(vazio), false);
  assert.equal(claudeRunnable(d), false, "pasta não é programa");
  assert.equal(claudeRunnable(join(d, "nao-existe")), false);
});
