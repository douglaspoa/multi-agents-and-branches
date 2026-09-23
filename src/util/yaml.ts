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
  // issue_url: se já existe, o agente NÃO deve criar outra — só referenciar.
  if (t.issueUrl) lines.push(`issue_url: ${t.issueUrl}`);
  // Tarefa SOB ÉPICO: o que ela prova (verify), quais requisitos do épico cobre, de quem depende,
  // a onda, o risco e se parte é de uma pessoa. Tarefa comum não tem o bloco.
  const epic = epicBlock(t);
  if (epic.length) lines.push("epic:", ...epic);
  lines.push("");
  return lines.join("\n");
}

/** Frase livre em YAML: aspas (JSON é YAML válido) quando há `: `, ` #`, quebra de linha ou começa com caractere especial. */
function yv(s: string): string {
  return /(: |:$| #|^[\s#&*!|>'"%@`\-?\[\]{},]|[\r\n])/.test(s) ? JSON.stringify(s) : s;
}

function epicBlock(t: TaskSpec): string[] {
  const out: string[] = [];
  if (t.epicId) out.push(`  id: ${t.epicId}`);
  if (t.wave) out.push(`  wave: ${t.wave}`);
  if (t.verify) out.push(`  verify: ${yv(t.verify)}`);
  if (t.covers?.length) out.push(`  covers: [${t.covers.map(yv).join(", ")}]`);
  if (t.after?.length) out.push(`  after: [${t.after.map(yv).join(", ")}]`);
  if (t.risk) out.push(`  risk: ${t.risk}`);
  if (t.hitl) out.push(`  hitl: true`);
  if (t.boundaries?.length) out.push(`  boundaries:`, ...t.boundaries.map((b) => `    - ${yv(b)}`));
  if (t.epicDoneWhen?.length) out.push(`  done_when:`, ...t.epicDoneWhen.map((d) => `    - ${yv(d)}`));
  if (t.epicChecks?.length) out.push(`  checks:`, ...t.epicChecks.map((c) => `    - ${yv(`${c.id}: ${c.evidence}`)}`));
  return out;
}
