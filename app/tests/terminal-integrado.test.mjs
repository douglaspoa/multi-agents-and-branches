// TERMINAL INTEGRADO (mock aprovado 04/10): funções puras de app/src/js/64-terminal-integrado.js — chips de resposta
// (evento `suggest`), botão → comando no terminal (/starfork-… no Claude Code, frase no Codex), @arquivo do anexo,
// folhas dos botões e entregáveis como link — e os ganchos nos arquivos de sempre. `node --test app/tests/terminal-integrado.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TI = new Function('esc', 'escA', cut(read('js/64-terminal-integrado.js'), '// @ti-puro-inicio', '// @ti-puro-fim') +
  '\nreturn { TI_AIS, tiModelShort, tiRecommended, tiAiSelHtml, tiAiRowHtml, tiKeyOpens, tiIsUserEv, tiParseSuggest, tiSuggest, tiCmdText, tiAtRef, tiSheetDef, tiSheetVisible, tiSheetText, tiSheetHtml, tiSheetKey, tiKindLabel, tiDelivList, tiDelivHtml1 };')(esc, esc);
const TL = new Function('esc', 'escA', cut(read('js/60-terminal-layout.js'), '// @tl-puro-inicio', '// @tl-puro-fim') + '\nreturn { tlPanelHtml, tlReqView };')(esc, esc);

// ---------------- chips de resposta ----------------
const ev = (id, o) => ({ id, taskId: 't1', ts: id, agent: 'Íris', type: 'think', text: '', ...o });
test('chips: o suggest mais novo DEPOIS da sua última fala; sua fala apaga os velhos', () => {
  const sug = (id, arr) => ev(id, { type: 'suggest', text: JSON.stringify(arr) });
  const evs = [ev(1, { agent: 'Você', type: 'note', text: 'Você: remove o item' }), sug(2, ['velho', 'outro']), ev(3, { text: 'pronto em 1440' }), sug(4, ['Sim, prova em 390 px', 'Abrir PR assim mesmo'])];
  assert.deepEqual(TI.tiSuggest(evs), { id: 4, list: ['Sim, prova em 390 px', 'Abrir PR assim mesmo'] });
  assert.equal(TI.tiSuggest([...evs, ev(5, { agent: 'Você', text: 'Você: sim' })]), null, 'falou depois: chips somem');
  assert.equal(TI.tiSuggest([...evs, ev(5, { agent: 'Sistema', type: 'note', text: 'humano respondeu: Os dois' })]), null, 'resposta a pergunta também é fala sua');
  assert.equal(TI.tiSuggest([...evs, ev(5, { type: 'note', agent: 'Starfork', text: 'Você: pelo terminal' })]), null, 'nota "Você:" (digitado no terminal) conta');
  assert.deepEqual(TI.tiSuggest([sug(2, ['a']), sug(3, 'lixo')]).list, ['a'], 'suggest ilegível não esconde o anterior');
  assert.equal(TI.tiSuggest([]), null);
});
test('chips: JSON limpo — 4 no máximo, sem repetidos, sem controle, objeto {text} aceito', () => {
  assert.deepEqual(TI.tiParseSuggest(JSON.stringify(['a', 'a', ' b\n c ', '', 'd', 'e', 'f'])), ['a', 'b c', 'd', 'e']);
  assert.deepEqual(TI.tiParseSuggest(JSON.stringify([{ text: 'x' }, { label: 'y' }, 3, null])), ['x', 'y'], 'o que não é texto sai');
  assert.deepEqual(TI.tiParseSuggest('{"a":1}'), []);
  assert.deepEqual(TI.tiParseSuggest('não é json'), []);
  assert.equal(TI.tiParseSuggest(JSON.stringify(['x'.repeat(400)]))[0].length, 160);
});

// ---------------- botão = comando no terminal ----------------
test('comando: /starfork-… no Claude Code e no DeepSeek; frase em pt-BR no Codex/Gateway', () => {
  assert.equal(TI.tiCmdText('claude', 'etapa', 'provar'), '/starfork-etapa provar');
  assert.equal(TI.tiCmdText('deepseek', 'pr', 'rascunho'), '/starfork-pr rascunho');
  assert.equal(TI.tiCmdText('claude', 'revisao'), '/starfork-revisao');
  assert.equal(TI.tiCmdText('claude', 'tarefa-quebrar'), '/starfork-tarefa quebrar');
  assert.equal(TI.tiCmdText('claude', 'skill', 'design-review'), '/starfork-skill design-review');
  assert.equal(TI.tiCmdText('claude', 'tarefa-nova', '  Ajuste: "Em breve"\ncom peso  '), '/starfork-tarefa nova "Ajuste: Em breve com peso"', 'título sem aspas nem quebra');
  const nl = TI.tiCmdText('codex', 'etapa', 'provar');
  assert.match(nl, /^Starfork: avance esta tarefa para Provar/); assert.match(nl, /`starfork status`/); assert.match(nl, /`starfork etapa review`/);
  assert.match(TI.tiCmdText('gemini', 'etapa', 'construir'), /`starfork etapa running`/);
  assert.match(TI.tiCmdText('gateway', 'pr', 'abrir'), /`starfork pr`/);
  assert.match(TI.tiCmdText('opencode', 'pr', 'rascunho'), /`starfork pr --rascunho`/);
  assert.match(TI.tiCmdText('codex', 'skill', 'testes'), /`starfork skill testes`/);
  assert.match(TI.tiCmdText('codex', 'tarefa-nova', 'X'), /tarefa nova de ajuste chamada "X"[^\n]*`starfork tarefa "X"/);
  for (const k of ['codex', 'gemini', 'opencode']) assert.ok(!TI.tiCmdText(k, 'revisao').startsWith('/'), k + ' não recebe /comando');
  // pedido inválido não manda nada
  assert.equal(TI.tiCmdText('claude', 'etapa', 'apagar'), '');
  assert.equal(TI.tiCmdText('claude', 'tarefa-nova', '   '), '');
  assert.equal(TI.tiCmdText('claude', 'skill', 'rm -rf /'), '');
  assert.equal(TI.tiCmdText('claude', 'qualquer'), '');
});
test('anexo: @caminho relativo da worktree, com espaço vai entre aspas', () => {
  assert.equal(TI.tiAtRef('.cardume/refs/print.png'), '@.cardume/refs/print.png ');
  assert.equal(TI.tiAtRef('./.cardume/refs/a b.png'), '@".cardume/refs/a b.png" ');
  assert.equal(TI.tiAtRef(''), '');
});
test('tecla no histórico: texto/Enter retomam; setas, PgUp e Esc só rolam', () => {
  assert.equal(TI.tiKeyOpens('a'), true); assert.equal(TI.tiKeyOpens('\r'), true); assert.equal(TI.tiKeyOpens('olá mundo'), true);
  assert.equal(TI.tiKeyOpens('\x1b[A'), false); assert.equal(TI.tiKeyOpens('\x1b[5~'), false); assert.equal(TI.tiKeyOpens('\x1b'), false); assert.equal(TI.tiKeyOpens(''), false);
});

// ---------------- folhas ----------------
test('folhas: etapa, tarefa e PR com o comando de cada opção; prévia e "mandar" travado sem título', () => {
  const et = TI.tiSheetDef('etapa');
  assert.deepEqual(et.opts.map((o) => TI.tiSheetText(et, { sel: et.opts.indexOf(o) }, 'claude')), ['/starfork-etapa provar', '/starfork-etapa entregar', '/starfork-etapa construir']);
  const pr = TI.tiSheetDef('pr');
  assert.deepEqual(pr.opts.map((o, i) => TI.tiSheetText(pr, { sel: i }, 'claude')), ['/starfork-revisao', '/starfork-pr abrir', '/starfork-pr rascunho', '/starfork-pr atualizar']);
  const tk = TI.tiSheetDef('tarefa');
  assert.equal(TI.tiSheetText(tk, { sel: 0, title: '' }, 'claude'), '');
  assert.equal(TI.tiSheetText(tk, { sel: 0, title: 'Ajuste' }, 'claude'), '/starfork-tarefa nova "Ajuste"');
  const h0 = TI.tiSheetHtml(tk, { sel: 0, title: '' }, 'claude');
  assert.match(h0, /data-ti="title"/); assert.match(h0, /data-ti="ok" disabled/); assert.match(h0, /vai ser digitado no terminal/);
  const h1 = TI.tiSheetHtml(tk, { sel: 0, title: 'Ajuste <b>' }, 'claude');
  assert.ok(!/data-ti="ok" disabled/.test(h1)); assert.match(h1, /\/starfork-tarefa nova &quot;Ajuste &lt;b&gt;&quot;/, 'escapado');
  assert.match(h1, /role="dialog" aria-modal="true" aria-labelledby="tiShT"/);
  assert.match(TI.tiSheetHtml(et, { sel: 1 }, 'codex'), /Starfork: avance esta tarefa para Entregar/, 'a prévia mostra a frase no Codex');
  assert.equal(TI.tiSheetDef('nada'), null);
});
test('skills: as do projeto primeiro, depois os atalhos do Starfork (mandam o prompt), depois as desligadas; filtro', () => {
  const skills = [{ name: 'zeta', active: true }, { name: 'off-1', active: false, description: 'x' }, { name: 'alfa', active: true, description: 'crítica visual' }];
  const quick = [{ id: 'testes', label: 'testes', desc: 'rodar a suíte', prompt: () => 'Rode os testes REAIS' }];
  const d = TI.tiSheetDef('skill', { skills, quick });
  assert.deepEqual(d.opts.map((o) => o.title), ['alfa', 'zeta', '/testes', 'off-1']);
  assert.equal(TI.tiSheetText(d, { sel: 0 }, 'claude'), '/starfork-skill alfa');
  assert.equal(TI.tiSheetText(d, { sel: 2 }, 'claude'), 'Rode os testes REAIS', 'atalho manda o prompt em qualquer motor');
  assert.match(TI.tiSheetHtml(d, { sel: 3 }, 'claude'), /desligada no projeto/);
  assert.deepEqual(TI.tiSheetVisible(d, { q: 'visual' }).map((x) => x.o.title), ['alfa']);
  assert.equal(TI.tiSheetDef('skill', { skills: Array.from({ length: 9 }, (_, i) => ({ name: 's' + i, active: true })) }).filter, true, 'lista grande ganha filtro');
  assert.match(TI.tiSheetDef('skill', { loading: true }).sub, /buscando/);
});
test('teclado da folha: ↑↓ andam nas visíveis, 1–9 escolhem, Enter manda, Esc fecha; no campo as letras passam', () => {
  const d = TI.tiSheetDef('pr'); const st = { sel: 0 };
  assert.equal(TI.tiSheetKey(d, st, 'ArrowDown').st.sel, 1);
  assert.equal(TI.tiSheetKey(d, st, 'ArrowUp').st.sel, 3, 'dá a volta');
  assert.equal(TI.tiSheetKey(d, st, '3').st.sel, 2);
  assert.equal(TI.tiSheetKey(d, st, 'Enter').act, 'send');
  assert.equal(TI.tiSheetKey(d, st, 'Escape').act, 'close');
  assert.equal(TI.tiSheetKey(d, st, 'a', true).pass, true);
  assert.equal(TI.tiSheetKey(d, st, 'ArrowDown', true).pass, true);
  assert.equal(TI.tiSheetKey(d, st, 'Enter', true).act, 'send', 'Enter no título manda');
});

// ---------------- entregáveis como link ----------------
test('entregáveis: arquivos mais novos primeiro (sem requirements.json), link pra aba Documento + abrir no app; combinado embaixo', () => {
  const d = TI.tiDelivList([{ name: 'a.png', created: 1 }, { name: 'requirements.json', created: 9 }, { name: 'proof.md', created: 5 }], ['agenda com remarcação', '']);
  assert.deepEqual(d.files.map((f) => f.name), ['proof.md', 'a.png']);
  assert.deepEqual(d.todo, ['agenda com remarcação']);
  const h = TI.tiDelivHtml1(d);
  assert.match(h, /data-tidoc="proof.md"/); assert.match(h, /data-tiapp="proof.md"/); assert.match(h, />MD</); assert.match(h, />IMG</);
  assert.match(h, /◆ agenda com remarcação/);
  assert.match(TI.tiDelivHtml1({ files: [], todo: [] }), /nenhum arquivo ainda/);
  assert.match(TI.tiDelivHtml1({ files: [], todo: [] }, { loading: true }), /buscando/);
  const many = TI.tiDelivList(Array.from({ length: 11 }, (_, i) => ({ name: 'f' + i + '.png', created: i })));
  assert.equal((TI.tiDelivHtml1(many).match(/data-tidoc=/g) || []).length, 8); assert.match(TI.tiDelivHtml1(many), /mais 3/);
  assert.equal((TI.tiDelivHtml1(many, { all: true }).match(/data-tidoc=/g) || []).length, 11);
  assert.ok(!/<script/.test(TI.tiDelivHtml1(TI.tiDelivList([{ name: '<script>.md' }]))), 'nome escapado');
  assert.equal(TI.tiKindLabel('x.PDF'), 'PDF'); assert.equal(TI.tiKindLabel('v.mov'), 'VÍDEO'); assert.equal(TI.tiKindLabel('semext'), 'ARQ');
});
test('painel: linha da prova e a seção extra entram pelo gancho (sem mudar o painel de quem não usa)', () => {
  const view = TL.tlReqView([{ text: 'r1', st: 'ok', evidence: ['p.png'] }], false);
  const base = TL.tlPanelHtml({ view, gate: { st: 'proven' }, phase: 'idle' });
  assert.match(base, /prova: p\.png/);
  const h = TL.tlPanelHtml({ view, gate: { st: 'proven' }, phase: 'idle', subHtml: () => '<button data-tidoc="p.png">p.png</button>', extra: '<section class="tidl">E</section>' });
  assert.match(h, /data-tidoc="p.png"/); assert.match(h, /<section class="tidl">E<\/section><\/div><\/aside>$/);
});

// ---------------- ganchos nos arquivos de sempre ----------------
test('ganchos: arquivos registrados, suggest fora de todo feed, xterm do histórico retoma ao digitar, dock no lugar do compositor', () => {
  const idx = read('index.html');
  assert.match(idx, /js\/63-revisao-pr\.js"><\/script>\n<script src="js\/64-terminal-integrado\.js">/);
  assert.match(idx, /css\/98-terminal-integrado\.css/);
  assert.match(read('js/20-workspace-tarefa.js'), /e\.type==='papel' \|\| e\.type==='suggest'\) continue/);
  assert.match(read('js/60-terminal.js'), /e\.type==='papel' \|\| e\.type==='suggest'\) continue/);
  assert.match(read('js/25-grafo.js'), /function lastEventOf[^\n]*type!=='suggest'/);
  assert.match(read('js/26-sidebar-projetos.js'), /filter\(e=>e\.type!=='suggest'\)/);
  const term = read('js/60-terminal.js');
  assert.match(term, /if\(st\.alive\)\{ invokeQuiet\('term_write'[^\n]*tiHistKey\(taskId, d\)/);
  assert.match(term, /tiHostWire\(taskId, st\)/);
  assert.match(term, /digite no terminal pra continuar a conversa/);
  const lay = read('js/60-terminal-layout.js');
  assert.match(lay, /tiDockHtml\(t\):''\}\$\{composer\}/);
  assert.match(lay, /ti-nocomp/); assert.match(lay, /tiWire\(t\)/); assert.match(lay, /tiSideClick\(taskId, e\)/); assert.match(lay, /tiLivePaint\(t\)/);
  assert.match(read('css/98-terminal-integrado.css'), /\.tlcol\.ti-nocomp>\.fwinput\{display:none\}/);
  // quem pede o campo de texto faz o compositor aparecer (não foca um campo escondido)
  assert.match(read('js/60-ciclo.js'), /fwInputShow\(\)/);
  assert.match(read('js/63-revisao-pr.js'), /fwInputShow\(\)/);
  assert.match(read('js/27-entregas.js'), /data-tidoc=/);
  const ti = read('js/64-terminal-integrado.js');
  assert.ok(!/window\.confirm|[^.]confirm\(/.test(ti), 'nada de confirm (quebrado no Tauri)');
  assert.match(ti, /invoke\('term_send', \{ taskId, text, mode:'queue' \}\)/);
  assert.match(ti, /invoke\('term_switch_ai', \{ taskId, ai, model:model\|\|null \}\)/);
  assert.match(ti, /showErr\(e, 'Não consegui trocar a IA do terminal'\)/, 'sem o comando no backend: erro legível, não quebra');
});

// ---------------- IA do terminal (o PTY é um shell) ----------------
test('IA do terminal: recomendado do backend ou montado do motor/modelo; seletor com o modelo; shell vira faixa', () => {
  assert.deepEqual(TI.tiRecommended({ ai: 'codex', model: 'gpt-5', command: 'starfork ia codex --modelo gpt-5' }, 'claude', 'x'), { ai: 'codex', model: 'gpt-5', command: 'starfork ia codex --modelo gpt-5' });
  assert.equal(TI.tiRecommended(null, 'claude', 'claude-sonnet-4-5').command, 'starfork ia claude --modelo sonnet');
  assert.equal(TI.tiRecommended(null, 'codex', '').command, 'starfork ia codex');
  assert.equal(TI.tiRecommended(null, 'gateway', '').ai, 'claude', 'motor sem CLI no terminal cai no Claude Code');
  const sel = TI.tiAiSelHtml('codex', 'claude', 'opus');
  assert.match(sel, /<option value="codex" selected>Codex<\/option>/); assert.match(sel, /Claude Code · opus/); assert.match(sel, /value="__cmd">Outro comando…/);
  assert.match(TI.tiAiSelHtml('', 'claude', ''), /value="" selected disabled>shell \(sem IA\)/);
  assert.match(TI.tiAiSelHtml('aider', 'claude', ''), /value="aider" selected/);
  const rec = { ai: 'claude', model: 'sonnet', command: 'starfork ia claude --modelo sonnet' };
  const row = TI.tiAiRowHtml({ cli: null, taskAi: 'claude', model: 'sonnet', rec });
  assert.match(row, /recomendado:/); assert.match(row, /starfork ia claude --modelo sonnet/); assert.match(row, /data-ti="rec"/); assert.match(row, /starfork ia &lt;nome&gt;/);
  assert.match(row, /<option value="claude" selected>/, 'sem o campo cli: a IA da tarefa');
  const sh = TI.tiAiRowHtml({ cli: '', taskAi: 'claude', model: '', rec, shell: true });
  assert.match(sh, /class="tiairow shell"/); assert.match(sh, /o terminal está no shell/); assert.match(sh, /btn sm primary" data-ti="rec"/);
  assert.equal(TI.TI_AIS.map((x) => x.id).join(','), 'claude,codex,deepseek,gemini,opencode');
});
