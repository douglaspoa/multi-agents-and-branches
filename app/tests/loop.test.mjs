// DETECTOR DE LOOP na tela (70-loop + 00-util + 22 + 60-ciclo + 10-core + 64 + Ajustes). COMPORTAMENTO das funções puras
// recortadas por marcador + a fiação conferida no código. Nenhuma IA, nenhum DOM. `node --test app/tests/loop.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const util = read('js/00-util.js'), loop = read('js/70-loop.js'), ciclo = read('js/60-ciclo.js'), core = read('js/10-core.js'),
  ti = read('js/64-terminal-integrado.js'), aj = read('js/67-ajustes.js'), ct = read('js/66-central-tabela.js'), html = read('index.html'), qf = read('js/22-quadro-fluxo.js');

// a fonte única do "aguardando você" (00-util) + o pedaço puro do 70-loop, juntos como no app
const U = new Function('pendingOf', cut(util, 'const AGUARDA_ST=', 'function taskProntaRevisar') + '\nreturn { taskAguardaVoce, taskLoop, taskEncerrada };')(() => []);
const L = new Function('esc', 'escA', 'taskLoop', 'ACTIVE_ST', 'IC', cut(loop, '// @loop-puro-inicio', '// @loop-puro-fim') + '\nreturn { loopBannerHtml, loopNews, loopTitle, loopShouldPause, LOOP_HINT, LOOP_REVIEW_MSG, LOOP_FRESH_MS };')(esc, esc, U.taskLoop, new Set(['running', 'thinking', 'queued']), { x: '<svg></svg>' });
// o selo efetivo (22 taskSt) com o resto do app de mentira
const taskSt = new Function('pendingOf', 'flowBucket', 'taskLoop', cut(qf, 'function taskSt(t){', '\n}\n') + '\n}\nreturn taskSt;')(() => [], (t) => (t.prUrl && t.status !== 'merged' ? 'praberto' : 'andamento'), U.taskLoop);

const NOW = 1_800_000_000_000;
const LOOP = { kind: 'erro', n: 3, what: "`npm test` falhou 3× com: Error: Cannot find module './x'", sig: 's', at: NOW - 1000 };
const T = (o) => ({ id: 't1', title: 'Login', status: 'running', spec: {}, loop: LOOP, ...o });

test('tarefa em loop = "aguardando você" pela fonte única; NUNCA concluída nem com PR aberto', () => {
  assert.equal(U.taskAguardaVoce(T()), true);
  assert.equal(U.taskAguardaVoce(T({ loop: undefined })), false, 'sem aviso: rodando normal');
  assert.equal(U.taskAguardaVoce(T({ loop: null })), false);
  assert.equal(U.taskAguardaVoce(T({ status: 'merged' })), false, 'integrada');
  assert.equal(U.taskAguardaVoce(T({ status: 'review', flag: 'closed' })), false, 'concluída à mão');
  assert.equal(U.taskAguardaVoce(T({ status: 'review', prUrl: 'https://github.com/o/r/pull/7' })), false, 'PR aberto');
  assert.equal(U.taskLoop(T({ spec: { loop: LOOP }, loop: undefined })), null, 'o aviso não mora mais no spec');
  assert.equal(taskSt(T()), 'needs-you', 'selo "precisa de você" do STATUS_META');
  assert.equal(taskSt(T({ prUrl: 'https://x/pull/1', status: 'review' })), 'pr-open', 'PR aberto vence o loop');
  assert.equal(taskSt(T({ flag: 'closed', status: 'review' })), 'closed', 'concluída vence o loop');
  assert.match(ct, /needsYou:asking \|\| CT_NEEDS_ST\.has\(t\.status\) \|\| !!\(typeof taskLoop==='function' && taskLoop\(t\)\)/, 'a barra da Central também');
  assert.doesNotMatch(loop, /STATUS_META|AGUARDA_ST=/, 'nenhum mapa novo de status');
});

test('o aviso: título com a contagem, a frase da falha (comando em código, escapada) e as ações', () => {
  const h = L.loopBannerHtml(T());
  assert.match(h, /A IA está repetindo o mesmo erro \(3×\)/);
  assert.match(h, /<code>npm test<\/code> falhou 3× com: Error: Cannot find module &#39;\.\/x&#39;/);
  for (const k of ['hint', 'review', 'stop', 'dismiss']) assert.match(h, new RegExp(`data-loop="${k}"`));
  assert.doesNotMatch(L.loopBannerHtml(T({ status: 'review', busy: false })), /data-loop="stop"/, 'parada: sem "Parar"');
  assert.equal(L.loopBannerHtml(T({ loop: null })), '');
  assert.doesNotMatch(L.loopBannerHtml(T({ loop: { ...LOOP, what: '`<img src=x onerror=1>` falhou' } })), /<img/, 'texto do erro nunca vira HTML');
  assert.doesNotMatch(loop, /repete|mesma ação/, 'a regra "mesma ação 4×" saiu');
});

test('notifica/pausa só tarefa JÁ VISTA com aviso NOVO e RECENTE (1ª leitura, troca de projeto e aviso velho só aprendem)', () => {
  const seen = {};
  assert.deepEqual(L.loopNews(seen, [T()], NOW), [], '1ª leitura: aprende, não notifica nem pausa');
  assert.deepEqual(L.loopNews(seen, [T()], NOW), [], 'mesmo episódio');
  assert.deepEqual(L.loopNews(seen, [T({ loop: { ...LOOP, at: NOW - 500 } })], NOW).map((t) => t.id), ['t1'], 'episódio novo');
  assert.deepEqual(L.loopNews(seen, [T({ id: 't2', loop: { ...LOOP, at: NOW } })], NOW), [], 'tarefa que aparece agora (troca de projeto) com aviso: só aprende');
  const s2 = { t3: 0 };
  assert.deepEqual(L.loopNews(s2, [T({ id: 't3', loop: { ...LOOP, at: NOW - L.LOOP_FRESH_MS - 1 } })], NOW), [], 'aviso velho: nunca');
  assert.deepEqual(L.loopNews(seen, [T({ loop: null })], NOW), []);
  assert.equal(L.loopNews(seen, [T({ loop: { ...LOOP, at: NOW - 100 } })], NOW).length, 1, 'zerou e voltou = novo');
});

test('pausa automática: só ligada, só trabalhando, NUNCA no piloto automático', () => {
  assert.equal(L.loopShouldPause(T(), true), true);
  assert.equal(L.loopShouldPause(T(), false), false, 'padrão desligado');
  assert.equal(L.loopShouldPause(T({ status: 'review', busy: false }), true), false, 'já parada');
  assert.equal(L.loopShouldPause(T({ spec: { autopilot: { id: 'p1' } } }), true), false, 'piloto automático: só avisa');
  assert.match(loop, /function loopPauseOn\(\)\{ return lsGet\('loopPause'\)==='1'; \}/);
  assert.match(loop, /if\(loopShouldPause\(t, loopPauseOn\(\)\)\) loopPause\(t\)/);
  assert.match(cut(loop, 'async function loopPause(t){', '\n}\n'), /budgetQuiet\.add\(t\.id\)[\s\S]*invoke\('stop_task',\{ taskId:t\.id, keepLoop:true \}\)/, 'a pausa deixa o aviso (keepLoop)');
});

test('ações: dica no compositor, revisão pelo caminho do terminal integrado, parar e dispensar limpam pelo app', () => {
  assert.equal(L.LOOP_HINT, 'Pare e tente outra abordagem: ');
  assert.match(L.LOOP_REVIEW_MSG, /resuma[\s\S]*abordagem diferente/);
  assert.match(loop, /fwDraft\[t\.id\]=cur\.startsWith\(LOOP_HINT\)\?cur:LOOP_HINT\+cur/);
  assert.match(loop, /const i0=\$id\('fwInput'\); if\(i0 && i0\.dataset\.tk===t\.id\) i0\.value=fwDraft\[t\.id\];/, 'a dica sobrevive ao re-render');
  assert.match(loop, /k==='review'\)\{ const ok=\(typeof tiSend==='function'\)\?await tiSend\(t\.id, LOOP_REVIEW_MSG, \{ interrupt:true \}\)/);
  assert.match(loop, /else if\(k==='stop'\) await stopTask\(t\.id\);/, 'parar = o stopTask de sempre (stop_task zera no Rust)');
  assert.match(loop, /async function loopClear\(t\)\{ await invoke\('loop_clear',\{ taskId:t\.id \}\)/, 'dispensar não toca no spec');
  assert.doesNotMatch(loop, /patch_task_spec/);
});

test('Pedir revisão: Esc SÓ com a IA ocupada (estado fresco do terminal); parada, só manda a mensagem', () => {
  const send = cut(ti, 'async function tiSend(taskId, text, o){', '\n}\n');
  assert.match(send, /if\(o && o\.interrupt && live\)\{ try\{ const s=await invokeQuiet\('term_status', \{ taskId \}\); if\(s\)\{ TI\.stat\[taskId\]=s; now=!!s\.busy; \} \}catch\(_\)\{ \} \}/);
  assert.match(send, /mode:now\?'interrupt':'queue'/);
  assert.match(send, /termHeadless\(t\)[\s\S]*fwSendText\(taskId, text\)/, 'automático: talk_task (fwSendText)');
});

test('fiação: faixa do ciclo ao vivo, notificação, snapshot e Ajustes', () => {
  const paint = cut(ciclo, 'function cicloPaint(t){', '\n}\n');
  assert.match(paint, /const loop=\(typeof loopBannerHtml==='function'\)\?loopBannerHtml\(t\):''/);
  assert.match(paint, /const sig=t\.id\+'\|'\+loop\+/);
  assert.match(paint, /host\.innerHTML=loop\+strip/);
  assert.match(cut(core, 'function detectNotifs(snap){', '\nconst prevEvTop'), /loopWatch\(tasks\)/);
  assert.match(cut(core, 'function snapSig(){', '\n}\n'), /x\.loop&&x\.loop\.at/, 'o aviso que some sem evento novo repinta lateral/Central');
  assert.match(cut(read('js/20-workspace-tarefa.js'), 'async function fwLiveUpdate(){', '\n}\n'), /loopLivePaint\(t\);[^\n]*\n\s*if\(sig===fwLiveSig\) return;/);
  const modo = cut(aj, 'function ajRenderModo(host){', '\n}\n');
  assert.match(modo, /Pausar a tarefa quando a IA repetir o mesmo erro/);
  assert.match(modo, /lsSet\('loopPause', lp\.checked\?'1':'0'\)/);
  assert.match(html, /<script src="js\/69-linha\.js"><\/script>\n<script src="js\/70-loop\.js"><\/script>/);
  assert.doesNotMatch(loop, /setInterval|setTimeout\([^,]+,\s*[1-9]\d{3,}/, 'sem polling novo');
});

test('motor e app: hooks registrados, aviso fora do spec, parar/interromper zeram', () => {
  const src = readFileSync(new URL('../../src/terminal.ts', import.meta.url), 'utf8');
  assert.match(src, /CLAUDE_HOOK_EVENTS = \[[^\]]*"PostToolUseFailure"/);
  assert.match(src, /loopReset\(store, taskId, \{ quick: true \}\)[\s\S]*loopTurnEnd\(store, taskId, \{ quick: true \}\)[\s\S]*loopTrack\(store, taskId, attemptFromHook\(event, p\), \{ quick: true \}\)/, 'hook: caminho rápido');
  const rs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.doesNotMatch(cut(rs, 'fn task_front_spec(', '\n}\n'), /"loop"/, 'o aviso NÃO vem do spec');
  assert.match(rs, /let w = loop_warns\(&conn\);/);
  assert.match(cut(rs, 'fn stop_task(', '\n}\n'), /if keep_loop != Some\(true\) \{ loop_clear_db\(&state, &task_id\); \}/);
  assert.match(cut(rs, 'fn abort_task(', '\n}\n'), /loop_clear_db\(&state, &task_id\);/);
  assert.match(readFileSync(new URL('../src-tauri/src/term.rs', import.meta.url), 'utf8'), /fn term_interrupt\([^\n]*crate::loop_clear_db\(&state, &task_id\)/);
});

test('nenhum // engolindo código na mesma linha nos arquivos tocados', () => {
  for (const [name, s] of [['70-loop.js', loop]]) {
    s.split('\n').forEach((ln, i) => {
      const c = ln.indexOf('//'); if (c < 0 || /^\s*\/\//.test(ln) || /https?:\/\//.test(ln)) return;
      assert.doesNotMatch(ln.slice(c + 2), /[;{}]\s*(const|let|if|for|return|await|function)\b/, `${name}:${i + 1} código depois de //`);
    });
  }
});
