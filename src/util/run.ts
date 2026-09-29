import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  /** A saída foi CORTADA: o processo saiu mas um neto segurou o pipe além da folga. */
  truncated?: boolean;
}

/** Wrapper Promise em cima de execFile — usado para chamar o git. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let truncated = false;
    const cp = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeout, maxBuffer: 1024 * 1024 * 64 },
      (err, stdout, stderr) => {
        if (err) {
          (err as Error & { stderr?: string; stdout?: string }).stderr = stderr;
          (err as Error & { stderr?: string; stdout?: string }).stdout = stdout; // o git merge diz "CONFLICT" no stdout
          reject(err);
        } else {
          resolve(truncated ? { stdout, stderr, truncated } : { stdout, stderr });
        }
      }
    );
    // O callback do execFile espera o 'close' (todos os pipes fechados). Um NETO que herda o
    // stdout — `npm run dev &` num setup.sh, um daemon do git/gh — segurava a promessa pra sempre
    // mesmo com o processo já morto. Saiu → 2s de folga; só então, e só se a saída ainda não
    // terminou, fecha os pipes e marca o resultado como cortado (com aviso no log).
    cp.on("exit", () => {
      const t = setTimeout(() => {
        const open = (st: NodeJS.ReadableStream | null | undefined) => !!st && !(st as unknown as { readableEnded?: boolean }).readableEnded;
        if (!open(cp.stdout) && !open(cp.stderr)) return;
        truncated = true;
        console.warn(`[run] ${cmd}: saída cortada — um processo filho segurou o pipe depois que ${cmd} terminou`);
        cp.stdout?.destroy();
        cp.stderr?.destroy();
      }, 2000);
      t.unref();
    });
  });
}

/** Tempo máximo de uma operação de REDE do git/gh (fetch, push, ls-remote, pr create). */
export function netTimeoutMs(): number {
  const n = Number(process.env.CARDUME_NET_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

/** Ambiente pra git/gh falarem com o remoto SEM pedir nada no terminal: sem TTY (app de janela),
 * um prompt de usuário/senha travava a operação — e a tarefa — pra sempre. Falha rápido em vez disso. */
export function netEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1" };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

import { existsSync } from "node:fs";
/** Acha o `gh` sem depender do PATH (o app pode ser lançado com PATH mínimo). */
export function ghBin(): string {
  if (process.env.CARDUME_GH) return process.env.CARDUME_GH;
  for (const cand of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
    if (existsSync(cand)) return cand;
  }
  return "gh";
}
