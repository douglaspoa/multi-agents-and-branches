import type { TaskSpec } from "../types.ts";

export type AgentEventType =
  | "status"
  | "think"
  | "read"
  | "edit"
  | "write"
  | "bash"
  | "note"
  | "claim"
  | "error"
  | "session"
  | "done";

export interface AgentEvent {
  type: AgentEventType;
  text: string;
  ok?: boolean;
  /** Para eventos "claim": o caminho e o modo. */
  path?: string;
  mode?: "read" | "write";
  /** Para "status"/"done": novo status do agente. */
  status?: string;
  /** Para "done": custo/uso do turno (do event 'result' do stream-json). */
  cost?: { usd: number; inTok: number; outTok: number; ms?: number };
}

export interface RunInput {
  cwd: string; // caminho da worktree
  spec: TaskSpec;
  systemContext: string; // estado do barramento (vai no system prompt)
  role: string; // papel/especialidade
  agentName: string; // agente que está atuando neste papel
  dbFile: string; // state.sqlite — para o servidor MCP (ask_human/claim)
  /** Continuar uma sessão existente com uma instrução nova do humano (mid-run). */
  resume?: { sessionId: string; instruction: string };
  /** Prompt customizado pra um turno fresco (ex.: gerar um entregável sob demanda). */
  promptOverride?: string;
  /** Minutos de INATIVIDADE do humano pra o ask_human encerrar educadamente (0 = espera pra sempre). */
  askTimeoutMin?: number;
  /** Route AI: força ESTE turno na IA alternativa (ex.: fallback após o Claude bater limite). */
  forceAlt?: boolean;
  /**
   * Skills ativadas pra este projeto (bloco pronto vindo de Orchestrator.skillsContext).
   * Vai no PROMPT de todo turno de RESUME — no turno fresco/promptOverride as skills já
   * chegam pelo systemContext (--append-system-prompt), mas o --resume NÃO reenvia o system
   * prompt, então sem isto a continuação de uma tarefa "esquece" as skills. Igual groundRule.
   */
  skillsRule?: string;
}

/**
 * Contrato do motor de agente. O núcleo NUNCA fala com "Claude" direto —
 * fala com esta interface. Trocar/somar motor = implementar um adapter.
 */
export interface AgentEngine {
  id: string;
  displayName: string;
  run(input: RunInput): AsyncIterable<AgentEvent>;
}
