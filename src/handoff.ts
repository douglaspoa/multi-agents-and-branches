/**
 * BASTÃO POR ARQUIVO entre papéis (decisão da mesa 03/10, K2): cada papel roda numa sessão própria e passa o
 * trabalho pro próximo por `.cardume/HANDOFF.md` (o que fiz · o que falta · o que decidi), ao lado do plano,
 * do `requirements.json` e do diff — nunca pela memória da conversa. O revisor nunca herda a conversa do builder.
 *
 * Usado hoje pelo modo automático (headless, src/orchestrator.ts). PONTO DE INTEGRAÇÃO DO MODO TERMINAL
 * (branch feat/motor-terminal): ao terminar um papel, chame `passBaton()` — ele garante o HANDOFF.md (guarda:
 * "existe e não está vazio") e devolve o prompt da PRÓXIMA sessão (`rolePrompt`), pra abrir o PTY do papel
 * seguinte já com ele. Uma sessão por papel, no máximo 1 PTY vivo por tarefa.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRole, TaskSpec } from "./types.ts";
import { verdictInstructions, type TaskKind, type Verdict, FLOW_BY_KIND } from "./lifecycle.ts";

export const HANDOFF_REL = ".cardume/HANDOFF.md";
export function handoffPath(worktree: string): string {
  return join(worktree, ".cardume", "HANDOFF.md");
}

export interface HandoffInput {
  from: Pick<AgentRole, "name" | "role">;
  to?: Pick<AgentRole, "name" | "role">;
  did: string;
  pending?: string[];
  decided?: string[];
  verdict?: Verdict;
  diffStat?: string;
}
/** O HANDOFF.md que o orquestrador escreve quando o papel não escreveu (ou deixou vazio). */
export function buildHandoff(h: HandoffInput): string {
  const L = [`# Bastão — de ${h.from.name} (${h.from.role})${h.to ? ` pra ${h.to.name} (${h.to.role})` : ""}`, "", "## O que fiz", h.did.trim() || "(o papel terminou sem resumo — confira o diff e o log)", ""];
  const pend = [...(h.pending ?? [])];
  if (h.verdict?.kind === "muda") pend.unshift(...h.verdict.items);
  L.push("## O que falta", ...(pend.length ? pend.map((p) => `- ${p}`) : ["- (nada pendente do meu lado)"]), "");
  const dec = [...(h.decided ?? [])];
  if (h.verdict) dec.unshift(h.verdict.kind === "aprova" ? "Veredito: aprova" : h.verdict.kind === "muda" ? "Veredito: muda (a lista acima)" : "Veredito: ilegível");
  L.push("## O que decidi", ...(dec.length ? dec.map((d) => `- ${d}`) : ["- (nenhuma decisão registrada)"]), "");
  if (h.diffStat?.trim()) L.push("## Diff até aqui", "```", h.diffStat.trim(), "```", "");
  L.push("Leia também: .cardume/TASK.yaml, .cardume/PLAN.md (se houver) e .cardume/artifacts/requirements.json.");
  return L.join("\n") + "\n";
}
/** Guarda do bastão: o HANDOFF.md existe e não está vazio (ao menos uma linha de conteúdo além do título). */
export function handoffOk(text: string | null | undefined): boolean {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/^#/.test(l));
  return lines.join(" ").replace(/\s+/g, "").length >= 10;
}
export function readHandoff(worktree: string): string | null {
  try { return readFileSync(handoffPath(worktree), "utf8"); } catch { return null; }
}
/**
 * Garante o bastão: se o papel escreveu um HANDOFF.md bom, mantém; senão escreve o do orquestrador. Guarda uma cópia
 * por papel em .cardume/handoffs/ (histórico). Devolve o texto em vigor e se foi o orquestrador que escreveu.
 */
export function ensureHandoff(worktree: string, seq: number, fallback: HandoffInput, received?: string | null): { text: string; wrote: boolean } {
  const cur = readHandoff(worktree);
  let text = cur ?? "";
  let wrote = false;
  // o bastão que o papel RECEBEU e devolveu igual não é dele — o papel não escreveu o seu
  const stale = received != null && cur === received;
  if (!handoffOk(cur) || stale) {
    text = buildHandoff(fallback);
    mkdirSync(join(worktree, ".cardume"), { recursive: true });
    writeFileSync(handoffPath(worktree), text, "utf8");
    wrote = true;
  } else if (fallback.verdict?.kind === "muda" && fallback.verdict.items.some((x) => !text.includes(x))) {
    // o revisor escreveu o dele mas a lista do "muda" tem que chegar inteira no builder
    text = text.trimEnd() + "\n\n## Veredito da revisão: muda\n" + fallback.verdict.items.map((x) => `- ${x}`).join("\n") + "\n";
    writeFileSync(handoffPath(worktree), text, "utf8");
  }
  try {
    // numeração contínua entre execuções (aprovar o plano, liberar teto e retomar não reiniciam a contagem)
    const dir = join(worktree, ".cardume", "handoffs");
    mkdirSync(dir, { recursive: true });
    const n = Math.max(seq, readdirSync(dir).filter((f) => /^\d+-/.test(f)).length + 1);
    writeFileSync(join(dir, `${String(n).padStart(2, "0")}-${fallback.from.role}.md`), text, "utf8");
  } catch { /* histórico é melhor-esforço */ }
  return { text, wrote };
}
/** Regra que vai no contexto de TODO papel: ler o bastão ao começar e escrever o seu ao terminar. */
export function handoffRule(hasBaton: boolean): string {
  return `\n\n## BASTÃO ENTRE PAPÉIS (${HANDOFF_REL})\n` +
    (hasBaton ? `ANTES de começar, leia ${HANDOFF_REL}: é o que o papel anterior fez, o que falta e o que decidiu. Você NÃO herda a conversa dele — confira o diff e os arquivos.\n` : "") +
    `AO TERMINAR, reescreva ${HANDOFF_REL} com três seções curtas: "## O que fiz", "## O que falta" e "## O que decidi". É assim que o próximo papel sabe por onde seguir.`;
}
/** Prompt da sessão do PRÓXIMO papel (modo terminal: o 1º input do PTY novo). */
export function rolePrompt(spec: Pick<TaskSpec, "title" | "objective">, role: Pick<AgentRole, "name" | "role">, handoff: string, o: { kind?: TaskKind; round?: number } = {}): string {
  const lens = role.role === "reviewer" ? (FLOW_BY_KIND[o.kind ?? "codigo"].find((s) => s.role === "reviewer")?.lens ?? "codigo") : null;
  return `Você é ${role.name} (papel: ${role.role}) na tarefa "${spec.title}". Objetivo: ${spec.objective}\n\n` +
    `O papel anterior passou o bastão em ${HANDOFF_REL}:\n\n${handoff.trim()}\n\n` +
    `Leia .cardume/TASK.yaml e siga o seu papel a partir daqui.` +
    (lens ? verdictInstructions(lens, o.round ?? 1) : "") + handoffRule(false);
}
/** Terminou um papel: guarda do bastão + prompt do próximo (o modo terminal abre o PTY do próximo com ele). */
export function passBaton(worktree: string, seq: number, spec: Pick<TaskSpec, "title" | "objective">, from: HandoffInput, next: Pick<AgentRole, "name" | "role"> | undefined, o: { kind?: TaskKind; round?: number; received?: string | null } = {}): { handoff: string; wrote: boolean; nextPrompt: string | null } {
  const { text, wrote } = ensureHandoff(worktree, seq, { ...from, to: next }, o.received);
  return { handoff: text, wrote, nextPrompt: next ? rolePrompt(spec, next, text, o) : null };
}
export function hasHandoff(worktree: string): boolean {
  return existsSync(handoffPath(worktree));
}
