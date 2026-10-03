/**
 * CICLO DA TAREFA (decisão da mesa de 03/10/2026, `_bmad-output/party-agentes/decisao.md`). Funções PURAS:
 * quem age em cada etapa, o teto de custo, o veredito do revisor e o Relatório Starfork do PR.
 * O app tem o espelho em `app/src/js/60-ciclo.js`; a paridade é conferida pelos fixtures de
 * `tests/fixtures/ciclo-golden/` nos dois lados.
 */
import type { AgentRole } from "./types.ts";

/** Tipo de entrega — quem muda as etapas é o TIPO (não existe "modo simples"). */
export type TaskKind = "codigo" | "pagina" | "pesquisa" | "documento";
export const TASK_KINDS: TaskKind[] = ["codigo", "pagina", "pesquisa", "documento"];

export interface ReviewRound {
  round: number;
  verdict: "aprova" | "muda" | "ilegivel";
  items: string[];
  at: number;
  reviewer: string;
  agentId?: string;
  engine?: string;
  model?: string;
}
export interface NeedsYou {
  /** teto = 80% do teto; rodadas = a revisão pediria a 3ª rodada; veredito = revisor não deu aprova/muda legível */
  kind: "teto" | "rodadas" | "veredito";
  text: string;
  at: number;
  /** índice do papel que estava pra rodar (retomar daqui) */
  roleIdx?: number;
}
export interface BudgetRelease { usd: number; reason: string; at: number; capBefore: number; capAfter: number }
/** P10: o que rodou num papel. `skills` = ["nome@v3", …]. */
export interface RoleRun { role: string; agentId?: string; name: string; version: number; engine: string; model?: string; skills: string[]; at: number }

// ---------------------------------------------------------------- P7: identidade estável

/** id estável de um papel: o do catálogo; tarefa antiga sem id fica "" (sem ficha — nunca adivinha pelo nome). */
export function agentIdOf(r: Pick<AgentRole, "agentId"> | undefined): string {
  return String(r?.agentId ?? "").trim();
}

// ---------------------------------------------------------------- P10: linha do evento por papel

/** "skills ativas: a@v3, b@v1 · nyx@v4 · codex" (o modelo, quando há, vem depois do motor). */
export function rosterLine(run: Pick<RoleRun, "agentId" | "name" | "version" | "engine" | "model" | "skills">): string {
  const who = `${run.agentId || run.name}@v${run.version}`;
  const eng = [String(run.engine || "").trim() || "?", String(run.model || "").trim()].filter(Boolean).join(" · ");
  const sk = run.skills.length ? run.skills.join(", ") : "nenhuma";
  return `skills ativas: ${sk} · ${who} · ${eng}`;
}
/** Etiqueta curta do papel no PR: "nyx@v4 · codex". */
export function runTag(run: Pick<RoleRun, "agentId" | "name" | "version" | "engine" | "model">): string {
  return `${run.agentId || run.name}@v${run.version} · ${[run.engine, run.model].filter(Boolean).join(" · ")}`;
}
/** Guarda o que rodou no papel (substitui a entrada anterior do MESMO papel+agente: rodada nova = última versão). */
export function upsertRoleRun(list: RoleRun[] | undefined, run: RoleRun): RoleRun[] {
  const key = (r: RoleRun) => `${r.role}|${r.agentId || r.name}`;
  return [...(list ?? []).filter((r) => key(r) !== key(run)), run];
}

// ---------------------------------------------------------------- P6: teto sempre ligado

/** A 80% do teto a tarefa para e pergunta (veto da Carla). */
export const CAP_PAUSE_AT = 0.8;
/** Teto padrão quando nem a tarefa nem as Configurações dizem (o teto nunca fica desligado). */
export const CAP_DEFAULT_USD = 5;

/** Teto efetivo: o da tarefa (> 0); senão o padrão de Configurações (> 0); senão US$ 5. 0/negativo/lixo NÃO desliga. */
export function effectiveCap(taskCap: unknown, settingsCap?: unknown): number {
  const ok = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  return ok(taskCap) || ok(settingsCap) || CAP_DEFAULT_USD;
}
/** "ok" = segue; "pausa" = gasto ≥ 80% do teto → para antes da próxima etapa. */
export function capCheck(spentUsd: number, capUsd: number): "ok" | "pausa" {
  const cap = effectiveCap(capUsd);
  return (Number(spentUsd) || 0) >= cap * CAP_PAUSE_AT - 1e-9 ? "pausa" : "ok";
}
/** "US$ 1,62" — o mesmo formato do app (fmtCost com usdOnly). */
export function fmtUsdBr(n: number): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return "US$ " + v.toFixed(2).replace(".", ",");
}
/** Frase da pausa do teto, em palavra (aparece na faixa e na conversa). */
export function capPauseText(spentUsd: number, capUsd: number, next: string): string {
  const pct = Math.round(((Number(spentUsd) || 0) / (capUsd || 1)) * 100);
  return `A tarefa já usou ${fmtUsdBr(spentUsd)} de ${fmtUsdBr(capUsd)} (${pct}% do teto) — parei antes de ${next}. Pra seguir, libere mais escrevendo o valor e o motivo (o motivo vai pro PR).`;
}

/** Motivo de liberação vale com pelo menos 3 palavras de verdade (vai pro PR — "porque sim" não explica nada). */
export const RELEASE_MIN_WORDS = 3;
export type ReleaseParse = { ok: true; usd: number; reason: string } | { ok: false; why: string };
/** Confere valor + motivo de uma liberação (a seção inline manda os dois campos separados). */
export function releaseCheck(usd: unknown, reason: unknown): ReleaseParse {
  const n = typeof usd === "number" ? usd : Number(String(usd ?? "").trim().replace(/^US\$\s*/i, "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return { ok: false, why: "escreva quanto liberar, em dólares (ex.: 2 ou 1,50)" };
  if (n > 1000) return { ok: false, why: "valor alto demais pra uma tarefa — confira (máximo US$ 1.000 por liberação)" };
  const r = String(reason ?? "").replace(/\s+/g, " ").trim();
  const words = r.split(" ").filter((w) => /[\p{L}\p{N}]{2,}/u.test(w));
  if (words.length < RELEASE_MIN_WORDS) return { ok: false, why: "escreva o motivo em uma frase (pelo menos 3 palavras) — ele vai pro PR" };
  return { ok: true, usd: Math.round(n * 100) / 100, reason: r.slice(0, 400) };
}
/** Liberação escrita numa frase só (conversa, celular): "liberar 2,50 porque falta o teste de login". */
export function parseRelease(text: string): ReleaseParse {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  const m = t.match(/(?:US\$\s*)?(\d+(?:[.,]\d{1,2})?)/i);
  if (!m) return { ok: false, why: "escreva quanto liberar e o motivo (ex.: \"liberar 2 porque falta o teste de login\")" };
  // tira as palavras de ligação do COMEÇO ("liberar mais 2 dólares porque …" → "…")
  const FILLER = /^(liberar|libera|libere|liberando|mais|continuar|continua|seguir|com|de|us\$|usd|d[óo]lares?|reais|porque|pois|motivo:?|j[áa]|que|[—–:,;.-]+)$/i;
  const words = (t.slice(0, m.index) + " " + t.slice((m.index ?? 0) + m[0].length)).split(" ").filter(Boolean);
  while (words.length && FILLER.test(words[0])) words.shift();
  const reason = words.join(" ");
  return releaseCheck(m[1], reason);
}
