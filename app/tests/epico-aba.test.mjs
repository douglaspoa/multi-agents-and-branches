// A ABA DO ÉPICO redesenhada (mock aprovado 15/10 — epico-fluxo.md): frase "agora", metrô das ondas, colunas por
// onda com o porquê da espera COM NOME, as 3 chaves do fluxo (spec.flow), verificação final e "Entregar o épico".
// Funções puras recortadas de 81-epico-aba.js (@ep-aba-puro-*) e 46-epico-time.js (@ep-iniciar-puro-*) + ganchos.
// `node --test app/tests/epico-aba.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };

const ep46 = read('js/46-epico-time.js'), aba = read('js/81-epico-aba.js');
const F = new Function(cut(ep46, '// @ep-iniciar-puro-inicio', '// @ep-iniciar-puro-fim') + '\nreturn { epFlowOf, epStrictOk, epWaveOpenStrict, epWaveReleased, epWaveOpen };')();
const A = new Function(cut(aba, '// @ep-aba-puro-inicio', '// @ep-aba-puro-fim') + '\nreturn { epaKind, epaKey, epaWaitTx, epaStuckTx, epaModel, epaRelatorioTx };')();

// o épico fictício "Checkout novo" da loja: 6 tarefas em 3 ondas
const it = (id, code, wave, who, o) => ({ id, cloud: id, code, title: 'tarefa ' + code, wave, after: [], st: 'backlog', flag: null, pr: false, who, whoName: who, reqOk: 0, reqTot: 3, ...o });
const epico = (o) => {
  const L = [
    it('c12', 'LOJA-12', 1, 'eu', { whoName: 'você' }), it('c21', 'LOJA-21', 1, 'carla', { whoName: 'Carla' }),
    it('c9', 'LOJA-9', 2, 'ana', { after: ['c12'], whoName: 'Ana' }), it('c15', 'LOJA-15', 2, 'bruno', { after: ['c21'], whoName: 'Bruno' }), it('c26', 'LOJA-26', 2, 'diego', { after: ['c12'], whoName: 'Diego' }),
    it('c34', 'LOJA-34', 3, 'elisa', { after: ['c9', 'c15', 'c26'], whoName: 'Elisa' }),
  ];
  for (const [k, v] of Object.entries(o || {})) Object.assign(L.find((x) => x.id === k), v);
  return L;
};
const DW = [{ id: 'D1', text: 'Pix ou cartão' }, { id: 'D2', text: 'cupom' }];
const flow = (o) => ({ strict: true, auto: true, released: 1, ...o });
const card = (M, id) => M.cards.find((x) => x.id === id);

test('as 3 chaves do épico: padrões do dono (onda inteira e começar sozinho ligados, aprovar plano desligado)', () => {
  assert.deepEqual(F.epFlowOf(null), { strict: true, auto: true, plan: false, released: 1, set: false });
  assert.deepEqual(F.epFlowOf({ flow: { strict: false, auto: false, plan: true, released: '2' } }), { strict: false, auto: false, plan: true, released: 2, set: true });
  assert.equal(F.epWaveReleased(F.epFlowOf({ flow: { auto: false } }), 2), false, 'sem "sozinho" a onda 2 espera o clique');
  assert.equal(F.epWaveReleased(F.epFlowOf({ flow: { auto: false, released: 2 } }), 2), true);
  assert.equal(F.epWaveReleased(F.epFlowOf({}), 5), true);
});

test('regra da onda inteira: só integrada libera — concluída com PR aberto e cancelada seguram; concluída sem PR libera', () => {
  assert.equal(F.epStrictOk({ st: 'merged', b: 'ok' }), true);
  assert.equal(F.epStrictOk({ st: 'closed', b: 'pr' }), false, 'concluir sem integrar não libera');
  assert.equal(F.epStrictOk({ st: 'cancelled', b: 'ok' }), false, 'cancelar não libera');
  assert.equal(F.epStrictOk({ st: 'closed', b: 'ok' }), true, 'sem nada pra integrar (pesquisa, doc)');
  const L = [{ wave: 1, st: 'merged', b: 'ok' }, { wave: 1, st: 'cancelled', b: 'off' }, { wave: 2, st: 'running', b: 'run' }];
  assert.equal(F.epWaveOpenStrict(L, 2), 1, 'onda inteira: a cancelada segura');
  assert.equal(F.epWaveOpen(L, 2), 0, 'desligado (#166): a cancelada não segura');
});

test('o tick das ondas usa o portão do fluxo (nuvem e rascunho local) e a fila lê o spec do épico', () => {
  assert.match(ep46, /const due=t=>ctArmed\(t\) && !epStartBusy\.has\(t\.epic_id\) && !epDepsLeft\(t\)\.length && epGateOk\(t\.epic_id, epqWave\(t\), \(t\.spec\|\|\{\}\)\.after\);/);
  const gate = cut(ep46, 'function epGateOk(', '\n}\n');
  assert.match(gate, /if\(!epWaveReleased\(f, wave\)\) return false;/);
  assert.match(gate, /if\(!f\.strict && \(after\|\|\[\]\)\.length\) return true;/, 'desligado: vale só o after (#166)');
  assert.match(cut(ep46, 'function epWaveLeft(', '\n}\n'), /if\(epFlowFor\(eid\)\.strict\) return epWaveOpenStrict\(epqEpicTasks\(eid, true\), wave\);/);
  const loc = cut(ep46, 'async function epAutoLocalTick(){', '\n}\n');
  assert.ok(loc.indexOf('epWaveReleased(epFlowFor') > 0 && loc.indexOf('epWaveReleased(epFlowFor') < loc.indexOf('await startTask(id)'));
  assert.match(ep46, /sbGet\('epics\?select=id,name,spec&id=in\./);
  assert.match(ep46, /flowOf:Object\.fromEntries\(eps\.map\(e=>\[e\.id,e\.spec\|\|\{\}\]\)\)/);
  assert.match(read('js/43-espaco-times.js'), /epFlowFor\(ct\.epic_id\)\.plan\) payload\.planApproval='review';/, 'chave "eu aprovo o plano"');
});

test('fluxo novo: conferido não é entregue — o épico fecha só no "Entregar o épico"', () => {
  assert.match(ep46, /if\(all && !spec\.flow\) body\.status='done';/, 'espelho do revisor');
  assert.match(ep46, /const all=!spec\.flow && dw\.length>0/, 'marcação à mão');
  const ln = read('js/69-linha.js');
  const epEntregue = new Function('lnTaskAtiva', 'lnTaskOk', cut(ln, 'function epEntregue(', '\n}\n') + '\n}\nreturn epEntregue;')(() => false, () => true);
  const ep = { status: 'in-progress', spec: { flow: { strict: true }, doneWhen: [{ id: 'D1', checkedBy: 'agent:x' }] } };
  assert.equal(epEntregue(ep, [{}]), false);
  assert.equal(epEntregue({ ...ep, spec: { ...ep.spec, delivery: { at: 'x' } } }, [{}]), true);
  assert.equal(epEntregue({ status: 'open', spec: { doneWhen: [{ id: 'D1', checkedBy: 'u' }] } }, [{}]), true, 'épico antigo: regra de sempre');
});

test('cada tarefa numa palavra (a partir do status efetivo) e o selo do STATUS_META', () => {
  assert.equal(A.epaKind({ st: 'merged' }), 'done');
  assert.equal(A.epaKind({ st: 'review', flag: 'closed', pr: true }), 'ready', 'concluída com PR aberto: falta aprovar/integrar');
  assert.equal(A.epaKind({ st: 'review', flag: 'closed', pr: false }), 'done');
  assert.equal(A.epaKind({ st: 'pr-open', pr: true }), 'ready');
  assert.equal(A.epaKind({ st: 'conflict' }), 'stuck');
  assert.equal(A.epaKind({ st: 'running', flag: 'blocked' }), 'stuck');
  assert.equal(A.epaKind({ st: 'running', pr: true }), 'run', 'rodando com PR aberto ainda é IA trabalhando');
  assert.equal(A.epaKind({ st: 'cancelled' }), 'off');
  assert.equal(A.epaKind({ st: 'backlog' }), 'queue');
  assert.equal(A.epaKey({ st: 'pr-open' }, 'ready'), 'review');
  assert.equal(A.epaKey({ st: 'backlog' }, 'queue', true, true), 'waiting');
  assert.equal(A.epaKey({ st: 'backlog' }, 'queue', false, false), null, 'no plano não tem selo');
});

test('plano: "Pronto para começar" com Começar a onda 1 (⌘↵), cartões dizem a ordem sem selo', () => {
  const M = A.epaModel({ items: epico(), flow: flow(), dw: DW, apr: 'você', meApr: true });
  assert.equal(M.phase, 'plano');
  assert.equal(M.agora.s, 'Pronto para começar: 6 tarefas em 3 ondas, com 6 pessoas.');
  assert.deepEqual(M.agora.act && [M.agora.act.k, M.agora.act.label, M.agora.act.kbd], ['start', 'Começar a onda 1', '⌘↵']);
  assert.equal(card(M, 'c12').why, 'roda logo no começo');
  assert.equal(card(M, 'c34').why, 'depois de LOJA-9, LOJA-15, LOJA-26');
  assert.equal(card(M, 'c9').key, null);
  assert.deepEqual(M.metro.map((s) => s.lab), ['Onda 1', 'Onda 2', 'Onda 3', 'Verificação final', 'Entregue']);
  assert.equal(M.waves[0].head, '2 tarefas rodam juntas');
  assert.equal(M.finalHead, 'IA confere o “Pronto quando” no fim');
});

test('onda 2 esperando: a frase diz QUEM aprova e o quê; os cartões dizem quem segura, com nome', () => {
  const L = epico({ c12: { st: 'review', pr: true, reqOk: 4, reqTot: 4 }, c21: { st: 'merged' } });
  const M = A.epaModel({ items: L, flow: flow(), dw: DW, apr: 'você', meApr: true });
  assert.equal(M.phase, 'aprovar');
  assert.equal(M.agora.s, 'A onda 2 está esperando você aprovar LOJA-12.');
  assert.equal(M.agora.act.k, 'aprovar');
  assert.equal(card(M, 'c12').why, 'provas prontas · falta você');
  assert.equal(card(M, 'c15').why, 'espera você aprovar LOJA-12', 'onda inteira: LOJA-15 só depende da 21, mas espera a onda 1 inteira');
  assert.equal(card(M, 'c15').key, 'waiting');
  assert.equal(M.waves[1].head, 'espera a onda 1 inteira: 1 de 2 faltando');
  assert.equal(M.metro[0].sub, 'esperando você aprovar');
  // quem não aprova vê o nome de quem aprova, sem o botão
  const N = A.epaModel({ items: L, flow: flow(), dw: DW, apr: 'Carla', aprNome: 'Carla', meApr: false });
  assert.equal(N.agora.s, 'A onda 2 está esperando Carla aprovar LOJA-12.');
  assert.equal(N.agora.act, null);
  // chave desligada (#166): LOJA-15 depende só da 21 (integrada) — já pode começar
  const D = A.epaModel({ items: L, flow: flow({ strict: false }), dw: DW, apr: 'você', meApr: true });
  assert.equal(card(D, 'c15').lock, false);
  assert.equal(card(D, 'c9').why, 'espera você aprovar LOJA-12');
});

test('esperas e erros: a frase "agora" fica vermelha e cada parada diz o que é, com nome', () => {
  const L = epico({ c12: { st: 'merged' }, c21: { st: 'merged' }, c9: { st: 'needs-you', nyKind: 'rodadas' }, c15: { st: 'running', flag: 'blocked' }, c26: { st: 'conflict' } });
  const M = A.epaModel({ items: L, flow: flow(), dw: DW, apr: 'você', meApr: true });
  assert.equal(M.phase, 'parado');
  assert.equal(M.agora.tone, 'bad');
  assert.equal(M.agora.s, '3 coisas paradas na onda 2. A onda 3 não começa até as 3 se resolverem.');
  assert.equal(M.agora.m, 'o revisor pediu mudança na LOJA-9 · LOJA-15 travou (Bruno) · LOJA-26 tem conflito');
  assert.equal(card(M, 'c34').why, 'espera LOJA-9 destravar (Ana) e mais 2');
  assert.equal(M.waves[1].state, 'problema');
});

test('"começar a próxima onda sozinho" desligado: a onda pronta espera o clique de quem aprova', () => {
  const L = epico({ c12: { st: 'merged' }, c21: { st: 'merged' } });
  const M = A.epaModel({ items: L, flow: flow({ auto: false, released: 1 }), dw: DW, apr: 'você', meApr: true, begun: true });
  assert.equal(M.phase, 'liberar');
  assert.deepEqual([M.agora.act.k, M.agora.act.label, M.agora.act.wave], ['liberar', 'Começar a onda 2', 2]);
  assert.equal(card(M, 'c9').why, 'pronta · espera você começar a onda 2');
  assert.equal(A.epaModel({ items: L, flow: flow({ auto: false, released: 2 }), dw: DW, apr: 'você', meApr: true, begun: true }).phase, 'rodando');
});

test('fim: todas integradas → verificação final → entregar (⌘↵) → entregue', () => {
  const all = epico(Object.fromEntries(['c12', 'c21', 'c9', 'c15', 'c26', 'c34'].map((k) => [k, { st: 'merged' }])));
  const V = A.epaModel({ items: all, flow: flow(), dw: DW, apr: 'você', meApr: true });
  assert.equal(V.phase, 'verificar');
  assert.equal(V.agora.act.k, 'verificar');
  const R = A.epaModel({ items: all, flow: flow(), dw: DW, apr: 'você', meApr: true, final: { state: 'running' } });
  assert.equal(R.agora.act, null, 'rodando: nada pra apertar');
  assert.equal(R.metro[3].sub, 'conferindo');
  const ok = DW.map((d) => ({ ...d, checkedBy: 'agent:t' }));
  const E = A.epaModel({ items: all, flow: flow(), dw: ok, apr: 'você', meApr: true, req: 'Carla' });
  assert.equal(E.phase, 'entregar');
  assert.equal(E.agora.s, 'Tudo aprovado e o “Pronto quando” foi conferido: 2 de 2. Falta você entregar.');
  assert.equal(E.agora.m, 'Entregar fecha o épico, gera o relatório e avisa Carla, que pediu. Todo o código já está na main.');
  assert.deepEqual([E.agora.act.k, E.agora.act.kbd], ['entregar', '⌘↵']);
  assert.equal(E.metro[4].sub, 'falta você entregar');
  const X = A.epaModel({ items: all, flow: flow(), dw: ok, apr: 'você', meApr: true, req: 'Carla', delivered: { quando: 'hoje às 17:42', prs: 6 } });
  assert.equal(X.phase, 'entregue');
  assert.equal(X.agora.s, 'Entregue hoje às 17:42. Carla recebeu o aviso com o relatório.');
  assert.equal(X.metro[4].cls, 'done');
  // épico sem "pronto quando": integrou tudo → entregar direto
  assert.equal(A.epaModel({ items: all, flow: flow(), dw: [], apr: 'você', meApr: true }).phase, 'entregar');
});

test('relatório curto do épico (texto puro, pronto pra colar)', () => {
  const t = A.epaRelatorioTx({ nome: 'Checkout novo', req: 'Carla Dias', apr: 'Douglas', quando: '15/10 17:42', itens: [{ code: 'LOJA-12', title: 'Cupom', who: 'Ana', pr: '41' }, { code: '', title: 'Doc', who: '', pr: '' }], dw: [{ id: 'D1', text: 'Pix', evidence: 'e2e pix' }] });
  assert.match(t, /^Épico entregue: Checkout novo · 15\/10 17:42\nPedido por Carla Dias · aprovado por Douglas · 2 tarefas, 1 PR integrado na main\./);
  assert.match(t, /• D1: Pix — prova: e2e pix/);
  assert.match(t, /• LOJA-12 · Cupom — Ana \(PR #41\)/);
});

test('ganchos: aba no 46, verificação final, entregar, Entregas, Central › Épicos e a carga', () => {
  assert.match(ep46, /if\(typeof epAbaRender==='function' && epAbaRender\(main, ep, c, tasks, locOnly\)\) return;/);
  assert.match(aba, /window\.addEventListener\('sf:epico-ultima-integrada', epFinalOnEvent\);/);
  assert.match(aba, /tickLoop\('epFinal'/);
  assert.match(aba, /autoPr:'no'/, 'a verificação final não abre PR');
  assert.match(aba, /epicDoneWhen:dw\.map/, 'o revisor marca com check_done_when (precisa do "pronto quando" no TASK)');
  assert.match(aba, /typeof window\.proofPanel==='function'/, 'painel de provas da outra frente quando existir');
  assert.match(aba, /relGerar\(btn, \{ all:cards, f:\{ epic:ep\.id \}/, 'relatório completo = o de Entregas recortado no épico');
  assert.match(ep46, /function epIsFinalTask\(t, eid\)/, 'a verificação final fica fora das ondas');
  assert.match(read('js/76-casca-semana.js'), /typeof epEntregaDiaHtml==='function'\?epEntregaDiaHtml\(k\)/);
  assert.match(read('js/76-casca-semana.js'), /dispatchEvent\(new CustomEvent\('sf:responsavel-mudou'\)\)/);
  assert.match(read('js/71-central-alcance.js'), /typeof epBarraHtml==='function'&&epBarraHtml\(e, ts\)/);
  const html = read('index.html');
  assert.ok(html.indexOf('js/81-epico-aba.js') > html.indexOf('js/76-casca-semana.js'));
  assert.match(html, /css\/99-epico-aba\.css/);
  // nada só por mouse: ⌘↵ = ação do momento; letras soltas fora de campo de texto e do terminal
  assert.match(aba, /if\(e\.key==='Enter' && \(e\.metaKey\|\|e\.ctrlKey\)\)/);
  assert.match(aba, /tg\.closest\('\.xterm'\)/);
});
