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
