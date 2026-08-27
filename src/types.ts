// Tipos compartilhados do núcleo do Cardume.

export type ClarMode = "ask" | "assume" | "strict";
export type CommitMode = "per-step" | "at-end" | "never";
export type ClaimMode = "read" | "write";
export type AgentStatus =
  | "queued"
  | "running"
  | "thinking"
  | "review"
  | "conflict"
  | "done"
  | "error";

/** Papel de um agente dentro de uma tarefa. */
export type Role = "planner" | "builder" | "reviewer";

/** Um agente atribuído a uma tarefa, com o seu papel. */
export interface AgentRole {
  role: Role;
  name: string; // nome do agente (ex.: "Íris")
  engine: string; // "mock" | "claude"
  model?: string;
}

export interface TaskScope {
  owns: string[];
  offLimits: string[];
}

export interface TaskAutonomy {
  clarifications: ClarMode;
  commit: CommitMode;
  runTests: boolean;
}

/** O "briefing" declarativo de uma tarefa — vira o .cardume/TASK.yaml na worktree. */
export interface TaskSpec {
  id: string;
  title: string;
  objective: string;
  deliverables: string[];
  requirements: string[];
  scope: TaskScope;
  autonomy: TaskAutonomy;
  engine: string; // motor padrão (fallback)
  model?: string;
  agent: string; // agente-líder (exibição / retrocompat)
  /** Equipe da tarefa. Se vazio, sintetiza [{role:"builder", name:agent}]. */
  roles: AgentRole[];
}

/** Uma função descoberta no diff, para o review humano. */
export interface ReviewFunction {
  name: string;
  file: string;
  kind: string; // function | class | const | fn | def
  purpose: string;
}

/** Resumo estruturado do trabalho de uma tarefa — para revisão humana. */
export interface Review {
  summary: string;
  functions: ReviewFunction[];
  files: { path: string; add: number; del: number }[];
  howToTest: string;
  byAgent: string;
}

/** Linha persistida de uma tarefa. */
export interface TaskRow {
  id: string;
  title: string;
  objective: string;
  status: AgentStatus;
  agent: string;
  stage: string;
  roles_json: string;
  branch: string;
  worktree: string;
  base: string;
  engine: string;
  model: string | null;
  spec_json: string;
  created_at: number;
}

export interface ClaimRow {
  id: number;
  task_id: string;
  agent: string;
  path: string;
  mode: ClaimMode;
  yielded_to: string | null;
  created_at: number;
}

export interface EventRow {
  id: number;
  task_id: string;
  agent: string;
  role: string | null;
  ts: number;
  type: string;
  text: string;
  ok: number | null;
}

/** Helper para nome de função em camelCase válido a partir de um texto livre. */
export function camelId(input: string, fallback: string): string {
  const words = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 4);
  if (words.length === 0) return fallback;
  const id = words
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
  return /^[a-z]/.test(id) ? id : fallback;
}

export interface DiffRow {
  task_id: string;
  files: number;
  additions: number;
  deletions: number;
  updated_at: number;
}

/** Faz um slug curto e seguro para nome de branch/pasta a partir de um título. */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return s || "tarefa";
}
