import type { Store } from "./store.ts";
import type { ClaimMode, TaskSpec } from "./types.ts";

export interface ClaimResult {
  ok: boolean;
  grantedMode: ClaimMode;
  conflictWith?: string; // agente que já tem a posse
  reason?: string;
}

/**
 * Barramento de coordenação — o que faz um agente "saber" dos outros.
 * Cada agente reivindica (claim) os caminhos que vai tocar. Se dois querem o
 * mesmo arquivo em modo write, aplica-se a política first-claim-wins: quem
 * chegou primeiro fica com a posse; o segundo é rebaixado para read e avisado.
 */
export class CoordinationBus {
  store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Só tarefas AINDA editando (queued/running/thinking) travam um caminho. Uma
   * tarefa em review/merged/error já terminou de editar — seus claims não valem. */
  private isActiveTask(taskId: string): boolean {
    const t = this.store.getTask(taskId);
    if (!t) return false;
    return t.status === "queued" || t.status === "running" || t.status === "thinking";
  }

  claim(taskId: string, agent: string, path: string, mode: ClaimMode): ClaimResult {
    const existing = this.store
      .claimsForPath(path)
      .filter((c) => c.agent !== agent && this.isActiveTask(c.task_id));
    const writeOwner = existing.find((c) => c.mode === "write");

    if (mode === "write" && writeOwner) {
      // Colisão: política first-claim-wins → rebaixa este agente para read.
      this.store.addClaim(taskId, agent, path, "read", writeOwner.agent);
      this.store.addEvent(
        taskId,
        agent,
        "collision",
        `${path} já é de ${writeOwner.agent} — cedi a vez e vou reutilizar a mudança (modo read)`,
        false
      );
      return {
        ok: false,
        grantedMode: "read",
        conflictWith: writeOwner.agent,
        reason: "first-claim-wins",
      };
    }

    this.store.addClaim(taskId, agent, path, mode);
    this.store.addEvent(taskId, agent, "claim", `${path} (${mode})`, true);
    return { ok: true, grantedMode: mode };
  }

  /**
   * Monta o trecho de system-prompt que descreve o "mural" para um agente:
   * o que os outros estão tocando e onde ele não pode encostar.
   * No produto final, isto vai em `claude -p --append-system-prompt`.
   */
  buildContext(spec: TaskSpec): string {
    const others = this.store
      .allClaims()
      .filter((c) => c.agent !== spec.agent && c.mode === "write" && this.isActiveTask(c.task_id));

    const lines: string[] = ["## Coordenação (outros agentes ativos no repo)"];
    if (others.length === 0) {
      lines.push("- Nenhum outro agente com posse de arquivos no momento.");
    } else {
      for (const c of others) {
        lines.push(`- ${c.agent} edita ${c.path} — não encoste.`);
      }
    }
    if (spec.scope.offLimits.length) {
      lines.push(`- Fora dos limites desta tarefa: ${spec.scope.offLimits.join(", ")}.`);
    }
    lines.push(
      "Antes de editar qualquer arquivo fora da sua área, use a tool claim(path)."
    );
    if (spec.autonomy.clarifications === "ask") {
      lines.push("Se houver ambiguidade, use a tool ask_human(pergunta).");
    } else {
      lines.push(
        `Modo ${spec.autonomy.clarifications}: não pergunte — ${
          spec.autonomy.clarifications === "assume"
            ? "assuma o razoável e registre a decisão."
            : "siga o spec à risca."
        }`
      );
    }
    return lines.join("\n");
  }
}
