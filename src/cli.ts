import { rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator, branchName, defaultEngine } from "./orchestrator.ts";
import { GitService } from "./git.ts";
import { Store } from "./store.ts";
import { detectScopeOverlap, type ScopeOverlap } from "./bus.ts";
import { Workspace } from "./workspace.ts";
import { run } from "./util/run.ts";
import { c, statusColor, eventGlyph } from "./util/ansi.ts";
import { slugify } from "./types.ts";
import { ensureConfig, loadConfig, resolveAgents, resolveWorkflow } from "./config.ts";
import { rolesForKind, TASK_KINDS, type TaskKind } from "./lifecycle.ts";
import { applyOrgPolicy, orgAgentPolicy, policyActive } from "./org-policy.ts";
import { parseArgs, type Args } from "./util/args.ts";
import type { AgentRole, Role, TaskRow, TaskSpec } from "./types.ts";
import { ensureFreshContext, epicTasksText, knownEpics, listEpicTasks, resolveEditTarget, resolveEpicTarget } from "./epic-context.ts";
import { install as slInstall, uninstall as slUninstall, status as slStatus } from "./claude-statusline.ts";
import { mobileCli } from "./mobile.ts";
import { askHookCli, AUQ_TOOL, hookCli, HOOK_MARK, setTermAi, statuslineCli, termMessage, termPrep, turnEndCli } from "./terminal.ts";
import { starforkCli } from "./starfork-cli.ts";
import { browserProxyCli } from "./browser-proxy.ts";
import { envCli } from "./env-up.ts";
import { AP_MAX_ATTEMPTS, AP_MAX_PARALLEL, AP_PLATFORMS, PHASE_PT, readState, requestStop, runAutopilot, type ApPlatform } from "./autopilot.ts";
import { checkEpicShape, checkTaskShape, decideProposal, editEpic, editTask, syncEpicDoneWhen, undoTaskEdit, type EditAuthor, type EditResult, type EpicEditInput, type TaskEditInput } from "./agent-edits.ts";

// ---------- parse de flags simples (src/util/args.ts) ----------
const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

// ---------- render ----------
function renderList(store: Store): string {
  const tasks = store.listTasks();
  if (tasks.length === 0) return c.dim("  (nenhuma tarefa)\n");
  const rows = tasks.map((t) => {
    const col = statusColor(t.status);
    const d = store.getDiff(t.id);
    const diff = d ? `${c.green("+" + d.additions)} ${c.red("-" + d.deletions)} ${c.dim(d.files + "f")}` : c.dim("—");
    const last = store.eventsForTask(t.id).slice(-1)[0];
    const lastTxt = last ? c.dim(`${eventGlyph(last.type)} ${last.text}`) : "";
    const roles = (JSON.parse(t.roles_json || "[]") as { role: string; name: string }[])
      .map((r) => r.name)
      .join(" → ");
    const rev = store.getReview(t.id) ? c.green(" ✓review") : "";
    const name = `${c.bold((roles || t.agent).padEnd(18))} ${c.dim(t.branch)}${rev}`;
    return `  ${col("●")} ${col(t.status.padEnd(8))} ${name}\n      ${diff}   ${lastTxt}`;
  });
  return rows.join("\n") + "\n";
}

function renderOverlaps(overlaps: ScopeOverlap[], selfId: string): string {
  const lines = [
    c.yellow("! sobreposição de escopo") +
      c.dim(` — "${selfId}" toca área de tarefa(s) ativa(s):`),
  ];
  for (const o of overlaps) {
    const via = o.kind === "claim" ? c.dim("(claim em vigor)") : c.dim("(owns)");
    lines.push(
      `  ${c.bold(o.taskId)} ${c.dim("·")} ${o.agent}: ${c.cyan(o.yours)} ✕ ${c.cyan(o.theirs)} ${via}`
    );
  }
  lines.push(
    c.dim("  → considere ") +
      c.green("dividir") +
      c.dim(" o escopo (owns) ou ") +
      c.green("sequenciar") +
      c.dim(" (rode uma, depois a outra). Use --no-overlap-check p/ silenciar.")
  );
  return lines.join("\n") + "\n";
}

// ---------- comandos ----------
async function cmdInit(repo: string, noGit = false) {
  const git = new GitService(repo);
  if (!(await git.isRepo())) {
    if (!noGit) {
      console.error(c.red(`✕ ${repo} não é um repositório git.`) + c.dim(" (use --no-git pra abrir a pasta mesmo assim)"));
      process.exit(1);
    }
    console.log(c.yellow("!") + ` ${repo} não é um repositório git — workspace criado sem branches (crie o repositório quando quiser)`);
  }
  const ws = new Workspace(repo);
  ws.ensure();
  new Store(ws.dbFile).close();
  console.log(c.green("✓") + ` workspace Starfork pronto em ${c.dim(ws.dir)}`);
  if (ensureConfig(repo)) console.log(c.green("✓") + ` catálogo criado em ${c.dim("cardume.config.json")} (agentes + workflows)`);
  console.log(c.dim("  dica: adicione .cardume/ ao seu .gitignore"));
}

function cmdAgents(repo: string) {
  const cfg = loadConfig(repo);
  console.log("\n" + c.bold(c.green("✦ Agentes")) + c.dim("  (cardume.config.json)\n"));
  for (const a of cfg.agents) {
    console.log(`  ${c.bold(a.name.padEnd(8))} ${c.cyan(a.role.padEnd(9))} ${c.dim(a.engine)}  ${c.dim("#" + a.id)}`);
    if (a.persona) console.log(`      ${c.dim("↳ " + a.persona)}`);
  }
  console.log("");
}

function cmdWorkflows(repo: string) {
  const cfg = loadConfig(repo);
  const byId = Object.fromEntries(cfg.agents.map((a) => [a.id, a]));
  console.log("\n" + c.bold(c.green("✦ Workflows")) + c.dim("  (cardume.config.json)\n"));
  for (const w of cfg.workflows) {
    const chain = w.steps.map((s) => `${byId[s]?.name ?? s}${c.dim("(" + (byId[s]?.role ?? "?") + ")")}`).join(c.dim(" → "));
    console.log(`  ${c.bold(w.name.padEnd(22))} ${c.dim("#" + w.id)}`);
    console.log(`      ${chain}`);
  }
  console.log(c.dim("\n  use: ") + c.green("cardume new --title \"...\" --workflow <id>") + "\n");
}

// --models "Vega=opus,Íris=sonnet" → modelo POR AGENTE (sobrepõe o --model global)
function applyModelOverrides(roles: AgentRole[], flag?: string): AgentRole[] {
  if (!flag) return roles;
  const map: Record<string, string> = {};
  String(flag).split(",").forEach((p) => {
    const [k, v] = p.split("=");
    if (k && v && v.trim()) map[k.trim().toLowerCase()] = v.trim();
  });
  return roles.map((r) => (map[r.name.toLowerCase()] ? { ...r, model: map[r.name.toLowerCase()] } : r));
}

function buildRoles(a: Args, repo: string): AgentRole[] {
  return applyModelOverrides(buildRolesInner(a, repo), a.flags.models);
}

function buildRolesInner(a: Args, repo: string): AgentRole[] {
  const engine = a.flags.engine; // se omitido, usa o do agente no config
  const model = a.flags.model;

  // 1) --workflow <id> resolve pelo catálogo
  if (a.flags.workflow) {
    return resolveWorkflow(loadConfig(repo), a.flags.workflow, engine, model);
  }
  // 2) --roles + --agents (papéis + nomes explícitos, sem catálogo)
  const roleNames = list(a.flags.roles) as Role[];
  const agents = list(a.flags.agents);
  if (roleNames.length > 0) {
    return roleNames.map((role, i) => ({ role, name: agents[i] ?? `Agente ${i + 1}`, engine: engine ?? "mock", model }));
  }
  // 3) --agents <ids do catálogo>
  if (agents.length > 0) {
    return resolveAgents(loadConfig(repo), agents, engine, model);
  }
  // 4) padrão: 1 builder
  return [{ role: "builder", name: a.flags.agent ?? "Agente", engine: engine ?? "mock", model }];
}

async function cmdNew(repo: string, a: Args) {
  const title = a.flags.title;
  if (!title) {
    console.error(c.red("✕ use --title \"...\""));
    process.exit(1);
  }
  // id pode vir do app (pra ele já rastrear o processo); senão, do título.
  const id = a.flags.id ? slugify(a.flags.id) : slugify(title);
  // P2: o TIPO de entrega muda as etapas. Sem workflow/agentes/papéis explícitos, a equipe vem do tipo (FLOW_BY_KIND).
  const kindFlag = String(a.flags["task-kind"] ?? "").trim();
  const taskKind = (TASK_KINDS as string[]).includes(kindFlag) ? (kindFlag as TaskKind) : undefined;
  const explicitTeam = !!(a.flags.workflow || a.flags.agents || a.flags.roles);
  const roles = taskKind && !explicitTeam
    ? applyModelOverrides(rolesForKind(taskKind, loadConfig(repo).agents, { engine: a.flags.engine, model: a.flags.model, withDesign: a.flags["with-design"] === "true" }), a.flags.models)
    : buildRoles(a, repo);
  const lead = roles.find((r) => r.role === "builder") ?? roles[0];
  const artifacts: TaskSpec["artifacts"] = [];
  if (a.flags["artifact-doc"]) {
    const name = a.flags["artifact-doc"] === "true" ? "ARCHITECTURE.md" : a.flags["artifact-doc"];
    artifacts.push({ kind: "doc", name, desc: "Documento de arquitetura da solução" });
  }
  if (a.flags["artifact-proof"]) {
    artifacts.push({ kind: "proof", name: "proof", desc: "Prova comprovando a solução" });
  }
  if (a.flags["artifact-tests"]) {
    artifacts.push({ kind: "tests", name: "tests.md", desc: "Testes reais comprovando a funcionalidade" });
  }
  const spec: TaskSpec = {
    id,
    title,
    agent: lead.name,
    objective: a.flags.objective ?? title,
    deliverables: a.multi.deliverable ?? [title],
    requirements: a.multi.requirement ?? list(a.flags.requirements),
    artifacts: artifacts.length ? artifacts : undefined,
    branchType: a.flags["branch-type"] || undefined,
    issueCode: a.flags.issue || undefined,
    issueUrl: a.flags["issue-url"] || undefined,
    base: a.flags.base || undefined,
    autoPr: (a.flags["auto-pr"] === "no" || a.flags["auto-pr"] === "auto" ? a.flags["auto-pr"] : "ask") as TaskSpec["autoPr"],
    prBase: a.flags["pr-base"] || undefined,
    linkedTo: a.flags["linked-to"] || undefined,
    light: a.flags.light === "true" || undefined,
    // tarefa SOB ÉPICO (cartão aprovado no planner) — ausentes numa tarefa comum
    epicId: a.flags["epic-id"] || undefined,
    verify: a.flags.verify || undefined,
    covers: a.multi.cover?.length ? a.multi.cover : undefined,
    after: a.multi.after?.length ? a.multi.after : undefined,
    wave: a.flags.wave && Number(a.flags.wave) > 0 ? Number(a.flags.wave) : undefined,
    boundaries: a.multi.boundary?.length ? a.multi.boundary : undefined,
    risk: (["low", "medium", "high"].includes(a.flags.risk) ? a.flags.risk : undefined) as TaskSpec["risk"],
    hitl: a.flags.hitl === "true" || undefined,
    // modo da tarefa (terminal | auto) — fixo a partir daqui (src/terminal.ts)
    termMode: a.flags["term-mode"] === "terminal" ? "terminal" : a.flags["term-mode"] === "auto" ? "auto" : undefined,
    epicDoneWhen: a.multi["done-when"]?.length ? a.multi["done-when"] : undefined,
    scope: { owns: list(a.flags.owns), offLimits: list(a.flags.off) },
    autonomy: {
      clarifications: (a.flags.clarifications as TaskSpec["autonomy"]["clarifications"]) ?? "ask",
      commit: "at-end",
      runTests: a.flags["no-tests"] ? false : true,
      approval: (a.flags.approve as TaskSpec["autonomy"]["approval"]) ?? "ask",
      // Cadeado 1 (K1): tarefa com tipo de entrega aprova o plano por padrão (só "--plan-approval auto" tira)
      planApproval: a.flags["plan-approval"] === "review" || (taskKind && a.flags["plan-approval"] !== "auto" && roles.some((r) => r.role === "planner")) ? "review" : "auto",
      busPolicy: (["first-claim-wins", "human-tiebreak", "sequential-lock"].includes(a.flags["bus-policy"])
        ? a.flags["bus-policy"]
        : undefined) as TaskSpec["autonomy"]["busPolicy"],
    },
    engine: a.flags.engine ?? "mock",
    model: a.flags.model,
    roles,
    taskKind,
    // teto da tarefa (P6) já na criação — o app também grava depois (patch_task_spec)
    budgetUsd: Number(a.flags["budget-usd-task"]) > 0 ? Number(a.flags["budget-usd-task"]) : undefined,
  };

  // F5 · P14: a política da organização (Empresa) que o app leu da nuvem — aplicada ANTES de nascer a worktree.
  // Sem a flag (Grátis, sem login, offline sem cache) nada muda.
  let policyNotes: string[] = [];
  if (a.flags["org-policy"]) {
    let raw: unknown = null;
    try { raw = JSON.parse(a.flags["org-policy"]); } catch { /* lixo = sem política */ }
    const pol = orgAgentPolicy(raw);
    if (policyActive(pol)) {
      const r = applyOrgPolicy(spec, pol, loadConfig(repo).agents);
      if (r.blocked) {
        console.error(c.red("✕ " + r.blocked));
        process.exit(1);
      }
      Object.assign(spec, r.spec);
      policyNotes = r.notes;
    }
  }

  const refSources = a.multi.ref ?? [];
  const orch = new Orchestrator(repo);
  // Detecção proativa de sobreposição de escopo: avisa (não bloqueia) se esta
  // demanda pisa na área de outra tarefa ainda ativa. Silenciável com --no-overlap-check.
  if (!a.flags["no-overlap-check"]) {
    const overlaps = detectScopeOverlap(orch.store, spec);
    if (overlaps.length) console.log(renderOverlaps(overlaps, spec.id));
  }
  console.log(c.dim(`→ criando worktree ${branchName(spec)} · equipe: ${roles.map((r) => r.role + ":" + r.name).join(" → ")}`));
  await orch.createTask(spec, refSources);
  for (const n of policyNotes) orch.store.addEvent(id, "Sistema", "note", n, true);
  if (a.flags["no-start"]) {
    orch.store.setStatus(id, "draft");
    console.log(c.green("✓") + ` rascunho ${c.bold(id)} criado — inicie quando quiser (${c.green("cardume start " + id)})`);
    orch.close();
    return;
  }
  console.log(c.dim(`→ rodando a equipe …\n`));
  await orch.runTask(id);
  console.log(renderList(orch.store));
  const rev = orch.store.getReview(id);
  if (rev) console.log(c.dim(`  review disponível: `) + c.green(`cardume review ${id} --repo ${repo}`) + "\n");
  orch.close();
}

/** F5 · P15: `cardume sample-review <taskId> --agent <id> --cap <usd> [--json]` — só a revisão, numa cópia descartável. */
async function cmdSampleReview(repo: string, taskId: string | undefined, a: Args) {
  const json = a.flags.json === "true";
  const fail = (msg: string) => { if (json) console.log(JSON.stringify({ error: msg })); else console.error(c.red("✕ " + msg)); process.exit(1); };
  if (!taskId || !a.flags.agent) return fail("use: cardume sample-review <tarefa> --agent <id> --cap <US$>");
  const cap = Number(a.flags.cap);
  if (!(cap > 0)) return fail("a amostra precisa de um teto (--cap)");
  const orch = new Orchestrator(repo);
  try {
    const r = await orch.sampleReview(taskId, a.flags.agent, cap);
    console.log(json ? JSON.stringify(r) : `${r.title}: antes ${r.old.kind ?? "sem veredito"} · agora ${r.now.kind} (US$ ${r.usd.toFixed(2)})`);
  } catch (e) {
    orch.close();
    return fail((e as Error).message);
  }
  orch.close();
}

function openStore(repo: string): Store {
  const ws = new Workspace(repo);
  if (!existsSync(ws.dbFile)) {
    console.error(c.red(`✕ nenhum workspace Starfork em ${repo}. Rode: cardume init`));
    process.exit(1);
  }
  return new Store(ws.dbFile);
}

function cmdMetrics(repo: string, json = false) {
  const store = openStore(repo);
  const m = store.coordinationMetrics();
  if (json) {
    console.log(JSON.stringify(m));
    store.close();
    return;
  }
  console.log("\n" + c.bold(c.green("✦ Coordenação")) + c.dim(`  ${repo}\n`));
  console.log(`  ${c.bold("tarefas")}            ${m.totalTasks}`);
  const st = Object.entries(m.byStatus)
    .map(([k, v]) => `${statusColor(k)(k)}:${v}`)
    .join("  ");
  if (st) console.log(`  ${c.dim("por status")}         ${st}`);
  console.log(
    `  ${c.bold("conflitos")}          ${m.conflictTasks ? c.red(String(m.conflictTasks)) : c.green("0")} ${c.dim("(tarefas que caíram em merge manual)")}`
  );
  console.log(
    `  ${c.bold("colisões (bus)")}     ${m.collisionEvents ? c.yellow(String(m.collisionEvents)) : c.green("0")} ${c.dim("(agente cedeu a vez em first-claim-wins)")}`
  );
  console.log(
    `  ${c.bold("reworks")}            ${m.reworkCount ? c.yellow(String(m.reworkCount)) : c.green("0")} ${c.dim("(re-execuções pedidas pelo humano)")}`
  );
  console.log(c.dim("\n  baseline p/ o POC de overlap — compare antes/depois de ligar a detecção.\n"));
  store.close();
}

function cmdOverlap(repo: string, a: Args) {
  const store = openStore(repo);
  const owns = list(a.flags.owns);
  const json = !!a.flags.json;
  if (owns.length === 0) {
    if (json) {
      console.log("[]");
      store.close();
      return;
    }
    console.error(c.red('✕ use --owns "src/auth/**,src/api/*.ts" (padrões de escopo a checar)'));
    process.exit(1);
  }
  const probe = {
    id: a.flags.id ? slugify(a.flags.id) : "(nova)",
    scope: { owns, offLimits: list(a.flags.off) },
  } as unknown as TaskSpec;
  const overlaps = detectScopeOverlap(store, probe);
  if (json) {
    console.log(JSON.stringify(overlaps));
    store.close();
    return;
  }
  console.log("");
  if (overlaps.length === 0) {
    console.log(c.green("✓") + ` sem sobreposição com tarefas ativas para: ${c.cyan(owns.join(", "))}\n`);
  } else {
    console.log(renderOverlaps(overlaps, probe.id));
  }
  store.close();
}

function cmdListCmd(repo: string) {
  const store = openStore(repo);
  console.log("\n" + c.bold(c.green("✦ Starfork")) + c.dim(`  ${repo}\n`));
  console.log(renderList(store));
  store.close();
}

function cmdLogs(repo: string, taskId: string) {
  const store = openStore(repo);
  const t = store.getTask(taskId);
  if (!t) {
    console.error(c.red(`✕ tarefa ${taskId} não encontrada`));
    process.exit(1);
  }
  console.log("\n" + c.bold(t.agent) + c.dim(`  ${t.branch}\n`));
  for (const e of store.eventsForTask(taskId)) {
    const g = eventGlyph(e.type);
    const col = e.type === "collision" || e.type === "error" ? c.red : e.type === "claim" ? c.cyan : c.dim;
    console.log(`  ${col(g)} ${c.dim(e.type.padEnd(9))} ${e.text}`);
  }
  console.log("");
  store.close();
}

function cmdReview(repo: string, taskId: string) {
  const store = openStore(repo);
  const t = store.getTask(taskId);
  if (!t) {
    console.error(c.red(`✕ tarefa ${taskId} não encontrada`));
    process.exit(1);
  }
  const r = store.getReview(taskId);
  if (!r) {
    console.log(c.dim(`\nsem review para ${taskId} — a tarefa tem um papel "reviewer"?\n`));
    store.close();
    return;
  }
  console.log("\n" + c.bold(c.green("✦ Review humano")) + c.dim(`  ${t.title}  ·  ${t.branch}`));
  console.log(c.dim(`  revisado por ${r.byAgent}\n`));
  console.log("  " + c.bold("Resumo"));
  console.log("  " + r.summary + "\n");
  console.log("  " + c.bold("Funções/definições criadas"));
  if (r.functions.length === 0) console.log(c.dim("    (nenhuma detectada)"));
  for (const f of r.functions) {
    console.log(`    ${c.green(f.name)} ${c.dim("(" + f.kind + ")")} ${c.dim("· " + f.file)}`);
    console.log(`      ${c.dim("↳ " + f.purpose)}`);
  }
  console.log("\n  " + c.bold("Arquivos alterados"));
  for (const f of r.files) {
    console.log(`    ${f.path}  ${c.green("+" + f.add)} ${c.red("-" + f.del)}`);
  }
  console.log("\n  " + c.bold("Como testar"));
  console.log("  " + c.dim(r.howToTest) + "\n");
  store.close();
}

function buildExportMarkdown(store: Store, t: TaskRow): string {
  const spec = JSON.parse(t.spec_json) as TaskSpec;
  const roles = (JSON.parse(t.roles_json || "[]") as { role: string; name: string }[]);
  const review = store.getReview(t.id);
  const diff = store.getDiff(t.id);
  const events = store.eventsForTask(t.id);

  const out: string[] = [];
  out.push(`# ${t.title}`);
  out.push("");
  out.push("## Objetivo");
  out.push(t.objective || spec.objective || "—");
  out.push("");

  out.push("## Entregáveis");
  if (spec.deliverables && spec.deliverables.length) {
    for (const d of spec.deliverables) out.push(`- ${d}`);
  } else {
    out.push("—");
  }
  out.push("");

  out.push("## Equipe");
  if (roles.length) {
    for (const r of roles) out.push(`- **${r.role}** → ${r.name}`);
  } else {
    out.push(`- **builder** → ${t.agent}`);
  }
  out.push("");

  out.push("## Resumo do review");
  out.push(review ? review.summary : "_(sem review)_");
  out.push("");

  out.push("## Funções criadas");
  if (review && review.functions.length) {
    for (const f of review.functions) {
      out.push(`- \`${f.name}\` (${f.kind}, ${f.file}) — ${f.purpose}`);
    }
  } else {
    out.push("_(nenhuma detectada)_");
  }
  out.push("");

  out.push("## Arquivos alterados");
  const files = review?.files ?? [];
  if (files.length) {
    for (const f of files) out.push(`- \`${f.path}\` +${f.add}/-${f.del}`);
  } else if (diff) {
    out.push(`- ${diff.files} arquivo(s), +${diff.additions}/-${diff.deletions}`);
  } else {
    out.push("—");
  }
  out.push("");

  out.push("## Como testar");
  out.push(review ? review.howToTest : "_(sem instruções)_");
  out.push("");

  out.push("## Timeline");
  if (events.length) {
    for (const e of events) {
      const when = new Date(e.ts).toISOString();
      out.push(`- \`${when}\` **${e.type}** — ${e.text}`);
    }
  } else {
    out.push("_(sem eventos)_");
  }
  out.push("");

  return out.join("\n");
}

function cmdExport(repo: string, taskId: string, a: Args) {
  const store = openStore(repo);
  const t = store.getTask(taskId);
  if (!t) {
    console.error(c.red(`✕ tarefa ${taskId} não encontrada`));
    store.close();
    process.exit(1);
  }
  const md = buildExportMarkdown(store, t);
  const out = a.flags.out;
  if (out && out !== "true") {
    writeFileSync(out, md);
    console.log(c.green("✓") + ` relatório gravado em ${c.dim(out)}`);
  } else {
    console.log(md);
  }
  store.close();
}

async function cmdRm(repo: string, taskId: string) {
  const orch = new Orchestrator(repo);
  await orch.removeTask(taskId);
  console.log(c.green("✓") + ` tarefa ${taskId} removida (worktree + branch + registros)`);
  orch.close();
}

async function cmdReviewPr(repo: string, a: Args) {
  const pr = a.flags.pr;
  if (!pr) {
    console.error(c.red("✕ use --pr <url|número>"));
    process.exit(1);
  }
  // sem --engine (o app não manda): a IA PADRÃO do usuário — antes era sempre o Claude, e quem só tem Codex não revisava
  const engine = a.flags.engine ?? defaultEngine();
  let roles = buildRoles({ ...a, flags: { ...a.flags, engine } } as Args, repo);
  // garante ao menos um revisor
  if (!roles.some((r) => r.role === "reviewer")) {
    roles = [{ role: "reviewer", name: roles[0]?.name ?? (a.flags.agent ?? "Revisor"), engine, model: a.flags.model }];
  }
  const id = a.flags.id ? slugify(a.flags.id) : slugify("pr " + pr);
  const spec: TaskSpec = {
    id,
    title: "",
    objective: "",
    deliverables: [],
    requirements: [],
    scope: { owns: [], offLimits: [] },
    autonomy: { clarifications: "auto", commit: "at-end", runTests: false, approval: "auto", planApproval: "auto" },
    engine,
    model: a.flags.model,
    agent: roles[0].name,
    roles,
    kind: "review",
  };
  const orch = new Orchestrator(repo);
  console.log(c.dim(`→ revisando ${pr} · revisor: ${roles.map((r) => r.name).join(", ")}`));
  await orch.reviewPr(spec, pr);
  console.log(c.green("✓") + " review do PR pronto");
  orch.close();
}

async function cmdDeliver(repo: string, taskId: string, kind?: string) {
  const k = kind === "tests" || kind === "proof" || kind === "all" ? kind : "doc";
  const orch = new Orchestrator(repo);
  if (!orch.store.getTask(taskId)) {
    console.error(c.red(`✕ tarefa ${taskId} não encontrada`));
    orch.close();
    process.exit(1);
  }
  console.log(c.dim(`→ gerando entregável (${k}) …`));
  await orch.deliverArtifact(taskId, k as "doc" | "tests" | "proof" | "all");
  console.log(c.green("✓") + " entregável pronto — veja em Artefatos");
  orch.close();
}

async function cmdTalk(repo: string, taskId: string, msg?: string, asReq = false, agent?: string) {
  if (!msg || !msg.trim()) {
    console.error(c.red('✕ use --msg "sua mensagem"'));
    process.exit(1);
  }
  const orch = new Orchestrator(repo);
  if (!orch.store.getTask(taskId)) {
    console.error(c.red(`✕ tarefa ${taskId} não encontrada`));
    orch.close();
    process.exit(1);
  }
  console.log(c.dim(`→ conversando com o agente …`));
  try {
    await orch.talkToAgent(taskId, msg.trim(), asReq, agent);
  } catch (e) {
    // grava o erro no FEED da task pra ele NÃO sumir (o app spawna com stderr→null)
    const em = (e as Error)?.message || String(e);
    try { orch.store.addEvent(taskId, "Sistema", "error", "não consegui falar com o agente: " + em, false); } catch { /* ignore */ }
    console.error(c.red("✕ " + em));
    orch.close();
    process.exit(1);
  }
  console.log(c.green("✓") + " o agente respondeu");
  orch.close();
}

async function cmdStart(repo: string, taskId: string) {
  const orch = new Orchestrator(repo);
  const t = orch.store.getTask(taskId);
  if (!t) {
    console.error(c.red(`✕ tarefa ${taskId} não encontrada`));
    orch.close();
    process.exit(1);
  }
  console.log(c.dim(`→ iniciando ${taskId} …\n`));
  await orch.runTask(taskId);
  console.log(renderList(orch.store));
  orch.close();
}

async function cmdResolveConflict(repo: string, taskId: string) {
  const orch = new Orchestrator(repo);
  if (!orch.store.getTask(taskId)) {
    console.error(c.red(`✕ tarefa ${taskId} não encontrada`));
    orch.close();
    process.exit(1);
  }
  try {
    console.log(c.dim(`→ pedindo pro agente resolver o conflito de merge …`));
    await orch.resolveConflict(taskId);
    console.log(c.green("✓") + ` conflito endereçado em ${taskId} — confira o diff e mergeie`);
  } catch (err) {
    console.error(c.red("✕ resolução falhou: " + (err as Error).message));
    orch.close();
    process.exit(1);
  }
  orch.close();
}

async function cmdRework(repo: string, taskId: string) {
  const orch = new Orchestrator(repo);
  try {
    await orch.reworkTask(taskId);
    console.log(c.green("✓") + ` ajuste aplicado em ${taskId} — pronto para review`);
  } catch (err) {
    console.error(c.red("✕ rework falhou: " + (err as Error).message));
    orch.close();
    process.exit(1);
  }
  orch.close();
}

async function cmdMerge(repo: string, taskId: string) {
  const orch = new Orchestrator(repo);
  try {
    await orch.mergeTask(taskId);
    console.log(c.green("✓") + ` ${taskId} mergeado na base (worktree e branch removidas)`);
  } catch (err) {
    console.error(c.red("✕ merge falhou: " + (err as Error).message));
    console.error(c.dim("  (conflito? resolva manualmente na base e tente de novo)"));
    orch.close();
    process.exit(1);
  }
  orch.close();
}

async function cmdWatch(repo: string) {
  const store = openStore(repo);
  const tick = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write("\n " + c.bold(c.green("✦ Starfork")) + c.dim(`  watch · ${repo}`) + "\n\n");
    process.stdout.write(renderList(store));
    process.stdout.write("\n " + c.dim("barramento:") + "\n");
    for (const cl of store.allClaims().filter((x) => x.yielded_to)) {
      process.stdout.write(
        `   ${c.yellow("!")} ${cl.agent} cedeu ${c.dim(cl.path)} → ${c.bold(cl.yielded_to!)}\n`
      );
    }
    process.stdout.write("\n " + c.dim("ctrl+c para sair") + "\n");
  };
  tick();
  const iv = setInterval(tick, 600);
  process.on("SIGINT", () => {
    clearInterval(iv);
    store.close();
    process.stdout.write("\n");
    process.exit(0);
  });
}

async function cmdDemo() {
  const projectRoot = process.cwd();
  const demoDir = join(projectRoot, ".cardume-demo");
  const repo = join(demoDir, "repo");
  console.log(c.dim("→ preparando repo de exemplo em .cardume-demo/repo …"));
  await rm(demoDir, { recursive: true, force: true });
  await run("git", ["init", "-q", "-b", "main", repo]);
  // config local para permitir commits
  await run("git", ["-C", repo, "config", "user.email", "demo@starfork.local"]);
  await run("git", ["-C", repo, "config", "user.name", "Starfork Demo"]);
  // arquivos-semente
  await run("bash", ["-lc", `mkdir -p "${repo}/src/components" && \
    echo "export const version = '2.4.0';" > "${repo}/src/index.ts" && \
    echo "export function Header(){ return 'header'; }" > "${repo}/src/components/Header.tsx" && \
    printf ".cardume/\\n" > "${repo}/.gitignore" && \
    echo "# App exemplo" > "${repo}/README.md"`]);
  await run("git", ["-C", repo, "add", "-A"]);
  await run("git", ["-C", repo, "commit", "-q", "-m", "seed: app inicial"]);
  // um pouco de história em main para o grafo ficar expressivo
  await run("git", ["-C", repo, "commit", "--allow-empty", "-q", "-m", "chore: configura lint e CI"]);
  await run("git", ["-C", repo, "commit", "--allow-empty", "-q", "-m", "feat: base do relatório"]);

  const orch = new Orchestrator(repo);

  const iris: TaskSpec = {
    id: "login-2fa",
    title: "Adicionar 2FA no login",
    agent: "Íris",
    objective: "Fluxo TOTP com QR code e códigos de recuperação.",
    deliverables: ["Verificar código TOTP", "Gerar códigos de recuperação"],
    requirements: ["Testes de auth verdes"],
    scope: { owns: ["src/auth", "src/components/Header.tsx"], offLimits: ["src/api"] },
    autonomy: { clarifications: "ask", commit: "at-end", runTests: true , approval: "ask" },
    engine: "mock",
    roles: [
      { role: "planner", name: "Vega", engine: "mock" },
      { role: "builder", name: "Íris", engine: "mock" },
      { role: "reviewer", name: "Nyx", engine: "mock" },
    ],
  };
  const onda: TaskSpec = {
    id: "api-ratelimit",
    title: "Rate limiting no gateway",
    agent: "Onda",
    objective: "Token bucket por chave de API com 429 + Retry-After.",
    deliverables: ["Aplicar rate limit", "Configurar limite por plano"],
    requirements: ["Sem quebrar rotas existentes"],
    scope: { owns: ["src/api", "src/components/Header.tsx"], offLimits: ["src/auth"] },
    autonomy: { clarifications: "assume", commit: "at-end", runTests: true , approval: "ask" },
    engine: "mock",
    roles: [
      { role: "builder", name: "Onda", engine: "mock" },
      { role: "reviewer", name: "Cobalt", engine: "mock" },
    ],
  };

  console.log(c.dim("→ criando 2 tarefas com EQUIPES — ambas querem Header.tsx …\n"));
  await orch.createTask(iris); // Íris reivindica Header.tsx primeiro
  await orch.createTask(onda); // Onda colide → cede a vez

  console.log(c.dim("→ rodando as equipes em paralelo (planner → builder → reviewer) …\n"));
  await Promise.all([orch.runTask("login-2fa"), orch.runTask("api-ratelimit")]);

  console.log(c.bold(c.green("\n✦ Starfork · resultado\n")));
  console.log(renderList(orch.store));

  console.log(" " + c.dim("barramento (colisões resolvidas):"));
  for (const cl of orch.store.allClaims().filter((x) => x.yielded_to)) {
    console.log(`   ${c.yellow("!")} ${cl.agent} cedeu ${c.dim(cl.path)} → ${c.bold(cl.yielded_to!)}`);
  }

  console.log("\n " + c.dim("worktrees reais criadas:"));
  const wts = await orch.git.listWorktrees();
  for (const w of wts) console.log(`   ${c.green("▸")} ${c.dim(w.path)}  ${c.cyan(w.branch)}`);

  console.log("\n " + c.dim("review humano gerado — veja um deles:"));
  console.log(" " + c.green(`node src/cli.ts review login-2fa --repo ${repo}`) + "\n");
  orch.close();
}

// ---------- edição de spec SEM rodar agente (tarefa irmã/rascunho, épico) ----------
function editAuthor(store: Store, a: Args): EditAuthor {
  const taskId = a.flags["by-task"] || process.env.CARDUME_TASK || undefined;
  const t = taskId ? store.getTask(taskId) : undefined;
  return {
    agent: a.flags["by-agent"] || process.env.CARDUME_AGENT || "Você",
    taskId: t?.id ?? taskId,
    taskTitle: t?.title,
    role: a.flags["by-role"] ?? process.env.CARDUME_ROLE ?? undefined,
  };
}

function printEdit(r: EditResult, json: boolean): void {
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(c.green("✓") + " " + r.message);
  else console.error(c.red("✕ " + r.message));
  if (!r.ok) process.exitCode = 1;
}

/** --patch '<json>' (o app manda a edição inteira; o formato é validado) ou flags soltas. */
function parsePatch(a: Args): { ok: true; v: unknown } | { ok: false; message: string } {
  try { return { ok: true, v: JSON.parse(a.flags.patch) }; } catch { return { ok: false, message: "--patch não é um JSON válido" }; }
}

async function cmdTaskEdit(repo: string, id: string | undefined, a: Args) {
  const store = openStore(repo);
  const json = !!a.flags.json;
  try {
    const by = editAuthor(store, a);
    if (a.flags.undo) return printEdit(undoTaskEdit({ store, targetId: id ?? "", editId: a.flags.undo, by }), json);
    if (a.flags.approve || a.flags.reject) {
      return printEdit(decideProposal({ store, targetId: id ?? "", proposalId: a.flags.approve || a.flags.reject, approve: !!a.flags.approve, by, msg: a.flags.note }), json);
    }
    let input: TaskEditInput;
    if (a.flags.patch !== undefined) {
      const p = parsePatch(a);
      if (!p.ok) return printEdit(p, json);
      const bad = checkTaskShape(p.v);
      if (bad) return printEdit({ ok: false, message: bad }, json);
      input = p.v as TaskEditInput;
    } else {
      input = {
        title: a.flags.title,
        objective: a.flags.objective,
        reqAdd: a.multi["req-add"],
        reqRemove: a.multi["req-remove"],
        deliverables: a.multi.deliverable,
        delivAdd: a.multi["deliv-add"],
        owns: a.flags.owns !== undefined ? list(a.flags.owns) : undefined,
        off: a.flags.off !== undefined ? list(a.flags.off) : undefined,
        note: a.flags.note,
      };
    }
    const author = by.taskId ? store.getTask(by.taskId) : undefined;
    let authorEpic: string | undefined;
    try { authorEpic = author ? (JSON.parse(author.spec_json) as TaskSpec).epicId : undefined; } catch { /* spec antiga */ }
    const epicId = a.flags["epic-id"] || authorEpic;
    const cardumeDir = new Workspace(repo).dir;
    // id (nuvem/local) OU título: resolvido contra as irmãs do épico; desconhecido é recusado na hora
    const t = await resolveEditTarget({ store, cardumeDir, query: id ?? "", epicId });
    if (!t.ok) return printEdit(t, json);
    const r = editTask({ store, cardumeDir, targetId: t.id, input, by, epicId, editId: a.flags["edit-id"] || undefined, knownCloud: t.cloud });
    printEdit(r.ok && t.warn ? { ...r, message: r.message + ` (aviso: ${t.warn})` } : r, json);
  } finally {
    store.close();
  }
}

function cmdEpicEdit(repo: string, id: string | undefined, a: Args) {
  const store = openStore(repo);
  const json = !!a.flags.json;
  try {
    let input: EpicEditInput;
    if (a.flags.patch !== undefined) {
      const p = parsePatch(a);
      if (!p.ok) return printEdit(p, json);
      const bad = checkEpicShape(p.v);
      if (bad) return printEdit({ ok: false, message: bad }, json);
      input = p.v as EpicEditInput;
    } else {
      input = {
        description: a.flags.description,
        outcome: a.flags.outcome,
        doneWhenAdd: a.multi["done-when-add"],
        doneWhenRemove: (a.multi["done-when-remove"] ?? []).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean),
        reqAdd: a.multi["req-add"],
        note: a.flags.note,
      };
    }
    const by = editAuthor(store, a);
    const cardumeDir = new Workspace(repo).dir;
    const e = resolveEpicTarget(id, knownEpics(store, cardumeDir), authorEpicOf(store, by));
    if (!e.ok) return printEdit(e, json);
    printEdit(editEpic({ store, cardumeDir, epicId: e.id, input, by }), json);
  } finally {
    store.close();
  }
}

function authorEpicOf(store: Store, by: EditAuthor): string | undefined {
  const t = by.taskId ? store.getTask(by.taskId) : undefined;
  try { return t ? (JSON.parse(t.spec_json) as TaskSpec).epicId : undefined; } catch { return undefined; }
}

/** Irmãs do épico com ids, títulos, status e requisitos (contexto que o app grava + tarefas locais). */
async function cmdEpicTasks(repo: string, id: string | undefined, a: Args) {
  const store = openStore(repo);
  try {
    const cardumeDir = new Workspace(repo).dir;
    const e = resolveEpicTarget(id, knownEpics(store, cardumeDir), authorEpicOf(store, editAuthor(store, a)));
    if (!e.ok) { console.error(c.red("✕ " + e.message)); process.exitCode = 1; return; }
    const f = await ensureFreshContext(cardumeDir, e.id, a.flags["no-wait"] ? 0 : 5000);
    const items = listEpicTasks(store, f.ctx, e.id);
    if (a.flags.json) console.log(JSON.stringify({ epicId: e.id, title: f.ctx?.title ?? "", warn: f.warn ?? null, tasks: items }));
    else console.log(epicTasksText(f.ctx, items, e.id, f.warn));
  } finally {
    store.close();
  }
}

/** O app manda a lista oficial do "pronto quando" (--patch '{"doneWhen":[...],"seq":N}') → cópias locais. */
function cmdEpicSync(repo: string, id: string | undefined, a: Args) {
  const store = openStore(repo);
  const json = !!a.flags.json;
  try {
    const p = parsePatch(a);
    if (!p.ok) return printEdit(p, json);
    const v = (p.v ?? {}) as { doneWhen?: unknown; seq?: unknown };
    printEdit(syncEpicDoneWhen({ store, epicId: id ?? "", doneWhen: v.doneWhen, seq: Number(v.seq) || 0, by: editAuthor(store, a), note: a.flags.note }), json);
  } finally {
    store.close();
  }
}

/** Barra de status do Claude Code (% real do plano no medidor) — fonte única: src/claude-statusline.ts. */
function cmdClaudeStatusline(sub: string | undefined, a: Args) {
  const json = !!a.flags.json;
  let r: { ok: boolean; message: string };
  try {
    if (sub === "install") r = slInstall({ node: a.flags.node });
    else if (sub === "uninstall") r = slUninstall();
    else if (sub === "status") r = slStatus({ repo: a.flags.repo });
    else { console.error(c.red("✕ use: cardume claude-statusline install [--node <caminho>] | uninstall | status [--repo <p>] [--json]")); process.exitCode = 1; return; }
  } catch (e) {
    r = { ok: false, message: "não consegui mexer na barra de status: " + ((e as Error)?.message ?? String(e)) };
  }
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(c.green("✓") + " " + r.message);
  else console.error(c.red("✕ " + r.message));
  if (!r.ok) process.exitCode = 1;
}

// ---------- piloto automático (src/autopilot.ts) ----------
async function cmdAutopilot(a: Args) {
  const dir = a.flags.dir || a._[1];
  if (!dir || dir === "true") {
    console.error(c.red(`✕ use: cardume autopilot --idea "…" --dir <pasta nova> [--platform web|ios|android|mobile] [--engine …] [--model …] [--parallel 1-${AP_MAX_PARALLEL}] [--attempts 1-${AP_MAX_ATTEMPTS}] [--budget-usd N (0 = sem teto)]`));
    process.exitCode = 1;
    return;
  }
  if (a.flags.stop) {
    // sem piloto nesta pasta: erro e NADA criado (antes criava .cardume/autopilot/STOP em qualquer pasta)
    if (!readState(dir)) {
      console.error(c.red("✕ nenhum piloto nesta pasta"));
      process.exitCode = 1;
      return;
    }
    requestStop(dir);
    console.log(c.green("✓") + " pedido de parada registrado — o piloto termina o passo atual e para");
    return;
  }
  if (a.flags.status) {
    const st = readState(dir);
    if (a.flags.json) console.log(JSON.stringify(st));
    else if (!st) console.log(c.dim("nenhum piloto automático nesta pasta"));
    else {
      console.log(`${c.bold(st.epicTitle || st.name)} — ${PHASE_PT[st.phase]} · US$ ${st.costUsd.toFixed(2)}`);
      for (const t of st.tasks) console.log(`  ${t.stage.padEnd(8)} ${t.title} ${c.dim(`(${t.attempts} tentativa(s))`)}`);
    }
    return;
  }
  const num = (k: string) => (a.flags[k] !== undefined && a.flags[k] !== "" && Number.isFinite(Number(a.flags[k])) ? Number(a.flags[k]) : undefined);
  const platform = a.flags.platform;
  if (platform && !AP_PLATFORMS.includes(platform as ApPlatform)) {
    console.error(c.red(`✕ --platform deve ser ${AP_PLATFORMS.join("|")}`));
    process.exitCode = 1;
    return;
  }
  try {
    const st = await runAutopilot({
      idea: a.flags.idea, dir, name: a.flags.name, platform: platform as ApPlatform | undefined,
      engine: a.flags.engine, model: a.flags.model, parallel: num("parallel"), attempts: num("attempts"), budgetUsd: num("budget-usd"),
      planFile: a.flags.plan,
      orgPolicy: a.flags["org-policy"] ? (() => { try { return JSON.parse(a.flags["org-policy"]); } catch { return null; } })() : undefined,
    });
    console.log((st.phase === "done" ? c.green("✓ ") : c.yellow("! ")) + `piloto automático: ${PHASE_PT[st.phase]} — relatório em ${join(st.dir, "AUTOPILOT.md")}`);
    if (st.phase === "failed") process.exitCode = 1;
  } catch (e) {
    console.error(c.red("✕ " + ((e as Error)?.message ?? String(e))));
    process.exitCode = 1;
  }
}

// ---------- dispatch ----------
async function main() {
  const argv = process.argv.slice(2);
  const a = parseArgs(argv);
  const cmd = a._[0];
  const repo = a.flags.repo ?? process.cwd();

  switch (cmd) {
    case "init":
      await cmdInit(a._[1] ?? repo, a.flags["no-git"] === "true");
      break;
    case "new":
      await cmdNew(repo, a);
      break;
    case "list":
      cmdListCmd(repo);
      break;
    case "metrics":
      cmdMetrics(repo, !!a.flags.json);
      break;
    case "overlap":
      cmdOverlap(repo, a);
      break;
    case "agents":
      cmdAgents(repo);
      break;
    case "workflows":
      cmdWorkflows(repo);
      break;
    case "logs":
      cmdLogs(repo, a._[1]);
      break;
    case "review":
      cmdReview(repo, a._[1]);
      break;
    case "export":
      cmdExport(repo, a._[1], a);
      break;
    case "watch":
      await cmdWatch(repo);
      break;
    case "rm":
      await cmdRm(repo, a._[1]);
      break;
    case "merge":
      await cmdMerge(repo, a._[1]);
      break;
    case "rework":
      await cmdRework(repo, a._[1]);
      break;
    case "sample-review":
      await cmdSampleReview(repo, a._[1], a);
      break;
    case "resolve-conflict":
      await cmdResolveConflict(repo, a._[1]);
      break;
    case "start":
      await cmdStart(repo, a._[1]);
      break;
    case "review-pr":
      await cmdReviewPr(repo, a);
      break;
    case "deliver":
      await cmdDeliver(repo, a._[1], a.flags.kind);
      break;
    case "talk":
      await cmdTalk(repo, a._[1], a.flags.msg, !!a.flags["as-req"], a.flags.agent);
      break;
    // ---- MODO TERMINAL (src/terminal.ts) — chamados pelos hooks do CLI e pelo app ----
    case "hook":
      // pergunta do agente (AskUserQuestion): espera a resposta da folha do app e devolve allow + answers
      if (a._[1] === AUQ_TOOL) { process.exitCode = await askHookCli(a.flags[HOOK_MARK.slice(2)] ?? "", repo); break; }
      // codex-notify: o Codex passa o JSON como ÚLTIMO argumento
      process.exitCode = hookCli(a._[1], a.flags[HOOK_MARK.slice(2)] ?? "", repo, a._[1] === "codex-notify" ? argv[argv.length - 1] : undefined);
      break;
    case "statusline":
      process.exitCode = statuslineCli(a.flags[HOOK_MARK.slice(2)] ?? "", repo);
      break;
    case "turn-end":
      await turnEndCli(repo, a._[1]);
      break;
    case "term-prep": {
      // JSON numa linha no stdout: o app (pty.rs) spawna exatamente isto
      const orch = new Orchestrator(repo);
      try {
        // worktree removida sem integrar (liberar espaço, cancelada limpa): recria no MESMO caminho — a sessão do
        // Claude é guardada por pasta, então o `--resume` continua valendo. Mergeada sem worktree o app nem chega aqui
        // (oferece uma tarefa nova de ajuste).
        const t0 = orch.store.getTask(a._[1]);
        if (t0 && t0.status !== "merged" && t0.worktree && !existsSync(t0.worktree)) await orch.ensureTaskWorktree(a._[1]);
        // INTEGRADA sem pasta: reabre pra CONVERSAR (mesmo caminho = o --resume acha a sessão); a tarefa segue integrada
        if (t0 && t0.status === "merged" && t0.worktree && !existsSync(t0.worktree)) await orch.ensureTaskWorktree(a._[1], { conversation: true });
        console.log(JSON.stringify(termPrep(orch, a._[1], { resume: !!a.flags.resume, message: a.flags.msg, ai: a.flags.ai || undefined, model: a.flags.ai ? a.flags.model : undefined })));
      } catch (e) {
        console.log(JSON.stringify({ error: (e as Error)?.message ?? String(e) }));
        process.exitCode = 1;
      } finally { orch.close(); }
      break;
    }
    case "term-ai": {
      // troca de IA pelo app (term_switch_ai): grava spec.termAi/termModel — reabrir o terminal lembra
      const orch = new Orchestrator(repo);
      try { console.log(JSON.stringify({ ok: true, recommended: setTermAi(orch, a._[1], a.flags.ai ?? "", a.flags.model) })); }
      catch (e) { console.log(JSON.stringify({ error: (e as Error)?.message ?? String(e) })); process.exitCode = 1; }
      finally { orch.close(); }
      break;
    }
    case "starfork":
      // o `starfork` do shell do terminal integrado (src/starfork-cli.ts) — argv cru: as flags são dele
      process.exitCode = await starforkCli(argv.slice(1));
      break;
    case "term-msg": {
      const orch = new Orchestrator(repo);
      try {
        const text = await termMessage(orch, a._[1], a.flags.kind ?? "talk", { msg: a.flags.msg, asReq: !!a.flags["as-req"], deliver: a.flags.deliver });
        // worktree: o app grava a mensagem em .cardume/term/next-msg.txt quando o shell está no prompt (sem IA)
        console.log(JSON.stringify({ text, worktree: orch.store.getTask(a._[1])?.worktree ?? "" }));
      } catch (e) {
        console.log(JSON.stringify({ error: (e as Error)?.message ?? String(e) }));
        process.exitCode = 1;
      } finally { orch.close(); }
      break;
    }
    case "claude-statusline":
      cmdClaudeStatusline(a._[1], a);
      break;
    case "mobile":
      process.exitCode = await mobileCli(a);
      break;
    case "browser-proxy":
      process.exitCode = await browserProxyCli(a);
      break;
    case "env":
      process.exitCode = await envCli(a);
      break;
    case "autopilot":
      await cmdAutopilot(a);
      break;
    case "demo":
      await cmdDemo();
      break;
    case "task":
      if (a._[1] === "edit") await cmdTaskEdit(repo, a._[2], a);
      else { console.error(c.red("✕ use: cardume task edit <id> [--objective …] [--note \"por quê\"]")); process.exitCode = 1; }
      break;
    case "epic":
      if (a._[1] === "edit") cmdEpicEdit(repo, a._[2], a);
      else if (a._[1] === "sync") cmdEpicSync(repo, a._[2], a);
      else if (a._[1] === "tasks") await cmdEpicTasks(repo, a._[2], a);
      else { console.error(c.red("✕ use: cardume epic edit <epicId> [--description …] [--note \"por quê\"]")); process.exitCode = 1; }
      break;
    default:
      console.log(`
${c.bold(c.green("✦ Starfork"))} ${c.dim("— orquestra múltiplos agentes em branches paralelas")}

${c.dim("criar & rodar")}
  ${c.green("cardume demo")}                        loop completo, 2 agentes em paralelo (mock)
  ${c.green("cardume init")} ${c.dim("[--repo <p>]")}            prepara .cardume/ num repo
  ${c.green("cardume new")}  ${c.dim('--title "..." --workflow <id>  (ou --agents vega,iris,nyx) [--engine claude --approve auto] [--no-start] [--no-overlap-check]')}
  ${c.green("cardume start")} ${c.dim("<taskId>")}               inicia uma tarefa em rascunho (--no-start)
  ${c.green("cardume rework")} ${c.dim("<taskId>")}              re-roda a equipe aplicando os ajustes do humano

  ${c.green("cardume autopilot")} ${c.dim(`--idea "…" --dir <pasta nova> [--platform web|ios|android|mobile] [--engine claude] [--model …] [--parallel 1-${AP_MAX_PARALLEL}] [--attempts 1-${AP_MAX_ATTEMPTS}] [--budget-usd N (0 = sem teto)]`)}
      piloto automático: cria o projeto local, planeja o épico e constrói o app sozinho (rode de novo pra continuar; --stop para; --status mostra)

${c.dim("acompanhar")}
  ${c.green("cardume list")} ${c.dim("[--repo <p>]")}            estado das tarefas
  ${c.green("cardume watch")} ${c.dim("[--repo <p>]")}           acompanha ao vivo (lê o SQLite)
  ${c.green("cardume metrics")} ${c.dim("[--repo <p>]")}         coordenação: conflitos, colisões e reworks (baseline)
  ${c.green("cardume overlap")} ${c.dim('--owns "src/**"')}      checa sobreposição de escopo com tarefas ativas
  ${c.green("cardume logs")} ${c.dim("<taskId>")}                eventos de uma tarefa
  ${c.green("cardume review")} ${c.dim("<taskId>")}              review humano (funções criadas, arquivos, como testar)

${c.dim("entregar & integrar")}
  ${c.green("cardume deliver")} ${c.dim("<taskId> --kind doc|tests|proof|all")}  gera artefato sob demanda
  ${c.green("cardume talk")} ${c.dim('<taskId> --msg "..." [--as-req] [--agent <nome>]')}  conversa com o agente (retoma a sessão)
  ${c.green("cardume task edit")} ${c.dim('<taskId> [--objective …] [--title …] [--req-add …] [--req-remove "<texto>"] [--owns …] [--off …] [--deliverable …] [--deliv-add …] --note "por quê"')}
      muda a spec de uma tarefa (irmã/rascunho) SEM acionar o agente dela; rodando → chega no próximo turno;
      remover requisito/estreitar owns/off vira proposta (--approve/--reject <id> decidem; --undo <id> desfaz)
  ${c.green("cardume epic edit")} ${c.dim('<epicId> [--description …] [--outcome …] [--done-when-add …] [--done-when-remove D3] [--req-add …] --note "por quê"')}
      muda o épico (o app aplica no épico do time, com histórico)
  ${c.green("cardume epic tasks")} ${c.dim("[<epicId>] [--json]")}   irmãs do épico com ids, títulos, status e requisitos
  ${c.green("cardume export")} ${c.dim("<taskId> [--out <arquivo.md>]")}  relatório Markdown p/ descrição de PR
  ${c.green("cardume review-pr")} ${c.dim("--pr <url|nº>")}      revisa um PR do GitHub (sem branch/worktree)
  ${c.green("cardume merge")} ${c.dim("<taskId>")}               faz merge da branch na base e remove a worktree
  ${c.green("cardume rm")}   ${c.dim("<taskId>")}                remove worktree + branch + registros

${c.dim("provas mobile (iOS/Android · nativo, React Native, Expo)")}
  ${c.green("cardume mobile")} ${c.dim("doctor | up --platform ios|android | install <app> | launch <id|url> | shot [nome] | rec start|stop | flow <yaml> | down")}
      simulador iOS por tarefa / emulador Android com trava; prints e vídeos em .cardume/artifacts/

${c.dim("Claude Code")}
  ${c.green("cardume claude-statusline")} ${c.dim("install [--node <caminho>] | uninstall | status [--json]")}
      barra de status que leva a % real do plano do Claude ao medidor (encadeia a sua barra, se tiver)

${c.dim("catálogo")}
  ${c.green("cardume agents")} ${c.dim("[--repo <p>]")}          catálogo de agentes (review, design, testes…)
  ${c.green("cardume workflows")} ${c.dim("[--repo <p>]")}       workflows prontos (feature, design-first, …)
${c.dim("  (todos aceitam --repo <p>)")}
`);
  }
}

main().catch((err) => {
  console.error(c.red("✕ " + (err?.stack ?? err?.message ?? String(err))));
  process.exit(1);
});
