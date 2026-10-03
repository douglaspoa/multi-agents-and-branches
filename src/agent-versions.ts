/**
 * VERSÕES DE AGENTE E DE SKILL (decisão da mesa 03/10 — P10 e P11). Lógica de arquivo, sem IA.
 *
 *  - Agente: `.cardume/agentes/<agentId>/versoes.json` = { agentId, current, versions:[…últimas 5] }. Sem arquivo = v1.
 *    Toda mudança ACEITA pela pessoa (skill/nota dona, persona, modelo, motor, voltar) cria a próxima versão.
 *  - Skill aprendida: `.cardume/aprendizado/historico/<nome>/v<N>.md` guarda os BYTES do SKILL.md de cada versão
 *    (as últimas 5) + `index.json` com o rastro. "Voltar pro jeito antigo" restaura byte a byte a versão anterior e
 *    também vira versão nova (voltar fica no histórico). Sem versão anterior (skill recém-criada) = arquivar: o
 *    SKILL.md é MOVIDO pro histórico, nunca apagado.
 *
 * O formato é o MESMO do Rust (`app/src-tauri/src/agent_versions.rs`) — paridade conferida pelo fixture
 * `tests/fixtures/ciclo-golden/versoes.json` nos dois lados. Mudou um, muda o outro.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const KEEP_VERSIONS = 5;

export interface AgentVersionEntry {
  v: number;
  at: number;
  /** o que mudou: "skill" | "nota" | "persona" | "modelo" | "motor" | "voltar" */
  change: string;
  /** frase curta do que mudou (ex.: nome da skill) */
  what: string;
  /** só em mudança de persona: o texto da persona DESTA versão e o de ANTES (voltar restaura `before` byte a byte) */
  persona?: string;
  before?: string;
}
export interface AgentVersions { agentId: string; current: number; versions: AgentVersionEntry[] }

export interface SkillVersionEntry { v: number; at: number; action: string; reason: string; taskId: string; agente: string }
export interface SkillHistory { name: string; current: number; archived: boolean; versions: SkillVersionEntry[] }

const atomic = (file: string, content: string | Buffer) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
};
const readJson = <T>(file: string): T | null => {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return null; }
};
/** id de agente seguro pra pasta (o id do catálogo já é assim; nome livre de tarefa antiga vira slug). */
export function agentKey(id: string): string {
  return String(id ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

// ---------------------------------------------------------------- agente

export function agentVersionsFile(cardumeDir: string, agentId: string): string {
  return join(cardumeDir, "agentes", agentKey(agentId), "versoes.json");
}
export function readAgentVersions(cardumeDir: string, agentId: string): AgentVersions {
  const j = readJson<AgentVersions>(agentVersionsFile(cardumeDir, agentId));
  if (j && Number(j.current) >= 1 && Array.isArray(j.versions)) return { agentId: agentKey(agentId), current: Number(j.current), versions: j.versions };
  return { agentId: agentKey(agentId), current: 1, versions: [] };
}
/** Versão atual do agente (sem arquivo = 1). */
export function agentVersion(cardumeDir: string, agentId: string | undefined): number {
  if (!agentId || !agentKey(agentId)) return 1;
  return readAgentVersions(cardumeDir, agentId).current;
}
/** Cria a próxima versão do agente (mudança aceita pela pessoa). Guarda as últimas 5. Devolve o número novo. */
export function bumpAgent(cardumeDir: string, agentId: string, e: Omit<AgentVersionEntry, "v">): number {
  const cur = readAgentVersions(cardumeDir, agentId);
  const v = cur.current + 1;
  const entry: AgentVersionEntry = { v, at: e.at, change: e.change, what: e.what, ...(e.persona !== undefined ? { persona: e.persona } : {}), ...(e.before !== undefined ? { before: e.before } : {}) };
  const out: AgentVersions = { agentId: cur.agentId, current: v, versions: [...cur.versions, entry].slice(-KEEP_VERSIONS) };
  atomic(agentVersionsFile(cardumeDir, agentId), JSON.stringify(out, null, 2));
  return v;
}

// ---------------------------------------------------------------- skill

export function skillHistDir(cardumeDir: string, name: string): string {
  return join(cardumeDir, "aprendizado", "historico", name);
}
export function readSkillHistory(cardumeDir: string, name: string): SkillHistory | null {
  const j = readJson<SkillHistory>(join(skillHistDir(cardumeDir, name), "index.json"));
  return j && Array.isArray(j.versions) ? { name, current: Number(j.current) || 0, archived: !!j.archived, versions: j.versions } : null;
}
/** Versão atual da skill (sem histórico = 1: skill existente antes das versões, ou do time). */
export function skillVersion(cardumeDir: string, name: string): number {
  const h = readSkillHistory(cardumeDir, name);
  return h && h.current >= 1 ? h.current : 1;
}
function prune(dir: string, current: number): void {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const m = /^v(\d+)\.md$/.exec(n);
    if (m && Number(m[1]) <= current - KEEP_VERSIONS) rmSync(join(dir, n), { force: true });
  }
}
function saveHist(cardumeDir: string, h: SkillHistory): void {
  const out = { name: h.name, current: h.current, archived: h.archived, versions: h.versions.slice(-KEEP_VERSIONS) };
  atomic(join(skillHistDir(cardumeDir, h.name), "index.json"), JSON.stringify(out, null, 2));
  prune(skillHistDir(cardumeDir, h.name), h.current);
}

/**
 * Grava `content` como o SKILL.md da skill `name` (em `skillsRoot/<name>/SKILL.md`) criando a próxima versão.
 * Skill aprendida que já existia SEM histórico: os bytes atuais viram a v1 ("legado") antes — assim dá pra voltar.
 */
export function writeSkillVersion(cardumeDir: string, skillsRoot: string, name: string, content: string | Buffer, meta: { at: number; action: string; reason?: string; taskId?: string; agente?: string }): number {
  const md = join(skillsRoot, name, "SKILL.md");
  const dir = skillHistDir(cardumeDir, name);
  let h = readSkillHistory(cardumeDir, name);
  if (!h) {
    h = { name, current: 0, archived: false, versions: [] };
    if (existsSync(md)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "v1.md"), readFileSync(md));
      h.current = 1;
      h.versions.push({ v: 1, at: meta.at, action: "legado", reason: "", taskId: "", agente: "" });
    }
  }
  const v = h.current + 1;
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  mkdirSync(dirname(md), { recursive: true });
  mkdirSync(dir, { recursive: true });
  atomic(md, buf);
  writeFileSync(join(dir, `v${v}.md`), buf);
  h.current = v;
  h.archived = false;
  h.versions.push({ v, at: meta.at, action: meta.action, reason: meta.reason ?? "", taskId: meta.taskId ?? "", agente: meta.agente ?? "" });
  saveHist(cardumeDir, h);
  return v;
}

export interface RevertResult { name: string; action: "restaurada" | "arquivada"; from: number; to: number; restored: number | null; agente: string }

/**
 * "Voltar pro jeito antigo": restaura BYTE A BYTE a versão anterior à atual e registra uma versão nova (motivo junto).
 * Sem versão anterior guardada → arquiva (move o SKILL.md pro histórico; tira do skills.json via `onArchive`).
 */
export function revertSkill(cardumeDir: string, skillsRoot: string, name: string, reason: string, at: number, onArchive?: (name: string) => void): RevertResult {
  const h = readSkillHistory(cardumeDir, name);
  if (!h || h.current < 1 || h.archived) throw new Error("essa skill não tem versão pra voltar");
  const dir = skillHistDir(cardumeDir, name);
  const md = join(skillsRoot, name, "SKILL.md");
  const cur = h.versions.find((x) => x.v === h.current);
  const agente = cur?.agente ?? "";
  const prev = join(dir, `v${h.current - 1}.md`);
  const from = h.current;
  const to = h.current + 1;
  if (h.current > 1 && existsSync(prev)) {
    const bytes = readFileSync(prev);
    atomic(md, bytes);
    writeFileSync(join(dir, `v${to}.md`), bytes);
    h.current = to;
    h.versions.push({ v: to, at, action: "voltar", reason: String(reason ?? "").trim(), taskId: "", agente });
    saveHist(cardumeDir, h);
    return { name, action: "restaurada", from, to, restored: from - 1, agente };
  }
  // sem anterior: arquiva (mover, nunca apagar) — os bytes atuais já estão em v<current>.md
  if (existsSync(md)) {
    mkdirSync(dir, { recursive: true });
    renameSync(md, join(dir, "arquivada.md"));
  }
  h.current = to;
  h.archived = true;
  h.versions.push({ v: to, at, action: "arquivar", reason: String(reason ?? "").trim(), taskId: "", agente });
  saveHist(cardumeDir, h);
  try { onArchive?.(name); } catch { /* skills.json: melhor-esforço */ }
  return { name, action: "arquivada", from, to, restored: null, agente };
}

// ---------------------------------------------------------------- P10: o que rodou no papel

/** Skills ativas no projeto (`.cardume/skills.json`) com a versão de cada uma: ["rodar-testes@v3", …].
 * Com `agentId` (P9): só as que ESSE papel recebe — as do projeto (sem dono) + as dele; as de outro agente ficam de fora. */
export function activeSkills(cardumeDir: string, agentId?: string): string[] {
  const arr = readJson<{ name?: string; agente?: string }[]>(join(cardumeDir, "skills.json"));
  const me = agentId === undefined ? null : agentKey(agentId);
  return (Array.isArray(arr) ? arr : [])
    .filter((s) => me === null || !agentKey(s?.agente ?? "") || agentKey(s?.agente ?? "") === me)
    .map((s) => String(s?.name ?? "").trim()).filter(Boolean).map((n) => `${n}@v${skillVersion(cardumeDir, n)}`);
}

// ---------------------------------------------------------------- P9: o que o agente lembra (notas com dono)

/**
 * Nota aceita "pra Lumen" mora na memória DO AGENTE (`.cardume/agentes/<id>/lembra.json`), não no cérebro do projeto:
 * só o papel dono recebe no prompt. Só o APP escreve (aceite/esquecer, `learn.rs`); "esquecer" marca `forgottenAt`
 * (nunca apaga — fica o rastro). Formato ≡ `agent_versions::read_agent_memory` do Rust.
 */
export interface AgentMemoryItem { id: string; kind: "nota"; title: string; body: string; at: number; v: number; taskId: string; forgottenAt?: number; forgetReason?: string }
export function agentMemoryFile(cardumeDir: string, agentId: string): string {
  return join(cardumeDir, "agentes", agentKey(agentId), "lembra.json");
}
/** Tudo o que o agente já lembrou (inclusive esquecidas). Sem arquivo/ilegível = []. */
export function readAgentMemory(cardumeDir: string, agentId: string | undefined): AgentMemoryItem[] {
  if (!agentId || !agentKey(agentId)) return [];
  const j = readJson<{ items?: AgentMemoryItem[] }>(agentMemoryFile(cardumeDir, agentId));
  return Array.isArray(j?.items) ? j!.items.filter((x) => x && typeof x.title === "string" && typeof x.body === "string") : [];
}
/** Só o que ele lembra AGORA (sem as esquecidas). */
export function activeAgentMemory(cardumeDir: string, agentId: string | undefined): AgentMemoryItem[] {
  return readAgentMemory(cardumeDir, agentId).filter((x) => !x.forgottenAt);
}
