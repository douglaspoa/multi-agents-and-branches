/**
 * REVISÃO: "Pedir alteração" e "Chamar outro agente" (mesa 09/10, `_bmad-output/revisao-alteracao/mesa.md`). Funções PURAS:
 * o texto ÚNICO de um pedido de alteração (toda superfície — cabeçalho, Revisão, PR, Central/Time, terminal, MCP — monta a
 * mensagem aqui), os agentes que dá pra chamar como ETAPA EXTRA, a instrução de cada um, o registro da etapa
 * (`spec.extraStages`), a faixa com as etapas extras e a linha do Relatório Starfork do PR.
 * O app tem o espelho em `app/src/js/71-revisao-alteracao.js`; a paridade é conferida pelos fixtures de
 * `tests/fixtures/revisao-alteracao-golden/` nos dois lados.
 */
import type { StageDef } from "./lifecycle.ts";

// ---------------------------------------------------------------- pedido de alteração (fonte única)

export interface ChangeRequest {
  /** o que mudar, nas palavras da pessoa */
  text: string;
  /** requisitos afetados (índice 0-based + texto) — vazio = a tarefa toda */
  reqs?: { i: number; text: string }[];
  /** anexos já importados (caminhos relativos à worktree, ex.: .cardume/attachments/print.png) */
  attachments?: string[];
  /** de onde veio (só pro registro): cabeçalho, revisao, pr, central, time, terminal, mcp */
  from?: string;
}
/** A mensagem que vai pro agente da tarefa (mesma sessão). Vazio → "" (quem chama recusa). */
export function changeRequestText(r: ChangeRequest): string {
  const text = String(r.text ?? "").trim();
  if (!text) return "";
  const reqs = (r.reqs ?? []).filter((x) => x && String(x.text ?? "").trim());
  const att = (r.attachments ?? []).map((x) => String(x ?? "").trim()).filter(Boolean);
  const L = [`PEDIDO DE ALTERAÇÃO (revisão humana): ${text}`];
  if (reqs.length) L.push(`Requisitos afetados: ${reqs.map((x) => `R${x.i + 1} “${String(x.text).trim().slice(0, 140)}”`).join("; ")} — atualize a prova deles no requirements.json.`);
  if (att.length) L.push(`Anexos (leia antes de mexer): ${att.join(", ")}`);
  L.push("Continue nesta mesma branch, sem recomeçar: faça só o que foi pedido e diga em uma linha o que mudou.");
  return L.join("\n");
}
/** Dá pra pedir alteração / chamar agente agora? (tarefa rodando → não, com o motivo). */
export function changeGate(t: { status?: string; busy?: boolean | number | null }): { ok: boolean; why: string } {
  const s = String(t?.status ?? "");
  if (t?.busy || ["running", "thinking", "queued"].includes(s)) return { ok: false, why: "o agente está trabalhando nesta tarefa — espere o turno acabar" };
  if (s === "plan-review") return { ok: false, why: "o plano ainda espera a sua aprovação" };
  if (["draft", "cancelled"].includes(s)) return { ok: false, why: "a tarefa ainda não rodou" };
  return { ok: true, why: "" };
}

// ---------------------------------------------------------------- etapa extra: quem dá pra chamar

export type ExtraKind = "design" | "revisor" | "qa" | "seguranca" | "performance" | "docs";
export interface ExtraAgent { id: string; name: string; role: string; kind: ExtraKind; line: string; persona: string; engine?: string; model?: string }
/** Os papéis que dá pra chamar na revisão (a ordem é a da lista). `agentId` = o do catálogo; sem ele no catálogo, vale o padrão. */
export const EXTRA_KINDS: { kind: ExtraKind; role: string; agentId: string; name: string; label: string; line: string; persona: string; aliases: string[] }[] = [
  { kind: "design", role: "designer", agentId: "aria", name: "Aria", label: "design", line: "melhora a UI/UX: hierarquia, espaçamento, estados, acessibilidade — com prints de antes e depois",
    persona: "Você cuida de UX/UI, hierarquia visual e acessibilidade.", aliases: ["design", "designer", "ux", "ui", "ui/ux"] },
  { kind: "revisor", role: "reviewer", agentId: "nyx", name: "Nyx", label: "revisão", line: "revisa de novo: correção, casos de borda e clareza — corrige o que achar",
    persona: "Você revisa correção, segurança, casos de borda e clareza. Aponta o que falta.", aliases: ["revisor", "reviewer", "code-review"] },
  { kind: "qa", role: "tester", agentId: "cobalt", name: "Cobalt", label: "testes", line: "escreve e roda os testes que faltam: caminho principal e casos de borda",
    persona: "Você escreve e roda testes; cobre caminho principal e casos de borda.", aliases: ["qa", "teste", "testes", "tester", "tests"] },
  { kind: "seguranca", role: "security", agentId: "sentinela", name: "Sentinela", label: "segurança", line: "procura falhas de segurança (entrada, segredos, permissões) e corrige",
    persona: "Você revisa segurança: validação de entrada, segredos no código, permissões, injeção e dependências. Corrige o que for seguro corrigir e explica o resto.", aliases: ["seguranca", "security", "sec"] },
  { kind: "performance", role: "performance", agentId: "pulso", name: "Pulso", label: "performance", line: "acha o que deixa lento (renders, consultas, laços) e otimiza sem mudar o comportamento",
    persona: "Você otimiza desempenho sem mudar comportamento: mede antes, corta trabalho repetido, renders e consultas desnecessárias.", aliases: ["performance", "perf", "desempenho"] },
  { kind: "docs", role: "docs", agentId: "lumen", name: "Lumen", label: "documentação", line: "atualiza a documentação e o README com o que a tarefa mudou",
    persona: "Você escreve documentação concisa com exemplos de uso.", aliases: ["docs", "doc", "documentacao", "documentação", "readme"] },
];
const fold = (s: unknown) => String(s ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
type CatAgent = { id: string; name: string; role: string; engine?: string; model?: string; persona?: string };
/** A lista do "Chamar outro agente…": o agente do CATÁLOGO (Meu time) de cada papel — pelo id padrão, senão pelo papel — ou o padrão. */
export function extraStageAgents(catalog: CatAgent[] | null | undefined): ExtraAgent[] {
  const cat = Array.isArray(catalog) ? catalog : [];
  return EXTRA_KINDS.map((k) => {
    const a = cat.find((x) => x && x.id === k.agentId) ?? cat.find((x) => x && fold(x.role) === k.role);
    return a
      ? { id: a.id, name: a.name || k.name, role: k.role, kind: k.kind, line: k.line, persona: String(a.persona || k.persona), engine: a.engine, model: a.model }
      : { id: k.agentId, name: k.name, role: k.role, kind: k.kind, line: k.line, persona: k.persona };
  });
}
/** "design", "aria", "Aria", "ux", "revisor"… → o agente (null se não achar). */
export function resolveExtraAgent(catalog: CatAgent[] | null | undefined, query: string): ExtraAgent | null {
  const q = fold(query);
  if (!q) return null;
  const list = extraStageAgents(catalog);
  return list.find((a) => fold(a.id) === q || fold(a.name) === q)
    ?? list.find((a) => EXTRA_KINDS.find((k) => k.kind === a.kind)!.aliases.some((x) => fold(x) === q))
    ?? null;
}
/** Rótulo da etapa extra na faixa ("+ Design") — ≡ o mapa do taskStages (app/src/js/60-ciclo.js). */
export const STRIP_LABEL: Record<string, string> = { design: "Design", revisor: "Revisão", qa: "Testes", seguranca: "Segurança", performance: "Performance", docs: "Docs" };
/** Etapa "rodando" há mais que isto, sem turno vivo, é dada como perdida (processo caiu) e não trava a próxima. */
export const EXTRA_STALE_MS = 45 * 60_000;
export function extraIsStale(s: Pick<ExtraStage, "status" | "at"> | null | undefined, now: number): boolean { return !!s && s.status === "rodando" && now - (Number(s.at) || 0) > EXTRA_STALE_MS; }
/** Rótulo do papel em português ("design", "revisão"…). */
export function extraLabel(kind: string): string { return EXTRA_KINDS.find((k) => k.kind === kind)?.label ?? kind; }

// ---------------------------------------------------------------- etapa extra: a instrução

/** Arquivo de UI (tela/estilo/texto/asset)? O de design que toca FORA disso aparece em vermelho na Revisão. */
export function isUiPath(p: string): boolean {
  const s = String(p ?? "").toLowerCase();
  if (/\.(css|scss|sass|less|styl|html?|svg|png|jpe?g|gif|webp|ico|jsx|tsx|vue|svelte|astro|mdx?)$/.test(s)) return true;
  if (/(^|\/)(\.cardume|styles?|css|components?|ui|views?|pages?|screens?|layouts?|templates?|assets|public|static|theme|i18n|locales?|frontend|client|web)\//.test(s)) return true;
  return false;
}
export function outsideUi(files: string[]): string[] { return (files ?? []).filter((f) => !isUiPath(f)); }

/**
 * O que o agente chamado recebe. Design: usa a skill Impeccable quando o projeto tem (`.claude/skills/impeccable`),
 * fica em UI/estilo/texto e entrega prints de ANTES e DEPOIS. Todos: mesma branch, sem recomeçar, commit no fim.
 */
export function extraStagePrompt(a: Pick<ExtraAgent, "name" | "kind" | "persona">, o: { note?: string; impeccable?: boolean; reqs?: string[]; base?: string } = {}): string {
  const base = String(o.base ?? "").trim() || "main";
  const L = [`ETAPA EXTRA DA REVISÃO — você é ${a.name} (${extraLabel(a.kind)}). Esta tarefa JÁ FOI implementada nesta worktree e está pronta pra revisar;`
    + " a pessoa pediu que você passe por ela antes de aprovar. Trabalhe NESTA MESMA branch, sem recomeçar e sem refazer o que já funciona."];
  if (a.persona) L.push(`## Seu perfil\n${a.persona}`);
  if (o.note && o.note.trim()) L.push(`## O que a pessoa pediu\n${o.note.trim()}`);
  if (a.kind === "design") {
    L.push("## Como trabalhar (design)\n"
      + (o.impeccable
        ? "- Use a skill **impeccable** deste projeto (`.claude/skills/impeccable`): leia o SKILL.md e siga o processo dela (critique → polish) nas telas que esta tarefa mexeu.\n"
        : "- Faça uma crítica de UX/UI das telas que esta tarefa mexeu (hierarquia, espaçamento, estados vazios/erro/carregando, contraste, foco de teclado) e aplique as melhorias.\n")
      + "- Mexa só em interface: markup, estilos, textos e componentes visuais. NÃO mude regra de negócio, dados nem API — se precisar, explique em vez de mudar.\n"
      + "- PROVA: tire prints da tela ANTES de mexer (`.cardume/artifacts/design-antes-1.png`, …) e DEPOIS (`.cardume/artifacts/design-depois-1.png`, …), na mesma tela e tamanho.");
  } else if (a.kind === "revisor") {
    L.push(`## Como trabalhar (revisão)\n- Leia o diff da tarefa (git diff ${base}...HEAD), rode os testes e confira cada requisito. Corrija o que for claro; o que for decisão, liste no resumo.`);
  } else if (a.kind === "qa") {
    L.push("## Como trabalhar (testes)\n- Rode a suíte do projeto, escreva os testes que faltam para os requisitos desta tarefa e registre a saída real em `.cardume/artifacts/tests.md`.");
  } else if (a.kind === "seguranca") {
    L.push(`## Como trabalhar (segurança)\n- Revise o diff da tarefa (git diff ${base}...HEAD) procurando entrada sem validação, segredo no código, permissão frouxa e injeção. Corrija o que for seguro; registre o resto em .cardume/artifacts/seguranca.md.`);
  } else if (a.kind === "performance") {
    L.push("## Como trabalhar (performance)\n- Meça antes (tempo/renders/consultas), otimize sem mudar o comportamento e registre antes × depois em `.cardume/artifacts/performance.md`.");
  } else if (a.kind === "docs") {
    L.push("## Como trabalhar (documentação)\n- Atualize README/docs com o que a tarefa mudou (como usar, exemplos). Não mexa em código.");
  }
  if (o.reqs?.length) L.push(`## Requisitos da tarefa (não quebre nenhum)\n${o.reqs.map((r, i) => `R${i + 1}. ${r}`).join("\n")}`);
  L.push("## Ao terminar\nEscreva `.cardume/artifacts/etapa-extra.md` com 1 a 3 linhas do que você mudou e por quê (vira a nota no PR) e deixe tudo commitado.");
  return L.join("\n\n");
}

// ---------------------------------------------------------------- etapa extra: o registro na tarefa

export interface ExtraStage {
  id: string;
  agentId: string;
  name: string;
  kind: ExtraKind;
  role: string;
  status: "rodando" | "feito" | "falhou";
  /** quem pediu: app | terminal | mcp | cli */
  by: string;
  at: number;
  endedAt?: number;
  note?: string;
  shaBefore?: string;
  shaAfter?: string;
  /** arquivos que ESTA etapa mudou (diff shaBefore..shaAfter) */
  files?: string[];
  /** desses, os fora de UI (só conta pro design) */
  outsideUi?: string[];
  /** 1–3 linhas do que mudou (etapa-extra.md) */
  summary?: string;
  usd?: number;
}
/** Etapa nova (rodando). O id é estável por agente+ordem: "extra-aria-1", "extra-aria-2"… */
export function newExtraStage(list: ExtraStage[] | undefined, a: Pick<ExtraAgent, "id" | "name" | "kind" | "role">, o: { at: number; by: string; note?: string; shaBefore?: string }): ExtraStage {
  const n = (list ?? []).filter((s) => s.agentId === a.id).length + 1;
  return { id: `extra-${a.id}-${n}`, agentId: a.id, name: a.name, kind: a.kind, role: a.role, status: "rodando", by: o.by, at: o.at, ...(o.note ? { note: o.note.slice(0, 600) } : {}), ...(o.shaBefore ? { shaBefore: o.shaBefore } : {}) };
}
/** Fecha a etapa: arquivos, os fora de UI (design), resumo, custo. */
export function finishExtraStage(s: ExtraStage, o: { ok: boolean; at: number; shaAfter?: string; files?: string[]; summary?: string; usd?: number }): ExtraStage {
  const files = [...new Set((o.files ?? []).map((f) => String(f).trim()).filter((f) => f && !f.startsWith(".cardume/")))];
  const out = s.kind === "design" ? outsideUi(files) : [];
  return {
    ...s, status: o.ok ? "feito" : "falhou", endedAt: o.at, files,
    ...(o.shaAfter ? { shaAfter: o.shaAfter } : {}), ...(out.length ? { outsideUi: out } : {}),
    ...(o.summary && o.summary.trim() ? { summary: o.summary.replace(/\s+/g, " ").trim().slice(0, 300) } : {}),
    ...(o.usd != null ? { usd: Math.round((Number(o.usd) || 0) * 10000) / 10000 } : {}),
  };
}
/** Troca a etapa de mesmo id na lista (ou acrescenta). */
export function upsertExtraStage(list: ExtraStage[] | undefined, s: ExtraStage): ExtraStage[] {
  const L = [...(list ?? [])];
  const i = L.findIndex((x) => x.id === s.id);
  if (i >= 0) L[i] = s; else L.push(s);
  return L;
}
/** A etapa extra que está rodando (no máximo uma por vez). */
export function runningExtra(list: ExtraStage[] | undefined): ExtraStage | null { return (list ?? []).find((s) => s.status === "rodando") ?? null; }

/** Teto: a etapa extra só começa abaixo de 80% do teto da tarefa (o mesmo corte do ciclo). */
export function extraCapGate(spentUsd: number, capUsd: number): { ok: boolean; why: string } {
  const cap = Number(capUsd) > 0 ? Number(capUsd) : 5;
  const spent = Number(spentUsd) || 0;
  if (spent >= cap * 0.8 - 1e-9) {
    const brl = (n: number) => "US$ " + (Math.round(n * 100) / 100).toFixed(2).replace(".", ",");
    return { ok: false, why: `a tarefa já usou ${brl(spent)} de ${brl(cap)} (${Math.round((spent / cap) * 100)}% do teto) — libere mais teto antes de chamar outro agente` };
  }
  return { ok: true, why: "" };
}

// ---------------------------------------------------------------- faixa e Relatório

/** A faixa com as etapas extras: entram DEPOIS de Revisar e antes de Provar (ou no fim, se o tipo não tem Revisar). */
export function flowWithExtras(flow: StageDef[], extras: ExtraStage[] | undefined): StageDef[] {
  const ex = (extras ?? []).map((s): StageDef => ({ id: s.id, label: `+ ${STRIP_LABEL[s.kind] ?? s.kind}`, role: s.role, agentId: s.agentId }));
  if (!ex.length) return flow;
  let at = flow.findIndex((s) => s.id === "revisar");
  if (at < 0) at = flow.findIndex((s) => s.id === "provar") - 1;
  if (at < 0) at = flow.length - 1;
  return [...flow.slice(0, at + 1), ...ex, ...flow.slice(at + 1)];
}
const mdc = (s: string) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
/** Linhas do Relatório Starfork: "**Passou pelo agente de design (Aria):** resumo — 3 arquivos". Só as etapas que terminaram. */
export function extraReportLines(extras: ExtraStage[] | undefined): string[] {
  return (extras ?? []).filter((s) => s.status !== "rodando").map((s) => {
    const n = (s.files ?? []).length;
    const tail = s.status === "falhou" ? "não terminou" : `${n} ${n === 1 ? "arquivo" : "arquivos"}`;
    const out = s.outsideUi?.length ? ` (${s.outsideUi.length} fora de tela: ${s.outsideUi.slice(0, 3).map((f) => "`" + mdc(f) + "`").join(", ")})` : "";
    return `**Passou pelo agente de ${extraLabel(s.kind)} (${mdc(s.name)}):** ${s.summary ? mdc(s.summary) + " — " : ""}${tail}${out}`;
  });
}
