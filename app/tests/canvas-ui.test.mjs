// Canvas do workspace (spec-canvas-workspace) — UI: F1 "Subir ambiente" (cartão, passos, erro humano, detalhes só
// sob pedido, mensagem pro agente) e a fiação (evento sem polling, comandos assíncronos, morre com a demanda).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const amb = read('js/58-ambiente.js');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escA = (s) => esc(s).replace(/"/g, '&quot;');
const A = new Function('esc', 'escA', cut(amb, '// @amb-puro-inicio', '// @amb-puro-fim') + '\nreturn { ENV_STEPS, envApply, envStepRows, envCardHtml, envStripHtml, envAgentMsg };')(esc, escA);

test('Subir ambiente: vazio nunca é branco nem só endereço — botão grande; estático vira "Ver a página funcionando"; sem página diz o que dá pra fazer', () => {
  const idle = A.envCardHtml({ plan: { kind: 'script', web: true, label: 'npm run dev', install: 'npm install' }, view: null });
  assert.match(idle, /class="envbig" data-env="up"/); assert.match(idle, /<b>Subir ambiente<\/b>/);
  assert.match(idle, /antes instala o que falta/); assert.ok(!/<input|localhost|npm run dev/.test(idle), 'sem campo de endereço nem texto de máquina na cara');
  assert.match(idle, /ver detalhes/); assert.ok(!/envlog/.test(idle), 'log escondido por padrão');
  assert.match(A.envCardHtml({ plan: { kind: 'static', web: true, label: 'x' } }), /<b>Ver a página funcionando<\/b>/);
  const none = A.envCardHtml({ plan: { kind: 'none', web: false } });
  assert.match(none, /não tem uma página/); assert.ok(!/data-env="up"/.test(none)); assert.match(none, /Entrega|Documento/);
  assert.match(A.envCardHtml({}), /vendo como ligar/);
});

test('passos ticando em pt-BR: feito ✓, atual girando, falha com !; "instalar" só quando acontece', () => {
  let v = null;
  for (const e of [{ ev: 'step', step: 'detect', label: 'npm run dev' }, { ev: 'step', step: 'start', port: 4100 }, { ev: 'step', step: 'wait', url: 'http://127.0.0.1:4100/' }]) v = A.envApply(v, e);
  assert.deepEqual(A.envStepRows(v, {}).map((r) => [r.k, r.st]), [['detect', 'done'], ['start', 'done'], ['wait', 'cur'], ['ready', 'wait']]);
  const run = A.envCardHtml({ plan: { kind: 'script', web: true }, view: v });
  assert.match(run, /Achando como ligar o projeto/); assert.match(run, /Esperando a página responder/); assert.match(run, /class="envst cur"/);
  assert.match(run, /data-env="down">parar/); assert.ok(!/Instalando/.test(run));
  assert.ok(A.envStepRows(v, { install: 'npm i' }).some((r) => r.k === 'install'), 'vai instalar → o passo aparece');
  const ready = A.envApply(v, { ev: 'ready', url: 'http://127.0.0.1:4100/' });
  assert.ok(A.envStepRows(ready, {}).every((r) => r.st === 'done')); assert.equal(ready.url, 'http://127.0.0.1:4100/');
  assert.match(A.envStripHtml(ready), /no ar · <span class="mono">127\.0\.0\.1:4100<\/span>/);
  assert.match(A.envStripHtml(ready), /data-env="restart">reiniciar[\s\S]*data-env="down">parar[\s\S]*data-env="details">detalhes/);
  assert.equal(A.envStripHtml(null), '', 'ambiente que não é do Starfork: sem faixa');
  const failed = A.envApply(v, { ev: 'fail', code: 'deps', msg: 'Falta instalar uma parte do projeto (uma dependência não foi encontrada).', tail: "Error: Cannot find module 'express'" });
  assert.deepEqual(A.envStepRows(failed, {}).map((r) => r.st), ['done', 'done', 'fail', 'wait']);
  const fc = A.envCardHtml({ plan: { kind: 'script', web: true, label: 'npm run dev' }, view: failed });
  assert.match(fc, /role="alert"/); assert.match(fc, /Falta instalar uma parte do projeto/);
  assert.match(fc, /data-env="agent">pedir pro agente resolver/); assert.match(fc, /data-env="up">tentar de novo/);
  assert.ok(!/Cannot find module/.test(fc), 'o erro técnico NÃO aparece no cartão');
  const det = A.envCardHtml({ plan: { kind: 'script', web: true, label: 'npm run dev' }, view: failed, details: true, log: "Error: Cannot find module 'express'" });
  assert.match(det, /class="mono envlog">Error: Cannot find module &#39;express&#39;|class="mono envlog">Error: Cannot find module 'express'/, 'só em "ver detalhes"');
  assert.match(det, /aria-expanded="true"/);
  const ex = A.envApply(ready, { ev: 'exit', code: 1, msg: 'O site parou.' });
  assert.equal(ex.ready, false); assert.equal(ex.fail.msg, 'O site parou.');
});

test('"pedir pro agente resolver": frase humana + como tentou ligar + fim do log + o caminho do env.json', () => {
  const tail = Array.from({ length: 60 }, (_, i) => 'linha ' + (i + 1)).join('\n');
  const m = A.envAgentMsg({ fail: { msg: 'O site não respondeu a tempo.', tail } }, { label: 'pnpm dev' });
  assert.match(m, /falhou: O site não respondeu a tempo\./); assert.match(m, /pnpm dev/); assert.match(m, /\.cardume\/env\.json/);
  assert.match(m, /linha 60\n```/); assert.ok(!/linha 20\n/.test(m), 'só o fim do log (40 linhas)');
});

test('fiação do ambiente: evento (sem polling), comandos assíncronos registrados, morre com a demanda/aba/app, varredura no boot', () => {
  assert.match(amb, /window\.__TAURI__\.event\.listen\('env-progress'/);
  assert.ok(!/setInterval\(/.test(amb), 'sem laço');
  for (const c of ['env_detect', 'env_up', 'env_down', 'env_status']) assert.match(amb, new RegExp(`invoke\\('${c}'`), c);
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const rs = readFileSync(new URL('../src-tauri/src/ambiente.rs', import.meta.url), 'utf8');
  for (const c of ['env_detect', 'env_up', 'env_down', 'env_status']) { assert.match(lib, new RegExp(`ambiente::${c},`), c + ' registrado'); assert.match(rs, new RegExp(`#\\[tauri::command\\(async\\)\\]\\npub fn ${c}`), c + ' assíncrono'); }
  assert.match(lib, /ambiente::kill_all\(\)/, 'sair do app mata os ambientes'); assert.match(lib, /std::thread::spawn\(ambiente::sweep_boot\)/, 'varredura no boot');
  assert.match(rs, /detach_new_group\(&mut c\)/, 'supervisor em grupo próprio');
  assert.match(read('js/10-core.js'), /envSweep\(snap\)/, 'tarefa acabou → ambiente para');
  assert.match(read('js/15-config-abas-onboarding.js'), /envOnTaskTabClose\(TABS\[i\]\.taskId\)/, 'aba fechada → ambiente para');
  const html = read('index.html');
  assert.ok(html.indexOf('js/58-ambiente.js') > html.indexOf('js/57-navegador.js')); assert.match(html, /css\/92-canvas\.css/);
  // a prévia vazia/erro usa o cartão (nunca o branco)
  assert.match(read('js/57-navegador.js'), /else if\(!st\.proxy && !st\.addr\) nvSetMsg\(st, st\.empty\?st\.empty\(\):nvEmptyHtml\(\)\)/);
});

// ---------------- F2: canvas (colunas, abas, painéis) ----------------
const canvas = read('js/58-canvas.js'), cvp = read('js/19-canvas-puro.js'), ws = read('js/20-workspace-tarefa.js'), html = read('index.html');
const PURE = cut(cvp, '// @canvas-puro-inicio', '// @canvas-puro-fim');
function loadPanes(tasks, home) {
  const state = { tasks };
  const code = PURE + cut(canvas, 'const CV_ICON', '\nfunction cvTask') + cut(canvas, 'function cvTask', 'function cvCtxOf') + cut(canvas, 'function cvTabLabel', 'function cvSkeleton');
  return new Function('esc', 'escA', 'state', 'fwTask', code + '\nreturn { cvTabsHtml, cvHeadHtml, cvColStyle, cvMkTab, cvDefaultLayout, cvAddTab };')(esc, escA, state, home);
}

test('abas: tablist acessível, arrastável, nome humano; aba de OUTRA demanda com a cor dela; × com rótulo', () => {
  const P = loadPanes([{ id: 'H', title: 'Remarcar aula' }, { id: 'B', title: 'Ajustar cores' }], 'H');
  let l = P.cvDefaultLayout('H', {});
  l = P.cvAddTab(l, P.cvMkTab('app', 'B'), 0);
  l = P.cvAddTab(l, P.cvMkTab('site', null, { url: 'https://youtu.be/aqz-KE-bpKQ' }), 0);
  l = P.cvAddTab(l, P.cvMkTab('documento', 'H', { ref: 'file:docs/README.md' }), 0);
  const h = P.cvTabsHtml(l, 0);
  assert.match(h, /role="tab" tabindex="-1" aria-selected="false" draggable="true"/);
  assert.match(h, /role="tab" tabindex="0" aria-selected="true"/, 'só a ativa entra no Tab');
  assert.match(h, /<span class="cvtl">Meu app<\/span>/);
  assert.match(h, /class="cvtab other"[\s\S]*?background:hsl\(\d+ 72% 62%\)[\s\S]*?Meu app · Ajustar cores/, 'prévia de outra demanda: cor + nome dela');
  assert.match(h, /vídeo · youtube\.com/); assert.match(h, /<span class="cvtl">README\.md<\/span>/);
  assert.match(h, /aria-label="fechar README\.md"/);
});

test('cabeçalho de cada painel: nome + cor da demanda DONA do painel (site externo: fora da demanda)', () => {
  const P = loadPanes([{ id: 'H', title: 'Remarcar aula' }, { id: 'B', title: 'Ajustar cores' }], 'H');
  const hh = P.cvHeadHtml(P.cvMkTab('conversa', 'H'));
  assert.match(hh, /class="cvdot" style="background:hsl\(/); assert.match(hh, /class="cvhn"[^>]*>Remarcar aula</); assert.match(hh, /· Conversa/);
  assert.match(P.cvHeadHtml(P.cvMkTab('demanda', 'B')), />Ajustar cores<[\s\S]*· Outra demanda/);
  const site = P.cvHeadHtml(P.cvMkTab('site', null, { url: 'https://docs.python.org/3/' }));
  assert.match(site, /docs\.python\.org/); assert.match(site, /fora da demanda/); assert.match(site, /background:var\(--muted\)/);
  // a conversa fica estreita ao lado (como antes); largura salva vale
  const l = P.cvDefaultLayout('H', {});
  assert.match(P.cvColStyle(l, 1, 2), /clamp\(300px, 30%, 420px\)/); assert.equal(P.cvColStyle(l, 0, 2), 'flex:1 1 0');
  assert.equal(P.cvColStyle(Object.assign({}, l, { w: [0.7, 0.3] }), 1, 2), 'flex:0.3 1 0');
});

test('estrutura: canvas + hosts estacionados (os modos antigos não são recriados), script/CSS carregados, sem laço', () => {
  assert.match(html, /<div class="cvcanvas" id="cvCanvas"/);
  assert.match(html, /<div class="cvpark" id="cvPark" hidden>[\s\S]*id="fwCols" data-cvhost="codigo"[\s\S]*id="fwChatCol" data-cvhost="conversa"[\s\S]*id="fwDev" data-cvhost="dispositivo"/);
  assert.ok(html.indexOf('js/19-canvas-puro.js') < html.indexOf('js/20-workspace-tarefa.js'), 'puras antes do workspace');
  assert.ok(html.indexOf('js/58-canvas.js') > html.indexOf('js/58-ambiente.js'));
  assert.ok(!/setInterval\(/.test(canvas), 'canvas sem laço');
  // o workspace pinta Código/Conversa SÓ quando a aba está à vista (antes pintava os 3 o tempo todo)
  assert.match(ws, /if\(typeof cvRender==='function'\) cvRender\(t\);[\s\S]{0,200}cvShows\('codigo'\)\) fwRenderCode\(t\);[\s\S]{0,120}cvShows\('conversa'\)\) fwRenderChat\(t\);/);
  assert.match(ws, /if\(typeof cvShows==='function' && !cvShows\('conversa'\)\) return fwLiveFiles\(t\);/, 'conversa estacionada não é repintada a cada tique');
  assert.ok(!/fwModesHtml\(t\)/.test(ws), 'os modos exclusivos saíram do topo');
  // legado: fwMode='entrega' + renderWorkspace() abre a aba Entrega (nada se perde)
  assert.match(canvas, /if\(fwMode!==CV\.lastMode\)\{ const ty=CV_MODE2TYPE\[fwMode\]/);
  assert.deepEqual(Object.keys(new Function(PURE + 'return CV_MODE2TYPE;')()), ['conversa', 'codigo', 'revisao', 'entrega', 'pr', 'previa']);
});

test('site qualquer: iframe sem proxy/mira/ponte, sem allow-top-navigation, com "abrir fora" sempre; congela pelo gerente', () => {
  const site = cut(canvas, 'function cvSiteRender', 'function cvSiteUnmount');
  assert.ok(!/browser_open|nvGo|nvMount|picker/.test(site), 'nada do proxy da prévia');
  assert.match(site, /setAttribute\('sandbox','allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation'\)/);
  assert.ok(!/sandbox','[^']*allow-top-navigation/.test(site));
  assert.match(site, /abrir fora/); assert.match(site, /cvRmTake\('web', key,/);
  assert.match(site, /Este site não deixa abrir dentro de outro app/);
});

test('atalhos e arrastar: ⌘\\ ⌘1..3 ⌘K só com a demanda na tela; indicador de onde cai; link/PDF de fora vira painel', () => {
  const keys = cut(canvas, "document.addEventListener('keydown', (e)=>{\n  if(!(e.metaKey||e.ctrlKey)", '}, true);');
  assert.match(keys, /!fwVisible\(\)/); assert.match(keys, /e\.key==='\\\\'/); assert.match(keys, /\/\^\[1-3\]\$\/\.test\(e\.key\)/); assert.match(keys, /l\.cols\.length>1/, '⌘1..9 continua trocando a aba do app com 1 coluna');
  assert.match(keys, /cvOpenMenu\(a, undefined, true\)/, '⌘K = menu de painéis com busca');
  assert.match(canvas, /solte pra abrir numa coluna à esquerda/); assert.match(canvas, /máximo de 3 colunas/);
  assert.match(canvas, /\.cvdragging iframe|cvdragging/); assert.match(read('css/92-canvas.css'), /\.cvdragging iframe\{pointer-events:none\}/, 'iframe não engole o arraste');
  const drop = cut(canvas, 'function cvExternalDrop', '// ---------- fiação');
  assert.match(drop, /import_attachment_data/); assert.match(drop, /cvOpenType\('documento', 'new', \{ ref:'ref:'/); assert.match(drop, /cvOpenType\('site', 'new'/);
  assert.match(drop, /25e6/, 'arquivo grande demais: erro humano');
  // menu é dropdown (não modal), com papéis de menu e teclado
  assert.match(canvas, /m\.setAttribute\('role','menu'\)/); assert.match(canvas, /role="menuitem"/); assert.match(canvas, /a11yMenuStep/);
  // site pede o endereço NO MENU (painel nunca nasce vazio só com campo de endereço — veto da Carla)
  assert.match(cut(canvas, 'function cvSiteAsk', 'function cvMenuKeys'), /cvOpenType\('site', col, \{ url:s\.url \}\)/);
});

test('documento: visualizadores da Entrega reaproveitados; sem arquivo escolhido → cartões (nunca vazio)', () => {
  const doc = cut(canvas, 'function cvDocRender', '// ---------- Site qualquer');
  assert.match(doc, /artPreviewHtml\(name, c, t\.id\)/); assert.match(doc, /invoke\('read_artifact'/);
  assert.match(doc, /Qual documento abrir\?/); assert.match(doc, /arrastar um PDF ou um link/);
  assert.match(cut(canvas, 'function cvDocChoices', 'function cvDocRender'), /'file:README\.md', 'README\.md'/);
  // P9: terminou → o entregável abre sozinho, uma vez
  const ad = cut(canvas, 'function cvAdapt', 'function cvRenderPane');
  assert.match(ad, /!\(n\.opened\|\|\[\]\)\.includes\('fim'\)/); assert.match(ad, /m\.opened=\[\.\.\.\(n\.opened\|\|\[\]\), 'fim'\]/);
});
