import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator } from "./orchestrator.ts";
import { GitService } from "./git.ts";
import { Store } from "./store.ts";
import { Workspace } from "./workspace.ts";
import { run } from "./util/run.ts";
import { c, statusColor, eventGlyph } from "./util/ansi.ts";
import { slugify } from "./types.ts";
import { ensureConfig, loadConfig, resolveAgents, resolveWorkflow } from "./config.ts";
import type { AgentRole, Role, TaskSpec } from "./types.ts";

// ---------- parse de flags simples ----------
interface Args {
  _: string[];
  flags: Record<string, string>;
  multi: Record<string, string[]>;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      a.flags[key] = val;
      (a.multi[key] ??= []).push(val);
    } else {
      a._.push(t);
    }
  }
  return a;
}
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

// ---------- comandos ----------
async function cmdInit(repo: string) {
  const git = new GitService(repo);
  if (!(await git.isRepo())) {
    console.error(c.red(`✖ ${repo} não é um repositório git.`));
    process.exit(1);
  }
  const ws = new Workspace(repo);
  ws.ensure();
  new Store(ws.dbFile).close();
  console.log(c.green("✔") + ` workspace Cardume pronto em ${c.dim(ws.dir)}`);
  if (ensureConfig(repo)) console.log(c.green("✔") + ` catálogo criado em ${c.dim("cardume.config.json")} (agentes + workflows)`);
  console.log(c.dim("  dica: adicione .cardume/ ao seu .gitignore"));
}

function cmdAgents(repo: string) {
  const cfg = loadConfig(repo);
  console.log("\n" + c.bold(c.green("🐙 Agentes")) + c.dim("  (cardume.config.json)\n"));
  for (const a of cfg.agents) {
    console.log(`  ${c.bold(a.name.padEnd(8))} ${c.cyan(a.role.padEnd(9))} ${c.dim(a.engine)}  ${c.dim("#" + a.id)}`);
    if (a.persona) console.log(`      ${c.dim("↳ " + a.persona)}`);
  }
  console.log("");
}

function cmdWorkflows(repo: string) {
  const cfg = loadConfig(repo);
  const byId = Object.fromEntries(cfg.agents.map((a) => [a.id, a]));
  console.log("\n" + c.bold(c.green("🐙 Workflows")) + c.dim("  (cardume.config.json)\n"));
  for (const w of cfg.workflows) {
    const chain = w.steps.map((s) => `${byId[s]?.name ?? s}${c.dim("(" + (byId[s]?.role ?? "?") + ")")}`).join(c.dim(" → "));
    console.log(`  ${c.bold(w.name.padEnd(22))} ${c.dim("#" + w.id)}`);
    console.log(`      ${chain}`);
  }
  console.log(c.dim("\n  use: ") + c.green("cardume new --title \"...\" --workflow <id>") + "\n");
}

function buildRoles(a: Args, repo: string): AgentRole[] {
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
    console.error(c.red("✖ use --title \"...\""));
    process.exit(1);
  }
  const id = slugify(title);
  const roles = buildRoles(a, repo);
  const lead = roles.find((r) => r.role === "builder") ?? roles[0];
  const spec: TaskSpec = {
    id,
    title,
    agent: lead.name,
    objective: a.flags.objective ?? title,
    deliverables: a.multi.deliverable ?? [title],
    requirements: list(a.flags.requirements),
    scope: { owns: list(a.flags.owns), offLimits: list(a.flags.off) },
    autonomy: {
      clarifications: (a.flags.clarifications as TaskSpec["autonomy"]["clarifications"]) ?? "ask",
      commit: "at-end",
      runTests: a.flags["no-tests"] ? false : true,
      approval: (a.flags.approve as TaskSpec["autonomy"]["approval"]) ?? "ask",
    },
    engine: a.flags.engine ?? "mock",
    model: a.flags.model,
    roles,
  };

  const orch = new Orchestrator(repo);
  console.log(c.dim(`→ criando worktree agent/${id} · equipe: ${roles.map((r) => r.role + ":" + r.name).join(" → ")}`));
  await orch.createTask(spec);
  console.log(c.dim(`→ rodando a equipe …\n`));
  await orch.runTask(id);
  console.log(renderList(orch.store));
  const rev = orch.store.getReview(id);
  if (rev) console.log(c.dim(`  review disponível: `) + c.green(`cardume review ${id} --repo ${repo}`) + "\n");
  orch.close();
}

function openStore(repo: string): Store {
  const ws = new Workspace(repo);
  if (!existsSync(ws.dbFile)) {
    console.error(c.red(`✖ nenhum workspace Cardume em ${repo}. Rode: cardume init`));
    process.exit(1);
  }
  return new Store(ws.dbFile);
}

function cmdListCmd(repo: string) {
  const store = openStore(repo);
  console.log("\n" + c.bold(c.green("🐙 Cardume")) + c.dim(`  ${repo}\n`));
  console.log(renderList(store));
  store.close();
}

function cmdLogs(repo: string, taskId: string) {
  const store = openStore(repo);
  const t = store.getTask(taskId);
  if (!t) {
    console.error(c.red(`✖ tarefa ${taskId} não encontrada`));
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
    console.error(c.red(`✖ tarefa ${taskId} não encontrada`));
    process.exit(1);
  }
  const r = store.getReview(taskId);
  if (!r) {
    console.log(c.dim(`\nsem review para ${taskId} — a tarefa tem um papel "reviewer"?\n`));
    store.close();
    return;
  }
  console.log("\n" + c.bold(c.green("🐙 Review humano")) + c.dim(`  ${t.title}  ·  ${t.branch}`));
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

async function cmdRm(repo: string, taskId: string) {
  const orch = new Orchestrator(repo);
  await orch.removeTask(taskId);
  console.log(c.green("✔") + ` tarefa ${taskId} removida (worktree + branch + registros)`);
  orch.close();
}

async function cmdMerge(repo: string, taskId: string) {
  const orch = new Orchestrator(repo);
  try {
    await orch.mergeTask(taskId);
    console.log(c.green("✔") + ` ${taskId} mergeado na base (worktree e branch removidas)`);
  } catch (err) {
    console.error(c.red("✖ merge falhou: " + (err as Error).message));
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
    process.stdout.write("\n " + c.bold(c.green("🐙 Cardume")) + c.dim(`  watch · ${repo}`) + "\n\n");
    process.stdout.write(renderList(store));
    process.stdout.write("\n " + c.dim("barramento:") + "\n");
    for (const cl of store.allClaims().filter((x) => x.yielded_to)) {
      process.stdout.write(
        `   ${c.yellow("⚠")} ${cl.agent} cedeu ${c.dim(cl.path)} → ${c.bold(cl.yielded_to!)}\n`
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
  await run("git", ["-C", repo, "config", "user.email", "demo@cardume.dev"]);
  await run("git", ["-C", repo, "config", "user.name", "Cardume Demo"]);
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

  console.log(c.bold(c.green("\n🐙 Cardume · resultado\n")));
  console.log(renderList(orch.store));

  console.log(" " + c.dim("barramento (colisões resolvidas):"));
  for (const cl of orch.store.allClaims().filter((x) => x.yielded_to)) {
    console.log(`   ${c.yellow("⚠")} ${cl.agent} cedeu ${c.dim(cl.path)} → ${c.bold(cl.yielded_to!)}`);
  }

  console.log("\n " + c.dim("worktrees reais criadas:"));
  const wts = await orch.git.listWorktrees();
  for (const w of wts) console.log(`   ${c.green("▸")} ${c.dim(w.path)}  ${c.cyan(w.branch)}`);

  console.log("\n " + c.dim("review humano gerado — veja um deles:"));
  console.log(" " + c.green(`node src/cli.ts review login-2fa --repo ${repo}`) + "\n");
  orch.close();
}

// ---------- dispatch ----------
async function main() {
  const argv = process.argv.slice(2);
  const a = parseArgs(argv);
  const cmd = a._[0];
  const repo = a.flags.repo ?? process.cwd();

  switch (cmd) {
    case "init":
      await cmdInit(a._[1] ?? repo);
      break;
    case "new":
      await cmdNew(repo, a);
      break;
    case "list":
      cmdListCmd(repo);
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
    case "watch":
      await cmdWatch(repo);
      break;
    case "rm":
      await cmdRm(repo, a._[1]);
      break;
    case "merge":
      await cmdMerge(repo, a._[1]);
      break;
    case "demo":
      await cmdDemo();
      break;
    default:
      console.log(`
${c.bold(c.green("🐙 Cardume"))} ${c.dim("— Fase 0 (núcleo)")}

  ${c.green("cardume demo")}                        loop completo, 2 agentes em paralelo (mock)
  ${c.green("cardume init")} ${c.dim("[--repo <p>]")}            prepara .cardume/ num repo
  ${c.green("cardume new")}  ${c.dim('--title "..." --workflow <id>  (ou --agents vega,iris,nyx) [--engine claude --approve auto]')}
  ${c.green("cardume agents")} ${c.dim("[--repo <p>]")}          catálogo de agentes (review, design, testes…)
  ${c.green("cardume workflows")} ${c.dim("[--repo <p>]")}       workflows prontos (feature, design-first, …)
  ${c.green("cardume list")} ${c.dim("[--repo <p>]")}            estado das tarefas
  ${c.green("cardume watch")} ${c.dim("[--repo <p>]")}           acompanha ao vivo (lê o SQLite)
  ${c.green("cardume logs")} ${c.dim("<taskId> [--repo <p>]")}   eventos de uma tarefa
  ${c.green("cardume review")} ${c.dim("<taskId> [--repo <p>]")} review humano (funções criadas, arquivos, como testar)
  ${c.green("cardume rm")}   ${c.dim("<taskId> [--repo <p>]")}   remove worktree + branch + registros
`);
  }
}

main().catch((err) => {
  console.error(c.red("✖ " + (err?.stack ?? err?.message ?? String(err))));
  process.exit(1);
});
