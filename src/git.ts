import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { netEnv, netTimeoutMs, run } from "./util/run.ts";
import { killInDir } from "./orfaos.ts";

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
 * Fina camada sobre o `git` CLI. Cada tarefa do Starfork vive numa worktree
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
   * worktrees) — assim a pasta do Starfork NUNCA é rastreada/commitada, sem
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

  /** O repo tem esse remoto configurado? (projeto local do piloto automático não tem nenhum) */
  async hasRemote(name = "origin"): Promise<boolean> {
    try {
      const { stdout } = await run("git", ["-C", this.repo, "remote"]);
      return stdout.split("\n").map((l) => l.trim()).includes(name);
    } catch {
      return false;
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
      await run("git", ["-C", this.repo, "fetch", "origin", short, "--no-tags"], { env: netEnv(), timeout: Math.min(netTimeoutMs(), 60_000) });
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

  /** A ref existe (branch local, remota, hash…)? */
  async refExists(ref: string): Promise<boolean> {
    try {
      await run("git", ["-C", this.repo, "rev-parse", "--verify", "--quiet", ref]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * RECRIA a worktree de uma tarefa no MESMO caminho (a sessão do Claude é
   * guardada por pasta — mesmo caminho = `--resume` continua valendo).
   *
   * - Tarefa NÃO mergeada: reaproveita a branch dela (local; senão busca
   *   origin/<branch>). Se a branch sumiu de todo lado, nasce da base.
   * - Tarefa MERGEADA: o trabalho já está na base, e a branch antiga tem um PR
   *   MERGED preso a ela (o `gh pr view <branch>` acharia esse PR e o app
   *   marcaria a tarefa como mergeada de novo, apagando a worktree). Então nasce
   *   uma branch NOVA da base: `<branch>-cont` (ou -cont2, -cont3…) → PR novo.
   *
   * Pré-condição: `path` não existe (o chamador limpa sobras).
   */
  async recreateWorktree(
    path: string,
    opts: { branch: string; base: string; merged: boolean },
  ): Promise<{ branch: string; from: string; reused: boolean }> {
    // registro velho da worktree apagada (senão o git diz "already registered"/"already checked out")
    try { await run("git", ["-C", this.repo, "worktree", "prune"]); } catch { /* ok */ }
    if (!opts.merged) {
      if (await this.refExists(`refs/heads/${opts.branch}`)) {
        await run("git", ["-C", this.repo, "worktree", "add", path, opts.branch]);
        return { branch: opts.branch, from: opts.branch, reused: true };
      }
      try { await run("git", ["-C", this.repo, "fetch", "origin", opts.branch, "--no-tags"], { env: netEnv(), timeout: netTimeoutMs() }); } catch { /* offline/sem remoto/branch apagada */ }
      if (await this.refExists(`refs/remotes/origin/${opts.branch}`)) {
        await run("git", ["-C", this.repo, "worktree", "add", "-b", opts.branch, path, `origin/${opts.branch}`]);
        return { branch: opts.branch, from: `origin/${opts.branch}`, reused: true };
      }
    }
    const baseRef = await this.freshBaseRef(opts.base);
    let name = opts.branch;
    if (opts.merged) {
      const stem = opts.branch.replace(/-cont\d*$/, "");
      for (let i = 1; i < 100; i++) {
        name = `${stem}-cont${i === 1 ? "" : i}`;
        if (!(await this.refExists(`refs/heads/${name}`)) && !(await this.remoteBranchExists(name))) break;
      }
    } else if (await this.refExists(`refs/heads/${name}`)) {
      // (não deveria: tratado acima) — nunca sobrescreve branch existente
      name = `${name}-cont`;
    }
    await run("git", ["-C", this.repo, "worktree", "add", "-b", name, path, baseRef]);
    return { branch: name, from: baseRef, reused: false };
  }

  /**
   * Pasta de CONVERSA de uma tarefa já integrada, no MESMO caminho: a branch dela (local; senão origin → cria a local);
   * sem branch → destacada no commit do merge (se existe aqui) ou na base. Nunca cria branch nova nem mexe na base.
   */
  async recreateForConversation(path: string, o: { branch: string; base: string; commit?: string }): Promise<{ from: string; detached: boolean }> {
    try { await run("git", ["-C", this.repo, "worktree", "prune"]); } catch { /* ok */ }
    if (o.branch && (await this.refExists(`refs/heads/${o.branch}`))) {
      await run("git", ["-C", this.repo, "worktree", "add", path, o.branch]);
      return { from: `branch ${o.branch}`, detached: false };
    }
    if (o.branch) {
      try { await run("git", ["-C", this.repo, "fetch", "origin", o.branch, "--no-tags"], { env: netEnv(), timeout: netTimeoutMs() }); } catch { /* offline/apagada */ }
      if (await this.refExists(`refs/remotes/origin/${o.branch}`)) {
        await run("git", ["-C", this.repo, "worktree", "add", "-b", o.branch, path, `origin/${o.branch}`]);
        return { from: `origin/${o.branch}`, detached: false };
      }
    }
    const baseRef = await this.freshBaseRef(o.base);
    if (o.commit) {
      try {
        await run("git", ["-C", this.repo, "rev-parse", "--verify", "--quiet", `${o.commit}^{commit}`]);
        await run("git", ["-C", this.repo, "worktree", "add", "--detach", path, o.commit]);
        return { from: `o commit do merge ${o.commit.slice(0, 9)}`, detached: true };
      } catch { /* commit não está aqui: cai na base */ }
    }
    await run("git", ["-C", this.repo, "worktree", "add", "--detach", path, baseRef]);
    return { from: `${baseRef} (a branch da tarefa não existe mais)`, detached: true };
  }

  /** Branch existe no origin? (sem remoto/offline → olha só o que já foi buscado). */
  private async remoteBranchExists(name: string): Promise<boolean> {
    if (await this.refExists(`refs/remotes/origin/${name}`)) return true;
    try {
      const { stdout } = await run("git", ["-C", this.repo, "ls-remote", "--heads", "origin", name], { env: netEnv(), timeout: 15000 });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async worktreeRemove(path: string): Promise<void> {
    await killInDir(path); // dev server/prévia rodando na pasta não fica órfão (servindo 404 → Prévia branca)
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

  /**
   * Ponto de bifurcação REAL da tarefa (espelho de `merge_base_ref` no Rust): merge-base do HEAD com origin/<base> E
   * com <base> local — fica o MAIS NOVO. Antes era `<base>...HEAD` com a base LOCAL: main local 171 commits atrás
   * (a branch nasce da origin/main) → o diff contava o avanço inteiro da main ("+132189 −3107 · 924 arquivos").
   */
  async forkPoint(worktree: string, base: string, tip = "HEAD"): Promise<string> {
    const clean = base.replace(/^origin\//, "");
    const mbs: string[] = [];
    for (const cand of [`origin/${clean}`, clean]) {
      try {
        const { stdout } = await run("git", ["-C", worktree, "merge-base", cand, tip]);
        const s = stdout.trim();
        if (s && !mbs.includes(s)) mbs.push(s);
      } catch { /* essa base não existe aqui */ }
    }
    if (mbs.length === 0) return base;
    if (mbs.length === 1) return mbs[0];
    try {
      await run("git", ["-C", worktree, "merge-base", "--is-ancestor", mbs[0], mbs[1]]);
      return mbs[1]; // o 1º é ancestral do 2º → o 2º é o mais novo
    } catch {
      return mbs[0];
    }
  }

  /** Diff da branch da worktree contra o ponto de bifurcação real (após commit). */
  async diffStat(worktree: string, base: string): Promise<DiffStat> {
    const fork = await this.forkPoint(worktree, base);
    // sem merge-base nenhum: fica o `base...HEAD` de antes (dois pontos contaria a base ao contrário)
    const range = fork === base ? [`${base}...HEAD`] : [fork, "HEAD"];
    const { stdout } = await run("git", ["-C", worktree, "diff", "--numstat", ...range]);
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

  /** Já há um merge em andamento no repo principal (MERGE_HEAD ou arquivos em conflito)? */
  async mergeInProgress(): Promise<boolean> {
    try {
      await run("git", ["-C", this.repo, "rev-parse", "-q", "--verify", "MERGE_HEAD"]);
      return true;
    } catch {
      return this.hasUnmerged();
    }
  }

  /** Há arquivos em conflito (merge parado no meio) no repo principal? */
  async hasUnmerged(): Promise<boolean> {
    try {
      const { stdout } = await run("git", ["-C", this.repo, "diff", "--name-only", "--diff-filter=U"]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
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
