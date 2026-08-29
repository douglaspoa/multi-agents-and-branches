import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Wrapper Promise em cima de execFile — usado para chamar o git. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 1024 * 1024 * 64 },
      (err, stdout, stderr) => {
        if (err) {
          (err as Error & { stderr?: string }).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });
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
