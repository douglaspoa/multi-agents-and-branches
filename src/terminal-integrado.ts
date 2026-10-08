// TERMINAL INTEGRADO — o que o agente (claude/codex/DeepSeek-via-claude) usa de DENTRO do terminal da tarefa pra
// conversar com o Starfork sem a pessoa sair da conversa:
//   tools MCP novas (src/mcp/server.ts): suggest_replies · task_status · set_status · list_skills · use_skill ·
//     create_task · open_pr — a lógica pura/reaproveitável mora AQUI (testada em src/terminal-integrado.test.ts);
//   slash commands do Claude Code (.claude/commands/starfork-*.md, escritos pelo termPrep) e o equivalente em
//     linguagem natural (naturalCommand) pros motores sem slash command (Codex);
//   o bloco curto de instruções que vai no system prompt (INTEGRADO_RULE).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { evidenceExists, type Orchestrator } from "./orchestrator.ts";
import { parseSkillMd, skillsDir } from "./learn.ts";
import { norm } from "./req-map.ts";
import { ASK_STYLE } from "./ask-style.ts";
import { slugify, type AgentStatus, type TaskRow, type TaskSpec } from "./types.ts";

// ======================= suggest_replies =======================
export const SUGGEST_MAX_CHARS = 60;
/** 2–4 respostas curtas, sem vazio nem repetida (comparação sem caixa/acento). Erro = texto pro agente corrigir. */
export function cleanSuggestions(raw: unknown): { ok: true; options: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "options precisa ser uma lista de 2 a 4 textos curtos" };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const t = String(x ?? "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    const k = norm(t) || t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t.length > SUGGEST_MAX_CHARS ? t.slice(0, SUGGEST_MAX_CHARS - 1).trimEnd() + "…" : t);
  }
  if (out.length < 2) return { ok: false, error: "mande de 2 a 4 respostas DIFERENTES e não vazias (ex.: [\"pode seguir\", \"mostra o diff\"])" };
  return { ok: true, options: out.slice(0, 4) };
}

// ======================= task_status =======================
export type ProofState = "provado" | "sem evidência no disco" | "pendente" | "adiado" | "bloqueado";
export interface ReqProof { req: string; state: ProofState; evidence: string[]; note?: string }
type ReqEntry = { req?: string; status?: string; evidence?: unknown; note?: string; reason?: string };

/** requirements.json da worktree (ou o coletado no repo) × requisitos do spec → estado da prova de cada um. */
export function reqProofs(task: Pick<TaskRow, "id" | "worktree">, repo: string, spec: Pick<TaskSpec, "requirements">): { found: boolean; list: ReqProof[] } {
  const artDir = join(task.worktree, ".cardume", "artifacts");
  let entries: ReqEntry[] = [];
  let found = false;
  for (const p of [join(artDir, "requirements.json"), join(repo, ".cardume", "artifacts", task.id, "requirements.json")]) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      entries = Array.isArray(raw) ? raw : Array.isArray(raw?.list) ? raw.list : [];
      found = true;
      if (entries.length) break;
    } catch { /* sem arquivo aqui */ }
  }
  const stateOf = (e: ReqEntry | undefined): { state: ProofState; evidence: string[]; note?: string } => {
    if (!e) return { state: "pendente", evidence: [] };
    const ev = (Array.isArray(e.evidence) ? e.evidence : []).map(String);
    if (e.status === "deferred") return { state: "adiado", evidence: ev };
    if (e.status === "blocked") return { state: "bloqueado", evidence: ev, note: String(e.reason ?? e.note ?? "").slice(0, 160) || undefined };
    if (e.status !== "done") return { state: "pendente", evidence: ev };
    const real = ev.filter((x) => evidenceExists(artDir, task.worktree, x));
    return real.length ? { state: "provado", evidence: real } : { state: "sem evidência no disco", evidence: ev };
  };
  const list: ReqProof[] = [];
  const used = new Set<ReqEntry>();
  for (const r of (spec.requirements ?? []).map(String)) {
    const e = entries.find((x) => x && !used.has(x) && norm(x.req) === norm(r));
    if (e) used.add(e);
    list.push({ req: r, ...stateOf(e) });
  }
  // o que está no arquivo e não no spec (requisito antigo/renomeado) também aparece — é o que o gate lê
  for (const e of entries) if (e && !used.has(e) && e.req) list.push({ req: String(e.req), ...stateOf(e) });
  return { found, list };
}

/** Arquivos em .cardume/artifacts (1 nível + subpastas resumidas). */
export function artifactFiles(worktree: string, max = 40): string[] {
  const dir = join(worktree, ".cardume", "artifacts");
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(join(dir, rel)).sort(); } catch { return; }
    for (const n of names) {
      if (out.length >= max) return;
      const r = rel ? `${rel}/${n}` : n;
      let isDir = false;
      try { isDir = statSync(join(dir, r)).isDirectory(); } catch { continue; }
      if (isDir) { if (depth < 2) walk(r, depth + 1); } else out.push(r);
    }
  };
  walk("", 0);
  return out;
}

export const STATUS_PT: Record<string, string> = {
  draft: "rascunho", queued: "na fila", running: "construindo", "plan-review": "plano esperando aprovação", thinking: "planejando",
  review: "pronta pra revisão", conflict: "em conflito", "needs-you": "esperando você", done: "concluída", error: "com erro", merged: "integrada", aborted: "cancelada", paused: "pausada",
};

export interface TaskStatusInfo { text: string; provado: boolean; entregue: boolean; faltaProvar: string[]; faltaEntregar: string[] }
/** Texto do task_status. Gate SEM rodar a suíte de testes (consulta não pode levar 3 min nem ter efeito colateral). */
export async function taskStatus(orch: Orchestrator, taskId: string): Promise<TaskStatusInfo> {
  const task = orch.store.getTask(taskId);
  if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
  const spec = JSON.parse(task.spec_json) as TaskSpec;
  const { found, list } = reqProofs(task, orch.ws.repo, spec);
  const gate = await orch.verifyProofs(taskId, task, spec, { runTests: false }).catch((e) => ({ ok: false, reasons: [String((e as Error)?.message ?? e)] }));
  const wantsTests = spec.autonomy?.runTests === true || (spec.artifacts ?? []).some((a) => a.kind === "tests");
  const faltaProvar = [...gate.reasons];
  if (!["review", "done", "merged"].includes(task.status)) faltaProvar.push(`a tarefa está "${STATUS_PT[task.status] ?? task.status}" — quando terminar, set_status review`);
  const provado = faltaProvar.length === 0;
  const merged = task.status === "merged";
  const faltaEntregar: string[] = [];
  if (!provado) faltaEntregar.push("provar primeiro (itens acima)");
  if (!spec.prUrl) faltaEntregar.push("abrir o PR (open_pr)");
  else if (!merged) faltaEntregar.push(`integrar o PR ${spec.prUrl} (o humano mergeia)`);
  const entregue = merged;
  const L: string[] = [];
  L.push(`Tarefa: ${task.title} (${taskId})`);
  L.push(`Status: ${STATUS_PT[task.status] ?? task.status} [${task.status}] · etapa: ${merged || spec.prUrl ? "Entregar" : provado ? "Entregar (falta o PR)" : ["review", "done"].includes(task.status) ? "Provar" : "Construir"}`);
  L.push(`Branch: ${task.branch}`);
  L.push("");
  L.push(`Requisitos (${list.filter((r) => r.state === "provado").length}/${list.length} provados)${found ? "" : " — ainda não há .cardume/artifacts/requirements.json"}:`);
  if (!list.length) L.push("  (nenhum requisito no TASK.yaml)");
  for (const r of list) L.push(`  - [${r.state}] ${r.req}${r.evidence.length ? ` → ${r.evidence.slice(0, 3).join(", ")}` : ""}${r.note ? ` (${r.note})` : ""}`);
  L.push("");
  L.push(`Entregáveis:${(spec.deliverables ?? []).length ? "" : " (nenhum)"}`);
  for (const d of spec.deliverables ?? []) L.push(`  - ${d}`);
  const arts = artifactFiles(task.worktree);
  L.push(`Arquivos em .cardume/artifacts:${arts.length ? "" : " (vazio)"}`);
  for (const a of arts) L.push(`  - ${a}`);
  L.push(`PR: ${spec.prUrl ?? "(nenhum)"}`);
  L.push("");
  L.push(provado ? "PROVADO ✓" : `Falta para PROVADO:\n${faltaProvar.map((x) => `  - ${x}`).join("\n")}`);
  if (wantsTests) L.push("  (os testes do projeto entram no gate do PR — rode-os você antes: aqui eles não foram rodados)");
  L.push(entregue ? "ENTREGUE ✓ (integrada)" : `Falta para ENTREGUE:\n${faltaEntregar.map((x) => `  - ${x}`).join("\n")}`);
  return { text: L.join("\n"), provado, entregue, faltaProvar, faltaEntregar };
}

// ======================= set_status =======================
export const SETTABLE_STATUS = ["review", "needs-you", "running"] as const;
export type SettableStatus = (typeof SETTABLE_STATUS)[number];
const LOCKED = new Set(["merged", "aborted"]);
/** Pode mover? Erro em pt-BR quando não. */
export function canSetStatus(cur: string, next: string): string | null {
  if (!(SETTABLE_STATUS as readonly string[]).includes(next)) return `status inválido: use ${SETTABLE_STATUS.join(" | ")}`;
  if (LOCKED.has(cur)) return `a tarefa está ${STATUS_PT[cur] ?? cur} — o status não muda mais`;
  return null;
}

// ======================= skills =======================
export interface SkillInfo { name: string; description: string; origin: "projeto · ativa" | "projeto" | "pessoal"; dir: string; agente?: string }
export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".claude");
const SKILL_NAME = /^[\w.-]{1,80}$/;
function scanSkills(dir: string): { name: string; description: string; dir: string; agente: string }[] {
  let names: string[] = [];
  try { names = readdirSync(dir).sort(); } catch { return []; }
  const out: { name: string; description: string; dir: string; agente: string }[] = [];
  for (const n of names) {
    if (!SKILL_NAME.test(n)) continue;
    try {
      const s = parseSkillMd(readFileSync(join(dir, n, "SKILL.md"), "utf8"));
      out.push({ name: n, description: s.description, dir: join(dir, n), agente: s.agente });
    } catch { /* pasta sem SKILL.md */ }
  }
  return out;
}
/** Skills que o agente pode usar: as ATIVAS do projeto (.cardume/skills.json) primeiro, depois as outras do projeto
 * (repo e worktree) e as pessoais (<config do Claude>/skills). Uma por nome — a do projeto vence a pessoal. */
export function listSkills(repo: string, worktree: string | undefined, configDir = claudeConfigDir()): SkillInfo[] {
  let active: { name?: string; agente?: string }[] = [];
  try { const a = JSON.parse(readFileSync(join(repo, ".cardume", "skills.json"), "utf8")); if (Array.isArray(a)) active = a; } catch { /* sem skills.json */ }
  const project = [...scanSkills(skillsDir(repo)), ...(worktree ? scanSkills(skillsDir(worktree)) : [])];
  const personal = scanSkills(join(configDir, "skills"));
  const seen = new Set<string>();
  const out: SkillInfo[] = [];
  const push = (s: SkillInfo) => { if (!seen.has(s.name)) { seen.add(s.name); out.push(s); } };
  for (const a of active) {
    const name = String(a?.name ?? "");
    const s = project.find((p) => p.name === name) ?? personal.find((p) => p.name === name);
    if (s) push({ name, description: s.description, origin: "projeto · ativa", dir: s.dir, agente: a.agente || s.agente || undefined });
  }
  for (const s of project) push({ name: s.name, description: s.description, origin: "projeto", dir: s.dir, agente: s.agente || undefined });
  for (const s of personal) push({ name: s.name, description: s.description, origin: "pessoal", dir: s.dir, agente: s.agente || undefined });
  return out;
}
export function skillsText(list: SkillInfo[]): string {
  if (!list.length) return "Nenhuma skill neste projeto nem nas pessoais (.claude/skills/<nome>/SKILL.md).";
  return list.map((s) => `- ${s.name} [${s.origin}${s.agente ? ` · do agente ${s.agente}` : ""}]: ${s.description || "(sem descrição)"}`).join("\n") +
    "\n\nPara usar: use_skill com o nome.";
}
/** Corpo do SKILL.md (sem frontmatter) — qualquer motor segue o texto. Desconhecida → erro com as disponíveis. */
export function readSkill(name: string, repo: string, worktree: string | undefined, configDir = claudeConfigDir()): { ok: true; skill: SkillInfo; body: string } | { ok: false; error: string } {
  const n = String(name ?? "").trim().replace(/^\//, "");
  const list = listSkills(repo, worktree, configDir);
  const s = SKILL_NAME.test(n) ? list.find((x) => x.name === n) ?? list.find((x) => x.name.toLowerCase() === n.toLowerCase()) : undefined;
  if (!s) return { ok: false, error: `skill "${n}" não encontrada. Disponíveis: ${list.map((x) => x.name).join(", ") || "(nenhuma)"}` };
  try {
    const p = parseSkillMd(readFileSync(join(s.dir, "SKILL.md"), "utf8"));
    return { ok: true, skill: s, body: p.body };
  } catch (e) {
    return { ok: false, error: `não consegui ler a skill ${s.name}: ${(e as Error).message}` };
  }
}

// ======================= create_task =======================
export interface ChildInput { title: string; objective?: string; requirements?: string[]; deliverables?: string[]; same_epic?: boolean }
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : undefined);
/** Spec da tarefa NOVA a partir da atual: mesma equipe/motor/autonomia/modo/PR; épico herdado quando same_epic. */
export function childSpec(cur: TaskSpec, input: ChildInput, id: string): TaskSpec {
  const title = String(input.title ?? "").trim();
  const sameEpic = input.same_epic !== false;
  const spec: TaskSpec = {
    id,
    title,
    agent: cur.agent,
    objective: String(input.objective ?? "").trim() || title,
    deliverables: strList(input.deliverables) ?? [title],
    requirements: strList(input.requirements) ?? [],
    scope: { owns: [], offLimits: [] },
    autonomy: { ...cur.autonomy },
    engine: cur.engine,
    model: cur.model,
    roles: (cur.roles ?? []).map((r) => ({ ...r })),
    linkedTo: cur.id,
    autoPr: cur.autoPr,
    prBase: cur.prBase,
    termMode: cur.termMode,
    taskKind: cur.taskKind,
    branchType: cur.branchType,
    light: cur.light,
  };
  if (sameEpic && cur.epicId) {
    spec.epicId = cur.epicId;
    if (cur.epicDoneWhen?.length) spec.epicDoneWhen = [...cur.epicDoneWhen];
  }
  return spec;
}
/** Id livre: slug do título, com -2, -3… se já existir tarefa/worktree com ele. */
export function freeTaskId(title: string, taken: (id: string) => boolean): string {
  const base = slugify(title) || "tarefa";
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}
/** Tarefa NOVA pedida pelo agente: SEMPRE rascunho — iniciar gasta (assinatura/API), então é o humano que inicia. */
export async function createChildTask(orch: Orchestrator, curId: string, input: ChildInput, by: string): Promise<{ id: string; title: string; status: AgentStatus; note: string }> {
  const cur = orch.store.getTask(curId);
  if (!cur) throw new Error(`tarefa ${curId} não encontrada`);
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("title vazio — dê um título curto pra tarefa nova");
  const curSpec = JSON.parse(cur.spec_json) as TaskSpec;
  const id = freeTaskId(title, (x) => !!orch.store.getTask(x) || existsSync(orch.ws.worktreePath(x)));
  const spec = childSpec(curSpec, input, id);
  await orch.createTask(spec);
  orch.store.setStatus(id, "draft");
  orch.store.addEvent(id, "Sistema", "status", `criada por ${by} a partir da tarefa "${cur.title}"${spec.epicId ? " (mesmo épico)" : ""}`, true);
  return { id, title, status: "draft", note: "rascunho criado — inicie pelo quadro quando quiser" };
}

// ======================= slash commands (/starfork-*) =======================
export const STARFORK_MARK = "<!-- starfork -->";
export interface StarforkCommand { name: string; description: string; argumentHint: string; body: string }
/** Corpo = instrução em linguagem natural ($ARGUMENTS = o que a pessoa digitou depois do comando). Serve pro Claude
 * Code (arquivo .md) e, via naturalCommand, pra qualquer motor. */
export const STARFORK_COMMANDS: StarforkCommand[] = [
  {
    name: "starfork-etapa",
    description: "Leva a tarefa do Starfork pra uma etapa: construir, provar ou entregar",
    argumentHint: "construir|provar|entregar",
    body:
      `O humano pediu pra levar esta tarefa do Starfork pra etapa: "$ARGUMENTS".\n` +
      `Comece chamando a tool task_status (MCP cardume) pra ver requisitos, provas e o que falta.\n` +
      `- construir: implemente o que ainda falta dos requisitos do .cardume/TASK.yaml; ao parar, use suggest_replies.\n` +
      `- provar: rode os testes do projeto; produza as provas que faltam em .cardume/artifacts (saídas e prints REAIS, nada mockado); ` +
      `atualize .cardume/artifacts/requirements.json (status "done" + evidence com os arquivos) e chame map_requirement pra cada requisito; ` +
      `chame task_status de novo e, se não faltar nada, set_status com status "review" e uma nota do que foi provado. Se faltar algo que você não consegue provar, diga exatamente o quê.\n` +
      `- entregar: confira as provas (starfork status); se tudo provado, abra o PR (starfork pr); senão diga o que falta.\n` +
      `Sem etapa ou etapa desconhecida: mostre o task_status resumido e pergunte qual etapa com suggest_replies.`,
  },
  {
    name: "starfork-skill",
    description: "Usa uma skill do projeto ou pessoal (vazio = listar as disponíveis)",
    argumentHint: "<nome da skill>",
    body:
      `Skill pedida pelo humano: "$ARGUMENTS".\n` +
      `Se veio vazio, chame list_skills (MCP cardume), mostre a lista curta e ofereça as mais úteis com suggest_replies.\n` +
      `Senão chame use_skill com name = "$ARGUMENTS" e siga as instruções devolvidas NESTA tarefa (se o nome não existir, mostre as disponíveis).`,
  },
  {
    name: "starfork-tarefa",
    description: "Cria uma tarefa nova no Starfork ou quebra esta em tarefas menores",
    argumentHint: "nova \"<título>\" | quebrar",
    body:
      `Pedido do humano sobre tarefas: "$ARGUMENTS".\n` +
      `- nova "<título>": chame create_task (MCP cardume) com esse título, um objetivo de 1-2 frases tirado da conversa e requisitos curtos e verificáveis. ` +
      `Fica como rascunho (start=false) e no mesmo épico (same_epic=true), a menos que o humano diga outra coisa.\n` +
      `- quebrar: proponha de 2 a 5 tarefas menores com escopos que não se sobrepõem (título + requisitos de cada) e pergunte se pode criar (suggest_replies). ` +
      `Com o ok, chame create_task pra cada uma.\n` +
      `No fim liste os ids/títulos criados.`,
  },
  {
    name: "starfork-revisao",
    description: "Revisa o próprio diff por requisito com 4 lentes (correção, testes, UX, segurança)",
    argumentHint: "[foco opcional]",
    body:
      `Faça uma REVISÃO do seu próprio trabalho nesta tarefa (foco extra pedido, se houver: "$ARGUMENTS").\n` +
      `1) Chame task_status (MCP cardume) pra pegar os requisitos e o estado das provas.\n` +
      `2) Leia o diff da branch: git diff da base até HEAD + o que não foi commitado (git status / git diff).\n` +
      `3) Pra CADA requisito, avalie o código que o atende com 4 lentes: correção (faz o que pede? casos de borda), testes (há teste que cobre e passa?), ` +
      `UX (o que a pessoa vê/usa faz sentido, mensagens em pt-BR), segurança (entrada não confiável, segredos, permissões).\n` +
      `4) Liste também o que mudou e não pertence a nenhum requisito.\n` +
      `5) Dê um veredito por requisito (aprova / muda, com o porquê em 1 linha) e um veredito geral. NÃO altere código nesta revisão.\n` +
      `6) Termine com suggest_replies (ex.: "corrigir os achados", "abrir o PR", "rodar os testes").`,
  },
  {
    name: "starfork-pr",
    description: "Abre, abre como rascunho ou atualiza o PR da tarefa",
    argumentHint: "abrir|rascunho|atualizar",
    body:
      `Pedido do humano sobre o PR desta tarefa: "$ARGUMENTS".\n` +
      `- abrir (ou vazio): chame task_status (MCP cardume). Se estiver provado, chame open_pr; se faltar prova, NÃO force — diga o que falta e ofereça provar ou abrir como rascunho (suggest_replies).\n` +
      `- rascunho: chame open_pr com draft=true (não exige prova).\n` +
      `- atualizar: commite o que estiver solto e rode git push na branch da tarefa (o PR já aberto se atualiza sozinho); confirme a URL com task_status.\n` +
      `Mostre a URL do PR no fim.`,
  },
];
/** Nome aceito com ou sem "/" e com ou sem o prefixo "starfork-". */
export function findCommand(name: string): StarforkCommand | undefined {
  const n = String(name ?? "").trim().replace(/^\//, "").toLowerCase();
  return STARFORK_COMMANDS.find((c) => c.name === n || c.name === `starfork-${n}`);
}
/** Instrução em linguagem natural equivalente ao /comando (pra motores sem slash command — Codex, DeepSeek…). */
export function naturalCommand(name: string, args = ""): string {
  const c = findCommand(name);
  if (!c) throw new Error(`comando desconhecido: ${name} (use ${STARFORK_COMMANDS.map((x) => "/" + x.name).join(", ")})`);
  const a = String(args ?? "").trim();
  return c.body.replace(/\$ARGUMENTS/g, a);
}
export function commandMd(c: StarforkCommand): string {
  const fm = (v: string) => JSON.stringify(v);
  return `---\ndescription: ${fm(c.description)}\nargument-hint: ${fm(c.argumentHint)}\n---\n${STARFORK_MARK}\n${c.body}\n`;
}
/** Escreve .claude/commands/starfork-*.md na worktree. Arquivo de mesmo nome que NÃO é nosso (sem a marca) fica intocado. */
export function writeStarforkCommands(worktree: string): { written: string[]; skipped: string[] } {
  const dir = join(worktree, ".claude", "commands");
  const written: string[] = [], skipped: string[] = [];
  for (const c of STARFORK_COMMANDS) {
    const rel = `.claude/commands/${c.name}.md`;
    const p = join(dir, `${c.name}.md`);
    let cur: string | null = null;
    try { cur = readFileSync(p, "utf8"); } catch { /* não existe */ }
    if (cur !== null && !cur.includes(STARFORK_MARK)) { skipped.push(rel); continue; }
    const md = commandMd(c);
    if (cur !== md) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, md, "utf8"); }
    written.push(rel);
  }
  return { written, skipped };
}

// ======================= instruções (system prompt / kickoff) =======================
export const INTEGRADO_RULE =
  `## Terminal integrado do Starfork\n` +
  `Você está no terminal integrado do Starfork: a pessoa conversa com você pelo app. Ferramentas do MCP cardume:\n` +
  `- suggest_replies: termine TODA resposta chamando suggest_replies (ou \`starfork sugerir\` no shell) com 2–4 próximas perguntas/ações curtas que o humano provavelmente mandaria (viram botões no app) — inclusive quando só respondeu uma pergunta.\n` +
  `- Quando o humano pedir na conversa: status / o que falta → task_status; marcar pronta pra revisão ou esperando ele → set_status; abrir PR → open_pr; ` +
  `tarefa nova ou quebrar esta → create_task; skills → list_skills e use_skill; ` +
  `agrupar tarefas num épico → create_epic (épico novo) ou link_tasks_to_epic (épico existente; list_epics mostra os do time) — vincula tarefas JÁ existentes, NUNCA recrie uma tarefa pra trocar o épico; tirar do épico → unlink_tasks_from_epic.\n` +
  `- Arquivos que o humano anexa chegam como caminhos @.cardume/refs/<arquivo> — leia-os antes de responder.\n` +
  `- Perguntar ao humano (AskUserQuestion, ask_human ou \`starfork perguntar\`):${ASK_STYLE}\n`;
export const INTEGRADO_CLAUDE_CMDS = `- Comandos deste projeto: ${STARFORK_COMMANDS.map((c) => "/" + c.name).join(", ")}.\n`;

// ======================= `starfork …` no shell (qualquer IA) =======================
/** Os comandos do shell do terminal (src/starfork-cli.ts) — a MESMA lógica das tools do MCP (src/mcp/tools.ts). */
export const SHELL_COMMANDS: { cmd: string; tool: string; desc: string }[] = [
  { cmd: "starfork status", tool: "task_status", desc: "requisitos × provas, entregáveis, PR e o que falta pra provado/entregue" },
  { cmd: "starfork sugerir \"<resposta 1>\" \"<resposta 2>\" […]", tool: "suggest_replies", desc: "2 a 4 respostas curtas que o humano provavelmente mandaria (viram botões no app)" },
  { cmd: "starfork etapa review|needs-you|running [--nota \"…\"]", tool: "set_status", desc: "pronta pra revisão · esperando o humano · construindo" },
  { cmd: "starfork skills", tool: "list_skills", desc: "skills do projeto e pessoais" },
  { cmd: "starfork skill <nome>", tool: "use_skill", desc: "imprime as instruções da skill pra você seguir" },
  { cmd: "starfork tarefa \"<título>\" [--objetivo …] [--requisito …]… [--fora-do-epico]", tool: "create_task", desc: "tarefa NOVA no projeto (rascunho — o humano inicia pelo quadro)" },
  { cmd: "starfork epico novo \"<título>\" [--descricao …] [--outcome …] [--pronto …]… [--tarefas id1,id2]", tool: "create_epic", desc: "cria um ÉPICO no time (o app executa) e já vincula tarefas existentes" },
  { cmd: "starfork epico vincular <épico> <tarefa>…", tool: "link_tasks_to_epic", desc: "põe tarefas EXISTENTES num épico (id ou nome) — sem recriar nem reiniciar" },
  { cmd: "starfork epico desvincular <tarefa>…", tool: "unlink_tasks_from_epic", desc: "tira tarefas do épico (elas continuam como estão)" },
  { cmd: "starfork epico status [<pedido>] · starfork epicos", tool: "epic_request_status", desc: "desfecho dos pedidos de épico · épicos do time" },
  { cmd: "starfork pr [--rascunho] [--titulo …] [--corpo …]", tool: "open_pr", desc: "abre o PR (exige provas, a não ser --rascunho)" },
  { cmd: "starfork requisito \"<texto>\"", tool: "add_requirement", desc: "registra um requisito novo pedido pelo humano" },
  { cmd: "starfork entregavel \"<item>\"", tool: "add_deliverable", desc: "registra um entregável novo" },
  { cmd: "starfork perguntar \"<pergunta curta?>\" [--contexto \"tópico\"]… [--opcao \"Rótulo — descrição\"]…", tool: "ask_human", desc: "pergunta ao humano pelo app (espera a resposta): 1 frase com '?', contexto em 3–5 tópicos, opções com rótulo curto + descrição" },
  { cmd: "starfork mapa --json '{\"req\":…,\"code\":[…]}'", tool: "map_requirement", desc: "liga um requisito aos trechos de código/testes" },
];
export const SECTION_BEGIN = "<!-- starfork:inicio -->";
export const SECTION_END = "<!-- starfork:fim -->";
/** Instruções do terminal integrado pra QUALQUER IA (AGENTS.md / GEMINI.md / arquivo próprio / 1ª mensagem). */
export function shellInstructions(): string {
  return `# Starfork — terminal integrado desta tarefa\n` +
    `Você roda dentro do terminal de uma tarefa do Starfork (o humano conversa com você pelo app).\n` +
    `- A tarefa (objetivo, requisitos, entregáveis, escopo) está em .cardume/TASK.yaml — leia antes de começar.\n` +
    `- Provas vão em .cardume/artifacts (requirements.json com status "done" + evidence apontando pra arquivos reais).\n` +
    `- Arquivos que o humano anexa chegam como caminhos @.cardume/refs/<arquivo> — leia-os antes de responder.\n` +
    `- Pra falar com o Starfork use as ferramentas do MCP "cardume" (se a sua IA tiver) OU estes comandos no shell (mesmo efeito):\n` +
    SHELL_COMMANDS.map((c) => `  - \`${c.cmd}\` — ${c.desc} (= ${c.tool})`).join("\n") + "\n" +
    `- Perguntar ao humano:${ASK_STYLE}\n` +
    `- Termine TODA resposta chamando \`starfork sugerir\` (ou a tool suggest_replies) com 2–4 próximas perguntas/ações curtas — inclusive quando só respondeu uma pergunta.\n` +
    `- Quando terminar: \`starfork status\`; se não faltar prova, \`starfork etapa review --nota "o que foi provado"\`. PR só quando o humano pedir.\n`;
}
/** Funde a seção do Starfork (entre os marcadores) num texto existente — troca só a nossa, preserva o resto. */
export function mergeSection(cur: string | null, body: string): string {
  const block = `${SECTION_BEGIN}\n${body.trim()}\n${SECTION_END}\n`;
  const t = cur ?? "";
  const i = t.indexOf(SECTION_BEGIN), j = t.indexOf(SECTION_END);
  if (i >= 0 && j > i) return t.slice(0, i) + block + t.slice(j + SECTION_END.length).replace(/^\n/, "");
  return t ? `${t}${t.endsWith("\n") ? "" : "\n"}\n${block}` : block;
}
/** Só a nossa seção (sem nada da pessoa fora dos marcadores)? */
export const onlyOurSection = (t: string) => { const i = t.indexOf(SECTION_BEGIN), j = t.indexOf(SECTION_END); return i >= 0 && j > i && !(t.slice(0, i) + t.slice(j + SECTION_END.length)).trim(); };
/** O arquivo é RASTREADO no git da worktree? (rastreado = do repo da pessoa: o Starfork não mexe) */
export function gitTracked(worktree: string, rel: string): boolean {
  const r = spawnSync("git", ["-C", worktree, "ls-files", "--error-unmatch", "--", rel], { stdio: "ignore", timeout: 5000 });
  return r.status === 0;
}
/**
 * Escreve a seção do Starfork em <worktree>/<rel> (AGENTS.md, GEMINI.md) SÓ quando o arquivo não existe ou já é só
 * nosso — arquivo rastreado ou com texto da pessoa fica INTOCADO (a seção entraria no commit da tarefa). Devolve se
 * escreveu (false = o chamador usa o outro caminho: arquivo próprio da IA ou a 1ª mensagem).
 */
export function writeInstructionsSection(worktree: string, rel: string, body = shellInstructions()): boolean {
  const p = join(worktree, rel);
  let cur: string | null = null;
  try { cur = readFileSync(p, "utf8"); } catch { /* não existe */ }
  if (cur !== null && !onlyOurSection(cur)) return false;
  if (gitTracked(worktree, rel)) return false;
  const next = mergeSection(cur, body);
  if (next !== cur) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, next, "utf8"); }
  return true;
}

// ======================= chips de reserva (o agente esqueceu o suggest_replies) =======================
const LIST_ITEM = /^\s*(?:\d{1,2}[.)]|[-*•])\s+(.+?)\s*$/;
const cleanItem = (t: string) => t.replace(/\*\*|__|`/g, "").replace(/[.;:]+$/, "").trim();
/**
 * PURA: a fala do agente TERMINA com opções claras? → 2–4 chips; senão null (não inventa nada).
 *  - lista no fim (numerada ou com marcador), 2–4 itens de até 60 caracteres (uma pergunta curta depois da lista vale);
 *  - ou a última frase é uma pergunta "A ou B?" (com o verbo de cortesia tirado: "Prefere manter ou ajustar?").
 */
export function suggestFromText(text: string): string[] | null {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!lines.length) return null;
  let end = lines.length;
  if (!LIST_ITEM.test(lines[end - 1]) && /\?\s*$/.test(lines[end - 1]) && end >= 2 && LIST_ITEM.test(lines[end - 2])) end--;
  const items: string[] = [];
  for (let i = end - 1; i >= 0 && LIST_ITEM.test(lines[i]); i--) items.unshift(cleanItem(lines[i].match(LIST_ITEM)![1]));
  if (items.length) {
    if (items.length < 2 || items.length > 4 || items.some((x) => !x || x.length > SUGGEST_MAX_CHARS)) return null;
    const r = cleanSuggestions(items);
    return r.ok && r.options.length === items.length ? r.options : null;
  }
  const last = lines[lines.length - 1].trim();
  const q = last.match(/(?:^|[.!:]\s+)([^.!:?]+\?)\s*$/)?.[1] ?? (last.endsWith("?") ? last : "");
  if (!q) return null;
  const parts = q.replace(/\?\s*$/, "").split(/\s+ou\s+/i);
  if (parts.length !== 2) return null;
  const lead = /^(?:e\s+)?(?:você\s+)?(?:quer|prefere|devo|posso|vamos|seguimos com|seria melhor)\s+(?:que\s+eu\s+)?/i;
  const a = cleanItem(parts[0].split(/[,;]\s*/).pop()!.replace(lead, ""));
  const b = cleanItem(parts[1]);
  if (a.length < 2 || b.length < 2 || a.length > SUGGEST_MAX_CHARS || b.length > SUGGEST_MAX_CHARS) return null;
  const r = cleanSuggestions([a, b]);
  return r.ok ? r.options : null;
}
/** Já houve `suggest` desde a última fala do humano ("Você: …")? */
export function suggestedSinceUser(events: { agent: string; type: string; text: string }[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "suggest") return true;
    if (e.agent === "Você" && /^Você:/.test(e.text)) return false;
  }
  return false;
}
