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

// ---------------------------------------------------------------- P2: o ciclo por tipo de entrega

export interface StageDef {
  id: string;
  label: string;
  /** papel que age nesta etapa (sem papel = etapa do app: prova, portão, retro) */
  role?: string;
  /** agente padrão do catálogo */
  agentId?: string;
  /** cadeado humano: 1 = aprovar o plano; 2 = portão da entrega */
  lock?: 1 | 2;
  /** etapa que só entra quando pedida (Design em Código: só se mexe em tela) */
  optional?: boolean;
  /** lente do revisor */
  lens?: "codigo" | "documento";
}
const PLANO: StageDef = { id: "plano", label: "Plano", role: "planner", agentId: "vega", lock: 1 };
const DESIGN: StageDef = { id: "design", label: "Design", role: "designer", agentId: "aria" };
const CONSTRUIR: StageDef = { id: "construir", label: "Construir", role: "builder", agentId: "iris" };
const ESCREVER: StageDef = { id: "escrever", label: "Escrever", role: "docs", agentId: "lumen" };
const REVISAR_COD: StageDef = { id: "revisar", label: "Revisar", role: "reviewer", agentId: "nyx", lens: "codigo" };
const REVISAR_DOC: StageDef = { id: "revisar", label: "Conferir", role: "reviewer", agentId: "nyx", lens: "documento" };
const PROVAR: StageDef = { id: "provar", label: "Provar" };
const ENTREGAR: StageDef = { id: "entregar", label: "Entregar", lock: 2 };
const RETRO: StageDef = { id: "retro", label: "Retro" };

/** FONTE ÚNICA do ciclo por tipo (a tabela da decisão). Etapa que não vale pro tipo NÃO aparece. ≡ 60-ciclo.js. */
export const FLOW_BY_KIND: Record<TaskKind, StageDef[]> = {
  codigo: [PLANO, { ...DESIGN, optional: true }, CONSTRUIR, REVISAR_COD, PROVAR, ENTREGAR, RETRO],
  pagina: [PLANO, DESIGN, CONSTRUIR, REVISAR_COD, PROVAR, ENTREGAR, RETRO],
  pesquisa: [PLANO, ESCREVER, REVISAR_DOC, PROVAR, ENTREGAR, RETRO],
  documento: [PLANO, ESCREVER, REVISAR_DOC, PROVAR, ENTREGAR, RETRO],
};
export const KIND_LABEL: Record<TaskKind, string> = { codigo: "Código", pagina: "Página/tela", pesquisa: "Pesquisa", documento: "Documento" };
/** Nome de equipe pronta pelo tipo (P16 fundida na P2). */
export const KIND_TEAM: Record<TaskKind, string> = { codigo: "Feature com revisão", pagina: "Página simples", pesquisa: "Pesquisa conferida", documento: "Relatório conferido" };

/** Tipo da tarefa: o gravado; senão deduzido do tipo de branch (design → página, docs → documento, invest → pesquisa). */
export function taskKindOf(spec: { taskKind?: unknown; branchType?: unknown } | null | undefined): TaskKind {
  const k = String(spec?.taskKind ?? "");
  if ((TASK_KINDS as string[]).includes(k)) return k as TaskKind;
  const b = String(spec?.branchType ?? "").toLowerCase();
  return b === "design" ? "pagina" : b === "docs" ? "documento" : b === "invest" ? "pesquisa" : "codigo";
}
/** Papéis (spec.roles) do tipo, com os agentes do catálogo. `withDesign` liga o Design opcional do Código. */
export function rolesForKind(kind: TaskKind, catalog: { id: string; name: string; role: string; engine: string; model?: string; persona?: string }[], o: { engine?: string; model?: string; withDesign?: boolean } = {}): AgentRole[] {
  const out: AgentRole[] = [];
  for (const st of FLOW_BY_KIND[kind]) {
    if (!st.role || (st.optional && !o.withDesign)) continue;
    const a = catalog.find((x) => x.id === st.agentId) ?? catalog.find((x) => x.role === st.role);
    if (!a) continue;
    out.push({ role: a.role === st.role ? a.role : st.role, agentId: a.id, name: a.name, engine: o.engine ?? a.engine, model: o.model ?? a.model, persona: a.persona });
  }
  return diversifyReviewer(out);
}
/** Papel que PRODUZ o que o revisor confere (volta pra ele no "muda"): o último builder/docs/designer antes de `i`. */
export function producerIndex(roles: { role: string }[], reviewerIdx: number): number {
  for (let j = reviewerIdx - 1; j >= 0; j--) if (["builder", "docs", "designer"].includes(roles[j].role)) return j;
  return -1;
}

// ---------------------------------------------------------------- P5 (parte da P3): revisor independente

const sameModel = (a?: string, b?: string) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
/** O revisor roda no MESMO motor e modelo do builder? (revisão menos independente) */
export function reviewerIsSame(builder: Pick<AgentRole, "engine" | "model"> | undefined, reviewer: Pick<AgentRole, "engine" | "model"> | undefined): boolean {
  if (!builder || !reviewer) return false;
  return String(builder.engine).toLowerCase() === String(reviewer.engine).toLowerCase() && sameModel(builder.model, reviewer.model);
}
export const SAME_REVIEWER_WARNING = "revisor igual ao builder — revisão menos independente";
/** Quando dá (Claude: outro modelo), põe o revisor num modelo diferente do builder. Senão mantém (e a UI avisa). */
export function diversifyReviewer(roles: AgentRole[]): AgentRole[] {
  const ri = roles.findIndex((r) => r.role === "reviewer");
  const pi = ri >= 0 ? producerIndex(roles, ri) : -1;
  if (ri < 0 || pi < 0 || !reviewerIsSame(roles[pi], roles[ri])) return roles;
  const b = roles[pi];
  if (String(b.engine).toLowerCase().startsWith("claude")) {
    const m = String(b.model ?? "").toLowerCase();
    const alt = m.includes("sonnet") ? "opus" : "sonnet";
    return roles.map((r, i) => (i === ri ? { ...r, model: alt } : r));
  }
  return roles;
}

// ---------------------------------------------------------------- P3: veredito do revisor

export const MAX_REVIEW_ROUNDS = 2;
export type Verdict = { kind: "aprova" | "muda" | "ilegivel"; items: string[] };
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;
/**
 * Lê o veredito do revisor. Aceita JSON {"veredito":"aprova"|"muda","itens":[…]} ou uma linha
 * "VEREDITO: aprova" / "VEREDITO: muda" seguida da lista (ou "muda: a; b"). NUNCA vira "aprova" por omissão:
 * sem linha, com duas respostas diferentes, ou "muda" sem nenhum item → ilegível.
 */
export function parseVerdict(text: string): Verdict {
  const t = String(text ?? "").replace(/\r\n/g, "\n");
  const bad: Verdict = { kind: "ilegivel", items: [] };
  if (!t.trim()) return bad;
  const j = (() => { const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a < 0 || b <= a) return null; try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; } })();
  if (j && typeof j === "object" && typeof j.veredito === "string") {
    const k = j.veredito.trim().toLowerCase();
    const items = (Array.isArray(j.itens) ? j.itens : []).map((x: unknown) => String(x ?? "").trim()).filter(Boolean).slice(0, 20);
    if (k === "aprova") return { kind: "aprova", items: [] };
    if (k === "muda") return items.length ? { kind: "muda", items } : bad;
    return bad;
  }
  const lines = t.split("\n");
  const re = /^\s*(?:[#>*_\s]*)veredito(?:[*_\s]*)\s*[:：-]\s*[*_]*\s*(aprova|muda)\b[*_]*\s*[:：-]?\s*(.*)$/i;
  const hits = lines.map((l, i) => ({ i, m: l.match(re) })).filter((x) => x.m);
  const kinds = new Set(hits.map((h) => h.m![1].toLowerCase()));
  if (kinds.size !== 1) return bad;
  const kind = [...kinds][0] as "aprova" | "muda";
  if (kind === "aprova") return { kind, items: [] };
  const h = hits[hits.length - 1];
  const items: string[] = [];
  const inline = h.m![2].trim();
  if (inline) items.push(...inline.split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean));
  for (let i = h.i + 1; i < lines.length; i++) {
    const m = lines[i].match(BULLET);
    if (m) { items.push(m[1]); continue; }
    if (lines[i].trim() && items.length) break; // a lista acabou
  }
  return items.length ? { kind, items: items.slice(0, 20) } : bad;
}
/** O que fazer com o veredito da rodada `round` (1-based). */
export function reviewDecision(round: number, v: Verdict): "segue" | "refaz" | "precisa-rodadas" | "precisa-veredito" {
  if (v.kind === "aprova") return "segue";
  if (v.kind === "ilegivel") return "precisa-veredito";
  return round < MAX_REVIEW_ROUNDS ? "refaz" : "precisa-rodadas";
}
/** Instrução do revisor: a lente do tipo + o formato do veredito (vai no contexto do papel). */
export function verdictInstructions(lens: "codigo" | "documento", round: number): string {
  const what = lens === "codigo"
    ? "LENTE: CÓDIGO — leia o diff (git diff <base>...HEAD), RODE os testes do projeto e confira cada requisito do TASK.yaml contra o que mudou."
      + " Confira também o \"code\" de cada requisito no .cardume/artifacts/requirements.json (arquivo + faixa de linhas): se apontar trecho errado ou faltar, peça a correção no \"muda\"."
    : "LENTE: DOCUMENTO — confira as FONTES (link e data em cada afirmação), os NÚMEROS (conta e origem), o PORTUGUÊS e se o roteiro do plano foi atendido seção por seção.";
  return `\n\n## SUA REVISÃO TEM VEREDITO (rodada ${round} de ${MAX_REVIEW_ROUNDS})\n${what}\n` +
    `Ao terminar, escreva .cardume/VEREDITO.md começando com UMA destas linhas:\n` +
    `- \`VEREDITO: aprova\` — está pronto pra prova;\n` +
    `- \`VEREDITO: muda\` — seguida de uma lista com "- " de cada mudança concreta que o builder precisa fazer.\n` +
    (lens === "codigo" ? `Item que aponta código começa com \`caminho:linha — \` (ex.: \`- src/lib/horarios.ts:13 — use o fuso do estúdio\`): o comentário aparece preso ao trecho na Revisão do app.\n` : "") +
    `Sem essa linha a revisão é tratada como ilegível e a tarefa para pra pessoa decidir. Não aprove por educação: "muda" volta pro builder (no máximo ${MAX_REVIEW_ROUNDS} rodadas).`;
}
/** Frase da rodada pra faixa e pra conversa: "Revisão 1/2 (Nyx): muda — 2 itens". */
export function roundText(r: Pick<ReviewRound, "round" | "verdict" | "items" | "reviewer">): string {
  const v = r.verdict === "aprova" ? "aprova" : r.verdict === "muda" ? `muda — ${r.items.length} ${r.items.length === 1 ? "item" : "itens"}` : "veredito ilegível";
  return `Revisão ${r.round}/${MAX_REVIEW_ROUNDS} (${r.reviewer}): ${v}`;
}

// ---------------------------------------------------------------- Relatório Starfork (PR)

export interface ReportData {
  requirements: { text: string; status: "provado" | "sem prova" | "adiado"; evidence: string[] }[];
  /** "aprovar sem prova" — quem e por quê */
  noProofReason?: string;
  noProofBy?: string;
  /** a pessoa seguiu pra prova sem nova revisão (3ª rodada/veredito ilegível) — o motivo */
  reviewOverride?: string;
  costByRole: { role: string; name: string; usd: number }[];
  totalUsd: number;
  capUsd: number;
  releases: BudgetRelease[];
  rounds: Pick<ReviewRound, "round" | "verdict" | "items" | "reviewer">[];
  runs: Pick<RoleRun, "role" | "agentId" | "name" | "version" | "engine" | "model">[];
  /** F5 · P14: as regras da política da organização que valiam na tarefa (ausente = sem política) */
  orgPolicy?: string[];
  /** provas publicadas no branch `starfork-provas` (pr-provas.ts): nome da evidência → link (imagem vira miniatura) */
  proofs?: Record<string, { url: string; kind: "img" | "video" }>;
  /** por que as provas não foram anexadas (ou o que ficou de fora) — vai em itálico abaixo da tabela */
  proofNote?: string;
  /** etapas extras da revisão ("Passou pelo agente de design (Aria): …") — já formatadas por extraReportLines */
  extraLines?: string[];
}
const ROLE_PT: Record<string, string> = { planner: "plano", builder: "construção", reviewer: "revisão", designer: "design", docs: "escrita", tester: "testes", retro: "retro", investigator: "investigação" };
const md = (s: string) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
/** O Relatório Starfork que vai no corpo do PR (≡ cicloReport do app; fixture ciclo-golden/relatorio.json). */
export function starforkReport(d: ReportData): string {
  const L: string[] = ["## Relatório Starfork", ""];
  if (d.requirements.length) {
    L.push("**Requisitos × provas**", "", "| Requisito | Prova |", "|---|---|");
    const lk = d.proofs ?? {};
    const code = (e: string) => "`" + md(e) + "`";
    // com prova publicada: miniatura clicável (imagem) / link (vídeo) + o nome como legenda; sem: a lista de nomes
    const cell = (r: ReportData["requirements"][number], i: number) => r.status !== "provado" ? r.status
      : !r.evidence.some((e) => lk[e]) ? `provado — ${r.evidence.map(code).join(", ") || "evidência no disco"}`
      : "provado<br>" + r.evidence.map((e) => !lk[e] ? code(e) : lk[e].kind === "img" ? `![R${i + 1}](${lk[e].url})<br>${code(e)}` : `[▶ ${md(e)}](${lk[e].url})`).join("<br>");
    d.requirements.forEach((r, i) => L.push(`| ${md(r.text)} | ${cell(r, i)} |`));
    L.push("");
    if (Object.keys(lk).length) L.push("*Provas no branch `starfork-provas` deste repositório (fora do código do PR) — clique na miniatura pra ver no tamanho real.*", "");
  }
  if (d.proofNote) L.push(`*${md(d.proofNote)}*`, "");
  if (d.noProofReason) L.push(`**Aprovado sem prova**${d.noProofBy ? ` por ${md(d.noProofBy)}` : ""}: ${md(d.noProofReason)}`, "");
  if (d.reviewOverride) L.push(`**Seguiu sem nova revisão:** ${md(d.reviewOverride)}`, "");
  if (d.rounds.length) L.push(`**Revisão:** ${d.rounds.map((r) => `rodada ${r.round} (${md(r.reviewer)}) — ${r.verdict === "aprova" ? "aprova" : r.verdict === "muda" ? `muda (${r.items.length})` : "ilegível"}`).join(" · ")}`, "");
  for (const x of d.extraLines ?? []) L.push(x, "");
  if (d.runs.length) L.push(`**Versões:** ${d.runs.map((r) => `${ROLE_PT[r.role] ?? r.role} \`${runTag(r)}\``).join(" · ")}`, "");
  if (d.orgPolicy?.length) L.push(`**Política da organização:** ${d.orgPolicy.map(md).join(" · ")}`, "");
  return L.join("\n").trimEnd() + "\n";
}
