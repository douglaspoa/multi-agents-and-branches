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
