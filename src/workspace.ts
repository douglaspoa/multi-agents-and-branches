import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Resolve e cria a estrutura .cardume/ de um repo. */
export class Workspace {
  repo: string;
  dir: string;
  worktrees: string;
  dbFile: string;

  constructor(repo: string) {
    this.repo = resolve(repo);
    this.dir = join(this.repo, ".cardume");
    this.worktrees = join(this.dir, "worktrees");
    this.dbFile = join(this.dir, "state.sqlite");
  }

  ensure(): void {
    mkdirSync(this.worktrees, { recursive: true });
  }

  worktreePath(taskId: string): string {
    return join(this.worktrees, taskId);
  }
}
