// DETECTOR DE LOOP na tela (70-loop + 00-util + 60-ciclo + 10-core + Ajustes). Funções puras recortadas por marcador
// + a fiação conferida no código. Nenhuma IA, nenhum DOM. `node --test app/tests/loop.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const util = read('js/00-util.js'), loop = read('js/70-loop.js'), ciclo = read('js/60-ciclo.js'), core = read('js/10-core.js'),
  ti = read('js/64-terminal-integrado.js'), aj = read('js/67-ajustes.js'), ct = read('js/66-central-tabela.js'), html = read('index.html');

// a fonte única do "aguardando você" (00-util) + o pedaço puro do 70-loop, juntos como no app
const U = new Function('pendingOf', cut(util, 'const AGUARDA_ST=', 'function taskProntaRevisar') + '\nreturn { taskAguardaVoce, taskLoop, taskEncerrada };')(() => []);
const L = new Function('esc', 'escA', 'taskLoop', 'ACTIVE_ST', 'IC', cut(loop, '// @loop-puro-inicio', '// @loop-puro-fim') + '\nreturn { loopBannerHtml, loopNews, loopTitle, LOOP_HINT, LOOP_REVIEW_MSG };')(esc, esc, U.taskLoop, new Set(['running', 'thinking', 'queued']), { x: '<svg></svg>' });

const LOOP = { kind: 'erro', n: 3, what: "`npm test` falhou 3× com: Error: Cannot find module './x'", sig: 's', at: 111 };
const T = (o) => ({ id: 't1', title: 'Login', status: 'running', spec: { loop: LOOP }, ...o });

test('tarefa em loop entra no "aguardando você" (a MESMA regra da lateral, Central e contadores) — sem status novo', () => {
  assert.equal(U.taskAguardaVoce(T()), true);
  assert.equal(U.taskAguardaVoce(T({ spec: {} })), false, 'sem aviso: rodando normal');
  assert.equal(U.taskAguardaVoce(T({ spec: { loop: null } })), false, 'aviso apagado (null)');
  assert.equal(U.taskAguardaVoce(T({ status: 'merged' })), false, 'encerrada não pede nada');
  assert.equal(U.taskAguardaVoce(T({ status: 'draft' })), false);
  assert.equal(U.taskLoop(T({ flag: 'closed', status: 'review' })), null);
  assert.match(ct, /needsYou:asking \|\| CT_NEEDS_ST\.has\(t\.status\) \|\| !!\(typeof taskLoop==='function' && taskLoop\(t\)\)/, 'a barra da Central também');
  assert.doesNotMatch(loop, /STATUS_META|AGUARDA_ST=/, 'nenhum mapa novo de status');
  assert.match(read('js/22-quadro-fluxo.js'), /if\(pendingOf\(t\.id\)\.length\) return 'asking';\n\s*if\(typeof taskLoop==='function' && taskLoop\(t\)\) return 'needs-you';/, 'selo efetivo (lateral/Central): "precisa de você" do STATUS_META');
});

test('o aviso: título com a contagem, a frase da falha (comando em código, escapada) e as 3 ações', () => {
  const h = L.loopBannerHtml(T());
  assert.match(h, /A IA está repetindo o mesmo erro \(3×\)/);
  assert.match(h, /<code>npm test<\/code> falhou 3× com: Error: Cannot find module &#39;\.\/x&#39;/);
  for (const k of ['hint', 'review', 'stop', 'dismiss']) assert.match(h, new RegExp(`data-loop="${k}"`));
  assert.match(h, />Dar uma dica</); assert.match(h, />Pedir revisão</); assert.match(h, />Parar</);
  assert.doesNotMatch(L.loopBannerHtml(T({ status: 'review', busy: false })), /data-loop="stop"/, 'parada: sem "Parar"');
  assert.equal(L.loopBannerHtml(T({ spec: {} })), '');
  assert.match(L.loopBannerHtml(T({ spec: { loop: { ...LOOP, kind: 'repete', n: 4, what: 'ler `a.ts` 4× seguidas' } } })), /repetindo a mesma ação \(4×\)/);
  const evil = L.loopBannerHtml(T({ spec: { loop: { ...LOOP, what: '`<img src=x onerror=1>` falhou' } } }));
  assert.doesNotMatch(evil, /<img/, 'texto do erro nunca vira HTML');
});

test('notificação/pausa só no episódio NOVO (a 1ª leitura só aprende; o mesmo episódio não repete)', () => {
  const seen = {};
  assert.deepEqual(L.loopNews(seen, [T()], false), [], 'boot: não notifica o que já estava lá');
  assert.deepEqual(L.loopNews(seen, [T()], true), [], 'mesmo episódio');
  assert.deepEqual(L.loopNews(seen, [T({ spec: { loop: { ...LOOP, at: 222 } } })], true).map((t) => t.id), ['t1'], 'episódio novo');
  assert.deepEqual(L.loopNews(seen, [T({ spec: {} })], true), []);
  assert.equal(L.loopNews(seen, [T({ spec: { loop: { ...LOOP, at: 222 } } })], true).length, 1, 'zerou e voltou = novo');
});

test('fiação: faixa do ciclo (terminal e Conversa), notificação, ações e Ajustes', () => {
  const paint = cut(ciclo, 'function cicloPaint(t){', '\n}\n');
  assert.match(paint, /const loop=\(typeof loopBannerHtml==='function'\)\?loopBannerHtml\(t\):''/);
  assert.match(paint, /const sig=t\.id\+'\|'\+loop\+/, 'repinta quando o aviso muda');
  assert.match(paint, /host\.innerHTML=loop\+strip/);
  assert.match(paint, /loopWire\(host, t\)/);
  assert.match(cut(core, 'function detectNotifs(snap){', '\nconst prevEvTop'), /loopWatch\(tasks\)/);
  assert.match(cut(core, 'function snapSig(){', '\n}\n'), /x\.spec&&x\.spec\.loop&&x\.spec\.loop\.at/, 'o aviso que some sem evento novo repinta lateral/Central');
  assert.match(cut(read('js/20-workspace-tarefa.js'), 'async function fwLiveUpdate(){', '\n}\n'), /loopLivePaint\(t\);[^\n]*\n\s*if\(sig===fwLiveSig\) return;/, 'aba aberta: entra/sai ao vivo');
  assert.match(loop, /function loopLivePaint\(t\)\{[\s\S]*if\(host\.__loopK===k\) return; host\.__loopK=k; cicloPaint\(t\);/);
  assert.match(loop, /const i0=\$id\('fwInput'\); if\(i0 && i0\.dataset\.tk===t\.id\) i0\.value=fwDraft\[t\.id\];/, 'a dica sobrevive ao re-render que copia o campo pro rascunho');
  assert.match(loop, /function loopWatch\(tasks\)\{[\s\S]*pushNotif\(loopTitle\(l\)[\s\S]*loopPauseOn\(\) && loopWorking\(t\)\) loopPause\(t\)/);
  assert.match(loop, /async function loopPause\(t\)\{[\s\S]*budgetQuiet\.add\(t\.id\)[\s\S]*invoke\('stop_task'/, 'pausa = o mesmo stop_task do Parar, sem a notificação falsa de "pronta"');
  assert.match(loop, /k==='review'\)\{ const ok=\(typeof tiSend==='function'\)\?await tiSend\(t\.id, LOOP_REVIEW_MSG, \{ interrupt:true \}\)/);
  assert.match(loop, /k==='stop'\)\{ await stopTask\(t\.id\)/);
  assert.match(loop, /fwDraft\[t\.id\]=cur\.startsWith\(LOOP_HINT\)\?cur:LOOP_HINT\+cur/);
  assert.equal(L.LOOP_HINT, 'Pare e tente outra abordagem: ');
  assert.match(L.LOOP_REVIEW_MSG, /resuma[\s\S]*abordagem diferente/);
  const send = cut(ti, 'async function tiSend(taskId, text, o){', '\n}\n');
  assert.match(send, /mode:now\?'interrupt':'queue'/, 'Pedir revisão interrompe o turno no terminal');
  assert.match(send, /termHeadless\(t\)[\s\S]*fwSendText\(taskId, text\)/, 'automático: talk_task (fwSendText)');
  const modo = cut(aj, 'function ajRenderModo(host){', '\n}\n');
  assert.match(modo, /Pausar a tarefa quando a IA repetir o mesmo erro/);
  assert.match(modo, /ajSw\('cfgLoopPause', typeof loopPauseOn==='function' && loopPauseOn\(\), 'pausar'\)/);
  assert.match(modo, /lsSet\('loopPause', lp\.checked\?'1':'0'\)/);
  assert.match(loop, /function loopPauseOn\(\)\{ return lsGet\('loopPause'\)==='1'; \}/, 'padrão desligado');
  assert.match(html, /<script src="js\/69-linha\.js"><\/script>\n<script src="js\/70-loop\.js"><\/script>/);
  assert.doesNotMatch(loop, /setInterval|setTimeout\([^,]+,\s*[1-9]\d{3,}/, 'sem polling novo');
});

test('motor e snapshot: o Claude Code manda PostToolUseFailure pro hook; spec.loop chega no front', () => {
  const src = readFileSync(new URL('../../src/terminal.ts', import.meta.url), 'utf8');
  assert.match(src, /CLAUDE_HOOK_EVENTS = \[[^\]]*"PostToolUseFailure"/);
  assert.match(src, /if \(event === "UserPromptSubmit"\) loopReset\(store, taskId\);\n\s*else loopTrack\(store, taskId, attemptFromHook\(event, p\)\);/);
  const rs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(cut(rs, 'fn task_front_spec(', '\n}\n'), /"roleRuns", "loop"\]/);
});

test('nenhum // engolindo código na mesma linha nos arquivos tocados', () => {
  for (const [name, s] of [['70-loop.js', loop]]) {
    s.split('\n').forEach((ln, i) => {
      const c = ln.indexOf('//'); if (c < 0 || /^\s*\/\//.test(ln) || /https?:\/\//.test(ln)) return;
      const after = ln.slice(c + 2);
      assert.doesNotMatch(after, /[;{}]\s*(const|let|if|for|return|await|function)\b/, `${name}:${i + 1} código depois de //`);
    });
  }
});
