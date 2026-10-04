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

test('Claude Code não instalado → Verificação (ex-Ambiente, F4)', () => {
  const h = humanErr('falha ao iniciar claude: spawn claude ENOENT');
  assert.equal(h.id, 'claude-missing');
  assert.match(h.msg, /Claude Code não está instalado/);
  assert.match(h.action.label, /Verificação/);
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

test('humanErr com {message, raw}: a tela usa o texto traduzido, "ver detalhes" guarda o cru', () => {
  const h = humanErr({ message: 'o arquivo não existe mais', raw: 'No such file or directory (os error 2)' }, 'Não consegui abrir a nota');
  assert.equal(h.msg, 'Não consegui abrir a nota: o arquivo não existe mais');
  assert.equal(h.raw, 'No such file or directory (os error 2)');
  // o catálogo casa pelo texto (Windows "acesso negado" chega como Permission denied)
  assert.equal(humanErr({ message: 'Permission denied — Access is denied. (os error 5)', raw: 'Access is denied. (os error 5)' }).id, 'permission');
});

// ===== R8: casos reais que antes chegavam crus na tela =====
test('SQLite: "database is locked" e banco danificado', () => {
  assert.equal(id('error returned from database: (code: 5) database is locked'), 'db-locked');
  assert.equal(id('SQLITE_BUSY: database is locked'), 'db-locked');
  assert.match(humanErr('database is locked', 'Não consegui gerar o daily').msg, /^Não consegui gerar o daily — O banco local está ocupado/);
  assert.equal(id('database disk image is malformed'), 'db-broken');
  assert.equal(id('no such table: tasks'), 'db-old');
  assert.match(humanErr('no such column: epic_id').msg, /atualize o Starfork/);
});
test('IO do macOS/Windows: os error N', () => {
  assert.equal(id('No such file or directory (os error 2)'), 'not-found');
  assert.equal(id('The system cannot find the path specified. (os error 3)'), 'not-found');
  assert.equal(id('Access is denied. (os error 5)'), 'permission');
  assert.equal(id('Operation not permitted (os error 1)'), 'permission');
  assert.equal(id('The process cannot access the file because it is being used by another process. (os error 32)'), 'file-busy');
  assert.equal(id('Resource busy (os error 16)'), 'file-busy');
  assert.equal(id('No space left on device (os error 28)'), 'disk');
  assert.equal(id('There is not enough space on the disk. (os error 112)'), 'disk');
  assert.equal(id('Connection refused (os error 61)'), 'network');
  // ENOENT de binário continua sendo "não instalado", não "arquivo sumiu"
  assert.equal(id('spawn claude ENOENT'), 'claude-missing');
  assert.equal(id('spawn gh ENOENT'), 'gh-missing');
  assert.equal(id('spawn git ENOENT'), 'git-missing');
  assert.equal(id('xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)'), 'git-missing');
});
test('git: mudanças locais, lock, branch existente, ref inexistente', () => {
  assert.equal(id('error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\nPlease commit your changes or stash them before you switch branches.'), 'git-dirty');
  assert.equal(id("fatal: Unable to create '/Users/x/loja/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository"), 'git-lock');
  assert.equal(id("fatal: a branch named 'feat/login' already exists"), 'branch-exists');
  assert.equal(id("error: pathspec 'feat/x' did not match any file(s) known to git"), 'git-ref');
  assert.equal(id("fatal: invalid reference: feat/x"), 'git-ref');
  assert.equal(id("fatal: couldn't find remote ref feat/x"), 'git-ref');
  // o "fatal: 'origin' does not appear" continua sendo sem remote
  assert.equal(id("fatal: 'origin' does not appear to be a git repository"), 'no-remote');
});
test('gh: PR já existe, sem commits, sem PR', () => {
  assert.equal(id('a pull request for branch "feat/x" into branch "main" already exists:\nhttps://github.com/a/b/pull/3'), 'pr-exists');
  assert.equal(id('pull request create failed: GraphQL: No commits between main and feat/x (createPullRequest)'), 'no-commits');
  assert.equal(id('no pull requests found for branch "feat/x"'), 'no-pr');
});
test('servidor 5xx ≠ sem internet; JSON inválido; duplicado; RLS', () => {
  assert.equal(id('HTTP 502: Bad Gateway (https://api.github.com/graphql)'), 'server');
  assert.equal(id('504 Gateway Time-out'), 'server');
  assert.equal(id('Internal Server Error'), 'server');
  assert.equal(id('Unexpected token < in JSON at position 0'), 'bad-json');
  assert.equal(id(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`), 'bad-json');
  assert.equal(id('expected value at line 1 column 1'), 'bad-json');
  assert.equal(id('Unexpected end of JSON input'), 'bad-json');
  assert.equal(id('duplicate key value violates unique constraint "teams_name_key"'), 'duplicate');
  assert.equal(id('new row violates row-level security policy for table "teams"'), 'cloud-permission');
  assert.equal(id('{"code":"42501","message":"permission denied for table teams"}'), 'cloud-permission');
  assert.match(humanErr('duplicate key value violates unique constraint').msg, /nada foi criado/);
});
test('rede: DNS/reqwest/timeout em pt-BR', () => {
  assert.equal(id('getaddrinfo EAI_AGAIN api.supabase.co'), 'network');
  assert.equal(id('error sending request for url (https://x.supabase.co/rest/v1/tasks): dns error'), 'network');
  assert.equal(id('tempo esgotado esperando o GitHub'), 'network');
  // números grandes não viram 5xx por engano
  assert.equal(id('operation timed out after 30000ms'), 'network');
});
test('cada item do catálogo tem mensagem em pt-BR e ação com rótulo', () => {
  const cat = vm.runInContext('ERR_CATALOG', ctx);
  assert.ok(cat.length >= 25, 'catálogo: ' + cat.length);
  for (const c of cat) {
    assert.ok(c.msg && c.msg.length > 10, c.id);
    if (c.act) assert.ok(c.label, c.id + ' sem rótulo');
  }
});

test('mensagens do Rust com binário ausente (os error 2) = não instalado, não "arquivo sumiu"', () => {
  assert.equal(id('falha ao rodar claude: No such file or directory (os error 2)'), 'claude-missing');
  assert.equal(id('gh indisponível: No such file or directory (os error 2)'), 'gh-missing');
  assert.equal(id('sem resposta do GitHub (gh): program not found'), 'gh-missing');
  assert.equal(id('git: No such file or directory (os error 2)'), 'git-missing');
  assert.equal(id('JSON inválido da IA: expected value at line 1 column 1'), 'bad-json');
  // arquivo comum que sumiu continua "não encontrado"
  assert.equal(id('não consegui abrir a pasta: No such file or directory (os error 2)'), 'not-found');
});

test('bug: "gh: Not Found (HTTP 404)" é recurso inexistente, não "gh não instalado"', () => {
  assert.equal(id('gh: Not Found (HTTP 404)'), 'generic');
  assert.equal(id('zsh: command not found: gh'), 'gh-missing');
  assert.equal(id('zsh: command not found: git'), 'git-missing');
  assert.equal(id('zsh: command not found: claude'), 'claude-missing');
});

test('R8 revisão: git-lock não engole colisão de nome nem falta de permissão', () => {
  assert.equal(id("error: cannot lock ref 'refs/heads/feat/login': 'refs/heads/feat' exists; cannot create 'refs/heads/feat/login'"), 'branch-clash');
  assert.equal(id("fatal: Unable to create '/repo/.git/index.lock': Permission denied"), 'permission');
  assert.equal(id("fatal: Unable to create '/repo/.git/index.lock': File exists."), 'git-lock');
});
test('R8 revisão: binário ausente com texto localizado do Windows; "^git:" só no começo', () => {
  assert.equal(id('falha ao rodar claude: O sistema não pode encontrar o arquivo especificado. (os error 2)'), 'claude-missing');
  assert.equal(id('gh indisponível: Das System kann die angegebene Datei nicht finden. (os error 2)'), 'gh-missing');
  // "git:" no meio de outra linha não é "git não instalado"
  assert.notEqual(id('passo 1 ok\ngit: No such file or directory (os error 2)'), 'git-missing');
});
test('R8 revisão: cópia da tarefa apagada (ENOENT com worktree) = wt-gone com ação, antes de *-missing', () => {
  const h = humanErr('falha ao rodar claude: No such file or directory (os error 2) — cwd /Users/a/loja/.cardume/worktrees/t-1');
  assert.equal(h.id, 'wt-gone');
  assert.ok(h.action && h.action.label);
  assert.equal(humanErr('a cópia de trabalho desta tarefa não existe mais (já foi limpa)').id, 'wt-gone');
});
test('R8 revisão: os error 3 no Unix (kill) e os error 1 sem texto não são "arquivo"/"permissão"', () => {
  assert.equal(id('No such process (os error 3)'), 'generic');
  assert.equal(id('The system cannot find the path specified. (os error 3)'), 'not-found');
  assert.equal(id('erro qualquer (os error 1)'), 'generic');
  assert.equal(id('Operation not permitted (os error 1)'), 'permission');
});
test('R8 revisão: bad-json não casa linha de stack nem "invalid args" do Tauri', () => {
  assert.notEqual(id('TypeError: x is undefined\n    at JSON.parse (<anonymous>)'), 'bad-json');
  assert.notEqual(id('invalid args `taskId` for command `pr_status`: invalid type: null, expected a string'), 'bad-json');
  assert.notEqual(id('invalid args `data` for command `x`: expected value at line 1 column 1'), 'bad-json');
  assert.equal(id('JSON.parse: unexpected character at line 1 column 1 of the JSON data'), 'bad-json');
});
test('R8 revisão: "nothing to commit" ≠ "no commits between"', () => {
  assert.equal(id('nothing to commit, working tree clean'), 'nothing-to-commit');
  assert.equal(id('GraphQL: No commits between main and feat/x'), 'no-commits');
  assert.match(humanErr('nothing to commit').msg, /nada novo pra salvar/);
  assert.match(humanErr('No commits between').msg, /abrir o PR/);
});
test('errShort: frase do catálogo quando conhece, 1ª linha do cru quando não', () => {
  const errShort = vm.runInContext('errShort', ctx);
  assert.equal(errShort('database is locked'), humanErr('database is locked').msg);
  assert.equal(errShort('Error: tarefa não está em execução\n  at x'), 'tarefa não está em execução');
  assert.equal(errShort(''), 'erro sem detalhe');
  assert.ok(!/^Algo deu errado/.test(errShort('qualquer coisa')));
});
