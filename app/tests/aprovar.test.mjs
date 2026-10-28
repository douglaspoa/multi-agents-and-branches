// APROVAR numa ação + painel de provas + fila "Para aprovar" (80-aprovar, mock do épico aprovado em 15/10).
// `node --test app/tests/aprovar.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const JS = read('js/80-aprovar.js'), RV = read('js/63-revisao-pr.js'), HTML = read('index.html'), CSS = read('css/99-aprovar.css');
const P = new Function('esc', 'escA', cut(RV, '// @revpr-puro-inicio', '// @revpr-puro-fim') + cut(JS, '// @ap-puro-inicio', '// @ap-puro-fim')
  + '\nreturn { rvGatesOf, apMotivoOk, apDecide, apChips, apAoAprovar, apFrase, apPode, apOndaDepois, apSugestoes, apNav, conflitoPedido, conflitoAviso, conflitoComentario, apVerifBloqueio, apEncerrarPlano, apEncerrarAtividade, AP_UNDO_MS };')(esc, esc);

// portões como a aba PR monta (rvGatesOf), com o que muda em cada caso
const gates = (o = {}) => P.rvGatesOf({
  proof: { st: o.proof || 'proven', n: 4, missing: o.missing || 0 },
  acc: { n: 4, done: o.acc ?? 0 },
  rev: { has: true, rounds: o.rounds || [{ round: 1, verdict: 'aprova', items: [] }], override: !!o.override },
  pr: o.pr === false ? {} : { checksTotal: o.checks ?? 3, checksFail: o.fail || 0, checksPending: 0, mergeable: o.merge || 'MERGEABLE', base: 'main' },
});

test('aprovar: tudo verde → ok (o aceite não bloqueia: aprovar ACEITA os requisitos)', () => {
  const d = P.apDecide(gates({ acc: 0 }));
  assert.equal(d.kind, 'ok'); assert.deepEqual(d.precisa, []);
});
test('aprovar: conflito nunca passa, nem com motivo', () => {
  const d = P.apDecide(gates({ merge: 'CONFLICTING' }), { motivo: 'sei o que estou fazendo aqui' });
  assert.equal(d.kind, 'conflito');
});
test('aprovar: revisor pediu mudança → só com motivo (≥ 3 palavras); com motivo passa e diz o que vai pro registro', () => {
  const G = gates({ rounds: [{ round: 1, verdict: 'muda', items: ['a'] }, { round: 2, verdict: 'muda', items: ['x', 'y'] }] });
  assert.equal(P.apDecide(G).kind, 'motivo');
  assert.equal(P.apDecide(G, { motivo: 'ok' }).kind, 'motivo', 'uma palavra não explica');
  const d = P.apDecide(G, { motivo: 'os centavos viram a LOJA-35' });
  assert.equal(d.kind, 'ok'); assert.deepEqual(d.precisa, ['revisor']);
});
test('aprovar: requisito sem prova também pede motivo (o mesmo "aprovar sem prova…")', () => {
  const d = P.apDecide(gates({ proof: 'unproven', missing: 1 }));
  assert.equal(d.kind, 'motivo'); assert.deepEqual(d.precisa, ['prova']);
});
test('aprovar: checagens do GitHub falhando ou revisão que não rodou bloqueiam com o porquê', () => {
  const a = P.apDecide(gates({ fail: 1 }));
  assert.equal(a.kind, 'bloqueado'); assert.match(a.why, /checagens passarem/);
  const b = P.apDecide(gates({ rounds: [] }));
  assert.equal(b.kind, 'bloqueado'); assert.match(b.why, /revisão/);
  const c = P.apDecide(gates({ proof: 'loading' }));
  assert.equal(c.kind, 'bloqueado', 'provas ainda carregando não deixam aprovar');
});
test('aprovar: sem PR aberto ainda (o conflito sai dos portões) → aprovar abre o PR', () => {
  const G = gates({ pr: false }).filter((g) => g.id !== 'conflito');
  assert.equal(P.apDecide(G).kind, 'ok');
});
test('motivo: régua de 3 palavras com letra/número', () => {
  assert.equal(P.apMotivoOk(''), false); assert.equal(P.apMotivoOk('não sei'), false);
  assert.equal(P.apMotivoOk('vira tarefa separada'), true); assert.equal(P.apMotivoOk('- - - -'), false);
});
test('selos: sem o aceite, sem "não se aplica"; revisor com nome; conflito em português', () => {
  const c = P.apChips(gates({}), 'Nyx');
  assert.deepEqual(c.map((x) => x.tx), ['4/4 com prova', 'Nyx: aprovou', 'checagens: 3 de 3 passaram', 'sem conflito']);
  assert.ok(c.every((x) => x.st === 'ok'));
  const r = P.apChips(gates({ merge: 'CONFLICTING', rounds: [{ round: 2, verdict: 'muda', items: ['x'] }], checks: 0 }), 'Nyx');
  assert.deepEqual(r.map((x) => x.st + ':' + x.tx), ['ok:4/4 com prova', 'bad:Nyx: pediu mudança', 'bad:conflito com a main']);
});
test('"Ao aprovar": sem épico, com outras na onda (com nome), fechando a onda, última → verificação final', () => {
  assert.equal(P.apAoAprovar({ pr: 46 }).h, 'Integra o PR #46 na main. Não faz parte de épico.');
  assert.match(P.apAoAprovar({}).h, /^Abre o PR e integra na main/);
  const w = P.apAoAprovar({ pr: 48, epico: { onda: 1, mesmaOnda: [{ code: 'LOJA-21', quem: 'Carla', st: 'rodando' }], proxima: [], ultima: false } });
  assert.equal(w.c, 'w'); assert.match(w.h, /A onda 2 ainda espera <b>LOJA-21<\/b> \(Carla, rodando\)/);
  const f = P.apAoAprovar({ pr: 48, epico: { onda: 1, mesmaOnda: [], proxima: [{ code: 'LOJA-9', quem: 'Ana' }, { code: 'LOJA-15', quem: 'Bruno' }], ultima: false } });
  assert.match(f.h, /fecha a onda 1: <b>a onda 2 começa sozinha<\/b> \(LOJA-9 com Ana, LOJA-15 com Bruno\)/);
  const m = P.apAoAprovar({ pr: 48, epico: { onda: 1, mesmaOnda: [], proxima: [], ultima: false, auto: false } });
  assert.match(m.h, /fica liberada pra você começar/);
  const u = P.apAoAprovar({ pr: 60, epico: { onda: 3, mesmaOnda: [], proxima: [], ultima: true } });
  assert.match(u.h, /última tarefa: a <b>verificação final<\/b>/);
  const x = P.apAoAprovar({ pr: 1, epico: { onda: 1, mesmaOnda: [{ code: '<b>', quem: 'A&B' }], proxima: [] } });
  assert.ok(!x.h.includes('<b><b>') && x.h.includes('&lt;b&gt;') && x.h.includes('A&amp;B'), 'escapa nomes e códigos');
});
test('frase do que mudou: o que o agente fez → a última fala → o pedido; corta em ~220', () => {
  assert.equal(P.apFrase({ dids: ['aviso com a data do cupom vencido.', 'desconto sobre o total com frete'] }), 'Aviso com a data do cupom vencido; desconto sobre o total com frete.');
  assert.equal(P.apFrase({ dids: ['', null], msg: 'Corrigi o frete. Depois rodei os testes.' }), 'Corrigi o frete.');
  assert.equal(P.apFrase({ objetivo: 'Parcelar no cartão' }), 'Parcelar no cartão');
  assert.ok(P.apFrase({ dids: ['x '.repeat(300)] }).length <= 220);
});
test('quem aprova: quem pediu ou o líder; sem time, você', () => {
  assert.deepEqual(P.apPode({ temTime: false, me: 'eu' }), { pode: true, quem: '' });
  assert.deepEqual(P.apPode({ temTime: true, me: 'eu', pediu: 'eu' }), { pode: true, quem: '' });
  assert.deepEqual(P.apPode({ temTime: true, me: 'eu', pediu: 'carla', lider: true }), { pode: true, quem: 'carla' });
  assert.deepEqual(P.apPode({ temTime: true, me: 'eu', pediu: 'carla' }), { pode: false, quem: 'carla' });
});
test('onda depois de integrar: fecha só com TODAS integradas; última = épico inteiro integrado; cancelada fica fora', () => {
  const it = [{ id: 'a', wave: 1, b: 'pr' }, { id: 'b', wave: 1, b: 'ok' }, { id: 'c', wave: 2, b: 'queue' }, { id: 'x', wave: 1, b: 'off' }];
  assert.deepEqual(P.apOndaDepois(it, 1, 'a'), { fechou: true, ultima: false });
  assert.deepEqual(P.apOndaDepois([{ id: 'a', wave: 1, b: 'pr' }, { id: 'b', wave: 1, b: 'rev' }], 1, 'a'), { fechou: false, ultima: false }, 'concluir sem integrar não fecha');
  assert.deepEqual(P.apOndaDepois([{ id: 'a', wave: 2, b: 'pr' }, { id: 'b', wave: 1, b: 'ok' }], 2, 'a'), { fechou: true, ultima: true });
});
test('sugestões do pedir alteração vêm do revisor; J/K não dão a volta; desfazer = 4 s', () => {
  assert.deepEqual(P.apSugestoes([{ verdict: 'muda', items: ['a', 'b'] }]), ['a', 'b']);
  assert.equal(P.apSugestoes([]).length, 3);
  assert.equal(P.apNav(3, 2, 1), 2); assert.equal(P.apNav(3, 0, -1), 0); assert.equal(P.apNav(3, 1, 1), 2); assert.equal(P.apNav(0, 0, 1), 0);
  assert.equal(P.AP_UNDO_MS, 4000);
});

// ---- ligações (sem DOM): o que as outras frentes e telas usam
test('API exportada pra aba do épico: proofPanel, aprovarTarefa, pedirAlteracao + eventos da onda', () => {
  for (const k of ['window.proofPanel=proofPanel', 'window.aprovarTarefa=aprovarTarefa', 'window.pedirAlteracao=pedirAlteracao']) assert.ok(JS.includes(k), k);
  assert.match(JS, /new CustomEvent\('sf:epico-onda-fechada', \{ detail:\{ epicId:eid, wave:w \} \}\)/);
  assert.match(JS, /new CustomEvent\('sf:epico-ultima-integrada', \{ detail:\{ epicId:eid \} \}\)/);
  assert.match(JS, /function proofPanel\(taskId, mode\)\{\n  mode=\['full','compact','task'\]/);
});
test('não duplica regra: portões do rvGatesOf, PR pelo prCreateRun (a criação do "Preparando o PR"), merge pelo mergePrRun, motivo no checks_override_log', () => {
  assert.match(JS, /rvGatesOf\(\{/); assert.match(JS, /await prCreateRun\(t,/); assert.match(JS, /mergePrRun\(id\)/);
  assert.match(JS, /checks_override_log/); assert.match(JS, /proofOverride\(t, motivo\)/); assert.match(JS, /rqChangeText\(/); assert.match(JS, /fwSendText\(taskId, msg\)/);
  const PR = read('js/21-pull-request.js');
  assert.match(PR, /async function mergePrRun\(taskId\)\{ await invoke\('merge_pr',\{ taskId, method:'squash' \}\)/);
  assert.match(PR, /try\{ await mergePrRun\(taskId\); toast\('PR mergeado','ok'\)/, 'o merge com confirmação usa o mesmo caminho');
  assert.match(PR, /async function proofOverride\(t, motivo\)/);
});
test('4 s com Desfazer antes do merge; Z desfaz; teclas de uma letra não roubam campo nem terminal', () => {
  assert.match(JS, /setTimeout\(\(\)=>apIntegrar\(t\.id\), AP_UNDO_MS\)/);
  assert.match(JS, /k==='z' && AP\.pending/);
  assert.match(JS, /INPUT\|TEXTAREA\|SELECT/); assert.match(JS, /\.xterm/);
});
test('lateral, aba e página: "Para aprovar" em TRABALHO, com contador; aba (nunca modal); CSS ligado', () => {
  assert.match(HTML, /id="aprovarBtn"[^>]*>[\s\S]*?<span class="sbl">Para aprovar<\/span><span class="sbcnt q ap" id="aprovarCnt" hidden><\/span><\/button>/);
  assert.ok(HTML.indexOf('id="meuBtn"') < HTML.indexOf('id="aprovarBtn"') && HTML.indexOf('id="aprovarBtn"') < HTML.indexOf('id="semanaBtn"'), 'entre Meu trabalho e Semana');
  assert.match(HTML, /<div class="overlay fwoverlay pgov" id="aprovarOverlay" style="display:none"><div class="pgpage sempage" id="aprovarPage"><\/div><\/div>/);
  assert.match(HTML, /<script src="js\/80-aprovar\.js"><\/script>/); assert.match(HTML, /css\/99-aprovar\.css/);
  assert.match(JS, /VIEW_META\.aprovar=/); assert.match(JS, /VIEW_OVERLAY\.aprovar='aprovarOverlay'/);
  assert.match(CSS, /\.apv-acts\{[^}]*position:sticky;bottom:0/, 'Aprovar sempre visível no rodapé do painel');
});
test('Central: filtro "Para aprovar", a linha aberta é o painel compacto, A/P/J/K na linha', () => {
  const ct = read('js/66-central-tabela.js'), fl = read('js/22-quadro-fluxo.js');
  assert.match(fl, /\['aprovar','Para aprovar','var\(--info\)'\]/); assert.match(fl, /flowStatus==='aprovar'\?\(typeof apAprovavel==='function'&&apAprovavel\(t\)\)/);
  assert.match(ct, /if\(r\.aprovar && typeof proofPanel==='function'\) return `<tr class="ctexp ctexp-ap"/);
  assert.match(ct, /proofPanel\(r\.id, 'compact'\)/); assert.match(ct, /aprovarTarefa\(tr\.dataset\.ctrow\)/); assert.match(ct, /e\.key==='j'\|\|e\.key==='k'/);
});
test('Meu trabalho e Revisão ⌘3 usam o mesmo painel (compact / task) — a revisão por requisito continua a um clique', () => {
  const sem = read('js/76-casca-semana.js'), ws = read('js/20-workspace-tarefa.js'), te = read('js/77-tarefa-etapas.js');
  assert.match(sem, /apMeuEvento\(x, meta\(x, x\.mod\)\)/); assert.match(sem, /apMeuExpHtml\(e\.tid\)/);
  assert.match(JS, /l:prAberto\?'Integrar':'Aprovar', pri:true/); assert.match(JS, /'Esconder provas':'Ver provas'/); // PR já aberto (86-pr-real): o mesmo botão integra
  assert.match(ws, /rvViewOf\(t\.id\)==='provas'\) apRenderTask\(t, main\)/);
  assert.match(te, /data-v="provas"/); assert.match(te, />Por requisito</);
  assert.match(RV, /function rvViewOf\(taskId\)\{ const v=rvViewM\[taskId\]; return v==='diff'\?'diff':v==='req'\|\|typeof apRenderTask!=='function'\?'req':'provas'; \}/);
});
test('status num lugar só: os estados do painel moram no STATUS_META', () => {
  const u = read('js/00-util.js');
  for (const k of ["'para-aprovar':", 'integrando:', "'mudanca-pedida':"]) assert.ok(u.includes(k), k);
  assert.match(JS, /stBadge\(v\.st\)/);
});

test('resolver conflito: UM texto pra IA — fetch + merge da base, manter os dois lados, testes, push', () => {
  const m = P.conflitoPedido({ base: 'origin/main', branch: 'feat/carrinho' });
  assert.match(m, /^RESOLVER CONFLITO COM A BASE: a branch feat\/carrinho conflita com a main/);
  assert.match(m, /git fetch origin main e git merge origin\/main/);
  assert.match(m, /preservando a intenção dos dois lados/);
  assert.match(m, /Rode os testes/);
  assert.match(m, /commit e push/);
  assert.ok(!/git push origin HEAD:/.test(m), 'na própria worktree o push é o de sempre');
  const outro = P.conflitoPedido({ base: 'develop', branch: 'feat/x', pushTo: 'feat/x' });
  assert.match(outro, /git fetch origin feat\/x/); assert.match(outro, /git push origin HEAD:feat\/x/, 'assumir e resolver: push no MESMO PR');
  assert.match(P.conflitoPedido({}), /conflita com a main/, 'sem base: main');
  // a fonte é única: o "corrigir tudo" do PR (63) e o painel usam o mesmo conflitoPedido
  assert.match(RV, /conflitoPedido\(\{ base:info\.baseRefName/);
  assert.match(JS, /fwSendText\(taskId, conflitoPedido\(/);
});
test('resolver conflito: aviso diz "na fila" com a IA rodando e "reabri o terminal" com a sessão encerrada', () => {
  assert.match(P.conflitoAviso({ working: true, code: 'LOJA-12' }), /^Na fila: .* resolve o conflito da LOJA-12 no terminal/);
  assert.match(P.conflitoAviso({ reabriu: true, code: 'LOJA-12' }), /^Reabri o terminal da LOJA-12 e mandei/);
  assert.match(P.conflitoAviso({}), /^Mandei pro terminal da tarefa/);
  assert.match(P.conflitoComentario('origin/develop'), /^Pediu pra resolver o conflito com a develop/);
});
test('resolver conflito: todas as telas chamam resolverConflito (nada de resolve_conflict solto nem botão duplicado)', () => {
  const dir = new URL('../src/js/', import.meta.url);
  const files = ['20-workspace-tarefa.js', '21-pull-request.js', '22-quadro-fluxo.js', '27-entregas.js', '63-revisao-pr.js', '66-central-tabela.js', '71-central-alcance.js', '72-kanban.js', '76-casca-semana.js', '80-aprovar.js', '81-epico-aba.js'];
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.ok(!/invoke\('resolve_conflict'/.test(src), f + ': o caminho velho (sem push, sem terminal) saiu');
    assert.ok(!/Pedir à IA pra resolver/.test(src), f + ': rótulo único "Resolver conflito"');
  }
  assert.match(JS, /window\.resolverConflito=resolverConflito/);
  assert.match(read('js/20-workspace-tarefa.js'), /await resolverConflito\(taskId, btn\)/);
});

// ===== bug 28/10: "ao clicar em Aprovar ele me joga pra dentro da tarefa sem aprovar" + Encerrar sem entregar =====
test('aprovar: a verificação do projeto pendente/falhando vira motivo NA linha com a ação certa (nunca abre a tarefa)', () => {
  for (const st of ['none', 'pass', 'override']) assert.equal(P.apVerifBloqueio({ st }), null, st + ' segue');
  const n = P.apVerifBloqueio({ st: 'notrun' });
  assert.equal(n.kind, 'verif'); assert.deepEqual(n.acts, ['verif', 'chkwhy']); assert.match(n.why, /ainda não rodou/);
  assert.match(P.apVerifBloqueio({ st: 'stale' }).why, /mudou depois/);
  const f = P.apVerifBloqueio({ st: 'fail', bad: [{ label: 'testes' }, { label: 'lint' }] });
  assert.equal(f.kind, 'verif-falhou'); assert.match(f.why, /falhou \(testes, lint\)/); assert.deepEqual(f.acts, ['pedir', 'chkwhy', 'verif']);
  assert.deepEqual(P.apVerifBloqueio({ st: 'running' }).acts, ['retry']);
  // 28/10: exit 127 (bun não instalado) = "não rodou" — confirmação simples, sem motivo longo nem "pedir alteração"
  const nr = P.apVerifBloqueio({ st: 'missing', miss: [{ label: 'Linter', notFound: 'bun' }, { label: 'Testes', notFound: 'bun' }] });
  assert.equal(nr.kind, 'nao-rodou');
  assert.match(nr.why, /Linter, Testes não rodaram: bun não está instalado/);
  assert.deepEqual(nr.acts, ['naorodou', 'entrega']);
  assert.match(P.apVerifBloqueio({ st: 'err', err: 'worktree sumiu\nstack' }).why, /: worktree sumiu\.$/);
});
test('aprovar: sem PR NÃO passa mais pelo approveGate (que navega pra Entrega); abre o PR pelo prCreateRun, na linha', () => {
  const f = cut(JS, 'async function aprovarTarefa(', 'window.aprovarTarefa=aprovarTarefa;');
  assert.ok(!/approveGate\(/.test(f), 'approveGate leva pra dentro da tarefa quando a verificação não rodou');
  assert.ok(!/openWorkspace|approveShowEntrega|apAbrirTarefa/.test(f), 'Aprovar nunca navega sozinho');
  assert.match(f, /chkEnsure\(t, true\)/); assert.match(f, /apVerifBloqueio\(g\)/); assert.match(f, /prCreateRun\(t,/);
  assert.match(f, /chkOverride\(t, g\.st==='fail'\?g:\{ st:'notrun' \}, motivo\)/, 'aprovar mesmo assim com o motivo do campo, sem outra pergunta');
  const PR = read('js/21-pull-request.js');
  assert.match(PR, /async function prCreateRun\(t, base, step\)/);
  assert.match(cut(PR, 'async function prPrepFinish(', 'async function openPr('), /prCreateRun\(t, base, prepMark\)/, '"Preparando o PR" usa a mesma criação');
  assert.match(PR, /async function chkOverride\(t, g, motivo\)/);
  // o merge que falha também fica na linha
  assert.match(cut(JS, 'async function apIntegrar(', '// ----'), /apBloq\(t, \{ why:'O merge do PR falhou: '/);
});
test('aprovar: o Meu trabalho mostra o andamento e o bloqueio na própria linha (Desfazer, ações), e sai quando integra', () => {
  const f = cut(JS, 'function apMeuEvento(', 'window.apMeuEvento');
  assert.match(f, /data-apcd/); assert.match(f, /Desfazer \(Z\)/); assert.match(f, /Ainda não aprovei/); assert.match(f, /Encerrar…/);
  const S = read('js/76-casca-semana.js');
  assert.match(S, /a\.act\(b\)/); assert.match(S, /a\.q\?' quiet'/);
});
test('encerrar: o plano diz o que acontece (PR fecha e a branch fica, issue fecha ou link, cartão, 4 s)', () => {
  const L = P.apEncerrarPlano({ pr: 12, issue: 'LOJA-12', painel: 'fecha', time: true, rodando: true }).join('\n');
  assert.match(L, /Para a IA/); assert.match(L, /Fecha o PR #12 .*a branch fica/); assert.match(L, /Fecha a issue LOJA-12 no painel/);
  assert.match(L, /cartão do time/); assert.match(L, /desfazer em 4 s \(Z\)/); assert.match(L, /não segura a onda/);
  const M = P.apEncerrarPlano({ issue: 'LOJA-12', painel: 'manual' }).join('\n');
  assert.match(M, /fica aberta/); assert.ok(!/PR #/.test(M) && !/Para a IA/.test(M));
  assert.equal(P.apEncerrarAtividade('  o cliente   desistiu '), 'Encerrou: o cliente desistiu');
  assert.equal(P.apEncerrarAtividade(''), 'Encerrou sem entregar.');
});
test('encerrar: usa o status que o app já tem (cancelled + flag closed), close_pr sem apagar a branch e o conector de Issues', () => {
  const f = cut(JS, 'async function apEncerrarRun(', 'apRefresh();\n}');
  assert.match(f, /mark_task_status',\{ taskId:id, status:'cancelled' \}/); assert.match(f, /set_task_flag',\{ taskId:id, flag:'closed' \}/);
  assert.match(f, /invoke\('close_pr'/); assert.match(f, /trkCloseIssue\(ctx\.issue, p\.motivo\)/); assert.match(f, /task_activity/);
  assert.match(JS, /if\(AP\.pending && AP\.pending\.id===t\.id && AP\.pending\.kind!=='enc'\) return true;/, 'encerrando não prende a tarefa na fila');
  // em todo lugar: painel de provas (fila, Central, épico, Revisão), Meu trabalho e o ⋯ da tarefa
  assert.match(JS, /data-ap="encerrar"/); assert.match(JS, /if\(k==='encerrar'\) return void encerrarTarefa/);
  assert.match(read('js/22-quadro-fluxo.js'), /item\('encerrar sem entregar…', \(\)=>encerrarTarefa\(taskId/);
  const RS = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(RS, /fn close_pr\(/); assert.match(RS, /"pr", "close", &branch\]/); assert.ok(!/fn close_pr[\s\S]{0,600}--delete-branch/.test(RS));
  assert.match(RS, /\n\s+close_pr,\n/);
});
