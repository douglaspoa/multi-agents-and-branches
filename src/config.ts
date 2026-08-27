import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentRole, Workflow } from "./types.ts";

export interface CardumeConfig {
  agents: Agent[];
  workflows: Workflow[];
}

/** Catálogo padrão de agentes e workflows (usado quando não há cardume.config.json). */
export const DEFAULT_CONFIG: CardumeConfig = {
  agents: [
    { id: "vega", name: "Vega", role: "planner", engine: "claude", color: "#e5c07b", persona: "Você planeja a tarefa em passos claros e lista riscos e decisões. Não implementa." },
    { id: "iris", name: "Íris", role: "builder", engine: "claude", color: "#39d46a", persona: "Você implementa com código limpo e o menor diff que resolve. Cobre o caminho principal." },
    { id: "nyx", name: "Nyx", role: "reviewer", engine: "claude", color: "#56b6c2", persona: "Você revisa correção, segurança, casos de borda e clareza. Aponta o que falta." },
    { id: "aria", name: "Aria", role: "designer", engine: "claude", color: "#b48ead", persona: "Você cuida de UX/UI, hierarquia visual e acessibilidade. Propõe a interface antes do código." },
    { id: "cobalt", name: "Cobalt", role: "tester", engine: "claude", color: "#5b9dff", persona: "Você escreve e roda testes; cobre caminho principal e casos de borda." },
    { id: "lumen", name: "Lumen", role: "docs", engine: "claude", color: "#d19a66", persona: "Você escreve documentação concisa com exemplos de uso." },
  ],
  workflows: [
    { id: "feature", name: "Feature completa", steps: ["vega", "iris", "nyx"] },
    { id: "design-first", name: "Design primeiro", steps: ["aria", "vega", "iris", "nyx"] },
    { id: "quickfix", name: "Fix rápido", steps: ["iris"] },
    { id: "review-only", name: "Só revisão", steps: ["nyx"] },
    { id: "full", name: "Completo (design → testes)", steps: ["aria", "vega", "iris", "cobalt", "nyx"] },
  ],
};

export function configPath(repo: string): string {
  return join(repo, "cardume.config.json");
}

/** Catálogo global do usuário (~/.cardume/agents.json), disponível em todo projeto. */
function loadGlobalCatalog(): { agents: Agent[]; workflows: Workflow[] } {
  const p = join(homedir(), ".cardume", "agents.json");
  if (!existsSync(p)) return { agents: [], workflows: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return { agents: raw.agents ?? [], workflows: raw.workflows ?? [] };
  } catch {
    return { agents: [], workflows: [] };
  }
}

/** Junta o catálogo do repo com o global (repo tem precedência por id). */
function mergeCatalog(base: CardumeConfig): CardumeConfig {
  const g = loadGlobalCatalog();
  const agentIds = new Set(base.agents.map((a) => a.id));
  const wfIds = new Set(base.workflows.map((w) => w.id));
  return {
    agents: [...base.agents, ...g.agents.filter((a) => a.id && !agentIds.has(a.id))],
    workflows: [...base.workflows, ...g.workflows.filter((w) => w.id && !wfIds.has(w.id))],
  };
}

export function loadConfig(repo: string): CardumeConfig {
  const f = configPath(repo);
  let base: CardumeConfig;
  if (!existsSync(f)) {
    base = DEFAULT_CONFIG;
  } else {
    try {
      const raw = JSON.parse(readFileSync(f, "utf8"));
      base = { agents: raw.agents ?? DEFAULT_CONFIG.agents, workflows: raw.workflows ?? DEFAULT_CONFIG.workflows };
    } catch {
      base = DEFAULT_CONFIG;
    }
  }
  return mergeCatalog(base);
}

/** Escreve o catálogo padrão se ainda não existir. Retorna true se criou. */
export function ensureConfig(repo: string): boolean {
  const f = configPath(repo);
  if (existsSync(f)) return false;
  writeFileSync(f, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  return true;
}

function toRole(a: Agent, engineOverride?: string, model?: string): AgentRole {
  return { role: a.role, name: a.name, engine: engineOverride ?? a.engine, model: model ?? a.model, persona: a.persona };
}

export function resolveWorkflow(cfg: CardumeConfig, workflowId: string, engineOverride?: string, model?: string): AgentRole[] {
  const wf = cfg.workflows.find((w) => w.id === workflowId);
  if (!wf) throw new Error(`workflow "${workflowId}" não existe (veja: cardume workflows)`);
  return wf.steps.map((aid) => {
    const a = cfg.agents.find((x) => x.id === aid);
    if (!a) throw new Error(`agente "${aid}" (do workflow "${workflowId}") não existe`);
    return toRole(a, engineOverride, model);
  });
}

export function resolveAgents(cfg: CardumeConfig, ids: string[], engineOverride?: string, model?: string): AgentRole[] {
  return ids.map((id) => {
    const a = cfg.agents.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
    if (!a) throw new Error(`agente "${id}" não existe (veja: cardume agents)`);
    return toRole(a, engineOverride, model);
  });
}
