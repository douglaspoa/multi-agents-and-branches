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
  | "error"
  | "merged";

/** Papel/especialidade de um agente. Aberto — comuns: planner, builder,
 * reviewer, designer, tester, security, docs. */
export type Role = string;

/** Um agente atribuído a uma tarefa, com o seu papel. */
export interface AgentRole {
  role: Role;
  name: string; // nome do agente (ex.: "Íris")
  engine: string; // "mock" | "claude"
  model?: string;
  persona?: string; // instrução de perfil injetada no system prompt
}

/** Definição reutilizável de um agente (do cardume.config.json). */
export interface Agent {
  id: string;
  name: string;
  role: Role;
  engine: string;
  model?: string;
  persona?: string;
  color?: string;
}

/** Um workflow = sequência de agentes (por id) para tocar uma tarefa. */
export interface Workflow {
  id: string;
  name: string;
  steps: string[]; // ids de agentes, em ordem
}

export interface TaskScope {
  owns: string[];
  offLimits: string[];
}

export type ApprovalMode = "auto" | "ask";

/** Política do barramento ao colidir escopo (write × write). */
export type BusPolicy = "first-claim-wins" | "human-tiebreak" | "sequential-lock";

export interface TaskAutonomy {
  clarifications: ClarMode;
  commit: CommitMode;
  runTests: boolean;
  /** "auto" = aprova as ações do agente sozinho; "ask" = pede aprovação humana. */
  approval: ApprovalMode;
  /** "review" = pausa após o planner para o humano aprovar o plano; "auto" = segue direto. */
  planApproval?: "auto" | "review";
  /** Como o bus resolve colisão de escopo. Padrão: first-claim-wins. */
  busPolicy?: BusPolicy;
}

/** O "briefing" declarativo de uma tarefa — vira o .cardume/TASK.yaml na worktree. */
/** Artefato pedido na criação da tarefa (doc de arquitetura, prova, etc.). */
export interface ArtifactReq {
  kind: "doc" | "proof" | "tests";
  name: string;
  desc?: string;
}

/** Um requisito do épico, citado pelas tarefas em `covers` (ex.: "R1"). */
export interface EpicRequirement {
  id: string;
  text: string;
}
/** Um item do "Done when" do épico: checagem que uma pessoa roda sem abrir tarefa. */
export interface DoneWhenItem {
  id: string;
  text: string;
  /** uuid de quem marcou, ou "agent:<taskId>" quando foi o agente revisor. Ausente = em aberto. */
  checkedBy?: string;
  checkedAt?: string;
  evidence?: string;
}
/** Envelope do épico — vive em epics.spec (jsonb) na nuvem. Épico antigo tem {}. */
export interface EpicSpec {
  description?: string;
  outcome?: string;
  requirements?: EpicRequirement[];
  doneWhen?: DoneWhenItem[];
  boundaries?: string[];
}
export type TaskRisk = "low" | "medium" | "high";
/** Nota de uma tarefa: decisão tomada, suposição a confirmar ou pergunta em aberto. */
export interface TaskNote {
  kind: "decision" | "assumption" | "open";
  text: string;
}

export interface TaskSpec {
  id: string;
  title: string;
  objective: string;
  deliverables: string[];
  requirements: string[];
  /** Artefatos que o agente deve produzir em .cardume/artifacts/. */
  artifacts?: ArtifactReq[];
  /** Documentos de referência anexados (basenames em .cardume/refs/). */
  refs?: string[];
  /** Convenção de branch: tipo (feat/fix/chore…) e código da issue (FND-xxx), se houver. */
  branchType?: string;
  issueCode?: string;
  /** Ajuste pedido pelo humano num rework — injetado no contexto de TODOS os papéis. */
  adjustment?: string;
  /** Tipo da tarefa: "build" (padrão, cria branch/worktree) ou "review" (revisa um PR por link, sem branch). */
  kind?: "build" | "review";
  /** Só para kind="review": link e número do PR sendo revisado. */
  prUrl?: string;
  prNumber?: number;
  /**
   * Link da ISSUE do tracker desta demanda (visível pro time). Preenchido pelo
   * humano na Nova demanda (issue já existente) OU pelo agente via mcp__cardume__set_issue
   * quando o projeto tem "criar issue ao abrir demanda" ligado. Espelha prUrl.
   */
  issueUrl?: string;
  /** Branch base da worktree. Se vazio, usa a default do repo (main). */
  base?: string;
  /** PR ao concluir: "no" (não abre), "ask" (avisa e pergunta — padrão), "auto" (abre sozinho se não houver pendências). */
  autoPr?: "no" | "ask" | "auto";
  /** Base do PR (padrão: main/default do repo). */
  prBase?: string;
  /** Tarefa de ORIGEM quando esta é uma correção/continuação linkada. */
  linkedTo?: string;
  /** Faixa leve: pula linkar deps + setup.sh na worktree (mudança pequena). */
  light?: boolean;
  // ---- Tarefa SOB ÉPICO. Todos opcionais: tarefa criada fora do planner não tem nenhum. ----
  /** id do épico na nuvem (epics.id). */
  epicId?: string;
  /** Como se prova que esta tarefa entregou, em uma linha; o builder deriva os critérios daqui + Requirements do épico. */
  verify?: string;
  /** R-ids do épico que esta tarefa cobre (ex.: ["R1", "R3"]). */
  covers?: string[];
  /** Tarefas irmãs (ids) que precisam estar done antes desta começar. */
  after?: string[];
  /** Onda derivada de `after` ao aprovar o card (1 = sem pré-requisito). O motor só carrega. */
  wave?: number;
  /** O que NÃO pode mudar (comportamento, não arquivos). Entra em scope.off ao gerar o TASK.yaml. */
  boundaries?: string[];
  notes?: TaskNote[];
  risk?: TaskRisk;
  /** Parte do trabalho precisa de uma pessoa. */
  hitl?: boolean;
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
  session_id?: string | null;
  done_roles?: number;
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
    .replace(/^-+|-+$/g, "");
  // corta em FRONTEIRA DE PALAVRA (nunca "…-apare", "…-cadastr"): 48 chars e,
  // se o corte caiu no meio de uma palavra, recua até o último '-'
  let cut = s.slice(0, 48);
  if (s.length > 48) {
    const i = cut.lastIndexOf("-");
    if (i > 0) cut = cut.slice(0, i);
  }
  cut = cut.replace(/-+$/g, "");
  return cut || "tarefa";
}
