import type { TaskSpec } from "../types.ts";

function list(arr: string[]): string {
  if (arr.length === 0) return " []";
  return arr.map((s) => `\n  - ${s}`).join("");
}

/**
 * Serializa a TaskSpec no formato .cardume/TASK.yaml que o agente lê na worktree.
 * Escrito à mão de propósito: mantém o núcleo zero-dependência.
 */
export function taskToYaml(t: TaskSpec): string {
  const lines = [
    `# .cardume/TASK.yaml — lido pelo agente Cardume na worktree`,
    `id: ${t.id}`,
    `title: ${t.title}`,
    `agent: ${t.agent}`,
    `objective: >`,
    `  ${t.objective}`,
    `deliverables:${list(t.deliverables)}`,
    `requirements:${list(t.requirements)}`,
    `scope:`,
    `  owns: [${t.scope.owns.join(", ")}]`,
    `  off_limits: [${t.scope.offLimits.join(", ")}]`,
    `autonomy:`,
    `  clarifications: ${t.autonomy.clarifications}`,
    `  commit: ${t.autonomy.commit}`,
    `  run_tests: ${t.autonomy.runTests}`,
    `engine: ${t.engine}`,
  ];
  if (t.model) lines.push(`model: ${t.model}`);
  lines.push("");
  return lines.join("\n");
}
