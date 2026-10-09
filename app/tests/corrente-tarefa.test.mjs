// Corrente no cabeçalho da tarefa + linha do tempo unificada (72 · mesa 09/10 D4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const T = new Function(cut(read('js/72-corrente-tarefa.js'), '// @puro-tcorrente-inicio', '// @puro-tcorrente-fim') + '\nreturn { tcActText, tcTimeline, tcReqs, tcPainelText, tcTimelineHtmlOf };')();
const NM = { eu: 'você', a: 'Ana Souza', b: 'Bruno Lima' };
const nm = (u) => NM[u] || 'pessoa sem nome';
const at = (h) => new Date(Date.UTC(2026, 9, 9, h)).toISOString();

test('linha do tempo: eventos do time em pt-BR com nomes (nunca id), em ordem, com a fonte', () => {
  const act = [
    { kind: 'delivered', user_id: 'b', body: 'PR aberto', at: at(14) },
    { kind: 'created', user_id: 'a', body: 'Cupom', at: at(10) },
    { kind: 'assigned', user_id: 'a', body: 'b', at: at(11) },
    { kind: 'claimed', user_id: 'b', at: at(12) },
    { kind: 'started', user_id: 'b', body: '', at: at(13) },
    { kind: 'status', user_id: 'b', body: 'FND-103 → “Em revisão” no painel', at: at(14.1) },
    { kind: 'released', user_id: 'eu', body: 'sem tempo', at: at(9) },
  ];
  const ev = T.tcTimeline({ act, nm });
  assert.deepEqual(ev.map((e) => e.text), ['Você devolveu — sem tempo · ficou livre', 'Ana Souza criou o cartão', 'Ana Souza atribuiu pra Bruno Lima', 'Bruno Lima assumiu', 'Bruno Lima iniciou', 'Bruno Lima abriu o PR', 'FND-103 → “Em revisão” no painel (pelo Starfork)']);
  assert.deepEqual([...new Set(ev.map((e) => e.src))], ['time', 'painel']);
  assert.ok(ev.every((e) => !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(e.text)));
});

test('tarefa desta máquina: "criada" e "integrada" locais só quando a nuvem não registrou; o painel não duplica', () => {
  const local = { createdAt: Date.UTC(2026, 9, 9, 8), finishedAt: Date.UTC(2026, 9, 9, 16), status: 'merged' };
  const sync = { code: 'FND-1', label: 'Feito', at: Date.UTC(2026, 9, 9, 16, 1) };
  const ev = T.tcTimeline({ act: [], local, sync, nm });
  assert.deepEqual(ev.map((e) => [e.text, e.src]), [['tarefa criada nesta máquina', 'starfork'], ['integrada (PR mergeado)', 'starfork'], ['FND-1 → “Feito” no painel (pelo Starfork)', 'painel']]);
  const ev2 = T.tcTimeline({ act: [{ kind: 'created', user_id: 'eu', at: at(8) }, { kind: 'status', user_id: 'eu', body: 'FND-1 → “Feito” no painel', at: new Date(sync.at + 30000).toISOString() }], local, sync, nm });
  assert.equal(ev2.filter((e) => /criad|criou/.test(e.text)).length, 1, 'não repete a criação');
  assert.equal(ev2.filter((e) => e.src === 'painel').length, 1, 'não repete o painel');
  assert.ok(ev2.some((e) => /integrada/.test(e.text)), 'a mudança no painel não esconde a integração');
});

test('requisitos x de y; cabeçalho e linha do tempo ligados na tarefa e na página do colega', () => {
  assert.deepEqual(T.tcReqs(['a', 'b', 'c'], [{ status: 'done' }, { status: 'todo' }, { status: 'done' }]), { ok: 2, tot: 3 });
  assert.equal(T.tcReqs([], []), null);
  const S = read('js/72-corrente-tarefa.js'), H = read('index.html');
  for (const s of ['veio de', 'vai pra', 'criada por', 'no painel', 'ainda sem PR', 'atualizado pelo Starfork', 'ver tudo']) assert.ok(S.includes(s), s);
  assert.ok(H.includes('id="fwChain"') && H.indexOf('js/72-corrente-tarefa.js') > H.indexOf('js/45-entrega-time.js'));
  assert.ok(read('js/20-workspace-tarefa.js').includes("if(typeof tcPaint==='function') tcPaint(t);"));
  assert.ok(read('js/27-entregas.js').includes('tcLocalTimelineSec(t)'));
  assert.ok(read('js/45-entrega-time.js').includes('tcHeaderHtml(ct,') && read('js/45-entrega-time.js').includes('tcCardTimelineHtml(ct, act)'));
});

test('textos de status, comentário e provas; o que não se conhece não vira inglês', () => {
  const t = (a) => T.tcActText(a, nm);
  assert.deepEqual(t({ kind: 'status', user_id: 'b', body: 'pronta pra revisar' }), { text: 'Bruno Lima — ficou “pronta pra revisar”', src: 'time' });
  assert.deepEqual(t({ kind: 'status', user_id: 'b', body: '' }), { text: 'Bruno Lima mudou a situação', src: 'time' });
  assert.equal(t({ kind: 'comment', user_id: 'a', body: 'olhei' }).text, 'Ana Souza comentou: olhei');
  assert.equal(t({ kind: 'delivered', user_id: 'b', body: '3 prints' }).text, 'Bruno Lima publicou provas');
  assert.equal(t({ kind: 'assigned', user_id: 'a', body: '' }).text, 'Ana Souza atribuiu o responsável');
  assert.equal(t({ kind: 'merged', user_id: 'a' }).text, 'Ana Souza registrou um evento');
});

test('"no painel": confirma só o que o Starfork pôs E o painel ainda mostra; falha diz o motivo', () => {
  const i = { status: 'rev' }, ago = () => 'há 2 min';
  assert.equal(T.tcPainelText('FND-1', i, 'Em revisão', { to: 'rev', at: 1 }, null, ago).text, 'FND-1 está “Em revisão” — atualizado pelo Starfork há 2 min');
  assert.equal(T.tcPainelText('FND-1', { status: 'doing' }, 'Fazendo', { to: 'rev', at: 1 }, null, ago).text, 'FND-1 está “Fazendo”', 'alguém mudou à mão depois: não diz que fomos nós');
  const e = T.tcPainelText('FND-1', i, 'x', null, { label: 'Feito', why: 'HTTP 503' }, ago);
  assert.equal(e.warn, true); assert.equal(e.text, 'FND-1 não foi pra “Feito”: HTTP 503');
  assert.equal(T.tcPainelText('FND-1', i, 'x', null, { label: 'Feito' }, ago).text, 'FND-1 não foi pra “Feito”: o painel recusou');
  assert.equal(T.tcPainelText('FND-1', null, 'x', null, null, ago), null);
});

test('linha do tempo na tela: as 8 MAIS RECENTES + "ver tudo (N)"; aberta mostra todas e oferece voltar', () => {
  const ev = Array.from({ length: 10 }, (_, k) => ({ at: Date.UTC(2026, 9, 1 + k), text: 'e' + k, src: 'time' }));
  const E = (x) => String(x), f = (ms) => String(ms);
  const h = T.tcTimelineHtmlOf(ev, false, 'l:x', E, f);
  assert.equal((h.match(/<li /g) || []).length, 8);
  assert.ok(h.includes('<span>e9</span>') && !h.includes('<span>e1</span>'), 'mostra as mais recentes');
  assert.match(h, /data-tcall="l:x" aria-expanded="false">ver tudo \(10\)/);
  const all = T.tcTimelineHtmlOf(ev, true, 'l:x', E, f);
  assert.equal((all.match(/<li /g) || []).length, 10); assert.match(all, /aria-expanded="true">ver só as 8 mais recentes/);
  assert.match(T.tcTimelineHtmlOf([], false, 'k', E, f), /sem eventos registrados/);
});
