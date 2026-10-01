import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * HOME TEMPORÁRIO pra teste: a IA auxiliar (src/ai-once.ts) lê a IA padrão e as chaves de
 * ~/.constellation — sem isolar, um dev com IA padrão Codex/gateway chamaria a IA DE VERDADE nos testes
 * que passam pelo Orchestrator.aux/summarizeCommit. Use com o withEnv do teste: `{ HOME: tempHome().home }`.
 */
export function tempHome(settings: Record<string, string> = {}, llmEnv = ""): { home: string; cleanup: () => void } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "starfork-home-")));
  mkdirSync(join(home, ".constellation"), { recursive: true });
  writeFileSync(join(home, ".constellation", "settings.json"), JSON.stringify(settings));
  writeFileSync(join(home, ".constellation", "llm.env"), llmEnv);
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
