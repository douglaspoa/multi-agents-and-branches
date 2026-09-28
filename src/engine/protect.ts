// MODO PROTEGIDO — regras de NEGAÇÃO passadas ao Claude Code (`--disallowedTools`).
//
// O motor roda com `--permission-mode bypassPermissions` (o humano entra via ask_human),
// mas as regras de negação são avaliadas ANTES do modo de permissão: valem mesmo em
// bypass (docs do Claude Code, "Permission modes": "Deny rules, explicit ask rules, and
// hooks are evaluated before the mode check and can still block a tool").
//
// Sintaxe (claude --help, 2.1.x): `--disallowedTools <tools...>` — cada regra é um argv
// separado ("Tool(padrão)"). Read(...) também vale pra Grep/Glob; Edit(...) vale pra
// todas as tools que editam arquivo (Edit/Write/MultiEdit/NotebookEdit). Padrões de
// caminho seguem gitignore: `**/x` casa em qualquer pasta, `~/x` é a home.
//
// A MESMA lista vive em app/src-tauri/src/lib.rs (PROTECT_DENY) pros chats que o app
// roda direto (planner, nova issue, conector) e no tooltip do selo (js/53-teto-protecao.js).
// Mudou aqui? Mude lá também — o teste (protect.test.ts) confere o tamanho.

/** Arquivos de SEGREDO: nem lê, nem edita. `.env.example`/`.env.sample` continuam legíveis. */
export const SECRET_PATHS = [
  "**/.env",
  "**/.env.local",
  "**/.env.*.local",
  "**/.env.development*",
  "**/.env.production*",
  "**/.env.staging*",
  "**/.env.test*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "~/.ssh/**",
  "~/.aws/**",
  "**/.ssh/**",
  "**/.aws/**",
];

/** Comandos DESTRUTIVOS / de alto risco no shell. `rm -rf /*` fica de FORA de propósito:
 * casaria qualquer caminho absoluto (inclusive a própria worktree) — bloqueamos só a raiz. */
export const DANGEROUS_BASH = [
  "rm -rf /",
  "rm -rf / *",
  "rm -rf ~",
  "rm -rf ~/",
  "rm -rf ~/*",
  "rm -rf $HOME*",
  "git push --force*",
  "git push -f*",
  "git push * --force*",
  "git push * -f",
  "git push * -f *",
  "curl * | sh*",
  "curl * | bash*",
  "wget * | sh*",
  "wget * | bash*",
  "sudo *",
  // leitura de segredo pelo shell (o Read(...) acima não cobre `cat`)
  "cat *.env",
  "cat *.env.local",
  "cat *.pem",
  "cat *id_rsa*",
];

/** Liga/desliga pelo app: CARDUME_PROTECT=0 → "Livre" (sem lista). Padrão: protegido. */
export function protectEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.CARDUME_PROTECT ?? "").trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "livre");
}

/** As regras, no formato do Claude Code. */
export function denyRules(): string[] {
  const out: string[] = [];
  for (const p of SECRET_PATHS) out.push(`Read(${p})`, `Edit(${p})`);
  for (const c of DANGEROUS_BASH) out.push(`Bash(${c})`);
  return out;
}

/**
 * Os args a acrescentar na linha do `claude` (vazio quando "Livre").
 * `--disallowedTools` é variádico: o chamador põe outra FLAG logo depois
 * (ex.: `--permission-mode`) pra ele não engolir argumentos posicionais.
 */
export function protectArgs(on: boolean): string[] {
  return on ? ["--disallowedTools", ...denyRules()] : [];
}

/** Trecho do prompt: o agente pede ao humano em vez de insistir quando bate numa regra. */
export const PROTECT_RULE =
  " MODO PROTEGIDO: este projeto bloqueia a leitura/edição de SEGREDOS (.env, chaves .pem/.key, id_rsa, ~/.ssh, ~/.aws) e comandos destrutivos (rm -rf em / ou ~, git push --force, curl|sh, sudo). Se uma ação for NEGADA por permissão, NÃO tente contornar (outro comando, cópia, cat, base64…) nem repita: chame mcp__cardume__ask_human explicando o que precisa e por quê — o humano fornece o valor ou faz a ação.";
