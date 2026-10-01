/**
 * APRENDIZADO CONTÍNUO — a "retro" do fim da tarefa (lógica pura, testada em src/learn.test.ts).
 *
 * Ao fim de cada tarefa um modelo (Sonnet 5 por padrão) relê o que aconteceu — sobretudo as
 * correções do humano e o retrabalho — e propõe NOTAS pro cérebro (fatos) e SKILLS aprendidas
 * (procedimentos). Modo "sugerir" (padrão): as propostas vão pra fila
 * `.cardume/aprendizado/pendentes.json` e o humano aceita/descarta na aba Memória (o app aplica,
 * ver app/src-tauri/src/learn.rs). Modo "auto": o motor aplica direto. "desligado": nada roda.
 *
 * Skills aprendidas moram SÓ no repo (`<repo>/.claude/skills/<nome>/SKILL.md`, frontmatter
 * `origem: aprendida`) e só elas podem ser atualizadas pela retro. O formato do SKILL.md é o
 * MESMO do lado Rust (`learn::skill_md`) — mudou um, muda o outro.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import { extractJson, looksSecret } from "./memory.ts";

export type LearnMode = "sugerir" | "auto" | "desligado";
export const RETRO_MODEL_DEFAULT = "claude-sonnet-5";
export const RETRO_MODELS: { id: string; label: string }[] = [
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];
export const MAX_NOTAS = 3;
export const MAX_SKILLS = 2;

export interface RetroNota { title: string; type: string; tags: string[]; body: string }
export interface RetroSkill { acao: "criar" | "atualizar"; nome: string; descricao: string; corpo: string; porque: string }
export interface PendingItem {
  id: string;
  kind: "nota" | "skill";
  taskId: string;
  taskTitle: string;
  createdAt: number;
  nota?: RetroNota;
  skill?: RetroSkill;
}
export interface LearnedSkill { name: string; description: string; body: string; tarefas: string[] }

// ---------------------------------------------------------------------------
// configurações (~/.constellation/settings.json — mesmo arquivo do write_setting do app)
// ---------------------------------------------------------------------------

export function settingsFile(): string {
  return join(homedir(), ".constellation", "settings.json");
}

/** Modo e modelo da retro. Valor desconhecido → padrão (sugerir · Sonnet 5). */
export function readLearnSettings(file = settingsFile()): { mode: LearnMode; model: string } {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(readFileSync(file, "utf8")) ?? {}; } catch { /* sem arquivo: padrão */ }
  const m = String(raw.learnMode ?? "").trim().toLowerCase();
  const mode: LearnMode = m === "auto" || m === "automatico" || m === "automático" ? "auto" : m === "desligado" || m === "off" ? "desligado" : "sugerir";
  const mod = String(raw.retroModel ?? "").trim();
  const model = /^claude-[a-z0-9.-]+$/i.test(mod) ? mod : RETRO_MODEL_DEFAULT;
  return { mode, model };
}

// ---------------------------------------------------------------------------
// filtros: segredo e injeção
// ---------------------------------------------------------------------------

const INJECTION_RES: RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|messages?|rules?)/i,
  /\bdisregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\b/i,
  /\bforget\s+(?:all\s+|your\s+)?(?:previous\s+)?instructions\b/i,
  /\bignor(?:e|ar|em)\s+(?:todas\s+)?(?:as\s+)?(?:instru[çc][õo]es|regras|mensagens)\s+(?:anteriores|acima|pr[ée]vias)/i,
  /\besque[çc](?:a|er|am)\s+(?:todas\s+)?(?:as\s+)?(?:suas\s+)?instru[çc][õo]es/i,
  /\bdesconsidere\s+(?:todas\s+)?(?:as\s+)?instru[çc][õo]es/i,
  /\bsystem\s*prompt\b/i,
  /\bprompt\s+do\s+sistema\b/i,
  /<\/?\s*(?:system|assistant|instructions?)\s*>/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions\s*:/i,
];

export function looksInjection(s: string): boolean {
  return INJECTION_RES.some((re) => re.test(String(s ?? "")));
}

/** Por que um texto proposto não pode ser gravado (null = pode). */
export function rejectReason(text: string): "segredo" | "injeção" | null {
  if (looksSecret(text)) return "segredo";
  if (looksInjection(text)) return "injeção";
  return null;
}

/** Todo o texto de um item (o filtro passa por todos os campos). */
export function itemText(it: { nota?: RetroNota; skill?: RetroSkill }): string {
  if (it.nota) return [it.nota.title, it.nota.type, ...(it.nota.tags ?? []), it.nota.body].join("\n");
  if (it.skill) return [it.skill.nome, it.skill.descricao, it.skill.corpo, it.skill.porque].join("\n");
  return "";
}

// ---------------------------------------------------------------------------
// prompt e parse
// ---------------------------------------------------------------------------

export interface RetroCtx {
  title: string;
  objective: string;
  requirements: string[];
  corrections: string[];   // instruções e mensagens do humano durante a tarefa
  reworks: number;         // pedidos de retrabalho
  reviewSummary: string;
  events: string[];        // últimos done/note dos agentes
  brainCatalog: string;    // "- slug: título (tipo)"
  learnedSkills: LearnedSkill[];
  alreadySuggested?: string[]; // propostas desta tarefa ainda na fila (a retro roda de novo a cada rework)
}

const clip = (s: string, n: number) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

export function retroPrompt(ctx: RetroCtx): string {
  const corr = ctx.corrections.length ? ctx.corrections.map((c) => `- ${clip(c.replace(/\s+/g, " "), 500)}`).join("\n") : "(nenhuma)";
  const skills = ctx.learnedSkills.length
    ? ctx.learnedSkills.map((s) => `### ${s.name}\n${clip(s.description, 300)}\n${clip(s.body, 1200)}`).join("\n\n")
    : "(nenhuma)";
  const evs = ctx.events.length ? clip(ctx.events.join("\n"), 5000) : "(sem eventos)";
  return (
    `Você é o RETRO de uma tarefa feita por agentes de IA num projeto de software. Releia o que aconteceu e proponha o que vale APRENDER pras próximas tarefas deste projeto.\n\n` +
    `## Tarefa\nTítulo: ${clip(ctx.title, 200)}\nObjetivo: ${clip(ctx.objective, 800)}\n` +
    (ctx.requirements.length ? `Requisitos:\n${ctx.requirements.slice(0, 12).map((r) => `- ${clip(r, 200)}`).join("\n")}\n` : "") +
    `\n## Correções do humano durante a tarefa (o sinal mais forte)\n${corr}\n` +
    `\nPedidos de retrabalho: ${ctx.reworks}\n` +
    (ctx.reviewSummary ? `\n## Resumo do review\n${clip(ctx.reviewSummary, 1500)}\n` : "") +
    `\n## O que os agentes relataram (últimos eventos)\n${evs}\n` +
    `\n## Notas que já existem no cérebro do projeto (slug: título)\n${ctx.brainCatalog || "(nenhuma)"}\n` +
    (ctx.alreadySuggested?.length ? `\n## Já sugeridos nesta tarefa (esperando revisão) — não repita, nem com outras palavras\n${ctx.alreadySuggested.slice(0, 20).map((x) => `- ${clip(x, 160)}`).join("\n")}\n` : "") +
    `\n## Skills aprendidas que já existem neste repo (só estas podem ser atualizadas)\n${skills}\n\n` +
    `## Regras\n` +
    `- NOTAS são DECLARATIVAS: um fato, decisão, regra ou armadilha do projeto (1-4 frases em português, com [[slug]] pras notas relacionadas). Máximo ${MAX_NOTAS}.\n` +
    `- SKILLS são PROCEDIMENTAIS: um jeito de fazer reaproveitável que funcionou (ou que o humano corrigiu). Corpo em markdown com as seções "## Quando usar", "## Passo a passo", "## Armadilhas" e "## Verificação". Máximo ${MAX_SKILLS}.\n` +
    `- PREFIRA ATUALIZAR uma skill aprendida existente (acao "atualizar", mesmo nome, corpo COMPLETO revisado) a criar uma nova parecida.\n` +
    `- NÃO capture: falha de ambiente/rede, "ferramenta X quebrada", becos sem saída, relato pontual desta tarefa, nada óbvio.\n` +
    `- NUNCA inclua segredos, chaves, senhas ou valores de .env.\n` +
    `- Se não há nada que valha, responda {"notas":[],"skills":[]} — é uma resposta válida e comum.\n\n` +
    `Responda SÓ um JSON:\n` +
    `{"notas":[{"title":"título curto e geral","type":"decisão|regra|gotcha|contexto|glossário","tags":["tema"],"body":"..."}],` +
    `"skills":[{"acao":"criar|atualizar","nome":"nome-em-kebab-case","descricao":"quando usar (gatilho), 1 frase","corpo":"## Quando usar\\n...\\n## Passo a passo\\n...\\n## Armadilhas\\n...\\n## Verificação\\n...","porque":"o que nesta tarefa mostrou isso"}]}`
  );
}

/** Nome de skill portável (minúsculo, hífen) — igual ao `skill_name` do Rust. */
export function skillName(s: string): string {
  return String(s ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

function notaFrom(o: any): RetroNota | null {
  if (!o || typeof o !== "object") return null;
  const title = String(o.title ?? "").replace(/\s+/g, " ").trim();
  const body = String(o.body ?? "").trim();
  if (title.length < 4 || title.length > 140 || body.length < 8 || body.length > 2000) return null;
  return { title, type: String(o.type ?? "contexto").trim() || "contexto", tags: Array.isArray(o.tags) ? o.tags.map(String).slice(0, 6) : [], body };
}

function skillFrom(o: any): RetroSkill | null {
  if (!o || typeof o !== "object") return null;
  const nome = skillName(o.nome ?? o.name ?? "");
  const descricao = String(o.descricao ?? o.description ?? "").replace(/\s+/g, " ").trim();
  const corpo = String(o.corpo ?? o.body ?? "").trim();
  if (nome.length < 3 || descricao.length < 10 || descricao.length > 600 || corpo.length < 20 || corpo.length > 8000) return null;
  const acao = String(o.acao ?? "").toLowerCase().startsWith("atual") ? "atualizar" : "criar";
  return { acao, nome, descricao, corpo, porque: String(o.porque ?? "").replace(/\s+/g, " ").trim().slice(0, 400) };
}

/** JSON da resposta. O corpo de uma skill pode ter ``` dentro das strings — tentar o objeto
 * cru ANTES do extractJson (que procura cerca de código primeiro e pegaria o trecho errado). */
function retroJson(txt: string): unknown {
  const t = txt.trim();
  try { return JSON.parse(t); } catch { /* segue */ }
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*)\n```\s*$/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* segue */ } }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* segue */ } }
  return extractJson(t);
}

/** Saída da retro → propostas válidas dentro dos limites. Lixo/vazio → listas vazias. */
export function parseRetro(text: string): { notas: RetroNota[]; skills: RetroSkill[] } {
  const j = retroJson(String(text ?? ""));
  let notasRaw: unknown[] = [], skillsRaw: unknown[] = [];
  if (Array.isArray(j)) notasRaw = j; // formato antigo do destilador: só notas
  else if (j && typeof j === "object") {
    notasRaw = Array.isArray((j as any).notas) ? (j as any).notas : [];
    skillsRaw = Array.isArray((j as any).skills) ? (j as any).skills : [];
  }
  const notas = notasRaw.map(notaFrom).filter((x): x is RetroNota => !!x).slice(0, MAX_NOTAS);
  const seen = new Set<string>();
  const skills = skillsRaw.map(skillFrom).filter((x): x is RetroSkill => {
    if (!x || seen.has(x.nome)) return false;
    seen.add(x.nome);
    return true;
  }).slice(0, MAX_SKILLS);
  return { notas, skills };
}

// ---------------------------------------------------------------------------
// skills aprendidas do repo
// ---------------------------------------------------------------------------

export function skillsDir(repo: string): string {
  return join(repo, ".claude", "skills");
}

/** Frontmatter simples de SKILL.md: name, description, origem, tarefas + corpo. */
export function parseSkillMd(text: string): { name: string; description: string; origem: string; tarefas: string[]; body: string } {
  const src = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const out = { name: "", description: "", origem: "", tarefas: [] as string[], body: src };
  if (!src.startsWith("---\n")) return out;
  const end = src.indexOf("\n---", 4);
  if (end < 0) return out;
  const un = (v: string) => v.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  for (const line of src.slice(4, end).split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "name") out.name = un(v);
    else if (k === "description") out.description = un(v);
    else if (k === "origem") out.origem = un(v);
    else if (k === "tarefas") out.tarefas = v.trim().replace(/^\[|\]$/g, "").split(",").map(un).filter(Boolean);
  }
  out.body = src.slice(end + 4).replace(/^\n+/, "").trimEnd();
  return out;
}

/** SKILL.md de uma skill aprendida (mesmo formato do Rust `learn::skill_md`). */
export function skillMd(name: string, description: string, tarefas: string[], body: string): string {
  const desc = String(description ?? "").replace(/\s+/g, " ").replace(/["\\]/g, "'").trim();
  const ts = [...new Set(tarefas.map((t) => String(t).replace(/[,\[\]\s]+/g, "")).filter(Boolean))];
  return `---\nname: ${name}\ndescription: "${desc}"\norigem: aprendida\ntarefas: [${ts.join(", ")}]\n---\n\n${String(body ?? "").trim()}\n`;
}

/** Skills APRENDIDAS deste repo (as que a retro pode atualizar). */
export function learnedSkills(repo: string): LearnedSkill[] {
  const dir = skillsDir(repo);
  let names: string[] = [];
  try { names = readdirSync(dir).sort(); } catch { return []; }
  const out: LearnedSkill[] = [];
  for (const n of names) {
    try {
      const s = parseSkillMd(readFileSync(join(dir, n, "SKILL.md"), "utf8"));
      if (s.origem === "aprendida") out.push({ name: s.name || n, description: s.description, body: s.body, tarefas: s.tarefas });
    } catch { /* pasta sem SKILL.md */ }
  }
  return out;
}

/**
 * Grava uma skill aprendida (modo auto — o app faz o mesmo no aceite):
 * - `atualizar` de uma skill APRENDIDA que existe → corpo/descrição novos, acumula a tarefa;
 * - `criar` com nome já usado (aprendida ou não) → `nome-2`, `nome-3`… (nunca sobrescreve);
 * - `atualizar` de nome que é de skill NÃO aprendida (repo ou pessoal) → também `nome-2`…;
 * - não existe → cria.
 * Depois liga em `.cardume/skills.json` (o motor injeta no prompt via skillsContext) e põe a pasta no
 * `info/exclude` do git (não suja a árvore do checkout principal).
 */
export function applySkill(repo: string, cardumeDir: string, sk: RetroSkill, taskId: string, personalDir = join(homedir(), ".claude", "skills")): { name: string; action: "created" | "updated" } {
  const base = skillName(sk.nome) || "skill-aprendida";
  const root = skillsDir(repo);
  const slotOf = (n: string): { tarefas: string[] } | null | "other" => {
    const f = join(root, n, "SKILL.md");
    if (existsSync(f)) {
      const s = parseSkillMd(readFileSync(f, "utf8"));
      return s.origem === "aprendida" ? { tarefas: s.tarefas } : "other";
    }
    if (existsSync(join(root, n)) || existsSync(join(personalDir, n))) return "other";
    return null;
  };
  // só "atualizar" pode reescrever uma aprendida; "criar" trata qualquer nome ocupado como ocupado
  const taken = (c: ReturnType<typeof slotOf>) => c === "other" || (c !== null && sk.acao !== "atualizar");
  let name = base;
  let cur = slotOf(name);
  for (let i = 2; taken(cur); i++) { name = `${base}-${i}`; cur = slotOf(name); }
  const prev = cur && cur !== "other" ? cur : null;
  const tarefas = [...(prev ? prev.tarefas : []), taskId];
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), skillMd(name, sk.descricao, tarefas, sk.corpo), "utf8");
  enableSkill(cardumeDir, name, sk.descricao);
  excludeSkill(repo, name);
  return { name, action: prev ? "updated" : "created" };
}

/** Põe `/.claude/skills/<nome>/` no `info/exclude` do repo (idempotente; fora de git: nada). */
export function excludeSkill(repo: string, name: string): void {
  try {
    const common = execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!common) return;
    const file = join(isAbsolute(common) ? common : join(repo, common), "info", "exclude");
    const line = `/.claude/skills/${name}/`;
    let cur = "";
    try { cur = readFileSync(file, "utf8"); } catch { /* ainda não existe */ }
    if (cur.split(/\r?\n/).some((l) => l.trim() === line)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n", "utf8");
  } catch { /* não é repo git: nada a excluir */ }
}

/** Liga (ou atualiza a descrição de) uma skill em `.cardume/skills.json`. */
export function enableSkill(cardumeDir: string, name: string, description: string): void {
  const f = join(cardumeDir, "skills.json");
  let arr: any[] = [];
  try { const j = JSON.parse(readFileSync(f, "utf8")); if (Array.isArray(j)) arr = j; } catch { /* sem arquivo */ }
  const desc = String(description ?? "").replace(/\s+/g, " ").trim();
  const hit = arr.find((s) => s && s.name === name);
  if (hit) hit.description = desc;
  else arr.push({ name, description: desc });
  atomicWrite(f, JSON.stringify(arr, null, 2));
}

// ---------------------------------------------------------------------------
// fila de pendentes — cada arquivo tem UM escritor:
//   .cardume/aprendizado/pendentes.json  → só o MOTOR escreve (enfileira e poda os resolvidos)
//   .cardume/aprendizado/resolvidos.json → só o APP escreve (ids aceitos/descartados)
// pendente = pendentes − resolvidos. Arquivo que existe mas não parseia: NUNCA é sobrescrito.
// ---------------------------------------------------------------------------

export function pendingFile(cardumeDir: string): string {
  return join(cardumeDir, "aprendizado", "pendentes.json");
}
export function resolvedFile(cardumeDir: string): string {
  return join(cardumeDir, "aprendizado", "resolvidos.json");
}

/** Array JSON do arquivo: ausente → []; existe mas não é um array JSON válido → null. */
function loadArr(file: string): any[] | null {
  let txt: string;
  try { txt = readFileSync(file, "utf8"); } catch { return []; }
  try { const j = JSON.parse(txt); return Array.isArray(j) ? j : null; } catch { return null; }
}

function resolvedIds(cardumeDir: string): Set<string> | null {
  const r = loadArr(resolvedFile(cardumeDir));
  return r ? new Set(r.map(String)) : null;
}

/** Pendentes de verdade (pendentes − resolvidos). Arquivo corrompido → [] (só leitura). */
export function readPending(cardumeDir: string): PendingItem[] {
  const p = loadArr(pendingFile(cardumeDir)) ?? [];
  const done = resolvedIds(cardumeDir) ?? new Set<string>();
  return p.filter((x) => x && typeof x.id === "string" && !done.has(x.id));
}

/** Id estável: mesma proposta da mesma tarefa → mesmo id (não duplica na fila). */
export function pendingId(it: { kind: string; taskId: string; nota?: RetroNota; skill?: RetroSkill }): string {
  const key = it.nota ? `${it.nota.title}\n${it.nota.body}` : it.skill ? `${it.skill.acao}\n${it.skill.nome}\n${it.skill.corpo}` : "";
  return createHash("sha1").update(`${it.kind}\n${it.taskId}\n${key}`).digest("hex").slice(0, 16);
}

/**
 * Enfileira (sem duplicar pelo id — nem o que já foi resolvido) e poda da fila os ids que o app
 * resolveu. Algum dos arquivos corrompido → não escreve nada (devolve []). Devolve o que ENTROU.
 */
export function appendPending(cardumeDir: string, items: Omit<PendingItem, "id" | "createdAt">[], now = Date.now()): PendingItem[] {
  const cur = loadArr(pendingFile(cardumeDir));
  const done = resolvedIds(cardumeDir);
  if (!cur || !done) return [];
  const kept = cur.filter((x) => x && typeof x.id === "string" && !done.has(x.id));
  const ids = new Set([...kept.map((x) => x.id as string), ...done]);
  const added: PendingItem[] = [];
  for (const it of items) {
    const id = pendingId(it);
    if (ids.has(id)) continue;
    ids.add(id);
    added.push({ id, createdAt: now, ...it });
  }
  if (added.length || kept.length !== cur.length) atomicWrite(pendingFile(cardumeDir), JSON.stringify([...kept, ...added], null, 2));
  return added;
}

function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}
