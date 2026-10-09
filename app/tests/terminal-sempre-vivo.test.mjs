// TERMINAL SEMPRE VIVO (mesa 09/10): toda tarefa com IA de terminal roda no PTY; tarefa de FUNDO legada vira terminal
// na 1ª tecla (clicar só foca); faixas de uma linha (fundo, assumindo, piloto, teto, plano, revisor); fluxos que
// começam sozinhos não pedem mais automático. Funções puras recortadas por marcador + a fiação conferida no código.
// `node --test app/tests/terminal-sempre-vivo.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const term = read('js/60-terminal.js'), ti = read('js/64-terminal-integrado.js');
const P = new Function(cut(term, '// @term-bar-puro-inicio', '// @term-bar-puro-fim') + '\nreturn { TERM_BAR, termLiveNote, termBgNote };')();

test('faixa do terminal vivo: teto pausado > plano > revisor falando; nada = sem faixa', () => {
  assert.equal(P.termLiveNote({ spec: {} }), null);
  assert.equal(P.termLiveNote(null), null);
  assert.equal(P.termLiveNote({ spec: { budgetHit: { cap: 1 } } }).text, 'Pausei: chegou a 80% do limite de gasto. Liberar e continuar?');
  assert.equal(P.termLiveNote({ spec: { needsYou: { kind: 'plano' } } }).text, 'A IA fez um plano · aprove no terminal (Enter) ou peça mudança');
  assert.equal(P.termLiveNote({ spec: { needsYou: { kind: 'teto' } } }), null, 'precisa de você de outro tipo: a faixa de cima mostra');
  const r = P.termLiveNote({ spec: { termRole: { role: 'reviewer', name: 'Iris', builder: 'Vega', round: 1, max: 2 } } });
  assert.equal(r.text, 'Iris está revisando o trabalho de Vega · rodada 1 de 2. Pode comentar.');
  assert.equal(P.termLiveNote({ spec: { budgetHit: {}, termRole: { role: 'reviewer' } } }).k, 'budget', 'teto vence (é o que trava)');
});

test('faixa da tarefa de fundo: frase da Bia, "trazendo" enquanto assume, piloto explica por que não', () => {
  assert.equal(P.termBgNote({ spec: {} }, false).text, 'A IA está trabalhando sozinha. Digite aqui para entrar na conversa.');
  assert.equal(P.termBgNote({ spec: {} }, true).text, 'Trazendo a IA pra cá… nada se perde.');
  assert.match(P.termBgNote({ spec: { autopilot: true } }, false).text, /piloto automático/);
  for (const k of Object.keys(P.TERM_BAR)) assert.doesNotMatch(P.TERM_BAR[k], /headless|PTY|SIGTERM|segundo plano/i, 'sem texto técnico: ' + k);
});

test('regra única: o front lê o modo RESOLVIDO (t.termRun) e o fundo de verdade (t.bg)', () => {
  assert.match(term, /function termModeOf\(t\)\{ return !!\(t && \(t\.termRun \|\| \(t\.spec && t\.spec\.termMode === 'terminal'\)\)\); \}/);
  assert.match(term, /function termHeadless\(t\)\{ if\(!t\) return false; if\(typeof t\.bg==='boolean'\) return t\.bg;/);
  assert.doesNotMatch(term + ti, /o histórico se atualiza sozinho/, 'o estado "segundo plano · o histórico se atualiza sozinho" sumiu');
});

test('assumir: a 1ª tecla no terminal de fundo chama term_takeover antes de abrir; clicar só foca; piloto segura', () => {
  assert.match(ti, /tiGoLive\(taskId, \{ takeover:termHeadless\(tiTask\(taskId\)\) \}\);\n\}/, 'tecla no histórico de fundo → assume');
  assert.match(term, /if\(o\.takeover\)\{ st\.taking=true;[^\n]*\n\s*try\{ await invoke\('term_takeover',\{ taskId, cols, rows \}\); \}/);
  assert.ok(term.indexOf("invoke('term_takeover'") < term.indexOf("invoke('term_open',{ taskId, cols, rows, resume:true, quiet:!!o.quiet })"), 'assume ANTES de abrir');
  const up = cut(ti, "st.box.addEventListener('mouseup'", '});');
  assert.match(up, /if\(!tiResumable\(taskId\)\)\{ const t=tiTask\(taskId\); if\(termHeadless\(t\)\) tiHint\(taskId, termBgNote\(t, false\)\.text\); return; \}/, 'clique acidental não mata um turno longo');
  assert.match(cut(ti, 'function tiBlockedWhy(taskId){', '\n}'), /t\.spec && t\.spec\.autopilot\) return TERM_BAR\.autopilot/);
  assert.match(term, /data-termtake="\$\{escA\(taskId\)\}">tentar de novo</, 'falhou: a faixa oferece tentar de novo (nunca trava)');
});

test('fila: aviso "anotado" quando a IA está ocupada; chip/botão em tarefa de fundo assume e o xterm vira o vivo', () => {
  assert.match(ti, /toast\('anotado — entra quando a IA terminar o que está fazendo', 'info'\)/);
  assert.match(ti, /if\(termHeadless\(t\)\)\{ const ok=\(typeof fwSendText==='function'\) \? await fwSendText\(taskId, text\) : false; if\(ok && typeof termGoLive==='function'\) termGoLive\(taskId\); return ok; \}/);
});

test('fluxos que começam sozinhos rodam no terminal (sem termMode:auto) e Ajustes tem o revisor automático', () => {
  assert.doesNotMatch(read('js/43-espaco-times.js'), /payload\.termMode='auto'/);
  assert.doesNotMatch(read('js/34-orquestrador.js'), /termMode:'auto'/);
  assert.doesNotMatch(read('js/59-ideia.js'), /termMode='auto'/);
  const aj = read('js/67-ajustes.js');
  assert.match(aj, /ajSw\('cfgTermRev', false, 'revisor entra sozinho'\)/, 'desligado por padrão (veto do Rafa até o teste de fumaça)');
  assert.match(aj, /ajSetting\('termRevisorAuto', tr\.checked\?'1':'0'\)/);
});
