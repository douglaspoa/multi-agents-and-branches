// O QUADRO único (72-kanban): agrupamento por coluna, ordem por modificação, quando pode arrastar, cartão sem uuid —
// e as três telas (Central, Time, Issues) passando pelo mesmo componente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const S72 = read('js/72-kanban.js');
const K = new Function(cut(S72, '// @puro-kanban-inicio', '// @puro-kanban-fim')
  + '\nreturn { kbColOf, kbSort, kbGroup, kbLocalDrops, kbTeamDrops, kbIssueDrops, kbCardHtml, kbBoardHtml };')();
const P = new Function(cut(read('js/08-periodo.js'), '// @puro-periodo-inicio', '// @puro-periodo-fim') + '\nreturn { modTs };')();
const ME = '0000aaaa-0000-4000-8000-00000000000a', BRUNO = '0000aaaa-0000-4000-8000-00000000000b';
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

test('coluna: etapa da Central (flowBucket) → coluna; concluída hoje/antes = Concluídas; mapa troca coluna', () => {
  assert.equal(K.kbColOf('andamento'), 'andamento');
  assert.equal(K.kbColOf('hoje'), 'concluidas');
  assert.equal(K.kbColOf('anteriores'), 'concluidas');
  assert.equal(K.kbColOf('hoje', { concluidas: 'prontas' }), 'prontas');
});

test('agrupamento: cada item na sua coluna, contador certo, coluna vazia existe; coluna desconhecida → fallback ou some', () => {
  const cols = [{ key: 'fila', label: 'Na fila' }, { key: 'andamento', label: 'Em andamento' }, { key: '__other', label: 'Outros' }];
  const items = [{ id: 1, col: 'fila', ts: 1 }, { id: 2, col: 'andamento', ts: 2 }, { id: 3, col: 'fila', ts: 3 }, { id: 4, col: 'xyz', ts: 4 }];
  const g = K.kbGroup(items, cols, '__other');
  assert.deepEqual(g.map((c) => [c.key, c.n]), [['fila', 2], ['andamento', 1], ['__other', 1]]);
  const g2 = K.kbGroup(items, cols.slice(0, 2));
  assert.equal(g2.reduce((s, c) => s + c.n, 0), 3, 'sem fallback, o item de coluna desconhecida não inventa coluna');
  assert.equal(K.kbGroup([], cols)[1].n, 0, 'coluna vazia continua no quadro');
});

test('ordem dentro da coluna: modificação mais recente primeiro (modTs = o maior carimbo do item); empate por título', () => {
  const a = { title: 'B', ts: P.modTs('2026-10-09T10:00:00Z', 0) };
  const b = { title: 'A', ts: P.modTs('2026-10-01T10:00:00Z', Date.parse('2026-10-09T12:00:00Z')) }; // atividade recente vence
  const c = { title: 'C', ts: P.modTs('2026-10-05T10:00:00Z') };
  assert.deepEqual(K.kbSort([c, a, b]).map((x) => x.title), ['A', 'B', 'C']);
  assert.deepEqual(K.kbSort([{ title: 'b', ts: 5 }, { title: 'a', ts: 5 }]).map((x) => x.title), ['a', 'b']);
  const g = K.kbGroup([{ col: 'x', ts: 1, title: 'velha' }, { col: 'x', ts: 9, title: 'nova' }], [{ key: 'x' }]);
  assert.deepEqual(g[0].items.map((x) => x.title), ['nova', 'velha']);
});

test('arrastar (tarefa desta máquina): só rascunho → Em andamento (iniciar); o resto não arrasta', () => {
  assert.deepEqual(K.kbLocalDrops({ status: 'draft' }), { andamento: 'start' });
  for (const st of ['running', 'review', 'error', 'merged']) assert.deepEqual(K.kbLocalDrops({ status: st }), {}, st);
});

test('arrastar (cartão do time): regras da 0032 — assumir e iniciar, devolver; colega não se toma', () => {
  const base = { status: 'backlog', claim_mode: 'open', assignee: null, created_by: BRUNO };
  assert.deepEqual(K.kbTeamDrops(base, { me: ME, sameRepo: true, bucket: 'fila' }), { andamento: 'claimstart' });
  assert.deepEqual(K.kbTeamDrops(base, { me: ME, sameRepo: false, bucket: 'fila' }), {}, 'projeto não está aberto aqui: nada de iniciar');
  assert.deepEqual(K.kbTeamDrops({ ...base, assignee: BRUNO }, { me: ME, sameRepo: true, bucket: 'fila' }), {}, 'cartão do colega não se toma');
  assert.deepEqual(K.kbTeamDrops({ ...base, claim_mode: 'reserved' }, { me: ME, sameRepo: true, bucket: 'fila' }), {}, 'reservado pra quem criou');
  assert.deepEqual(K.kbTeamDrops({ ...base, claim_mode: 'reserved', created_by: ME }, { me: ME, sameRepo: true, bucket: 'fila' }), { andamento: 'claimstart' });
  // devolver: parado (erro), sem PR, meu → pode voltar pra fila; rodando, com PR ou entregue → não
  const err = { status: 'error', assignee: ME, created_by: ME };
  assert.deepEqual(K.kbTeamDrops(err, { me: ME, bucket: 'aguardando' }), { fila: 'release' });
  assert.deepEqual(K.kbTeamDrops({ ...err, assignee: BRUNO }, { me: ME, bucket: 'aguardando' }), {}, 'de outra pessoa e eu não atribuo');
  assert.deepEqual(K.kbTeamDrops({ ...err, assignee: BRUNO }, { me: ME, canAssign: true, bucket: 'aguardando' }), { fila: 'release' }, 'líder devolve');
  for (const x of [{ status: 'running' }, { status: 'error', pr_url: 'https://x/pull/1' }, { status: 'review' }, { status: 'merged' }, { status: 'error', flag: 'closed' }])
    assert.deepEqual(K.kbTeamDrops({ ...err, ...x }, { me: ME, bucket: 'andamento' }), {}, JSON.stringify(x));
  assert.deepEqual(K.kbTeamDrops(null, {}), {});
});

test('arrastar (issue): qualquer status do conector menos o atual e "Outros"; sem updateStatus, nada', () => {
  assert.deepEqual(K.kbIssueDrops({ status: 'todo' }, ['todo', 'doing', 'done', '__other'], true), { doing: 'move', done: 'move' });
  assert.deepEqual(K.kbIssueDrops({ status: 'todo' }, ['todo', 'doing'], false), {});
});

test('cartão: título, corrente, pessoa ou "livre", requisitos x/y, prova, trava, "há X" — e NENHUM id no texto', () => {
  const vm = { id: '0000ffff-0000-4000-8000-000000000001', title: 'QR Code do Pix', chain: '<button class="chn">FND-101</button>',
    who: '<span class="pchip"><span class="pnm">Bruno</span></span>', reqs: { ok: 1, tot: 3 }, proofs: 2, thumb: null,
    trav: 'Teste falhando no CI.', ago: 'há 3 min', drops: {}, acts: [{ act: 'claim', label: 'Assumir', primary: true }], menu: true };
  const h = K.kbCardHtml(vm, {});
  const t = text(h);
  assert.ok(!UUID.test(t), 'uuid no texto: ' + t);
  assert.ok(!/aria-label="[^"]*[0-9a-f]{8}-[0-9a-f]{4}/i.test(h), 'uuid no aria-label');
  for (const s of ['QR Code do Pix', 'FND-101', 'Bruno', '1/3', 'Teste falhando no CI.', 'há 3 min', 'Assumir']) assert.ok(t.includes(s), s);
  assert.match(h, /data-kbid="0000ffff/); // o id fica só no atributo (pra abrir), nunca no texto
  assert.match(h, /tabindex="0"/, 'cartão focável (Enter abre)');
  assert.ok(!/draggable/.test(h), 'sem ação de arrastar = sem arrasto (nem cursor)');
  const livre = K.kbCardHtml({ ...vm, who: null, drops: { andamento: 'claimstart' } }, {});
  assert.match(text(livre), /\blivre\b/); assert.match(livre, /tmfree/, 'avatar tracejado');
  assert.match(livre, /draggable="true" data-kbdrops="andamento"/);
  assert.match(K.kbCardHtml({ ...vm, title: '<script>x</script>' }, {}), /&lt;script&gt;/, 'título escapado');
  assert.match(K.kbCardHtml({ ...vm, reqs: { ok: 3, tot: 3 } }, {}), /kb-req ok/);
});

test('quadro: colunas com contador, vazio decente, corte com "+N", rolagem lateral só DENTRO do quadro', () => {
  const cols = K.kbGroup([{ id: 'a', col: 'fila', ts: 2, title: 'A' }, { id: 'b', col: 'fila', ts: 1, title: 'B' }], [{ key: 'fila', label: 'Na fila', cap: 1 }, { key: 'andamento', label: 'Em andamento' }]);
  const h = K.kbBoardHtml({ id: 't', cols, card: (vm) => `<i data-c="${vm.id}"></i>`, empty: () => '<p class="vz">nada</p>', more: (c, s) => `<em>+${c.n - s.length}</em>` });
  assert.match(h, /aria-label="Na fila, 2"/); assert.match(h, /<span class="kb-n">2<\/span>/);
  assert.ok(h.includes('data-c="a"') && !h.includes('data-c="b"'), 'corte mostra a mais recente');
  assert.match(h, /<em>\+1<\/em>/); assert.match(h, /kb-col vazia[^>]*>[\s\S]*class="vz"/);
  const css = read('css/99-kanban.css');
  assert.match(css, /\.kb-board\{[^}]*overflow-x:auto/); assert.match(css, /\.kb-board\{[^}]*min-width:0/);
  assert.match(css, /\.kb-card\[draggable="true"\]\{cursor:grab\}/);
  assert.ok(!/border-left:\s*[2-9]/.test(css), 'sem faixa colorida na borda (craft-floor)');
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(css), 'só tokens de cor existentes');
});

test('as três telas usam o MESMO componente (Central, Time, Issues) e o quadro da Central é lembrado por pessoa', () => {
  const S22 = read('js/22-quadro-fluxo.js'), S71 = read('js/71-central-alcance.js'), S43 = read('js/43-espaco-times.js'), S14 = read('js/14-issues-projeto.js'), S23 = read('js/23-kanban-artefatos-editor.js');
  assert.match(S22, /kbCentralMinhasHtml\(tasks\)/); assert.match(S22, /data-kbview="board"/);
  assert.match(S71, /kbCentralTeamHtml\(vis, scope\)/); assert.match(S71, /caFiltra\(all, f, me, CA_FN\)[\s\S]{0,900}kbCentralTeamHtml/, 'quadro do alcance respeita chips/projeto/pessoa');
  assert.match(S43, /kbTeamBoardHtml\(visP\)/); // o Quadro com o período (74 perAbertoOuNoPeriodo) — a aba conta o mesmo
  assert.match(S14, /kbIssueCard\(i, \{ inGroup, row:[^}]*drops:kbIssueDrops\(/); assert.match(S72, /trkRowOf\(i, trkEntriesFor\(i\.code\)/, "ligação pelo índice novo do 14"); assert.ok(!/trkTasksFor/.test(S72)); assert.match(S14, /kbBoardHtml\(\{ id:'issues'/);
  assert.match(S23, /function renderKanban\(\)\{[\s\S]{0,400}kbCentralKey\(\),'1'\)[\s\S]{0,120}setView\('flow'\)/, 'o Kanban antigo cai no quadro da Central');
  assert.match(S72, /function kbCentralKey\(\)\{ return userKey\('kb:central', /, 'lembrado por pessoa');
  // nenhuma busca por cartão: provas vêm do lote do 70 e a miniatura só de cache
  const vm = cut(S72, 'function kbTeamThumb', '\n}\n') + cut(S72, 'function kbLocalThumb', '\n}\n');
  assert.ok(!/sbGet|invoke\(|fetch\(|cloudSignedUrl/.test(vm), 'miniatura sem busca por cartão');
  const html = read('index.html');
  assert.ok(html.indexOf('js/71-central-alcance.js') < html.indexOf('js/72-kanban.js'), '72 depois do 71');
  assert.match(html, /css\/99-kanban\.css/);
});

test('cartão do time encerrado (flag closed) não se arrasta pra "Em andamento" (o caLivre também não deixa assumir)', () => {
  assert.deepEqual(K.kbTeamDrops({ status: 'backlog', flag: 'closed', claim_mode: 'open', assignee: null, created_by: BRUNO }, { me: ME, sameRepo: true, bucket: 'hoje' }), {});
});

// o que o soltar/abrir/menu chama de fato (handlers executados com dublês — não só o texto do código)
const kbHandlersOf = (env) => new Function(...Object.keys(env), cut(S72, 'function kbHandlers(vms, after){', '\nfunction kbWireCentral') + '\nreturn kbHandlers;')(...Object.values(env));
test('soltar: rascunho → iniciar; cartão do time → assumir e iniciar / devolver; abrir e menu certos por tipo', async () => {
  const log = [];
  const env = { crossRun: (id, f) => { log.push('cross:' + id); return f(); }, startTask: (id) => log.push('start:' + id), teamClaimStart: async (ct) => log.push('claimstart:' + ct.id),
    tsRelease: async (ct) => log.push('release:' + ct.id), caAct: async (a, ct) => log.push('caAct:' + a + ':' + ct.id), caOpen: (ct) => log.push('caOpen:' + ct.id),
    caLocalOf: () => null, openTaskMenu: (id) => log.push('menuLocal:' + id), kbTeamMenu: (ct) => log.push('menuTeam:' + ct.id), openOrEdit: (t) => log.push('open:' + t.id),
    switchToProjectTask: (r, id) => log.push('switch:' + id), render: () => {}, showErr: (e) => log.push('err:' + e), state: { repo: '/p' }, selected: null, teamFetchedAt: 1 };
  const H = kbHandlersOf(env)([], () => log.push('after'));
  const loc = { id: 'rasc-1', kind: 'local', ref: { id: 'rasc-1', repo: '/p' } }, ct = { id: 'c1', kind: 'cloud', ref: { id: 'c1' } };
  await H.drop(loc, 'andamento', 'start'); await H.drop(ct, 'andamento', 'claimstart'); await H.drop(ct, 'fila', 'release');
  H.open(loc); H.open(ct); H.menu(loc, {}); H.menu(ct, {}); await H.act(ct, 'claim', {});
  assert.deepEqual(log, ['cross:rasc-1', 'start:rasc-1', 'claimstart:c1', 'after', 'release:c1', 'after', 'open:rasc-1', 'caOpen:c1', 'menuLocal:rasc-1', 'menuTeam:c1', 'caAct:claim:c1', 'after']);
});

test('quadro da Central: lembrado POR PESSOA; Concluídas e "por dia" voltam pra lista', () => {
  const ls = {}; let uid = 'u1';
  const env = { userKey: (k, u) => k + ':' + u, cloudUserId: () => uid, lsGet: (k) => ls[k], lsSet: (k, v) => { ls[k] = v; }, renderFlow: () => {}, lastSig: '', flowScope: 'exec', flowGroupBy: 'none' };
  const src = cut(S72, 'function kbCentralKey(){', 'const KB_CENTRAL_COLS');
  const mk = (scope, group) => new Function(...Object.keys(env), src.replace(/flowScope/g, JSON.stringify(scope)).replace(/flowGroupBy/g, JSON.stringify(group)) + '\nreturn { kbCentralOn, kbCentralSet, kbCentralNow };')(...Object.values(env));
  const F = mk('exec', 'none');
  assert.equal(F.kbCentralOn(), false); F.kbCentralSet(true); assert.equal(F.kbCentralNow(), true);
  uid = 'u2'; assert.equal(F.kbCentralOn(), false, 'outra pessoa no mesmo computador: a escolha é dela'); uid = 'u1';
  assert.equal(mk('done', 'none').kbCentralNow(), false); assert.equal(mk('exec', 'day').kbCentralNow(), false);
  F.kbCentralSet(false); assert.equal(F.kbCentralOn(), false);
});
