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
