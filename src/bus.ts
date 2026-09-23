import type { Store } from "./store.ts";
import { globsOverlap } from "./glob.ts";
import type { BusPolicy, ClaimMode, TaskSpec } from "./types.ts";

export type { BusPolicy };

export interface ClaimResult {
  ok: boolean;
  grantedMode: ClaimMode;
  conflictWith?: string; // agente que já tem a posse
  reason?: string;
}

/** Uma sobreposição de escopo detectada ANTES de rodar. */
export interface ScopeOverlap {
  taskId: string; // tarefa ativa que já reivindica a área
  agent: string;
  yours: string; // padrão dos seus owns
  theirs: string; // padrão/caminho deles
  kind: "owns" | "claim"; // veio do escopo declarado ou de um claim já em vigor
}

const ACTIVE_STATUSES = new Set(["queued", "running", "thinking", "draft"]);

/**
 * Detecção PROATIVA de sobreposição de escopo — o coração do fosso.
 * Compara os `scope.owns` de uma tarefa nova com o que as tarefas ainda ativas
 * já declaram possuir (owns) ou já reivindicaram (claims em modo write), usando
 * casamento por glob. Roda na CRIAÇÃO da demanda, não no merge — para avisar
 * "essas duas vão brigar" antes de gastar tokens rodando as duas.
 * Função pura de leitura: não grava nada, não altera o `claim()` ao vivo.
 */
export function detectScopeOverlap(store: Store, spec: TaskSpec): ScopeOverlap[] {
  const mine = (spec.scope?.owns ?? []).map((s) => s.trim()).filter(Boolean);
  if (mine.length === 0) return [];
  const overlaps: ScopeOverlap[] = [];
  const seen = new Set<string>();
  const push = (o: ScopeOverlap) => {
    const key = `${o.taskId}|${o.yours}|${o.theirs}|${o.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      overlaps.push(o);
    }
  };

  for (const t of store.listTasks()) {
    if (t.id === spec.id) continue;
    if (!ACTIVE_STATUSES.has(t.status)) continue;

    // 1) escopo declarado da outra tarefa (owns do spec_json)
    let theirOwns: string[] = [];
    try {
      const otherSpec = JSON.parse(t.spec_json) as TaskSpec;
      theirOwns = (otherSpec.scope?.owns ?? []).map((s) => s.trim()).filter(Boolean);
    } catch {
      /* spec corrompido — ignora */
    }
    for (const mineP of mine) {
      for (const theirP of theirOwns) {
        if (globsOverlap(mineP, theirP)) {
          push({ taskId: t.id, agent: t.agent, yours: mineP, theirs: theirP, kind: "owns" });
        }
      }
    }

    // 2) claims em vigor (write) dessa tarefa ativa
    for (const cl of store.claimsForTask(t.id)) {
      if (cl.mode !== "write") continue;
      for (const mineP of mine) {
        if (globsOverlap(mineP, cl.path)) {
          push({ taskId: t.id, agent: cl.agent, yours: mineP, theirs: cl.path, kind: "claim" });
        }
      }
    }
  }
  return overlaps;
}

/**
 * Barramento de coordenação — o que faz um agente "saber" dos outros.
 * Cada agente reivindica (claim) os caminhos que vai tocar. Se dois querem o
 * mesmo arquivo em modo write, aplica-se a política first-claim-wins: quem
 * chegou primeiro fica com a posse; o segundo é rebaixado para read e avisado.
 */
export class CoordinationBus {
  store: Store;
  /** Política de resolução de colisão. Padrão preserva o comportamento atual. */
  policy: BusPolicy = "first-claim-wins";

  constructor(store: Store, policy: BusPolicy = "first-claim-wins") {
    this.store = store;
    this.policy = policy;
  }

  /** Só tarefas AINDA editando (queued/running/thinking) travam um caminho. Uma
   * tarefa em review/merged/error já terminou de editar — seus claims não valem. */
  private isActiveTask(taskId: string): boolean {
    const t = this.store.getTask(taskId);
    if (!t) return false;
    return t.status === "queued" || t.status === "running" || t.status === "thinking";
  }

  claim(taskId: string, agent: string, path: string, mode: ClaimMode): ClaimResult {
    // Glob-aware: um claim de write em "src/auth/**" protege "src/auth/login.ts".
    // Antes só casava caminho EXATO (store.claimsForPath) e deixava o glob passar.
    const writeOwner = this.store
      .allClaims()
      .find(
        (c) =>
          c.agent !== agent &&
          c.mode === "write" &&
          this.isActiveTask(c.task_id) &&
          (c.path === path || globsOverlap(c.path, path))
      );

    if (mode === "write" && writeOwner) {
      const owner = writeOwner.agent;
      const where = writeOwner.path === path ? path : `${path} (⊂ ${writeOwner.path})`;

      if (this.policy === "sequential-lock") {
        // Não concede nem rebaixa: sinaliza que este agente deve ESPERAR.
        // (Honrar a espera na execução é papel do orquestrador — próximo passo.)
        this.store.addEvent(
          taskId,
          agent,
          "blocked",
          `${where} travado por ${owner} — aguardando liberar (sequential-lock)`,
          false
        );
        return { ok: false, grantedMode: "read", conflictWith: owner, reason: "sequential-lock" };
      }

      // first-claim-wins e human-tiebreak rebaixam para read (execução não trava).
      this.store.addClaim(taskId, agent, path, "read", owner);
      this.store.addEvent(
        taskId,
        agent,
        "collision",
        `${where} já é de ${owner} — cedi a vez e vou reutilizar a mudança (modo read)`,
        false
      );

      if (this.policy === "human-tiebreak") {
        // Abre a decisão para o humano na UI de perguntas (infra de pending já existe).
        this.store.addPending(
          taskId,
          agent,
          "tiebreak",
          `Conflito de escopo em ${where}: quem deve ter a posse — ${owner} ou ${agent}?`,
          [owner, agent]
        );
      }

      return {
        ok: false,
        grantedMode: "read",
        conflictWith: owner,
        reason: this.policy,
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
