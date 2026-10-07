// LINHA DO PROJETO (spec-linha-do-projeto): matriz de I/O das funções puras do 69-linha (épico entregue, ativos,
// sem janela, janela inválida, sem "pronto quando", escala de meses, saúde, mescla do spec, recolher entregues)
// + os ganchos no Time (43), na casca (68) e no index. `node --test app/tests/linha.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const linha = read('js/69-linha.js'), times = read('js/43-espaco-times.js'), casca = read('js/68-casca-g1.js'), html = read('index.html');
const L = new Function(cut(linha, '// @puro-linha-inicio', '// @puro-linha-fim') +
  '\nreturn { epEntregue, epAtivo, linhaModelo, linhaEscala, linhaHtml, linhaJanela, linhaJanelaErro, linhaSaude, linhaSaudeErro, linhaMesclaSpec, linhaVisiveis, linhaJanelaTx, linhaOrdena, linhaDataBR, linhaDataTx };')();

const HOJE = new Date(2026, 9, 6); // 06/10/2026
const dw = (n, ok) => Array.from({ length: n }, (_, i) => ({ id: 'D' + (i + 1), text: 'item ' + (i + 1), ...(i < ok ? { checkedBy: 'u1', checkedAt: '2026-09-2' + (i % 9) + 'T10:00:00Z' } : {}) }));
const ep = (o) => ({ id: 'e1', name: 'Épico', status: 'open', spec: {}, ...o });
const tk = (st, o) => ({ id: Math.random().toString(36).slice(2), status: st, cost_usd: 1, updated_at: '2026-09-29T12:00:00Z', ...o });

test('épico entregue: doneWhen todo provado · sem doneWhen e todas as tarefas entregues (≥1) · status done', () => {
  assert.equal(L.epEntregue(ep({ spec: { doneWhen: dw(5, 5) } }), []), true, '5/5 provados com status open = entregue');
  assert.equal(L.epEntregue(ep({ spec: { doneWhen: dw(8, 5) } }), [tk('merged')]), false, '5/8: não');
  assert.equal(L.epEntregue(ep({ spec: { doneWhen: dw(2, 1) } }), [tk('merged'), tk('done')]), false, 'com doneWhen, tarefas não decidem');
  assert.equal(L.epEntregue(ep({}), [tk('merged'), tk('done')]), true, 'sem doneWhen: tudo entregue');
  assert.equal(L.epEntregue(ep({}), [tk('merged'), tk('review')]), false, 'em revisão ainda não é entregue');
  assert.equal(L.epEntregue(ep({}), []), false, '0 tarefas nunca é entregue');
  assert.equal(L.epEntregue(ep({ status: 'done' }), []), true, 'status done');
});

test('contagem de ativos: entregue e arquivado saem (14 "ativos" com vários 5/5 deixa de acontecer)', () => {
  const eps = [ep({ id: 'a', spec: { doneWhen: dw(5, 5) } }), ep({ id: 'b', spec: { doneWhen: dw(5, 3) } }), ep({ id: 'c', status: 'archived' }), ep({ id: 'd', status: 'done' }), ep({ id: 'e' })];
  const tasks = { e: [tk('merged')] };
  assert.deepEqual(eps.filter((e) => L.epAtivo(e, tasks[e.id] || [])).map((e) => e.id), ['b']);
});

test('modelo: janela out–nov e 5 de 8 provados → 62%, rótulo e custo', () => {
  const m = L.linhaModelo(ep({ spec: { doneWhen: dw(8, 5), window: { start: '2026-10-01', end: '2026-11-30' }, health: { state: 'no_rumo', note: '', by: 'u1', at: '2026-10-05T10:00:00Z' } } }), [tk('merged', { cost_usd: 20 }), tk('running', { cost_usd: 18.2 })]);
  assert.equal(m.pct, 62); assert.equal(m.rotulo, '5 de 8 itens provados'); assert.equal(Math.round(m.custo * 100), 3820);
  assert.ok(m.janela && m.janela.start === '2026-10-01'); assert.equal(m.saude.state, 'no_rumo'); assert.equal(m.entregue, false); assert.equal(m.ativo, true);
  assert.equal(L.linhaJanelaTx(m.janela, HOJE), 'out–nov', 'mês, nunca dia');
});

test('sem doneWhen: preenche pelas tarefas ("2 de 4 tarefas"); 0 tarefas → 0% e "sem itens"', () => {
  const m = L.linhaModelo(ep({}), [tk('merged'), tk('done'), tk('running'), tk('backlog')]);
  assert.equal(m.pct, 50); assert.equal(m.rotulo, '2 de 4 tarefas');
  const z = L.linhaModelo(ep({}), []);
  assert.equal(z.pct, 0); assert.equal(z.rotulo, 'sem itens'); assert.equal(z.entregue, false);
});

test('janela: digitada inválida não salva (com aviso); dado ruim do banco = sem janela', () => {
  assert.equal(L.linhaJanelaErro('2026-10-01', '2026-11-30'), '');
  assert.equal(L.linhaJanelaErro('', ''), '', 'os dois vazios = tirar a janela');
  assert.match(L.linhaJanelaErro('2026-10-01', ''), /início e o fim/);
  assert.match(L.linhaJanelaErro('2026-11-30', '2026-10-01'), /fim vem antes/);
  assert.match(L.linhaJanelaErro('2026-02-30', '2026-03-01'), /inválida/);
  assert.match(L.linhaJanelaErro('01/10/2026', '2026-11-01'), /inválida/);
  for (const w of [null, 'x', {}, { start: '2026-11-30', end: '2026-10-01' }, { start: '2026-13-01', end: '2026-12-01' }, { start: 20261001, end: '2026-10-02' }])
    assert.equal(L.linhaJanela(w), null, JSON.stringify(w));
  assert.equal(L.linhaModelo(ep({ spec: { window: { start: 'lixo', end: '2026-10-01' } } }), []).janela, null);
});

test('saúde: atenção/atrasado exigem a frase; estado desconhecido = sem avaliação (nunca verde automático)', () => {
  assert.equal(L.linhaSaudeErro('no_rumo', ''), '');
  assert.match(L.linhaSaudeErro('atencao', '  '), /frase/);
  assert.match(L.linhaSaudeErro('atrasado', ''), /frase/);
  assert.equal(L.linhaSaudeErro('atrasado', 'falta acesso ao banco'), '');
  assert.match(L.linhaSaudeErro('verde', 'x'), /Escolha/);
  assert.equal(L.linhaSaude({ state: 'verde' }), null);
  assert.equal(L.linhaSaude(null), null);
  const h = L.linhaHtml([L.linhaModelo(ep({ spec: { window: { start: '2026-09-01', end: '2026-12-01' } } }), [])], { hoje: HOJE });
  assert.match(h, /ln-bar h-none/); assert.match(h, /sem avaliação/); assert.doesNotMatch(h, /h-no_rumo"? style/);
});

test('mescla do spec: só a chave mexida muda; doneWhen e description ficam intactos; null tira a chave', () => {
  const fresh = { doneWhen: dw(3, 1), description: 'desc', outcome: 'o', window: { start: '2026-01-01', end: '2026-02-01' } };
  const a = L.linhaMesclaSpec(fresh, 'health', { state: 'atencao', note: 'x', by: 'u', at: 't' });
  assert.deepEqual(a.doneWhen, fresh.doneWhen); assert.equal(a.description, 'desc'); assert.deepEqual(a.window, fresh.window); assert.equal(a.health.state, 'atencao');
  const b = L.linhaMesclaSpec(fresh, 'window', null);
  assert.equal('window' in b, false); assert.equal(b.description, 'desc');
  assert.ok(fresh.window, 'não muta o spec lido');
  assert.deepEqual(L.linhaMesclaSpec(null, 'window', { start: 'a', end: 'b' }), { window: { start: 'a', end: 'b' } });
});

test('escala: meses visíveis (mín. 3, máx. 12) com hoje marcado', () => {
  const E0 = L.linhaEscala([], HOJE);
  assert.deepEqual(E0.meses.map((m) => m.label), ['out/26', 'nov', 'dez'], 'sem janelas: hoje + 2 meses');
  assert.ok(E0.hojePct > 0 && E0.hojePct < 34);
  const m = L.linhaModelo(ep({ spec: { window: { start: '2026-08-15', end: '2027-01-10' } } }), []);
  const E1 = L.linhaEscala([m], HOJE);
  assert.deepEqual(E1.meses.map((x) => x.label), ['ago/26', 'set', 'out', 'nov', 'dez', 'jan/27']);
  assert.equal(Math.round(E1.meses.reduce((s, x) => s + x.width, 0)), 100);
  const far = L.linhaModelo(ep({ spec: { window: { start: '2025-01-01', end: '2028-06-30' } } }), []);
  const E2 = L.linhaEscala([far], HOJE);
  assert.equal(E2.meses.length, 12, 'no máximo 12 meses');
  assert.equal(E2.meses[0].label, 'jul/26', 'corta a partir de 3 meses antes de hoje');
  assert.ok(E2.hojePct > 0 && E2.hojePct < 100);
  const h = L.linhaHtml([far], { hoje: HOJE });
  assert.match(h, /cut-l/); assert.match(h, /cut-r/); assert.match(h, /class="ln-today"/); assert.match(h, /class="ln-hoje"/);
});

test('entregue: losango na data de fim da janela (ou da última entrega); "sem data" com "definir janela" só pra quem pode', () => {
  const comJ = L.linhaModelo(ep({ status: 'done', spec: { window: { start: '2026-09-01', end: '2026-09-29' } } }), []);
  assert.equal(comJ.entregueEm.getDate(), 29);
  const semJ = L.linhaModelo(ep({ spec: { doneWhen: [{ id: 'D1', checkedBy: 'u', checkedAt: '2026-09-20T12:00:00Z' }, { id: 'D2', checkedBy: 'u', checkedAt: '2026-09-27T12:00:00Z' }] } }), []);
  assert.equal(semJ.entregue, true); assert.equal(semJ.entregueEm.getDate(), 27);
  const h = L.linhaHtml([semJ], { hoje: HOJE, podeEditar: () => true });
  assert.match(h, /class="ln-ms"/); assert.match(h, /entregue 27\/09/); assert.doesNotMatch(h, /data-lnwin/, 'entregue não ganha edição');
  const nd = L.linhaModelo(ep({ id: 'x' }), [tk('running')]);
  assert.match(L.linhaHtml([nd], { hoje: HOJE, podeEditar: () => true }), /<button class="ln-nodate" type="button" data-lnwin="x"[^>]*>sem data · definir janela/);
  const ro = L.linhaHtml([nd], { hoje: HOJE, podeEditar: () => false });
  assert.match(ro, /<span class="ln-nodate">sem data<\/span>/); assert.doesNotMatch(ro, /data-lnwin|data-lnhealth/);
});

test('> 20 épicos: entregues há mais de 60 dias recolhidos em "mostrar entregues (N)"', () => {
  const mods = [];
  for (let i = 0; i < 18; i++) mods.push(L.linhaModelo(ep({ id: 'a' + i, name: 'A' + i }), [tk('running')]));
  for (let i = 0; i < 4; i++) mods.push(L.linhaModelo(ep({ id: 'v' + i, status: 'done', spec: { window: { start: '2026-05-01', end: '2026-06-01' } } }), []));
  mods.push(L.linhaModelo(ep({ id: 'n', status: 'done', spec: { window: { start: '2026-09-01', end: '2026-09-30' } } }), []));
  const v = L.linhaVisiveis(mods, HOJE, false);
  assert.equal(v.ocultos, 4); assert.equal(v.vis.length, 19); assert.equal(v.recolhe, true);
  assert.equal(L.linhaVisiveis(mods, HOJE, true).vis.length, 23);
  assert.equal(L.linhaVisiveis(mods.slice(0, 20), HOJE, false).recolhe, false, 'até 20 não recolhe');
  assert.match(L.linhaHtml(mods, { hoje: HOJE }), /mostrar entregues \(4\)/);
});

test('HTML: escapa nomes e notas; sem branch/PR/worktree na Linha', () => {
  const m = L.linhaModelo(ep({ name: '<b>x</b>', spec: { window: { start: '2026-10-01', end: '2026-10-31' }, health: { state: 'atencao', note: '"falta" <acesso>', by: 'u1', at: '2026-10-05T10:00:00Z' } } }), [tk('running', { branch: 'feat/x', pr_url: 'https://github.com/o/r/pull/1' })]);
  const h = L.linhaHtml([m], { hoje: HOJE, quem: () => 'Douglas S.', projeto: () => 'logcomex-ai-v2' });
  assert.doesNotMatch(h, /<b>x<\/b>/); assert.match(h, /&lt;b&gt;x&lt;\/b&gt;/); assert.match(h, /&quot;falta&quot; &lt;acesso&gt;/);
  assert.match(h, /ln-bar h-atencao/); assert.match(h, /Douglas S\., 05\/10/); assert.match(h, /logcomex-ai-v2/);
  assert.doesNotMatch(h, /feat\/x|pull\/1|worktree|branch/i);
});

test('ganchos: aba Linha no Time, ativos pela regra única, seção Linha no Projeto, arquivos no index', () => {
  assert.match(times, /\['linha','Linha',''\]/);
  assert.match(times, /const epActive=e=>typeof epAtivo==='function'\?epAtivo\(e, epTs\(e\)\)/);
  assert.match(times, /const activeEps=teamEpics\.filter\(epActive\);/);
  assert.match(times, /window\._timeSum=\{ n:members\.length, eps:epA\.length/, 'cabeçalho, KPI e seletor = mesma conta');
  assert.match(times, /tmView==='linha'\)\{\n\s+\/\/[^\n]*\n\s+main=typeof linhaTimeHtml==='function'\?linhaTimeHtml\(\):'';/);
  assert.match(casca, /typeof epAtivo==='function'\?epAtivo\(e,/, 'fallback do cabeçalho usa a mesma regra');
  assert.match(casca, /if\(sub==='linha'\)\{/); assert.match(casca, /const lin=\$id\('projLinha'\); if\(lin\) lin\.hidden=sub!=='linha';/);
  assert.ok(html.indexOf('js/69-linha.js') > html.indexOf('js/68-casca-g1.js'));
  assert.match(html, /css\/99-linha\.css/);
  assert.doesNotMatch(linha, /setInterval|tickLoop/, 'sem polling novo');
});

test('lnTaskOk/epEntregue usam o epDelivered do app quando ele existe (não o fallback por status)', () => {
  const S = new Function('epDelivered', cut(linha, '// @puro-linha-inicio', '// @puro-linha-fim') + '\nreturn { epEntregue, linhaModelo };')((t) => t.status === 'review');
  assert.equal(S.epEntregue(ep({}), [tk('review'), tk('review')]), true, 'stub diz entregue pra review');
  assert.equal(S.epEntregue(ep({}), [tk('merged')]), false, 'stub diz não entregue pra merged');
  assert.equal(S.linhaModelo(ep({}), [tk('review'), tk('merged')]).rotulo, '1 de 2 tarefas');
  // doneWhen com item nulo: mesma lista no "entregue" e no modelo (antes: barra 100% num épico "ativo")
  const m = L.linhaModelo(ep({ spec: { doneWhen: [null, { id: 'D1', checkedBy: 'u' }] } }), []);
  assert.equal(m.pct, 100); assert.equal(m.entregue, true);
});

test('fora da faixa e entregue sem data: nada desenhado como se fosse data real', () => {
  const velho = L.linhaModelo(ep({ id: 'v', status: 'done', spec: { window: { start: '2025-01-01', end: '2025-02-01' } } }), []);
  const longe = L.linhaModelo(ep({ id: 'l', spec: { window: { start: '2027-09-01', end: '2027-10-01' } } }), []);
  const perto = L.linhaModelo(ep({ id: 'p', spec: { window: { start: '2026-10-01', end: '2027-08-01' } } }), []);
  const semData = L.linhaModelo(ep({ id: 's', status: 'done' }), []);
  const h = L.linhaHtml([velho, longe, perto, semData], { hoje: HOJE });
  assert.match(h, /class="ln-ms out"[^>]*title="entregue 01\/02, fora da faixa"/);
  assert.match(h, /class="ln-edge r"[^>]*>depois de /);
  assert.equal(semData.entregueEm, null);
  assert.match(h, /entregue · US\$/); assert.doesNotMatch(h, /entregue  ·/);
  assert.equal((h.match(/class="ln-ms/g) || []).length, 1, 'sem data: sem losango');
});

// gravação de verdade com a nuvem falsa
function salvarCom(o) {
  const calls = { get: 0, patch: [] , repaint: 0 };
  const teamEpics = [{ id: 'e1', name: 'E', spec: { doneWhen: [{ id: 'D1' }] }, updated_at: 't0' }];
  const fn = new Function('sbGet', 'sbFetch', 'teamEpics', 'linhaRepaint',
    cut(linha, 'function linhaMesclaSpec(', '// A regra ÚNICA') + cut(linha, "const LN_SUMIU=", '\n}\n') + '\n}\nreturn linhaSalvar;')(
    async (q) => { calls.get++; return o.get(calls.get, q); },
    async (url, opts) => { calls.patch.push({ url, body: JSON.parse(opts.body) }); return o.patch(calls.patch.length); },
    teamEpics, () => { calls.repaint++; });
  return { run: (k, v) => fn('e1', k, v), calls, teamEpics };
}
const FRESH = (ua, dwOk) => [{ id: 'e1', spec: { doneWhen: [{ id: 'D1', ...(dwOk ? { checkedBy: 'x' } : {}) }], description: 'd' }, updated_at: ua }];

test('linhaSalvar: mescla no spec fresco, PATCH com a pré-condição de updated_at e atualiza o teamEpics', async () => {
  const S = salvarCom({ get: () => FRESH('2026-10-06T10:00:00.1+00:00', true), patch: () => [{ id: 'e1', spec: { done: 1 }, updated_at: 't9' }] });
  await S.run('window', { start: '2026-10-01', end: '2026-11-01' });
  assert.equal(S.calls.patch.length, 1);
  const p = S.calls.patch[0];
  assert.match(p.url, /id=eq\.e1&updated_at=eq\.2026-10-06T10%3A00%3A00\.1%2B00%3A00$/);
  assert.deepEqual(p.body.spec.doneWhen, [{ id: 'D1', checkedBy: 'x' }], 'doneWhen do spec FRESCO');
  assert.equal(p.body.spec.description, 'd'); assert.equal('status' in p.body, false);
  assert.deepEqual(S.teamEpics[0].spec, { done: 1 }); assert.equal(S.teamEpics[0].updated_at, 't9'); assert.equal(S.calls.repaint, 1);
});
test('linhaSalvar: releitura falha → nenhum PATCH; 0 linhas com o mesmo updated_at → sem permissão', async () => {
  const A = salvarCom({ get: () => { throw new Error('Failed to fetch'); }, patch: () => [] });
  await assert.rejects(A.run('window', null), /Failed to fetch/); assert.equal(A.calls.patch.length, 0);
  const B = salvarCom({ get: () => FRESH('t1'), patch: () => [] });
  await assert.rejects(B.run('window', null), /permissão/); assert.equal(B.calls.patch.length, 1); assert.equal(B.calls.repaint, 0);
  const C = salvarCom({ get: (n) => (n === 1 ? FRESH('t1') : []), patch: () => [] });
  await assert.rejects(C.run('window', null), /não existe mais/);
});
test('linhaSalvar: updated_at mudou no meio → relê e refaz UMA vez (com o doneWhen novo); mudou de novo → "tente de novo"', async () => {
  const A = salvarCom({ get: (n) => FRESH(n === 1 ? 't1' : 't2', n > 1), patch: (n) => (n === 1 ? [] : [{ id: 'e1', spec: {}, updated_at: 't3' }]) });
  await A.run('health', { state: 'no_rumo', note: '', by: 'u', at: 'x' });
  assert.equal(A.calls.patch.length, 2);
  assert.match(A.calls.patch[1].url, /updated_at=eq\.t2$/); assert.equal(A.calls.patch[1].body.spec.doneWhen[0].checkedBy, 'x');
  const B = salvarCom({ get: (n) => FRESH('t' + n), patch: () => [] });
  await assert.rejects(B.run('window', null), /tente de novo/); assert.equal(B.calls.patch.length, 2);
});

test('folhas: data incompleta não apaga a janela; saúde sem avaliação começa sem escolha', () => {
  assert.match(linha, /if\(s===null \|\| e===null\) return 'Data inválida/); assert.match(linha, /if\(!s && !e && !j\) return 'Preencha o início e o fim\.'/);
  assert.match(linha, /let pick=h\?h\.state:null;/);
  assert.match(L.linhaSaudeErro(null, ''), /Escolha/);
});

test('tarefas todas entregues mas pronto quando sem prova: avisa "falta conferir" (não conta como entregue)', () => {
  const m = L.linhaModelo(ep({ spec: { doneWhen: dw(5, 0) } }), [tk('merged'), tk('done')]);
  assert.equal(m.entregue, false); assert.equal(m.faltaConferir, true);
  assert.match(L.linhaHtml([m], { hoje: HOJE }), /falta conferir o pronto quando/);
  assert.equal(L.linhaModelo(ep({ spec: { doneWhen: dw(5, 0) } }), [tk('merged'), tk('running')]).faltaConferir, false);
});

test('data digitada dd/mm/aaaa (campo de texto: o date do WebKit mostrava hoje num campo vazio)', () => {
  assert.equal(L.linhaDataBR('03/11/2026'), '2026-11-03');
  assert.equal(L.linhaDataBR('3/1/26'), '2026-01-03');
  assert.equal(L.linhaDataBR('2026-11-30'), '2026-11-30');
  assert.equal(L.linhaDataBR(''), '');
  assert.equal(L.linhaDataBR('31/02/2026'), null);
  assert.equal(L.linhaDataBR('03/11'), null);
  assert.equal(L.linhaDataTx('2026-11-03'), '03/11/2026');
});
