// TERMINAL NO LUGAR DA CONVERSA (spec-terminal-sempre): histórico da sessão pintado no xterm (60-terminal.js, trecho
// puro @term-hist-puro), quem ganha a aba Terminal e o compositor-cartão da página Ideia.
// `node --test app/tests/terminal-sempre.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const SRC = read('js/60-terminal.js');
const TH = new Function(cut(SRC, '// @term-hist-puro-inicio', '// @term-hist-puro-fim') +
  '\nreturn { thClean, thItemLines, thFromEvents, thSysNotes, thRender, thWrap, thSysText };')();
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('transcript → gramática do mock: > você · ● fala · ⎿ ferramenta · ● Update(arq) +N −M', () => {
  const items = [
    { k: 'you', ts: 1000, text: 'a aluna não consegue remarcar' },
    { k: 'say', ts: 2000, text: 'Vou ler a **agenda**.' },
    { k: 'tool', ts: 2100, name: 'Read', arg: 'src/pages/Agenda.tsx', lines: 212, done: true },
    { k: 'edit', ts: 2200, name: 'Update', arg: 'src/pages/Agenda.tsx', add: 18, del: 3 },
    { k: 'tool', ts: 2300, name: 'Bash', arg: 'npm test -- agenda', err: true, out: 'FAIL agenda.test' },
    { k: 'ask', ts: 2400, text: 'Cheia?', done: true, out: 'User has answered your questions: "Cheia?"="Só livres"' },
  ];
  const out = plain(TH.thRender(items, { head: 'claude · sessão e3f63ca1', foot: 'fim do histórico' }));
  const L = out.split('\r\n');
  assert.equal(L[0], '╭─ claude · sessão e3f63ca1');
  assert.ok(L.includes('> a aluna não consegue remarcar'));
  assert.ok(L.includes('● Vou ler a agenda.'), 'markdown vira negrito, não asteriscos');
  assert.ok(L.includes('  ⎿ Read src/pages/Agenda.tsx (212 linhas)'));
  assert.ok(L.includes('● Update(src/pages/Agenda.tsx)  +18 −3'));
  assert.ok(L.includes('  ⎿ Bash npm test -- agenda  ✗ FAIL agenda.test'));
  assert.ok(L.includes('? Cheia?') && L.some((l) => /^ {2}✓ respondido: "Cheia\?"="Só livres"/.test(l)));
  assert.equal(L[L.length - 2], '╰─ fim do histórico');
  // ferramenta fica colada na fala (sem linha em branco antes do ⎿)
  const i = L.indexOf('  ⎿ Read src/pages/Agenda.tsx (212 linhas)');
  assert.notEqual(L[i - 1], '');
});

test('nada do transcript vira sequência de controle; fala longa é cortada', () => {
  const evil = TH.thItemLines({ k: 'say', text: 'oi\x1b]0;titulo\x07\x1b[2J fim' }).join('');
  assert.ok(!/\x1b\]|\x1b\[2J|\x07/.test(evil), JSON.stringify(evil));
  const long = TH.thItemLines({ k: 'you', text: Array.from({ length: 20 }, (_, i) => 'linha ' + i).join('\n') });
  assert.equal(long.length, 7, '6 linhas + "… +14 linhas"');
  assert.match(plain(long[6]), /… \+14 linhas/);
});

test('notas do Starfork entram no meio do transcript pelo horário (PR aberto, fila)', () => {
  const evs = [
    { id: 1, agent: 'Sistema', type: 'note', text: 'Na fila (1º): o terminal está no meio de um turno', ts: 1500 },
    { id: 2, agent: 'Íris', type: 'note', text: 'PR aberto: https://x/pull/3', ts: 2500 },
    { id: 3, agent: 'Íris', type: 'done', text: 'pronto', ts: 2600 },
  ];
  const notes = TH.thSysNotes(evs);
  assert.deepEqual(notes.map((n) => n.text), ['Na fila (1º): o terminal está no meio de um turno', 'PR aberto: https://x/pull/3']);
  const L = plain(TH.thRender([{ k: 'you', ts: 1000, text: 'a' }, { k: 'say', ts: 2000, text: 'b' }], { notes })).split('\r\n').filter(Boolean);
  assert.deepEqual(L, ['> a', '▸ Na fila (1º): o terminal está no meio de um turno', '● b', '▸ PR aberto: https://x/pull/3']);
});

test('sem transcript: os eventos do state.sqlite na mesma gramática', () => {
  const it = TH.thFromEvents([
    { agent: 'Você', type: 'note', text: 'Você: muda a cor', ts: '2026-10-02T05:10:42.206Z' },
    { agent: 'Íris', type: 'read', text: 'src/a.ts', ts: 1 },
    { agent: 'Íris', type: 'edit', text: 'src/a.ts', ts: 2 },
    { agent: 'Íris', type: 'bash', text: 'npm test', ts: 3 },
    { agent: 'Íris', type: 'done', text: 'feito', ts: 4 },
    { agent: 'Sistema', type: 'status', text: 'terminal fechado', ts: 5 },
    { agent: 'Íris', type: 'error', text: 'quebrou', ts: 6 },
    { agent: 'Íris', type: 'papel', text: 'skills ativas', ts: 7 },
  ]);
  assert.deepEqual(it.map((x) => x.k), ['you', 'tool', 'edit', 'tool', 'say', 'note', 'err']);
  assert.equal(it[0].ts, 1790917842206);
  assert.equal(it[0].text, 'muda a cor');
  assert.match(plain(TH.thRender(it, {})), /\(a sessão|● feito/);
  assert.match(plain(TH.thRender([], {})), /a sessão ainda não tem nada registrado/);
});

test('quem ganha a aba Terminal: toda tarefa Claude Code (não rascunho); DeepSeek/gateway/Codex headless ficam na Conversa', () => {
  const body = cut(SRC, 'function termModeOf(t)', 'function termSlotHtml');
  const state = { remote: false };
  const aiEngineOf = (e) => { const n = String(e || '').toLowerCase(); return !n ? 'mock' : n.startsWith('codex') ? 'codex' : n.startsWith('deepseek') ? 'deepseek' : n.startsWith('gateway') ? 'gateway' : 'claude'; };
  const f = new Function('state', 'aiEngineOf', body + '\nreturn termViewOf;')(state, aiEngineOf);
  assert.equal(f({ engine: 'claude', status: 'merged', spec: {} }), true, 'concluída antiga headless');
  assert.equal(f({ engine: 'claude', status: 'review', spec: {} }), true);
  assert.equal(f({ engine: 'claude', status: 'draft', spec: {} }), false, 'rascunho ainda não rodou');
  assert.equal(f({ engine: 'deepseek', status: 'review', spec: {} }), false);
  assert.equal(f({ engine: 'gateway', status: 'review', spec: {} }), false);
  assert.equal(f({ engine: 'codex', status: 'review', spec: {} }), false, 'Codex headless');
  assert.equal(f({ engine: 'codex', status: 'review', spec: { termMode: 'terminal' } }), true, 'Codex no terminal');
  state.remote = true;
  assert.equal(f({ engine: 'claude', status: 'review', spec: {} }), true, 'repo com remote no GitHub (state.remote) continua com Terminal');
});

test('a UI usa termViewOf (não o termMode cru) onde a Conversa virava Terminal', () => {
  for (const f of ['js/20-workspace-tarefa.js', 'js/27-entregas.js', 'js/24-perguntas-agente.js', 'js/57-navegador.js']) {
    const s = read(f);
    assert.ok(s.includes('termViewOf'), f);
    assert.ok(!/termModeOf\(t\)/.test(s), f + ' ainda decide a aba pelo termMode');
  }
  const ws = read('js/20-workspace-tarefa.js');
  assert.match(ws, /termWtGone\(t\.id\)/, 'mergeada sem worktree não manda nada');
  assert.match(ws, /termGoLive\(t\.id\)/, 'depois de mandar, o xterm vira o vivo');
  assert.match(ws, /termHistTick\(t\)/, 'histórico acompanha a sessão em segundo plano');
});

test('Ideia: compositor único em cartão, na mesma coluna do texto', () => {
  assert.match(read('js/59-ideia.js'), /chatComposerHtml\(\{ input:'ideiaNewIn'[^)]*cls:'card'/);
  const css = read('css/81-chat.css');
  const fw = css.match(/\.cc\.cc\.card:focus-within\s*\{([^}]*)\}/)[1];
  assert.match(fw, /outline: 2px solid var\(--accent\)/, 'o foco padrão do .in:focus');
  assert.match(fw, /border-color: transparent/, 'a borda some: UM contorno só');
  assert.ok(!/box-shadow/.test(fw), 'sem o anel duplo');
  assert.match(css, /\.cc\.cc\.card \.cc-ta, \.cc\.cc\.card \.cc-ta:focus \{[^}]*border: 0;[^}]*box-shadow: none/);
  const ic = read('css/94-ideia.css');
  assert.match(ic, /\.ideiastart\{--ideia-measure:72ch/);
  assert.ok(!/\.ideiahero p\{[^}]*max-width/.test(ic), 'o parágrafo não tem medida própria (senão o compositor fica mais largo)');
});

test('teto de custo: cartão com uma opção por botão (trava enquanto envia); sem teto, nada', () => {
  const src = read('js/60-terminal-layout.js');
  const body = cut(src, 'function tlBudgetHtml(t){', '/** O HTML da coluna');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let pend = [];
  const TL = { budSending: {} };
  const f = new Function('pendingOf', 'fwIsBudgetAsk', 'esc', 'escA', 'TL', body + '\nreturn tlBudgetHtml;')(() => pend, (p) => !!p && (p.kind === 'budget' || +p.id < 0), esc, esc, TL);
  assert.equal(f({ id: 't1' }), '');
  pend = [{ id: 7, kind: 'question', prompt: 'qual cor?' }, { id: -1, kind: 'budget', prompt: 'Chegou a US$ 2,00', options: ['liberar US$ 1', 'parar aqui'] }];
  const h = f({ id: 't1' });
  assert.equal((h.match(/data-tlbud=/g) || []).length, 2);
  assert.match(h, /Teto de custo<\/b> · Chegou a US\$ 2,00/);
  TL.budSending.t1 = 1;
  assert.equal((f({ id: 't1' }).match(/ disabled/g) || []).length, 2, 'enviando: o poll repinta desabilitado');
});

test('histórico quebra POR PALAVRA na largura do xterm (nunca "vo ltaram"); continuação alinha depois do marcador', () => {
  const said = 'As barras voltaram um pouco menores, sem voltar ao estado inicial. Banheiro: esfregar o sabão como antes.';
  const out = plain(TH.thRender([{ k: 'say', ts: 1, text: said }, { k: 'tool', ts: 2, name: 'Read', arg: 'src/' + 'x'.repeat(90) + '.ts' }], { cols: 40 }));
  const L = out.split('\r\n').filter(Boolean);
  for (const l of L) assert.ok(l.length <= 39, 'cabe: ' + JSON.stringify(l));
  const words = said.split(' ');
  const got = L.filter((l) => !/⎿|x{5}/.test(l)).map((l) => l.replace(/^[● ]+/, '')).join(' ').split(' ');
  assert.deepEqual(got, words, 'nenhuma palavra partida');
  assert.match(L[0], /^● As barras/); assert.match(L[1], /^ {2}\S/);
  assert.ok(L.some((l) => /^ {4}x+/.test(l)), 'caminho gigante partido, alinhado depois do ⎿');
  const sgr = TH.thWrap('\x1b[32m● \x1b[0m' + 'palavra '.repeat(12), 40);
  assert.ok(sgr.length > 1 && sgr.every((l) => plain(l).length <= 39), 'cores não contam na largura');
  assert.deepEqual(TH.thWrap('curta', 80), ['curta']);
  const two = plain(TH.thRender([{ k: 'say', ts: 1, text: 'primeira linha\nsegunda linha bem comprida que precisa quebrar em mais de uma linha aqui' }], { cols: 40 })).split('\r\n').filter(Boolean);
  assert.ok(two.slice(1).every((l) => l.startsWith('  ') && !l.startsWith('   ')), 'continuação da fala mantém o recuo de 2: ' + JSON.stringify(two));
});

test('notas de fim do terminal em pt-BR, sem código cru (inclusive as já gravadas)', () => {
  assert.equal(TH.thSysText('terminal: sessão encerrada (other)'), 'terminal: a sessão terminou');
  assert.equal(TH.thSysText('terminal: sessão encerrada (prompt_input_exit)'), 'terminal: você saiu do terminal');
  assert.equal(TH.thSysText('terminal: sessão encerrada (algo_novo)'), 'terminal: a sessão terminou');
  assert.equal(TH.thSysText('terminal fechado (código 0)'), 'terminal fechado');
  assert.equal(TH.thSysText('terminal fechado (código 143)'), 'o terminal fechou com erro');
  assert.equal(TH.thSysText('PR aberto: x'), 'PR aberto: x');
  assert.equal(TH.thSysText('⏸ esperando você no terminal: Claude is waiting for your input'), '⏸ o Claude está esperando você no terminal');
  const out = TH.thRender([], { notes: TH.thSysNotes([{ agent: 'Sistema', type: 'status', text: 'terminal: sessão encerrada (other)', ts: 1 }]) });
  assert.ok(!/other/.test(out) && /a sessão terminou/.test(out));
});

test('painel baixo do canvas: faixa de etapas vira resumo, barra do histórico na linha de status, compositor em 1 linha', () => {
  const css = read('css/95-terminal.css');
  const low = css.slice(css.indexOf('@media (max-height:420px)'));
  assert.match(low, /\.cicstrip>:not\(\.cicst-sum\)\{display:none\}/);
  assert.match(low, /\.fwtermbar\{position:absolute;top:0;right:0;height:28px/);
  assert.match(low, /\.fwinput\.cc \.cc-row\{display:contents\}/);
  assert.match(low, /\.cc-compmore\{order:3;display:inline-grid/);
  const ws = read('js/20-workspace-tarefa.js');
  assert.match(ws, /id="fwCompMore"/, 'o ⋯ do compositor (IA e vira requisito) só existe no terminal');
  assert.match(read('js/60-terminal-layout.js'), /function tlCompMoreOpen\(t, anchor\)[\s\S]*openModelMenu\(t\.id, anchor\)[\s\S]*req\.checked=!req\.checked/);
});
