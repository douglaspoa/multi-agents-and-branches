// Catálogo de erros pt-BR (E1): `node --test app/tests/`
// Carrega o 00-util.js inteiro num contexto vm com um window/document mínimos e testa humanErr/pathBase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/js/00-util.js', import.meta.url), 'utf8');
const noop = () => {};
const ctx = {
  window: { addEventListener: noop },
  document: { getElementById: () => null, addEventListener: noop },
  localStorage: { getItem: () => null, setItem: noop },
  navigator: { platform: 'MacIntel', userAgent: '' },
  console,
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { humanErr, pathBase, pathDir, errFirstLine } = ctx;

const id = (e, c) => humanErr(e, c).id;

test('Claude Code não instalado → Ambiente', () => {
  const h = humanErr('falha ao iniciar claude: spawn claude ENOENT');
  assert.equal(h.id, 'claude-missing');
  assert.match(h.msg, /Claude Code não está instalado/);
  assert.match(h.action.label, /Ambiente/);
  assert.equal(id('zsh: claude: command not found'), 'claude-missing');
});
test('Claude Code sem login (/login, API key inválida)', () => {
  assert.equal(id('claude saiu com código 1 — Invalid API key · Please run /login'), 'claude-login');
  assert.equal(id('Error: Not logged in'), 'claude-login');
  assert.match(humanErr('Please run /login').msg, /precisa de login/);
});
test('GitHub CLI: não instalado e sem login', () => {
  assert.equal(id('spawn gh ENOENT'), 'gh-missing');
  assert.equal(id('gh pr create: To get started with GitHub CLI, please run: gh auth login'), 'gh-auth');
  assert.equal(id('HTTP 401: Bad credentials (https://api.github.com/graphql)'), 'gh-auth');
  assert.match(humanErr('gh auth login').msg, /Conecte sua conta do GitHub/);
});
test('pasta sem git', () => {
  const h = humanErr('fatal: not a git repository (or any of the parent directories): .git');
  assert.equal(h.id, 'not-git');
  assert.equal(h.action.label, 'criar repositório');
});
test('sem remote ≠ sem internet (bug #5)', () => {
  const noRemote = "fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights";
  const h = humanErr(noRemote);
  assert.equal(h.id, 'no-remote');
  assert.equal(h.action.label, 'publicar no GitHub');
  assert.equal(id('fatal: No configured push destination.'), 'no-remote');
  // rede de verdade
  assert.equal(id("ssh: Could not resolve hostname github.com: nodename nor servname provided\nfatal: Could not read from remote repository."), 'network');
  assert.equal(id("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com"), 'network');
});
test('conflito de merge', () => {
  assert.equal(id('CONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed; fix conflicts'), 'conflict');
  assert.equal(id(' ! [rejected]        main -> main (fetch first)'), 'conflict');
});
test('permissão negada (arquivo, SSH, HTTP 403, branch protegida)', () => {
  assert.equal(id('EACCES: permission denied, open /Users/x/a.txt'), 'permission');
  assert.equal(id('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'), 'permission');
  assert.equal(id("remote: Permission to a/b.git denied.\nfatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403"), 'permission');
  assert.equal(id('GraphQL: Protected branch rules not configured for this branch'), 'permission');
});
test('rede: fetch, timeout, offline', () => {
  assert.equal(id(new TypeError('Failed to fetch')), 'network');
  assert.equal(id('Load failed'), 'network');
  assert.equal(id('operation timed out after 30000ms'), 'network');
  assert.equal(id('connect ECONNREFUSED 127.0.0.1:443'), 'network');
  assert.match(humanErr('Failed to fetch').msg, /Sem conexão/);
});
test('limite de uso / rate limit da IA', () => {
  assert.equal(id('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'), 'ai-limit');
  assert.equal(id('Claude AI usage limit reached|1759000000'), 'ai-limit');
  assert.equal(id('Overloaded'), 'ai-limit');
});
test('disco cheio', () => {
  assert.equal(id('ENOSPC: no space left on device, write'), 'disk');
});
test('sessão da nuvem expirada (Supabase)', () => {
  assert.equal(id('{"code":"PGRST301","message":"JWT expired"}'), 'session');
});
test('genérico: "Algo deu errado" + 1ª linha curta, sem ação', () => {
  const h = humanErr('Error: tarefa não está em execução\n  at x (y.js:1)');
  assert.equal(h.id, 'generic');
  assert.equal(h.msg, 'Algo deu errado: tarefa não está em execução');
  assert.equal(h.action, null);
  assert.ok(h.raw.includes('at x'), 'o texto cru fica pro "ver detalhes"');
  const long = humanErr('x'.repeat(400));
  assert.ok(long.msg.length < 170, long.msg.length);
});
test('contexto vira prefixo (o que se tentava fazer)', () => {
  assert.equal(humanErr('tarefa não está pausada', 'Falha ao retomar').msg, 'Falha ao retomar: tarefa não está pausada');
  assert.equal(humanErr('spawn claude ENOENT', 'Falha ao iniciar:').msg, 'Falha ao iniciar — O Claude Code não está instalado neste computador.');
});
test('aceita Error, string, objeto e vazio', () => {
  assert.equal(id(new Error('Failed to fetch')), 'network');
  assert.equal(id({ message: 'spawn gh ENOENT' }), 'gh-missing');
  assert.equal(humanErr(null).msg, 'Algo deu errado: erro sem detalhe');
  assert.equal(errFirstLine('fatal: algo\nmais'), 'algo');
});
test('pathBase/pathDir: / e \\ (Windows — E10)', () => {
  assert.equal(pathBase('/Users/ana/projetos/loja'), 'loja');
  assert.equal(pathBase('/Users/ana/projetos/loja/'), 'loja');
  assert.equal(pathBase('C:\\Users\\ana\\projetos\\loja'), 'loja');
  assert.equal(pathBase(''), '');
  assert.equal(pathDir('C:\\Users\\ana\\loja\\a.png'), 'C:\\Users\\ana\\loja');
  assert.equal(pathDir('/Users/ana/loja/a.png'), '/Users/ana/loja');
});

test('login do Claude Code expirado (mensagem do Rust em pt-BR e erro OAuth) vira "login", não rede', () => {
  const a = humanErr('Login do Claude Code expirou — abra um terminal, rode `claude` e digite /login (ou `claude auth login`), depois tente de novo aqui. (Failed to authenticate: OAuth session expired and could not be refreshed)');
  assert.equal(a.id, 'claude-login');
  assert.ok(a.action);
  assert.equal(humanErr('Failed to authenticate: OAuth session expired').id, 'claude-login');
});
