/**
 * POLÍTICA DA ORGANIZAÇÃO PARA AGENTES (F5 · P14 da decisão da mesa de 03/10/2026) — recurso do plano Empresa.
 * Guardada em `orgs.policy.agentes` (nuvem, escrita só por owner/admin). O app lê com sessão + org Empresa ativa e
 * manda pro motor no `cardume new --org-policy <json>`; sem login (Grátis) nada daqui roda — o local é livre.
 *
 * Funções PURAS ≡ app/src/js/63-politica-org.js (paridade pelo fixture tests/fixtures/ciclo-golden/politica.json).
 */
import type { AgentRole, TaskSpec } from "./types.ts";
import { diversifyReviewer, producerIndex, reviewerIsSame } from "./lifecycle.ts";

export interface OrgAgentPolicy {
  /** toda tarefa passa pelo portão: sem PR automático e com prova */
  portao: boolean;
  /** teto máximo por tarefa (US$); null = sem máximo da org (vale o teto de sempre) */
  tetoMaxUsd: number | null;
  /** toda equipe tem revisor */
  revisor: boolean;
  /** o revisor roda em motor ou modelo diferente de quem produz */
  revisorDiferente: boolean;
  /** quem aprova aprendizado compartilhado com o time */
  aprovaAprendizado: "admins" | "membros";
}

export const ORG_POLICY_DEFAULT: OrgAgentPolicy = { portao: false, tetoMaxUsd: null, revisor: false, revisorDiferente: false, aprovaAprendizado: "admins" };

/** Normaliza o que veio da nuvem (lixo/ausente → padrão: nada exigido). Aceita `{ agentes: {...} }` ou o bloco direto. */
export function orgAgentPolicy(raw: unknown): OrgAgentPolicy {
  const o0 = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const o = o0.agentes && typeof o0.agentes === "object" ? (o0.agentes as Record<string, unknown>) : o0;
  const teto = Number(o.tetoMaxUsd);
  return {
    portao: o.portao === true,
    tetoMaxUsd: Number.isFinite(teto) && teto > 0 ? Math.round(teto * 100) / 100 : null,
    revisor: o.revisor === true,
    revisorDiferente: o.revisorDiferente === true,
    aprovaAprendizado: o.aprovaAprendizado === "membros" ? "membros" : "admins",
  };
}

/** A política tem alguma regra que muda a tarefa? (sem nenhuma, o motor nem recebe a flag) */
export function policyActive(p: OrgAgentPolicy): boolean {
  return p.portao || p.tetoMaxUsd != null || p.revisor || p.revisorDiferente;
}

const usd = (n: number) => "US$ " + (Math.round(n * 100) / 100).toFixed(2).replace(".", ",");

/** As regras em frases de gente (a seção da aba Meu time e o Relatório do PR). */
export function policyRules(p: OrgAgentPolicy): string[] {
  const out: string[] = [];
  if (p.portao) out.push("toda tarefa passa pelo portão — nenhum PR abre sozinho e a prova é obrigatória");
  if (p.tetoMaxUsd != null) out.push(`teto de no máximo ${usd(p.tetoMaxUsd)} por tarefa`);
  if (p.revisor) out.push("toda equipe tem um revisor");
  if (p.revisorDiferente) out.push("o revisor roda em motor ou modelo diferente de quem constrói");
  out.push(p.aprovaAprendizado === "membros" ? "aprendizado compartilhado com o time é aprovado por outra pessoa da organização" : "aprendizado compartilhado com o time é aprovado por um admin da organização");
  return out;
}

export interface PolicyIssue { rule: "revisor" | "revisorDiferente"; text: string }

/** O que uma equipe (papéis em ordem) fere da política — em palavra. Vazio = pode rodar. */
export function teamPolicyIssues(roles: Pick<AgentRole, "role" | "name" | "engine" | "model">[], p: OrgAgentPolicy): PolicyIssue[] {
  const out: PolicyIssue[] = [];
  const rs = Array.isArray(roles) ? roles : [];
  const ri = rs.findIndex((r) => r.role === "reviewer");
  if (p.revisor && ri < 0) out.push({ rule: "revisor", text: "a política da organização exige um revisor nesta equipe" });
  if (p.revisorDiferente && ri >= 0) {
    const pi = producerIndex(rs, ri);
    if (pi >= 0 && reviewerIsSame(rs[pi], rs[ri])) out.push({ rule: "revisorDiferente", text: `a política da organização exige o revisor em motor ou modelo diferente de quem constrói (${rs[ri].name} e ${rs[pi].name} estão no mesmo)` });
  }
  return out;
}

export interface ApplyResult { spec: TaskSpec; blocked: string; notes: string[] }

/**
 * Aplica a política na spec que vai nascer (motor, `cardume new`). Puro: devolve a spec ajustada, as frases do que
 * mudou e `blocked` (≠ "") quando não dá pra cumprir — aí a tarefa NÃO é criada.
 */
export function applyOrgPolicy(spec0: TaskSpec, p: OrgAgentPolicy, catalog: { id: string; name: string; role: string; engine: string; model?: string; persona?: string }[] = []): ApplyResult {
  const spec: TaskSpec = { ...spec0, roles: [...(spec0.roles ?? [])], artifacts: spec0.artifacts ? [...spec0.artifacts] : undefined };
  const notes: string[] = [];
  if (!policyActive(p)) return { spec, blocked: "", notes };
  if (p.revisor && !spec.roles.some((r) => r.role === "reviewer")) {
    const a = catalog.find((x) => x.role === "reviewer");
    if (!a) return { spec, blocked: "a política da organização exige um revisor e o catálogo deste projeto não tem nenhum agente revisor", notes };
    spec.roles.push({ role: "reviewer", agentId: a.id, name: a.name, engine: a.engine, model: a.model, persona: a.persona });
    notes.push(`a política da organização pôs ${a.name} pra revisar`);
  }
  if (p.revisorDiferente) {
    const before = spec.roles.map((r) => r.model ?? "").join("|");
    spec.roles = diversifyReviewer(spec.roles);
    const ri = spec.roles.findIndex((r) => r.role === "reviewer");
    if (before !== spec.roles.map((r) => r.model ?? "").join("|") && ri >= 0) notes.push(`a política da organização pôs ${spec.roles[ri].name} num modelo diferente de quem constrói (${spec.roles[ri].model})`);
    const left = teamPolicyIssues(spec.roles, { ...p, revisor: false });
    if (left.length) return { spec, blocked: left[0].text + " — troque o motor ou o modelo do revisor na ficha dele", notes };
  }
  if (p.tetoMaxUsd != null) {
    const cur = Number(spec.budgetUsd);
    const next = Number.isFinite(cur) && cur > 0 ? Math.min(cur, p.tetoMaxUsd) : p.tetoMaxUsd;
    if (next !== spec.budgetUsd) notes.push(`teto da tarefa ${usd(next)} (máximo da política da organização)`);
    spec.budgetUsd = next;
  }
  if (p.portao) {
    if (spec.autoPr === "auto") { spec.autoPr = "ask"; notes.push("o PR não abre sozinho: a política da organização exige o portão"); }
    const arts = spec.artifacts ?? [];
    if (!arts.some((x) => x.kind === "proof")) { spec.artifacts = [...arts, { kind: "proof", name: "proof", desc: "Prova comprovando a solução" }]; notes.push("prova obrigatória pela política da organização"); }
  }
  spec.orgPolicy = { rules: policyRules(p), ...(p.tetoMaxUsd != null ? { tetoMaxUsd: p.tetoMaxUsd } : {}), ...(p.portao ? { portao: true } : {}) };
  return { spec, blocked: "", notes };
}
