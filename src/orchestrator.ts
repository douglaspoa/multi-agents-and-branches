import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CoordinationBus } from "./bus.ts";
import { GitService } from "./git.ts";
import { Store } from "./store.ts";
import { Workspace } from "./workspace.ts";
import { buildReview } from "./review.ts";
import { taskToYaml } from "./util/yaml.ts";
import { MockEngine } from "./engine/mock.ts";
import { ClaudeEngine } from "./engine/claude.ts";
import type { AgentEngine } from "./engine/types.ts";
import type { AgentStatus, Role, TaskRow, TaskSpec } from "./types.ts";

/**
 * O "maestro": cria a worktree, escreve o TASK.yaml, reivindica o escopo e roda
 * a EQUIPE da tarefa (planner → builder → reviewer) em sequência na mesma
 * worktree, persistindo cada evento no SQLite. Ao final, monta o review humano
 * a partir do diff real.
 */
export class Orchestrator {
  ws: Workspace;
  git: GitService;
  store: Store;
  bus: CoordinationBus;

  constructor(repo: string) {
    this.ws = new Workspace(repo);
    this.ws.ensure();
    this.git = new GitService(repo);
    this.store = new Store(this.ws.dbFile);
    this.bus = new CoordinationBus(this.store);
  }

  private engineFor(name: string, model: string | undefined, approval: TaskSpec["autonomy"]["approval"]): AgentEngine {
    if (name === "claude") return new ClaudeEngine({ model, approval });
    return new MockEngine();
  }

  private statusFor(role: Role): AgentStatus {
    if (role === "planner") return "thinking";
    if (role === "reviewer") return "review";
    return "running";
  }

  async createTask(spec: TaskSpec): Promise<TaskRow> {
    // Garante a equipe (retrocompat: 1 builder).
    if (!spec.roles || spec.roles.length === 0) {
      spec.roles = [{ role: "builder", name: spec.agent, engine: spec.engine, model: spec.model }];
    }

    const branch = `agent/${spec.id}`;
    const worktree = this.ws.worktreePath(spec.id);
    const base = await this.git.currentBranch();

    await this.git.worktreeAdd(worktree, branch, base);

    const taskDir = join(worktree, ".cardume");
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "TASK.yaml"), taskToYaml(spec), "utf8");

    this.store.createTask(spec, branch, worktree, base);
    this.store.addEvent(spec.id, spec.agent, "status", `worktree criada em ${branch}`, true);

    for (const path of spec.scope.owns) {
      this.bus.claim(spec.id, spec.agent, path, "write");
    }

    return this.store.getTask(spec.id)!;
  }

  /** Roda a equipe da tarefa: cada papel em sequência, na mesma worktree. */
  async runTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    const roles = spec.roles.length ? spec.roles : [{ role: "builder" as Role, name: spec.agent, engine: spec.engine }];

    for (const r of roles) {
      this.store.setStage(taskId, r.role);
      this.store.setStatus(taskId, this.statusFor(r.role));
      const engine = this.engineFor(r.engine, r.model, spec.autonomy.approval);
      const persona = r.persona ? `## Seu perfil (${r.name} · ${r.role})\n${r.persona}\n\n` : "";
      const ctx = persona + this.bus.buildContext(spec);

      try {
        for await (const ev of engine.run({
          cwd: task.worktree,
          spec,
          systemContext: ctx,
          role: r.role,
          agentName: r.name,
          dbFile: this.ws.dbFile,
        })) {
          if (ev.type === "claim" && ev.path) {
            this.bus.claim(taskId, r.name, ev.path, ev.mode ?? "write");
            continue;
          }
          this.store.addEvent(taskId, r.name, ev.type, ev.text, ev.ok, r.role);
          if (ev.status) this.store.setStatus(taskId, ev.status as AgentStatus);
        }
      } catch (err) {
        this.store.addEvent(taskId, r.name, "error", (err as Error).message, false, r.role);
        this.store.setStatus(taskId, "error");
        return;
      }

      // Commita o que sobrou solto (o agente pode ter commitado sozinho) e
      // sempre recalcula o diff da branch vs base — assim o diff aparece mesmo
      // quando foi o próprio agente que fez o commit.
      if (r.role !== "reviewer") {
        try {
          await this.git.commitAll(task.worktree, `cardume(${r.role}): ${task.title}`);
          const d = await this.git.diffStat(task.worktree, task.base);
          this.store.setDiff(taskId, d.files, d.add, d.del);
        } catch (err) {
          this.store.addEvent(taskId, r.name, "note", `falha ao finalizar: ${(err as Error).message}`, false, r.role);
        }
      }

      // O reviewer monta o review FATUAL a partir do diff real.
      if (r.role === "reviewer") {
        try {
          const diff = await this.git.diffText(task.worktree, task.base);
          const review = buildReview(diff, r.name);
          this.store.addReview(taskId, review);
          this.store.addEvent(taskId, r.name, "note", `review pronto: ${review.summary}`, true, "reviewer");
        } catch (err) {
          this.store.addEvent(taskId, r.name, "note", `falha no review: ${(err as Error).message}`, false, r.role);
        }
      }
    }

    this.store.setStatus(taskId, "review");
  }

  /** Faz merge da branch da tarefa na base, remove a worktree/branch e marca 'merged'. */
  async mergeTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    await this.git.mergeBranch(task.branch, `cardume: merge ${task.title} (${task.branch})`);
    try {
      await this.git.worktreeRemove(task.worktree);
    } catch {
      /* ok */
    }
    await this.git.branchDelete(task.branch);
    this.store.setStatus(taskId, "merged");
    this.store.addEvent(taskId, task.agent, "note", `merge na ${task.base} concluído`, true);
  }

  async removeTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) return;
    try {
      await this.git.worktreeRemove(task.worktree);
    } catch {
      /* worktree pode já ter sido removida */
    }
    await this.git.branchDelete(task.branch);
    this.store.deleteTask(taskId);
  }

  close(): void {
    this.store.close();
  }
}
