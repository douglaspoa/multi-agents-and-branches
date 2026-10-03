// CANVAS PRONTO (03/10, "nem o canva está pronto"): layout automático quando os painéis ficariam espremidos, conteúdo
// do painel responsivo ao PRÓPRIO painel, sem tooltip nativo preso, número da tarefa integrada pelo PR, e a Prévia
// que nunca fica branca (pasta da tarefa removida / servidor parado). `node --test app/tests/canvas-pronto.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CV = new Function(cut(read('js/19-canvas-puro.js'), '// @canvas-puro-inicio', '// @canvas-puro-fim') +
  '\nreturn { CV_PANE_MIN_W, cvLayEff, cvLayFits, cvLayout };')();
const canvas = read('js/58-canvas.js'), css = read('css/92-canvas.css'), base = read('css/10-base.css');

// área da linha de painéis numa janela de W pt (barra lateral de 220 + gutter, abas de 40)
const box = (W, H) => ({ w: W - 220 - 2, h: H - 40 });

test('layout automático: 3 lado a lado que ficariam < 460 px viram grade; 2 viram empilhado', () => {
  assert.equal(CV.cvLayEff(3, 'side', box(1000, 700)), 'grid', '1000 pt: 3 de ~258 px → grade');
  assert.equal(CV.cvLayEff(3, 'side', box(1280, 800)), 'grid', '1280 pt: 3 de ~350 px → grade');
  assert.equal(CV.cvLayEff(3, 'side', box(1600, 960)), 'grid', '1600 pt com a barra aberta: 3 de ~455 px → grade');
  assert.equal(CV.cvLayEff(3, 'side', { w: 1600 - 56 - 2, h: 920 }), 'side', '1600 pt com a barra recolhida: 3 de ~510 px cabem');
  assert.equal(CV.cvLayEff(2, 'side', box(1000, 700)), 'stack', '1000 pt: 2 de ~388 px → empilhado');
  assert.equal(CV.cvLayEff(2, 'side', box(1280, 800)), 'side', '1280 pt: 2 de ~528 px cabem');
  assert.equal(CV.cvLayEff(3, 'side', box(1800, 1000)), 'side', 'janela larga: a escolha vale');
});
test('layout automático: a escolha EXPLÍCITA vale enquanto couber; sem medida = a escolha', () => {
  assert.equal(CV.cvLayEff(3, 'stack', box(1000, 900)), 'stack', 'empilhado com altura sobrando fica');
  assert.equal(CV.cvLayEff(3, 'stack', box(1000, 600)), 'grid', '3 empilhados de ~180 px de altura → grade');
  assert.equal(CV.cvLayEff(3, 'grid', box(1000, 700)), 'grid');
  assert.equal(CV.cvLayEff(2, 'grid', box(1600, 900)), 'side', 'grade com 2 continua lado a lado');
  assert.equal(CV.cvLayEff(3, 'side', null), 'side', 'painel escondido (sem medida): não troca nada');
  assert.equal(CV.cvLayEff(3, 'side'), 'side');
  assert.equal(CV.cvLayEff(2, 'side', { w: 900, h: 400 }), 'stack', 'nenhum cabe: o padrão de 2');
  assert.equal(CV.cvLayEff(3, 'grid', { w: 1600, h: 400 }), 'side', 'grade não cabe (baixa), lado a lado cabe → lado a lado');
  assert.ok(CV.cvLayFits(3, 'side', { w: 3 * 460 + 12, h: 700 }));
  assert.ok(!CV.cvLayFits(3, 'side', { w: 3 * 460 + 11, h: 700 }));
});
test('layout automático: a escolha salva NÃO muda; a tela reavalia no resize (só grid-area, nada recarrega)', () => {
  const apply = cut(canvas, 'function cvApplyLayout(row, ids){', '\n}\n');
  assert.match(apply, /cvLayEff\(n, SPL\.lay, cvRowBox\(row\)\)/);
  assert.doesNotMatch(apply, /SPL\.lay\s*=/, 'aplicar o automático nunca sobrescreve a escolha');
  assert.match(canvas, /new ResizeObserver\(\(\)=>cvRelayout\(\)\)\.observe\(row\)/);
  assert.match(canvas, /window\.addEventListener\('resize', \(\)=>\{ cvNatSync\(\); cvRelayout\(\); \}\)/);
  assert.match(cut(canvas, 'function cvLayHtml(', '\n}\n'), /automático: a janela está estreita/);
});
test('painel: o iframe da demanda tem aria-label, não title (o title virava tooltip nativo preso no canto)', () => {
  const r = cut(canvas, 'function cvRealmRender(tab, body){', '\n}\n');
  assert.doesNotMatch(r, /\.title\s*=/);
  assert.match(r, /setAttribute\('aria-label', 'demanda: '/);
  assert.doesNotMatch(read('js/57-navegador.js'), /f\.title='prévia da página'/);
});
test('painel responsivo à largura/altura DO PAINEL (o iframe é o viewport): Entrega, conversa, faixa de etapas', () => {
  const narrow = cut(css, '@media (max-width:720px){', '\n}\n');
  assert.match(narrow, /html\.sfpane \.en-h1\{font-size:var\(--fs-lg\)/, 'título da Entrega menor');
  assert.match(narrow, /html\.sfpane \.en-ht\{min-width:0/, 'nada de min-width 280 estourando o painel');
  assert.match(narrow, /html\.sfpane \.en-kpi\{flex-direction:row/, 'números em linha compacta');
  assert.match(narrow, /html\.sfpane \.cmsg \.cbub\{font-size:var\(--fs-base\)/, 'texto do agente na régua do painel');
  const short = cut(css, '@media (max-height:520px){', '\n}\n');
  assert.match(short, /\.cicst-cost\{display:none\}/, 'faixa de etapas numa linha');
  assert.match(short, /\.fwchath\{display:none\}/, 'painel baixo: sai a linha "Arquivos · agente" pra sobrar altura pras mensagens');
  assert.match(css, /html\.sfpane,html\.sfpane body\{overflow-x:hidden\}/, 'nada estoura a largura do painel');
  assert.match(base, /\.cbub h1,\.cbub h2,\.cbub h3,\.cbub h4\{font-size:1em/, 'título do agente nunca menor que o texto');
});

// ---------- número da tarefa integrada: o do PR ----------
const D = new Function(cut(read('js/15-config-abas-onboarding.js'), 'function diffPick(', '\n') + '\nreturn diffPick;')();
test('número da tarefa integrada: PR mergeado manda (o diff local contava o avanço da main)', () => {
  const local = { taskId: 'x', additions: 132189, deletions: 3107, files: 924 };
  assert.deepEqual(D(local, { exists: true, state: 'MERGED', additions: 412, deletions: 57, changedFiles: 9 }), { taskId: 'x', additions: 412, deletions: 57, files: 9, src: 'pr' });
  assert.equal(D(local, { exists: true, state: 'OPEN', additions: 1, deletions: 1, changedFiles: 1 }), local, 'PR aberto: commits locais podem estar à frente — fica o diff');
  assert.equal(D(local, null), local);
  assert.equal(D(local, { exists: true, state: 'MERGED', changedFiles: 0 }), local, 'resposta sem arquivos não zera');
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(lib, /createdAt,additions,deletions,changedFiles"/, 'gh pr view traz o tamanho');
  assert.match(lib, /diffstat_from_pr\(&conn, &task_id, &v\);/, 'PR mergeado grava o tamanho na fonte única (diffstat)');
  assert.match(read('js/27-entregas.js'), /done && t\.prUrl && prCache\[t\.id\]===undefined/, 'a Entrega de uma integrada busca o PR');
});

// ---------- Prévia nunca branca ----------
const NV = new Function('esc', cut(read('js/57-navegador.js'), 'function nvHealthHtml(', '// @nav-puro-fim') + '\nreturn nvHealthHtml;')(esc);
test('Prévia: tarefa integrada com a pasta removida → cartão claro + "abrir a prévia da main"', () => {
  const h = NV({ verdict: 'gone', status: 404, rootStatus: 404, finished: true, tail: '' }, 'http://127.0.0.1:5241/u/painel');
  assert.match(h, /Esta tarefa já foi integrada e a pasta dela foi removida/);
  assert.match(h, /responde 404 em tudo/); assert.match(h, /127\.0\.0\.1:5241/);
  assert.match(h, /data-nvh="main">abrir a prévia da main/);
  assert.match(NV({ verdict: 'gone', status: null, finished: false }, 'http://localhost:3000/'), /A pasta desta tarefa foi removida/);
});
test('Prévia: tarefa em andamento com o servidor caído → "o servidor da prévia parou" + subir de novo + log curto', () => {
  const h = NV({ verdict: 'down', status: null, tail: 'linha 1\nError: Cannot find module \'vite\'\n' }, 'http://127.0.0.1:4412/');
  assert.match(h, /O servidor da prévia parou/); assert.match(h, /Ninguém responde/);
  assert.match(h, /data-nvh="up">subir de novo/);
  assert.match(h, /data-nvh="force">abrir mesmo assim/, 'falso positivo (servidor só de API) não prende a prévia');
  assert.match(h, /<pre class="mono nvhlog"[^>]*>linha 1\nError: Cannot find module &#39;vite&#39;<\/pre>/);
  assert.equal(NV({ verdict: 'ok' }, 'http://x'), '');
  assert.equal(NV(null, 'http://x'), '');
});
test('Prévia: a saúde é checada ANTES de montar o iframe; "main" liga o projeto na pasta principal e não morre no envSweep', () => {
  const nav = read('js/57-navegador.js'), amb = read('js/58-ambiente.js');
  const go = cut(nav, 'async function nvGo(', '\n}\n');
  assert.ok(go.indexOf("invokeQuiet('preview_health'") >= 0 && go.indexOf("invokeQuiet('preview_health'") < go.indexOf("invoke('browser_open'"), 'saúde antes do proxy/iframe');
  assert.match(amb, /invoke\('env_up',\{ taskId, main:s\.main \}\)/);
  assert.match(cut(amb, 'function envSweep(', '\n}\n'), /if\(s\.main\) continue;/);
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(lib, /preview_health,\n/, 'comando registrado');
  assert.match(lib, /orfaos::kill_in_dir\(wt\);\n\s*let _ = Command::new\("git"\)\.arg\("-C"\)\.arg\(repo\)\.args\(\["worktree", "remove"/, 'quem roda na worktree morre antes de ela sair');
  assert.match(lib, /std::thread::spawn\(orfaos::sweep_boot\);/, 'varredura de órfãos no boot');
});
