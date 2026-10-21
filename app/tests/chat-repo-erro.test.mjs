// Bug 21/10 (produção): no chat da Nova demanda, cada envio voltava "Não deu pra falar com a IA: repo não definido"
// ou "Sem permissão pra essa ação (… conta sem acesso ao repositório)" — com o projeto aparecendo na tela.
// Aqui: o catálogo separa as causas reais, o `invoke` recupera sozinho quando o backend está sem o projeto
// (harness headless: o trecho REAL do 10-core rodando contra um backend falso) e o mesmo erro não empilha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const util = read('00-util.js'), core = read('10-core.js'), planner = read('32-planner.js'), pc = read('12-chat-prefs-daily.js');
const noop = () => {};
const ctx = { window: { addEventListener: noop }, document: { getElementById: () => null, addEventListener: noop }, localStorage: { getItem: () => null, setItem: noop }, navigator: { platform: 'MacIntel', userAgent: '' }, console };
vm.createContext(ctx);
vm.runInContext(util, ctx);
const { humanErr, repoRetry, sysMsgPush, errDetailLine } = ctx;
const cut = (src, a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, 'achei ' + a); const j = src.indexOf(b, i); assert.ok(j > i, 'achei ' + b); return src.slice(i, j); };

test('catálogo: pasta bloqueada pelo macOS, falta preparar, sem projeto e 403 da IA são causas DIFERENTES', () => {
  const mac = humanErr('abrir a pasta do projeto: SEM_ACESSO_PASTA_MAC: o macOS não deu ao Starfork acesso à pasta "loja" (/Users/ana/Documents/loja) — libere em Ajustes… [Operation not permitted (os error 1)]');
  assert.equal(mac.id, 'mac-folder');
  assert.match(mac.msg, /Privacidade e Segurança › Arquivos e Pastas/);
  assert.equal(mac.action.label, 'abrir Ajustes');
  // o spawn do claude na pasta protegida (sem o prefixo do Rust) também não é "conta sem acesso ao repositório"
  assert.equal(humanErr('falha ao rodar claude: Operation not permitted (os error 1)').id, 'mac-folder');
  const prep = humanErr('SEM_WORKSPACE: a pasta "loja" ainda não foi preparada pro Starfork (sem .cardume/state.sqlite em /x) — toque em Preparar');
  assert.equal(prep.id, 'repo-prepare'); assert.equal(prep.action.label, 'Preparar');
  assert.equal(humanErr('sem state.sqlite em /x/.cardume/state.sqlite — rode `cardume init`').id, 'repo-prepare'); // versão antiga do backend
  assert.equal(humanErr('abrir o projeto: repo não definido').id, 'repo-none');
  assert.equal(humanErr('PASTA_SUMIU: a pasta do projeto não existe mais: /x').id, 'folder-gone');
  assert.equal(humanErr('SEM_ACESSO_PASTA: sem permissão de leitura na pasta "x" (/x). [Permission denied (os error 13)]').id, 'folder-perm');
  const ai = humanErr('API Error: 403 {"type":"error","error":{"type":"permission_error","message":"x"}}');
  assert.equal(ai.id, 'ai-403'); assert.match(ai.msg, /Claude recusou/);
  // GitHub 403 continua "permission" — com a frase que não acusa a pasta
  assert.equal(humanErr("remote: Permission to a/b.git denied.\nfatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403").id, 'permission');
  assert.equal(errDetailLine('abrir o projeto: repo não definido\nmais', 'Nenhum projeto aberto'), 'abrir o projeto: repo não definido');
  assert.equal(errDetailLine('igual', 'texto igual'), '', 'não repete o que a frase já diz');
});

test('repoRetry: backend sem projeto + projeto na tela → reabre e repete UMA vez; falha = motivo real', async () => {
  const be = { db: null, setRepo: [], fail: null, calls: 0 };
  const aiChat = async () => { be.calls++; if (!be.db) throw 'abrir o projeto: repo não definido'; return { text: 'oi' }; };
  const reopen = async (r) => { be.setRepo.push(r); if (be.fail) throw be.fail; be.db = r; };
  const logs = [];
  const r = await repoRetry(aiChat, { want: () => '/Users/ana/loja', reopen, log: (l) => logs.push(l) });
  assert.equal(r.text, 'oi'); assert.deepEqual(be.setRepo, ['/Users/ana/loja']); assert.equal(be.calls, 2);
  assert.match(logs.join('\n'), /reabrindo/);
  // sem projeto na tela: não inventa um — o erro original sobe
  be.db = null; be.setRepo = [];
  await assert.rejects(repoRetry(aiChat, { want: () => '', reopen }), /repo não definido/);
  assert.deepEqual(be.setRepo, []);
  // set_repo falha (pasta bloqueada): sobe o motivo do set_repo, marcado, e o chat NÃO roda de novo
  be.fail = 'SEM_ACESSO_PASTA_MAC: o macOS não deu ao Starfork acesso à pasta "loja" [Operation not permitted (os error 1)]'; be.calls = 0;
  await assert.rejects(repoRetry(aiChat, { want: () => '/Users/ana/loja', reopen }), (e) => e.reopenFailed && e.repo === '/Users/ana/loja' && humanErr(e).id === 'mac-folder');
  assert.equal(be.calls, 1);
  // outro erro qualquer passa direto, sem reabrir
  be.setRepo = [];
  await assert.rejects(repoRetry(async () => { throw 'rate limit'; }, { want: () => '/x', reopen }), /rate limit/);
  assert.deepEqual(be.setRepo, []);
});

test('harness headless: o invoke REAL do 10-core recupera o chat quando o backend perde o projeto', async () => {
  // backend falso: state.db do Rust + comandos usados (set_repo / ai_chat)
  const be = { db: null, log: [], setRepoErr: null };
  const _invokeRaw = async (cmd, a) => {
    if (cmd === 'set_repo') { if (be.setRepoErr) throw be.setRepoErr; be.db = a.repo; return a.repo; }
    if (cmd === 'ai_chat') { if (!be.db) throw 'abrir o projeto: repo não definido'; return { text: 'resposta', sessionId: 's' }; }
    throw 'cmd ' + cmd;
  };
  const ls = new Map([['lastRepo', '/Users/ana/loja']]);
  const E = { _invokeRaw, repoRetry, errText: ctx.errText, lsGet: (k) => ls.get(k) ?? null, __diagLog: (l) => be.log.push(l),
    state: { repo: null }, projects: [{ path: '/Users/ana/loja', name: 'loja' }], refresh: () => {}, window: {} };
  const code = cut(core, 'const REPO_SELF=', 'window.repoWanted=repoWanted;');
  const mk = new Function('E', `let { _invokeRaw, repoRetry, errText, lsGet, __diagLog, state, projects, refresh, window }=E; let connected=false, lastSig='x';
    ${code} return { invoke, repoWanted, setProjects:(p)=>{ projects=p; } };`);
  const h = mk(E);
  // tela: o último projeto aberto (lastRepo) ainda está na lista da conta; backend: sem nenhum (state.db None)
  assert.equal(h.repoWanted(), '/Users/ana/loja');
  const r = await h.invoke('ai_chat', { prompt: 'teste' });
  assert.equal(r.text, 'resposta'); assert.equal(be.db, '/Users/ana/loja', 'set_repo reabriu o projeto da tela');
  assert.match(be.log.join('\n'), /\[repo\] backend sem projeto com "loja" na tela/);
  // set_repo é um dos comandos que NÃO passam pela recuperação (sem laço)
  be.db = null; be.setRepoErr = 'SEM_WORKSPACE: a pasta "loja" ainda não foi preparada pro Starfork';
  await assert.rejects(h.invoke('set_repo', { repo: '/x' }), /SEM_WORKSPACE/);
  // set_repo falha → o chat mostra o motivo acionável (Preparar), e a 2ª tentativa em 30s não martela o set_repo
  let n = 0; const raw0 = _invokeRaw; E._invokeRaw = async (c, a) => { if (c === 'set_repo') n++; return raw0(c, a); };
  const h2 = mk(E);
  await assert.rejects(h2.invoke('ai_chat', {}), (e) => e.reopenFailed && humanErr(e).id === 'repo-prepare' && humanErr(e).action.label === 'Preparar');
  await assert.rejects(h2.invoke('ai_chat', {}), (e) => e.reopenFailed);
  assert.equal(n, 1, 'um set_repo só no intervalo');
  // projeto escondido por ser de outra conta (fora da lista) NUNCA é reaberto pelo "último aberto"
  h2.setProjects([{ path: '/Users/ana/outro' }]);
  assert.equal(h2.repoWanted(), '');
  await assert.rejects(h2.invoke('ai_chat', {}), /repo não definido/);
});

test('o mesmo erro de novo vira um balão só com (×N)', () => {
  const msgs = [{ who: 'you', text: 'oi' }];
  const t = 'O macOS não deu ao Starfork acesso à pasta do projeto. Sua mensagem voltou pra caixa — é só enviar de novo.';
  sysMsgPush(msgs, t); sysMsgPush(msgs, t); sysMsgPush(msgs, t);
  assert.equal(msgs.length, 2); assert.equal(msgs[1].text, t + ' (×3)');
  sysMsgPush(msgs, 'outro'); assert.equal(msgs.length, 3);
  const pcm = []; sysMsgPush(pcm, 'x', null, 'role'); sysMsgPush(pcm, 'x', null, 'role');
  assert.deepEqual(JSON.parse(JSON.stringify(pcm)), [{ role: 'sys', text: 'x (×2)', n: 2, base: 'x' }]);
});

test('fiação: planner e chat do projeto usam o colapso + motivo real; tela sem projeto não finge um; troca de conta zera o "último"', () => {
  assert.match(planner, /sysMsgPush\(plMsgs, msg\)/);
  assert.match(planner, /e&&e\.reopenFailed&&e\.repo\?'Não consegui abrir o projeto '/);
  assert.match(planner, /state\.repo\?'':'<option value="" selected disabled>escolha o projeto<\/option>'/);
  assert.match(pc, /sysMsgPush\(ms2, h\.msg/);
  assert.match(core, /repoRetry\(\(\) => _invokeRaw\(cmd, args\), \{ want: repoWanted, reopen: repoReopen, log: __diagLog \}\)/);
  assert.match(core, /if\(snap\.repo\) lsSet\('lastRepo', snap\.repo\); else repoBootReopen\(\);/);
  assert.match(read('40-conta-escopo.js'), /if\(r && r\.switched\)\{ lsSet\('lastRepo', r\.active\|\|''\);/);
});

test('harness headless: boot/conta deixou o backend sem projeto → o 1º snapshot vazio reabre o último projeto da conta', async () => {
  const be = { db: null, calls: [] };
  const _invokeRaw = async (cmd, a) => { be.calls.push(cmd); if (cmd === 'set_repo') { be.db = a.repo; return a.repo; } throw 'cmd ' + cmd; };
  const ls = new Map([['lastRepo', '/Users/ana/loja']]); const toasts = [];
  const E = { _invokeRaw, repoRetry, errText: ctx.errText, errFirstLine: ctx.errFirstLine, humanErr, pathBase: ctx.pathBase, lsGet: (k) => ls.get(k) ?? null,
    __diagLog: noop, state: { repo: null }, projects: [{ path: '/Users/ana/loja' }], refresh: noop, window: {}, $id: () => null, toast: (m) => toasts.push(m), errDetails: noop };
  const code = cut(core, 'const REPO_SELF=', 'window.repoWanted=repoWanted;') + cut(core, 'let repoBootAt=0;', 'async function connect(repo){');
  const h = new Function('E', `let { _invokeRaw, repoRetry, errText, errFirstLine, humanErr, pathBase, lsGet, __diagLog, state, projects, refresh, window, $id, toast, errDetails }=E; let connected=false, lastSig='';
    ${code} return { repoBootReopen, isConn:()=>connected };`)(E);
  h.repoBootReopen(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(be.db, '/Users/ana/loja', 'set_repo chamado com o último projeto da conta');
  assert.ok(h.isConn());
  h.repoBootReopen(); assert.equal(be.calls.filter((c) => c === 'set_repo').length, 1, 'no máximo uma tentativa por minuto');
  // pasta bloqueada no boot: o motivo real vira aviso (não "sem repo" mudo)
  const E2 = Object.assign({}, E, { _invokeRaw: async () => { throw 'SEM_ACESSO_PASTA_MAC: o macOS não deu ao Starfork acesso à pasta "loja" [Operation not permitted (os error 1)]'; } });
  const h2 = new Function('E', `let { _invokeRaw, repoRetry, errText, errFirstLine, humanErr, pathBase, lsGet, __diagLog, state, projects, refresh, window, $id, toast, errDetails }=E; let connected=false, lastSig='';
    ${code} return { repoBootReopen };`)(E2);
  h2.repoBootReopen(); await new Promise((r) => setTimeout(r, 0));
  assert.match(toasts.join('\n'), /Não consegui abrir loja — O macOS não deu ao Starfork acesso/);
});

test('conta: o Rust reabre o projeto ao voltar a sessão e a tela redesenha; o seletor novo troca pelo mesmo switchProject', () => {
  const esc = read('40-conta-escopo.js');
  assert.match(esc, /if\(r && r\.restored && r\.active\)\{ lsSet\('lastRepo', r\.active\); await acctAfterSwitch\(\); \}/);
  const rs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const spu = cut(rs, 'fn set_projects_user(', '\n}\n');
  assert.match(spu, /active_for_user\(active\.as_deref\(\), u\.as_deref\(\), &f, &vis\)/);
  assert.match(spu, /"restored": restored/);
  assert.match(read('76-casca-semana.js'), /if\(v!==state\.repo && window\.switchProject\)\{ try\{ await window\.switchProject\(v\);/);
});
