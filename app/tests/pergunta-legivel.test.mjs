// FOLHA DE PERGUNTA LEGÍVEL (08/10: "está ruim de ler, só um texto gigante"): a pergunta vira TÍTULO (a frase com "?"),
// o resto vira CONTEXTO em markdown leve (mdToHtml — fonte única), recolhido quando longo; opções com descrição.
// Funções puras de app/src/js/60-terminal-layout.js. `node --test app/tests/pergunta-legivel.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const fnOf = (src, name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(i, k + 1); } };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kb = read('js/23-kanban-artefatos-editor.js');
const mdToHtml = new Function([fnOf(kb, 'mdSafeHref'), fnOf(kb, 'ghHtmlClean'), fnOf(kb, 'mdToHtml')].join('\n') + '\nreturn mdToHtml;')();
const TL = new Function('esc', 'escA', 'mdToHtml', cut(read('js/60-terminal-layout.js'), '// @tl-puro-inicio', '// @tl-puro-fim') +
  '\nreturn { tlAskKey,tlSentences, tlAskSplit, tlMono, tlProseMd, tlCtxBlocks, tlCtxLines, tlOptSplit, tlTitleHtml, tlAskGroup, tlAskNew, tlSheetHtml, TL_CTX_FOLD_LINES };')(esc, esc, mdToHtml);

// o caso real que o dono mandou (parágrafo único de ~20 linhas, lista inline, rótulo em caixa alta, pergunta no fim)
const WALL = 'Paridade visual ANTES (main 3f9c2b1) × DEPOIS (esta branch) feita com prints reais a 1440 e 390 px de Início, Agenda, Busca (vazia e com busca "pilates"), Relatórios e Pagamentos. Comparei elemento a elemento (texto, caixa e estilo computado) e pixel a pixel. Resultado: os 12 pares têm a mesma contagem de elementos e caixas/estilos idênticos. Diferenças: - 3 só de texto no busca-cheia: a grafia da descrição do plano, que já varia entre duas capturas do próprio ANTES. - 2 faixas de 1 a 3 px: uma no pagamentos, que também varia ANTES×ANTES; outra de 1 linha na borda de um botão da Agenda. RESSALVA DE INFRA: Relatórios e Pagamentos aparecem só com a casca real (validação, filtros, cabeçalho) e o estado de erro "A fonte de dados não respondeu", sem linhas de dados. O motivo é que a conexão banco \'vendas\' não está configurada no local (log: "Destino não configurado: vendas"; as credenciais ficam no cofre de segredos). Além disso, o Docker Desktop desta máquina travou ("Docker Desktop is unable to start"), então a prova rodou num Postgres descartável (PG14, porta 55433), o mesmo banco no ANTES e no DEPOIS. Aceita fechar com essa ressalva (linhas de dados de Relatórios/Pagamentos cobertas só pelos testes vitest e pela igualdade de DOM/CSS da casca), ou quer me passar acesso ao banco \'vendas\' para eu refazer essas duas telas com dados?';
const OPTS = ['Aceito fechar com a ressalva registrada', 'Vou liberar o banco vendas; aguarde'];

test('título = a frase que pergunta; o resto é contexto (nada se perde)', () => {
  const { title, ctx } = TL.tlAskSplit(WALL);
  assert.match(title, /^Aceita fechar com essa ressalva .* com dados\?$/);
  assert.ok(!/Paridade/.test(title));
  assert.match(ctx, /^Paridade visual/); assert.match(ctx, /no ANTES e no DEPOIS\.$/);
  assert.equal((title + ' ' + ctx).replace(/\s+/g, '').length, WALL.replace(/\s+/g, '').length, 'mesmo texto, só reorganizado');
});

test('contexto: parágrafos por frase-chave, lista inline vira lista, CAIXA ALTA vira callout, termos técnicos em mono', () => {
  const blocks = TL.tlCtxBlocks(TL.tlAskSplit(WALL).ctx);
  assert.equal(blocks.length, 2);
  const [main, call] = blocks;
  assert.equal(call.label, 'RESSALVA DE INFRA');
  assert.match(main.md, /\n\n\*\*Resultado:\*\* os 12 pares/);
  assert.match(main.md, /\*\*Diferenças:\*\*\n\n- 3 só de texto no busca-cheia: .* ANTES\.\n- 2 faixas de 1 a 3 px: .*Agenda\.$/);
  assert.match(main.md, /\(main `3f9c2b1`\)/, 'hash em mono');
  assert.match(call.md, /banco `vendas`/, "'id' em mono");
  assert.match(call.md, /porta `55433`/, 'porta em mono');
  assert.match(call.md, /\n\nO motivo é/); assert.match(call.md, /\n\nAlém disso/);
  const html = mdToHtml(main.md);
  assert.equal((html.match(/<li>/g) || []).length, 2); assert.match(html, /<code>3f9c2b1<\/code>/);
  assert.ok(TL.tlCtxLines(blocks) > TL.TL_CTX_FOLD_LINES, 'longo → começa recolhido');
});

test('folha: título no topo, contexto recolhido com "ver contexto completo", callout, opções e rodapé', () => {
  const g = TL.tlAskGroup([{ id: 11, kind: 'question', agent: 'Íris', prompt: WALL, options: OPTS }]);
  const st = TL.tlAskNew(g);
  const h = TL.tlSheetHtml(g, st);
  const iq = h.indexOf('class="tlq"'), ic = h.indexOf('class="tlctx fold"'), io = h.indexOf('class="tlopts"'), isf = h.indexOf('class="tlsf"');
  assert.ok(iq > 0 && ic > iq && io > ic && isf > io, 'ordem: título → contexto → opções → rodapé');
  assert.match(h.slice(iq, ic), /Aceita fechar/); assert.ok(!/Paridade/.test(h.slice(iq, ic)));
  assert.match(h, /data-tl="askctx" aria-expanded="false" aria-controls="tlCtx-p-11">ver contexto completo</);
  assert.match(h, /<div class="tlcall"><span class="tlcallk">RESSALVA DE INFRA<\/span>/);
  assert.match(h, /<span class="tlqp">\(linhas de dados/, 'parêntese longo do título em tom menor');
  assert.equal((h.match(/data-tlopt=/g) || []).length, 2);
  st.ctxOpen[0] = true; const o = TL.tlSheetHtml(g, st);
  assert.match(o, /class="tlctx" id="tlCtx-p-11"/); assert.match(o, />recolher contexto</);
  assert.ok(!/<script/i.test(TL.tlSheetHtml(TL.tlAskGroup([{ id: 1, kind: 'question', prompt: WALL + ' <script>x</script>?', options: [] }]), TL.tlAskNew(TL.tlAskGroup([{ id: 1, kind: 'question', prompt: 'x', options: [] }])))), 'escapado');
});

test('pergunta curta continua igual (sem contexto, sem botão); ask_human com context (parágrafo + pergunta) separa', () => {
  const g = TL.tlAskGroup([{ id: 7, kind: 'question', prompt: 'Qual banco?', options: ['pg', 'sqlite'] }]);
  const h = TL.tlSheetHtml(g, TL.tlAskNew(g));
  assert.match(h, /<div class="tlq" id="tlQ-p-7">Qual banco\?<\/div>/); assert.match(h, /aria-labelledby="tlQ-p-7"/); assert.ok(!/tlctx/.test(h));
  const s = TL.tlAskSplit('- a migration 0031 falhou\n- o log está em `.cardume/tmp/m.log`\n\nRodo de novo agora?');
  assert.equal(s.title, 'Rodo de novo agora?'); assert.match(s.ctx, /^- a migration/);
  const b = TL.tlCtxBlocks(s.ctx); assert.equal(b.length, 1); assert.match(mdToHtml(b[0].md), /<ul><li>a migration 0031 falhou<\/li>/);
  // contexto curto não recolhe
  const g2 = TL.tlAskGroup([{ id: 8, kind: 'question', prompt: '- a\n- b\n\nSigo?', options: [] }]);
  const h2 = TL.tlSheetHtml(g2, TL.tlAskNew(g2)); assert.match(h2, /class="tlctx" id="tlCtx-p-8"/); assert.ok(!/askctx/.test(h2));
});

test('sem "?": header do AskUserQuestion ou a última frase vira título; frases não cortam em abreviação/parêntese/aspas', () => {
  const long = 'Rodei a suíte toda e o build. '.repeat(8) + 'Escolha como seguir.';
  assert.equal(TL.tlAskSplit(long).title, 'Escolha como seguir.');
  assert.equal(TL.tlAskSplit(long, 'deploy').title, 'deploy');
  assert.deepEqual(TL.tlSentences('Use ex. o pg. Depois (vale o "x. Y") siga. Fim?'), ['Use ex. o pg.', 'Depois (vale o "x. Y") siga.', 'Fim?']);
  // duas perguntas seguidas no fim = título com as duas
  const two = 'Contexto longo. '.repeat(16) + 'Posso apagar? Ou prefere arquivar?';
  assert.equal(TL.tlAskSplit(two).title, 'Posso apagar? Ou prefere arquivar?');
});

test('mono: caminho, arquivo, host:porta; "DOM/CSS" e "e/ou" ficam texto; `código` já marcado não duplica', () => {
  assert.equal(TL.tlMono('veja src/terminal.ts e .cardume/artifacts/proof.png'), 'veja `src/terminal.ts` e `.cardume/artifacts/proof.png`');
  assert.equal(TL.tlMono('rode em localhost:5173 já'), 'rode em `localhost:5173` já');
  assert.equal(TL.tlMono('igualdade de DOM/CSS e/ou ANTES×ANTES'), 'igualdade de DOM/CSS e/ou ANTES×ANTES');
  assert.equal(TL.tlMono('já `src/a.ts` aqui'), 'já `src/a.ts` aqui');
  assert.equal(TL.tlMono('o TASK.yaml'), 'o `TASK.yaml`');
});

test('opções: descrição do AskUserQuestion ou "Rótulo — descrição" do ask_human em linha menor; resposta = opção inteira', () => {
  assert.deepEqual(TL.tlOptSplit('Fechar — registro a ressalva no PR'), { label: 'Fechar', desc: 'registro a ressalva no PR' });
  assert.deepEqual(TL.tlOptSplit('Fechar', 'padrão'), { label: 'Fechar', desc: 'padrão' });
  assert.deepEqual(TL.tlOptSplit('2h'), { label: '2h', desc: '' });
  const g = TL.tlAskGroup([{ id: 3, kind: 'question', prompt: 'Fecho?', options: ['Fechar — registro a ressalva no PR', 'Esperar'] }]);
  const h = TL.tlSheetHtml(g, TL.tlAskNew(g));
  assert.match(h, /<b>Fechar<\/b><small>registro a ressalva no PR<\/small>/);
});

test('CSS: contexto encolhe antes das opções e rola sozinho; ~72ch; recolhido; painel compacto igual', () => {
  const css = read('css/95-terminal.css');
  assert.match(css, /\.tlctx\{flex:0 1000 auto;min-height:0;max-height:min\(22em,42vh\);overflow-y:auto;[^}]*max-width:72ch/);
  assert.match(css, /\.tlctx\.fold\{max-height:6\.4em;overflow:hidden/);
  assert.match(css, /\.tlsf\{flex:none;/, 'rodapé nunca encolhe');
  assert.match(css, /\.tlsheethost\.tight \.tlctx\.fold\{max-height:4\.7em\}/);
  assert.match(css, /\.tlsheethost\.tight \.tlsf\{position:sticky;bottom:0/);
  assert.doesNotMatch(css, /\.tlsheethost\.tight \.tlot small[^{]*\{display:none/, 'descrição das opções aparece no compacto');
  const tl = read('js/60-terminal-layout.js');
  assert.match(tl, /if\(k==='askctx'\)\{[^\n]*st\.ctxOpen\[st\.q\]=!st\.ctxOpen\[st\.q\]/);
});

test('ask_human com context: a pergunta vem PRIMEIRO no texto (notificação/celular) e meta.question diz onde ela termina', () => {
  const p = { id: 21, kind: 'question', agent: 'Íris', prompt: 'Sigo com o PG14?\n\n- o Docker travou?\n- porta 55433', options: [], meta: { src: 'ask', question: 'Sigo com o PG14?' } };
  const g = TL.tlAskGroup([p]); assert.equal(g.rows[0].q, 'Sigo com o PG14?');
  const sp = TL.tlAskSplit(p.prompt, '', g.rows[0].q);
  assert.equal(sp.title, 'Sigo com o PG14?', 'mesmo com "?" num tópico do contexto');
  assert.equal(sp.ctx, '- o Docker travou?\n- porta 55433');
  // várias perguntas em abas: o rótulo é a pergunta, não o começo do texto
  const two = TL.tlAskGroup([{ id: 1, kind: 'question', prompt: '- ctx a\n- ctx b\n\nRodo de novo?', options: [], meta: { src: 'auq', group: 'x', idx: 0, n: 2 } }, { id: 2, kind: 'question', prompt: 'E o deploy?', options: [], meta: { src: 'auq', group: 'x', idx: 1, n: 2 } }]);
  assert.match(TL.tlSheetHtml(two, TL.tlAskNew(two)), />1\. Rodo de novo\?</);
});

test('bordas: "?" de URL não vira título; lista em linhas sem "?" fica inteira; [link](caminho) não quebra; código não vira callout', () => {
  const s = TL.tlAskSplit('Posso seguir?\n\n' + 'Detalhe longo. '.repeat(14) + 'Veja https://x.dev/a?b=1 aqui.');
  assert.equal(s.title, 'Posso seguir?');
  const l = TL.tlAskSplit('- passo 1 feito\n- passo 2 feito\n' + '- item de contexto bem comprido '.repeat(6) + '\nEscolha como seguir');
  assert.equal(l.title, 'Escolha como seguir'); assert.match(l.ctx, /^- passo 1 feito\n- passo 2 feito\n/);
  assert.equal(TL.tlMono('veja [o log](./a/b.md) e src/x.ts'), 'veja [o log](./a/b.md) e `src/x.ts`');
  assert.equal(TL.tlCtxBlocks('```\nERROR: falhou\n```').length, 1, 'bloco de código inteiro');
});

test('contexto vindo do agente é escapado (sem HTML, sem javascript:)', () => {
  const g = TL.tlAskGroup([{ id: 5, kind: 'question', prompt: 'Sigo?\n\n- <img src=x onerror=alert(1)>\n- [x](javascript:alert(1))\n\nNOTA IMPORTANTE: <script>y</script> ' + 'texto longo. '.repeat(40), options: [], meta: { src: 'ask', question: 'Sigo?' } }]);
  const h = TL.tlSheetHtml(g, TL.tlAskNew(g));
  assert.ok(!/<img|<script|javascript:/i.test(h), h.slice(0, 400));
  assert.match(h, /&lt;script&gt;y/); assert.match(h, /class="tlcall"/);
});

test('teclado: Espaço no "ver contexto completo" é o clique dele (não marca opção na pergunta múltipla); foco volta pro botão', () => {
  const tl = read('js/60-terminal-layout.js');
  assert.match(tl, /if\(\(e\.key==='Enter'\|\|e\.key===' '\) && e\.target\.closest\('button\[data-tl\]'\)\) return;/);
  assert.match(tl, /el\.__focusCtx=true; repaint\(true\)/);
  assert.match(tl, /if\(el\.__focusCtx\)\{ el\.__focusCtx=false; const c=el\.querySelector\('\[data-tl="askctx"\]'\)/);
  assert.match(read('css/95-terminal.css'), /\.tlsheethost\.tight \.tlctx:not\(\.fold\)\{max-height:none;overflow:visible/);
});
