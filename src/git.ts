import { run } from "./util/run.ts";

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
}

export interface DiffStat {
  files: number;
  add: number;
  del: number;
}

/**
 * Fina camada sobre o `git` CLI. Cada tarefa do Cardume vive numa worktree
 * isolada apontando para a sua branch — é o que permite N agentes editarem o
 * mesmo repo em paralelo sem conflito de arquivo.
 */
export class GitService {
  repo: string;

  constructor(repo: string) {
    this.repo = repo;
  }

  async isRepo(): Promise<boolean> {
    try {
      await run("git", ["-C", this.repo, "rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  async currentBranch(): Promise<string> {
    const { stdout } = await run("git", [
      "-C",
      this.repo,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    return stdout.trim();
  }

  async worktreeAdd(path: string, branch: string, base: string): Promise<void> {
    await run("git", ["-C", this.repo, "worktree", "add", "-b", branch, path, base]);
  }

  async worktreeRemove(path: string): Promise<void> {
    await run("git", ["-C", this.repo, "worktree", "remove", "--force", path]);
  }

  async branchDelete(branch: string): Promise<void> {
    try {
      await run("git", ["-C", this.repo, "branch", "-D", branch]);
    } catch {
      /* branch pode não existir */
    }
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    const { stdout } = await run("git", [
      "-C",
      this.repo,
      "worktree",
      "list",
      "--porcelain",
    ]);
    const out: WorktreeInfo[] = [];
    let cur: Partial<WorktreeInfo> = {};
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) cur = { path: line.slice(9).trim() };
      else if (line.startsWith("HEAD ")) cur.head = line.slice(5).trim();
      else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "").trim();
      else if (line.trim() === "") {
        if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? "(detached)", head: cur.head ?? "" });
        cur = {};
      }
    }
    if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? "(detached)", head: cur.head ?? "" });
    return out;
  }

  /** Faz add -A e commit na worktree se houver mudanças. Retorna true se commitou. */
  async commitAll(worktree: string, message: string): Promise<boolean> {
    await run("git", ["-C", worktree, "add", "-A"]);
    const { stdout } = await run("git", ["-C", worktree, "status", "--porcelain"]);
    if (!stdout.trim()) return false;
    await run("git", ["-C", worktree, "commit", "-m", message]);
    return true;
  }

  /** Diff da branch da worktree contra a base (após commit). */
  async diffStat(worktree: string, base: string): Promise<DiffStat> {
    const { stdout } = await run("git", [
      "-C",
      worktree,
      "diff",
      "--numstat",
      `${base}...HEAD`,
    ]);
    let files = 0;
    let add = 0;
    let del = 0;
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split("\t");
      files++;
      add += Number(parts[0]) || 0;
      del += Number(parts[1]) || 0;
    }
    return { files, add, del };
  }

  /** Faz merge (--no-ff) de uma branch na base atualmente em check-out no repo. */
  async mergeBranch(branch: string, message: string): Promise<void> {
    await run("git", ["-C", this.repo, "merge", "--no-ff", "-m", message, branch]);
  }

  /** Diff unificado da branch contra a base — insumo do review humano. */
  async diffText(worktree: string, base: string): Promise<string> {
    const { stdout } = await run("git", [
      "-C",
      worktree,
      "diff",
      "--unified=0",
      `${base}...HEAD`,
    ]);
    return stdout;
  }
}
