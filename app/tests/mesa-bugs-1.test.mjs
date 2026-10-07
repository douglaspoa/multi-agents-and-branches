// Mesa de bugs 1 (_bmad-output/mesa-bugs/RELATORIO.md): um teste por achado corrigido. Puro quando a lógica é nova
// (busca de Ajustes, recolher entregues, iniciais, contagem de entregues); o resto confere a fonte/CSS.
// `node --test app/tests/mesa-bugs-1.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return src.slice(i, j); };
const line = (src, start) => { const i = src.indexOf(start); assert.ok(i >= 0, 'não achei: ' + start); return src.slice(i, src.indexOf('\n', i)); };
const times = read('js/43-espaco-times.js'), linha = read('js/69-linha.js'), aj = read('js/67-ajustes.js'), tl = read('js/60-terminal-layout.js');
const L = new Function(cut(linha, '// @puro-linha-inicio', '// @puro-linha-fim') + '\nreturn { linhaModelo, linhaVisiveis, linhaHtml };')();
const A = new Function(cut(aj, '// @ajustes-puro-inicio', '// @ajustes-puro-fim') + '\nreturn { ajSearch };')();

test('#1 página do épico rola como a "Entrega do time"', () => {
  assert.match(read('css/60-grafo-times-nova-demanda.css'), /#ctPageMain,#epicPageMain\{flex:1;min-height:0;overflow:auto\}/);
});

test('#2/#3 folha de pergunta: pergunta e opções encolhem por igual, abre no FIM do texto; pane pequeno rola a folha inteira com pular/próxima presos', () => {
  const css = read('css/95-terminal.css');
  assert.match(css, /\.tlq\{flex:0 1 auto;/); assert.match(css, /\.tlopts\{flex:0 1 auto;/);
  assert.match(css, /\.tlq,\.tlopts\{background:linear-gradient/, 'sombra de rolagem (a barra do macOS é sobreposta)');
  assert.match(css, /\.tlsheethost\.tight \.tlsheet\{overflow-y:auto/);
  assert.match(css, /\.tlsheethost\.tight \.tlsf\{position:sticky;bottom:0/);
  assert.match(tl, /function tlAskScrollEnd\(el\)\{[\s\S]*?q\.scrollTop=q\.scrollHeight/);
  assert.match(tl, /tlAskScrollPut\(el, same\?el\.__sc:null\)/, 'mesma pergunta mantém a rolagem; pergunta nova vai pro fim');
  assert.match(tl, /tlAskKeepVisible\(b\)/, 'a opção com foco nunca fica atrás da borda');
});

test('#4 Time: "entregues" = regra única epDelivered (pronta pra revisar não conta), no KPI, por dia, por membro e em Pessoas', () => {
  assert.doesNotMatch(times, /B\.done\(t\)\|\|B\.review\(t\)|inP\.filter\(B\.done\)\.length\+inP\.filter\(B\.review\)/);
  assert.match(times, /const done=inP\.filter\(epDelivered\)\.length;/);
  assert.match(times, /all\.filter\(t=>epDelivered\(t\) && new Date/);
  assert.match(times, /if\(epDelivered\(t\)\) b\.d\+\+;/);
  assert.match(times, /const d=mine\.filter\(epDelivered\)\.length/);
  assert.match(times, /<div class="l">entregues<\/div>/);
  // a regra em si: review/delivered/PR aberto não contam
  const epDelivered = new Function('tsSt', 'taskSt', line(read('js/46-epico-time.js'), 'function epEffSt') + '\n' + line(read('js/46-epico-time.js'), 'function epDelivered') + '\nreturn epDelivered;')((t) => t.status, (t) => t.status);
  const cards = ['merged', 'done', 'review', 'delivered', 'running'].map((status) => ({ team_id: 'x', status }));
  assert.equal(cards.filter(epDelivered).length, 2);
});

test('#5/#6/#14/#15 Linha: meses fixos no topo, frase da saúde no title, sem "mostrar entregues (0)", ano dos meses não corta', () => {
  const css = read('css/99-linha.css');
  assert.match(css, /\.ln-hd\{position:sticky;top:0;/);
  assert.match(css, /\.ln-wrap\{[^}]*overflow:auto;max-height:/);
  const ep = (id, o) => ({ id, name: 'E' + id, status: 'open', spec: {}, ...o });
  const tk = (st) => ({ id: Math.random().toString(36).slice(2), status: st, cost_usd: 1, updated_at: '2026-09-29T12:00:00Z' });
  const mods = Array.from({ length: 22 }, (_, i) => L.linhaModelo(ep('a' + i), [tk('running')]));
  const HOJE = new Date(2026, 9, 6);
  const v = L.linhaVisiveis(mods, HOJE, false);
  assert.deepEqual([v.ocultos, v.recolhe], [0, false], 'nada entregue há tempo: nada a recolher');
  assert.doesNotMatch(L.linhaHtml(mods, { hoje: HOJE }), /mostrar entregues/);
  const s = L.linhaModelo(ep('s', { spec: { health: { state: 'atencao', note: 'Falta definir o escopo da integração com o banco', by: 'u1', at: '2026-10-01T10:00:00Z' } } }), [tk('running')]);
  assert.match(L.linhaHtml([s], { hoje: HOJE, quem: () => 'Beto' }), /<span class="ln-sub" title="atenção · “Falta definir o escopo da integração com o banco” · Beto">/);
  assert.match(L.linhaHtml([s], { hoje: HOJE }), /<div class="ln" style="min-width:\d+px">/);
});

test('#7 seletor de IA: redesenho devolve o foco ao mesmo controle; ↑↓ andam pelas opções', () => {
  const ia = read('js/29-ia-picker.js');
  assert.match(ia, /const ae=document\.activeElement, had=ae===sh\|\|sh\.contains\(ae\);/);
  assert.match(ia, /e\.key==='ArrowDown'\|\|e\.key==='ArrowUp'/);
});

test('#8 lateral recolhida sai do Tab (inert)', () => {
  assert.match(read('js/12-chat-prefs-daily.js'), /sb\.inert=!!v;/);
});

test('#9/#10 foco não cai no body: sub-abas do Projeto e Ajustes', () => {
  assert.match(read('js/68-casca-g1.js'), /Promise\.resolve\(projGo\(k\)\)\.then\(\(\)=>\{ const f=nav\.querySelector/);
  assert.match(aj, /if\(foco\)\{ const f=nav\.querySelector/);
  assert.match(aj, /document\.querySelector\('#ajNav \.ajni\.on'\); if\(f\) f\.focus\(\);/);
});

test('#11 Código: cabeçalho do arquivo quebra linha em coluna estreita (editar não some sob o terminal)', () => {
  assert.match(read('css/50-workspace-planner.css'), /\.fwmhead\{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap;/);
});

test('#12/#13 Ajustes: busca casa o começo da palavra ("tema" não acha Sistema); sem resultado esconde a seção', () => {
  assert.deepEqual(A.ajSearch('tema').sections, ['aparencia']);
  assert.ok(A.ajSearch('chave').sections.includes('motores'), 'prefixo continua achando');
  assert.match(aj, /c\.style\.visibility=r\.sections\.length\?'':'hidden'/);
});

test('#18/#19/#20/#21/#23 cosméticos do Time e da fila', () => {
  const tsIni = new Function(line(times, 'function tsIni') + '\nreturn tsIni;')();
  assert.equal(tsIni('Douglas S.'), 'DS'); assert.equal(tsIni('douglas.sobreira@x.com'), 'DS'); assert.equal(tsIni('Beto'), 'BE');
  assert.match(times, /split\(' '\)\[0\]\.replace\(\/\[:;,\.·–—-\]\+\$\/,''\)/);
  assert.doesNotMatch(times, / · \$\{perSel\}/);
  assert.match(read('js/46-epico-time.js'), /nPl\(cnt\[k\],'pronta','prontas'\)\+' pra revisar'/);
  assert.doesNotMatch(read('js/46-epico-time.js'), /pronta\(s\)/);
  assert.match(times, /if\(t\.status==='backlog'\) return 0;/);
});

test('#22 folha Saúde: radiogroup com setas e um Tab só', () => {
  assert.match(linha, /const d=\{ ArrowDown:1, ArrowRight:1, ArrowUp:-1, ArrowLeft:-1 \}\[e\.key\]/);
  assert.match(linha, /x\.tabIndex=on\?0:-1/);
});
