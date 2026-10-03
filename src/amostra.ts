/**
 * TESTAR NUMA AMOSTRA (F5 · P15 da decisão da mesa de 03/10/2026) — partes PURAS e o arquivo de resultados.
 * A execução (worktree descartável + só o papel revisor) mora em `Orchestrator.sampleReview`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventRow, TaskSpec } from "./types.ts";

export interface SampleVerdict { v: number | null; kind: "aprova" | "muda" | "ilegivel" | null; items: string[] }
export interface SampleResult {
  at: number; agentId: string; agentName: string; taskId: string; title: string;
  old: SampleVerdict; now: SampleVerdict; usd: number; capUsd: number; stopped: boolean;
}
export const SAMPLES_KEEP = 20;

/** "skills ativas: a@v3 · nyx@v4 · codex" → 4 (≡ agVerOf do app). */
export function versionOfRoster(text: string | null | undefined): number | null {
  const parts = String(text ?? "").split(" · ");
  if (parts.length < 2 || !/^skills ativas:/.test(parts[0])) return null;
  const m = /^\S.*@v(\d+)$/.exec(parts[1].trim());
  return m ? Number(m[1]) : null;
}

/** O veredito que o agente deu NA TAREFA (1ª rodada dele) + a versão dele naquela tarefa (1º `papel`). */
export function oldVerdict(spec: Pick<TaskSpec, "reviewRounds">, events: Pick<EventRow, "type" | "agent_id" | "text" | "ok">[], agentId: string): SampleVerdict {
  const papel = events.find((e) => e.type === "papel" && e.agent_id === agentId);
  const v = papel ? versionOfRoster(papel.text) : null;
  const round = (spec.reviewRounds ?? []).find((r) => r.agentId === agentId);
  if (round) return { v, kind: round.verdict, items: [...(round.items ?? [])] };
  const ev = events.find((e) => e.type === "veredito" && e.agent_id === agentId);
  if (!ev) return { v, kind: null, items: [] };
  const items = String(ev.text).split("\n").slice(1).map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  return { v, kind: ev.ok ? "aprova" : /ilegível/.test(String(ev.text)) ? "ilegivel" : "muda", items };
}

export function samplesFile(cardumeDir: string): string {
  return join(cardumeDir, "aprendizado", "amostras.json");
}
/** Guarda o resultado (as últimas SAMPLES_KEEP do projeto). Arquivo ruim é recomeçado (é só histórico de amostra). */
export function saveSample(cardumeDir: string, r: SampleResult): void {
  const f = samplesFile(cardumeDir);
  let cur: SampleResult[] = [];
  try { const j = JSON.parse(readFileSync(f, "utf8")); if (Array.isArray(j)) cur = j; } catch { /* sem arquivo */ }
  const next = [r, ...cur].slice(0, SAMPLES_KEEP);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, f);
}
