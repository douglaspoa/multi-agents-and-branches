/**
 * Quem roda DENTRO de uma worktree morre antes de ela ser removida (espelho de app/src-tauri/src/orfaos.rs).
 * Caso real (03/10): a tarefa foi integrada, a worktree sumiu, mas o `vite` que subiu nela ficou vivo respondendo
 * 404 em tudo — e a Prévia mostrava uma tela branca. O `lsof` dá o cwd de cada processo (mesmo com a pasta apagada).
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";

/** `lsof -d cwd -Fpn` → [pid, cwd]. Puro (testado). */
export function parseLsofCwd(out: string): Array<[number, string]> {
  const v: Array<[number, string]> = [];
  let pid: number | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) { const n = Number(line.slice(1)); pid = Number.isFinite(n) ? n : null; continue; }
    if (line.startsWith("n") && pid !== null && line[1] === "/") v.push([pid, line.slice(1).trimEnd()]);
  }
  return v;
}

/** Pids com cwd na pasta `dir` (ela ou abaixo — prefixo de NOME não conta). Puro (testado). */
export function procsInDir(list: Array<[number, string]>, dir: string, me: number): number[] {
  const d = dir.replace(/\/+$/, "");
  const out = list.filter(([p, c]) => p > 1 && p !== me && (c === d || c.startsWith(d + "/"))).map(([p]) => p);
  return [...new Set(out)].sort((a, b) => a - b);
}

const lsof = () => new Promise<string>((res) => {
  execFile("lsof", ["-w", "-a", "-d", "cwd", "-Fpn", "-u", String(process.getuid?.() ?? "")], { timeout: 8000, maxBuffer: 16 << 20 }, (_e, out) => res(String(out || "")));
});

/** Derruba (TERM, depois KILL) quem roda em `dir`. Devolve quantos. Nunca lança. */
export async function killInDir(dir: string): Promise<number> {
  if (process.platform === "win32") return 0;
  try {
    const list = parseLsofCwd(await lsof());
    const dirs = [dir]; try { const r = realpathSync(dir); if (r !== dir) dirs.push(r); } catch { /* já apagada */ }
    const pids = [...new Set(dirs.flatMap((d) => procsInDir(list, d, process.pid)))];
    for (const p of pids) { try { process.kill(p, "SIGTERM"); } catch { /* já saiu */ } }
    if (pids.length) {
      await new Promise((r) => setTimeout(r, 600));
      for (const p of pids) { try { process.kill(p, 0); process.kill(p, "SIGKILL"); } catch { /* saiu */ } }
    }
    return pids.length;
  } catch { return 0; }
}
