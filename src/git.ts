import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
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

  /**
   * Garante padrões no exclude LOCAL do git (.git/info/exclude, comum a todas as
   * worktrees) — assim a pasta do Constellation NUNCA é rastreada/commitada, sem
   * tocar no .gitignore rastreado do repo do usuário. Idempotente, best-effort.
   */
  async ensureExcluded(patterns: string[]): Promise<void> {
    try {
      const { stdout } = await run("git", ["-C", this.repo, "rev-parse", "--git-common-dir"]);
      const common = stdout.trim();
      const gitDir = isAbsolute(common) ? common : join(this.repo, common);
      const infoDir = join(gitDir, "info");
      await mkdir(infoDir, { recursive: true });
      const exclude = join(infoDir, "exclude");
      let cur = "";
      try {
        cur = await readFile(exclude, "utf8");
      } catch {
        /* arquivo ainda não existe */
      }
      const have = new Set(cur.split("\n").map((l) => l.trim()));
      const add = patterns.filter((p) => !have.has(p));
      if (add.length) {
        const prefix = cur && !cur.endsWith("\n") ? cur + "\n" : cur;
        await writeFile(exclude, prefix + add.join("\n") + "\n", "utf8");
      }
    } catch {
      /* best-effort */
    }
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

  /**
   * Branch BASE padrão pra novas tarefas: o default do repo (origin/HEAD →
   * geralmente main), com fallback pra main/master (local ou remoto). Assim as
   * tarefas nascem da main mesmo que o usuário esteja numa branch de trabalho —
   * a não ser que passe uma base explícita. Último recurso: a branch atual.
   */
  async defaultBase(): Promise<string> {
    const cands: string[] = [];
    try {
      const { stdout } = await run("git", ["-C", this.repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      const b = stdout.trim().replace(/^origin\//, "");
      if (b) cands.push(b, "origin/" + b);
    } catch {
      /* sem origin/HEAD */
    }
    cands.push("main", "origin/main", "master", "origin/master");
    for (const c of cands) {
      try {
        await run("git", ["-C", this.repo, "rev-parse", "--verify", "--quiet", c]);
        return c;
      } catch {
        /* ref não existe, tenta a próxima */
      }
    }
    return this.currentBranch();
  }

  /**
   * Base ATUALIZADA: faz fetch do remoto e devolve origin/<base> quando existir
   * — toda tarefa nova nasce da main (ou da base pedida) FRESCA, não da cópia
   * local possivelmente velha. Sem rede/remoto, cai na ref local sem falhar.
   */
  async freshBaseRef(base: string): Promise<string> {
    const short = base.replace(/^origin\//, "");
    try {
      await run("git", ["-C", this.repo, "fetch", "origin", short, "--no-tags"]);
    } catch { /* offline ou sem remoto — segue com o que há */ }
    for (const c of [`origin/${short}`, base]) {
      try {
        await run("git", ["-C", this.repo, "rev-parse", "--verify", "--quiet", c]);
        return c;
      } catch { /* tenta a próxima */ }
    }
    return base;
  }

  async worktreeAdd(path: string, branch: string, base: string): Promise<void> {
    await run("git", ["-C", this.repo, "worktree", "add", "-b", branch, path, base]);
  }

  async worktreeRemove(path: string): Promise<void> {
    await run("git", ["-C", this.repo, "worktree", "remove", "--force", path]);
  }

  /** Renomeia a branch atual da worktree (git branch -m). */
  async renameBranch(worktree: string, newName: string): Promise<void> {
    await run("git", ["-C", worktree, "branch", "-m", newName]);
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

  /** Aborta um merge em andamento (usado quando dá conflito). */
  async abortMerge(): Promise<void> {
    try {
      await run("git", ["-C", this.repo, "merge", "--abort"]);
    } catch {
      /* sem merge em andamento */
    }
  }

  /** Hash do HEAD de uma worktree. */
  async headHash(worktree: string): Promise<string> {
    const { stdout } = await run("git", ["-C", worktree, "rev-parse", "HEAD"]);
    return stdout.trim();
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
