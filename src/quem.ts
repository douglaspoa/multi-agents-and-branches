// QUEM ESTÁ FALANDO — fonte única da identidade que vai pra IA (bug 14/10: um colega mandou "teste" e a IA o chamou
// pelo nome do dono do time). Quem fala é SEMPRE a pessoa logada NESTA máquina: o app grava o nome dela (personName da
// conta da sessão) em ~/.constellation/quem.json ao entrar/trocar de conta e apaga ao sair. Nada de git user.name, usuário
// do sistema ou nome fixo: sem conta logada, a IA trata por "você" e não chuta nome.
// O texto é IGUAL ao do Rust (app/src-tauri/src/quem.rs) — conferido pelo fixture tests/fixtures/memoria-golden/quem.json.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function quemFile(): string {
  return join(homedir(), ".constellation", "quem.json");
}

const NOT_A_NAME = new Set(["você", "voce", "pessoa sem nome", "carregando…", "carregando...", "—", "-"]);

/** Nome limpo (sem quebra de linha, crase ou controle; até 80 caracteres) ou "" quando não é um nome de verdade. PURA. */
export function cleanName(raw: unknown): string {
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f-\u009f`]/g, " ").replace(/\s+/g, " ").trim();
  const n = Array.from(s).slice(0, 80).join("").trim();
  return NOT_A_NAME.has(n.toLowerCase()) ? "" : n;
}

/** Nome da pessoa logada nesta máquina ("" = sem conta). Lido a cada chamada: trocar de conta vale no turno seguinte. */
export function readSpeaker(file = quemFile()): string {
  try { return cleanName(JSON.parse(readFileSync(file, "utf8"))?.name); } catch { return ""; }
}

const OTHERS =
  "Outros nomes que aparecerem (memória do projeto, convenções e aprendizados do time, histórico, TASK.yaml, HANDOFF, EPIC.md, cartões e issues) " +
  "são de OUTRAS pessoas do time — quem escreveu ou foi citado —, nunca de quem está falando com você agora.";

/** Bloco "quem está falando" pro system prompt. PURA (mesmo texto do Rust). */
export function speakerLine(name: string): string {
  const n = cleanName(name);
  const who = n
    ? `Você está conversando com ${n} — a pessoa logada no Starfork nesta máquina. As mensagens desta conversa são de ${n}: trate por esse nome (ou por "você").`
    : `A pessoa nesta máquina não está com conta logada no Starfork: você não sabe o nome dela — trate por "você" e NÃO chute um nome (nem pelo git, pelo sistema, pela memória ou pelo histórico).`;
  return `## Quem está falando com você\n${who}\n${OTHERS}\n`;
}

/** Marca curta pra mensagem de um turno retomado (--resume não reenvia o system prompt). PURA. */
export function speakerTag(name: string): string {
  const n = cleanName(name);
  return n
    ? `[Mensagem de ${n}, a pessoa logada no Starfork nesta máquina — é com ${n} que você está falando agora.]`
    : `[Mensagem da pessoa nesta máquina, sem conta logada no Starfork — trate por "você", sem chutar nome.]`;
}
