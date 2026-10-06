// node --import ./scripts/test-sem-ia-real.mjs --test …  (npm test)
//
// Testes NUNCA chamam a IA de verdade. Vários testes trocam o HOME por uma pasta temporária e rodam tarefas
// com o motor mock — mas o fim da tarefa dispara a retro (orchestrator.retroTask), que resolve o `claude`
// pelo PATH / ao lado do node (nvm) e acha o REAL. Com o HOME falso o `claude` roda
// `security find-generic-password … "Claude Code-credentials"`, o macOS não acha o chaveiro em $HOME/Library
// e abre o popup "Chaves Não Encontradas … armazenar 'douglassobreira'" (06/10) — além de gastar IA real.
//
// Aqui: CARDUME_CLAUDE/CARDUME_CODEX apontam pra um binário que só falha (o motor trata como IA indisponível).
// Teste que precisa de resposta continua pondo o próprio fake (sobrescreve e restaura o valor daqui).
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "win32" && !process.env.STARFORK_TEST_NO_AI) {
  const dir = mkdtempSync(join(tmpdir(), "starfork-sem-ia-"));
  const bin = join(dir, "ia-indisponivel");
  writeFileSync(bin, "#!/bin/sh\necho 'teste: IA real bloqueada (scripts/test-sem-ia-real.mjs)' >&2\nexit 1\n");
  chmodSync(bin, 0o755);
  process.env.STARFORK_TEST_NO_AI = bin; // filhos herdam e reusam o mesmo binário
  for (const k of ["CARDUME_CLAUDE", "CARDUME_CODEX"]) process.env[k] ??= bin;
}
