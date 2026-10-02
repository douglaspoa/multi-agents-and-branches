// Painel Dispositivo no app (spec-dispositivo-no-app): HTML do painel docado (moldura, barra de botões redondos,
// menus, FPS, seletor do aparelho, alça de redimensionar), só-visualização quando o agente usa o emulador, gesto →
// evento, leitura do /stream, codec do SPS, a MENSAGEM da marcação (o que o agente recebe) — e a fonte: painel docado
// (não modal), espelho só com o painel visível, nada de quadro pelo Tauri.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/js/57-dispositivo.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const ws = readFileSync(new URL('../src/js/20-workspace-tarefa.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/css/91-dispositivo.css', import.meta.url), 'utf8');
const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const slice = (from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const escA = (s) => esc(s).replace(/"/g, '&quot;');

function load() {
  const code = slice('function dvParseFrames', '// ---------- integração com o workspace');
  return new Function('esc', 'escA', 'IC', code + '\nreturn { dvParseFrames, dvCodecFromAu, dvNorm, dvGesture, dvMarkMessage, dvDeviceLabel, dvPanelHtml, dvContentRect };')(esc, escA, { xs: '×' });
}
const F = load();
const INFO = {
  mobile: true, label: 'Expo', platforms: ['ios', 'android'],
  ios: { up: true, udid: 'U1', device: 'iPhone 17', runtime: 'iOS 26.5', deviceType: 'dt.17', options: [{ id: 'dt.17', label: 'iPhone 17 · iOS 26.5' }, { id: 'dt.17p', label: 'iPhone 17 Pro · iOS 26.5' }], touch: true },
  android: { up: true, serial: 'emulator-5584', avd: 'starfork-pixel', options: [{ id: 'starfork-pixel', label: 'starfork-pixel' }], busyBy: null },
};

test('painel iOS: cabeçalho (iOS|Android, FPS, expandir, fechar), seletor do aparelho, menus, moldura e a barra de botões redondos', () => {
  const h = F.dvPanelHtml({ plat: 'ios', info: INFO, up: true, caps: { touch: true }, zoom: 'fit' });
  assert.match(h, /class="dvresize" id="dvResize" title="Redimensionar"/, 'alça de redimensionar na borda');
  assert.match(h, /data-dvplat="ios" aria-selected="true"[\s\S]*data-dvplat="android"/);
  assert.match(h, /id="dvFps"[^>]*>FPS: 0</);
  assert.match(h, /id="dvExpand"/); assert.match(h, /id="dvClose"/);
  assert.match(h, /<select class="dvsel" id="dvSel"[^>]*><option value="dt\.17" selected>iPhone 17 · iOS 26\.5<\/option><option value="dt\.17p">/);
  for (const m of ['disp', 'exib', 'debug']) assert.match(h, new RegExp(`data-dvmenu="${m}"`));
  assert.match(h, /Dispositivo ▾[\s\S]*Exibição ▾[\s\S]*Debug ▾/);
  assert.match(h, /class="dvframe ios" id="dvFrame"><span class="dvside l1">[\s\S]*<canvas id="dvCanvas"/, 'moldura com botões laterais e a tela num canvas');
  const tools = h.slice(h.indexOf('class="dvtools"'));
  assert.deepEqual([...tools.matchAll(/class="dvb[^"]*" id="(\w+)"/g)].map((m) => m[1]), ['dvHome', 'dvMark', 'dvShot', 'dvRec', 'dvRotate', 'dvPower', 'dvPop2'], 'Home · lápis · câmera · vídeo · girar · energia · expandir (sem Voltar no iOS)');
  assert.match(tools, /id="dvRotate" title="girar: o Simulador iOS não gira[^"]*"[^>]*disabled/, 'iOS não gira — desabilitado com a explicação');
  assert.ok(!/class="dvro"/.test(h), 'com toque: sem aviso de só visualização');
});

test('painel Android: Voltar existe, girar habilitado; agente com a trava → SÓ VISUALIZAÇÃO (toques/print/vídeo desabilitados)', () => {
  const free = F.dvPanelHtml({ plat: 'android', info: INFO, up: true, caps: { touch: true, liveDrag: true } });
  assert.match(free, /id="dvBack"/); assert.ok(!/id="dvRotate"[^>]*disabled/.test(free));
  assert.match(free, /class="dvframe android"/);
  const busy = F.dvPanelHtml({ plat: 'android', info: INFO, up: true, caps: { touch: true, liveDrag: true }, busy: 'o agente da tarefa t9 está usando o emulador — só visualização' });
  assert.match(busy, /<div class="dvro">[\s\S]*o agente da tarefa t9 está usando o emulador — só visualização<\/div>/);
  for (const id of ['dvHome', 'dvBack', 'dvShot', 'dvRec', 'dvRotate', 'dvPower']) assert.match(busy, new RegExp(`id="${id}"[^>]*disabled`), id + ' desabilitado');
  assert.match(busy, /<select class="dvsel" id="dvSel"[^>]*disabled/, 'nem trocar o aparelho no meio do turno do agente');
  // AVD padrão ausente: opção vazia selecionada ("padrão") — nunca liga o 1º AVD da lista por engano
  const other = F.dvPanelHtml({ plat: 'android', info: { ...INFO, android: { up: false, options: [{ id: 'Pixel_9_da_pessoa', label: 'Pixel_9_da_pessoa' }] } }, up: false, caps: {} });
  assert.match(other, /<option value="" selected>padrão \(starfork-pixel\)<\/option><option value="Pixel_9_da_pessoa">/);
  assert.ok(!/id="dvMark"[^>]*disabled/.test(busy), 'marcar continua: é só olhar e pedir no chat');
});

test('desligado: ligar; ligando: espera; sem AXe no iOS: só visualização com a correção; marcação aberta: campo da instrução', () => {
  const off = F.dvPanelHtml({ plat: 'ios', info: INFO, up: false, caps: {} });
  assert.match(off, /Simulador iOS desta tarefa desligado[\s\S]*id="dvPowerOn">ligar/);
  assert.match(off, /id="dvShot"[^>]*disabled/);
  assert.match(F.dvPanelHtml({ plat: 'ios', info: INFO, up: false, starting: true, caps: {} }), /ligando… \(o 1º boot leva ~30 s\)/);
  const noAxe = F.dvPanelHtml({ plat: 'ios', info: { ...INFO, ios: { ...INFO.ios, touch: false, touchFix: 'pra tocar, instale o AXe: brew install cameroncooke/axe/axe' } }, up: true, caps: { touch: false } });
  assert.match(noAxe, /só visualização — pra tocar, instale o AXe: brew install cameroncooke\/axe\/axe/);
  const mark = F.dvPanelHtml({ plat: 'ios', info: INFO, up: true, caps: { touch: true }, mark: { rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } } });
  assert.match(mark, /O que mudar nesta área\?[\s\S]*id="dvMarkTx"[\s\S]*id="dvMarkSend">enviar pro chat/);
  assert.match(mark, /id="dvMark"[^>]*class|class="dvb on" id="dvMark"/, 'lápis aceso');
  const logs = F.dvPanelHtml({ plat: 'ios', info: INFO, up: true, caps: { touch: true }, logs: '<erro> x' });
  assert.match(logs, /Logs do app[\s\S]*&lt;erro> x/, 'log escapado');
});

test('gesto: toque curto vira tap; arrasto vira swipe com a duração; Android manda o up (arrasto ao vivo); ponteiro → 0..1', () => {
  assert.deepEqual(F.dvGesture({ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.5 }, 90, {}), { t: 'tap', x: 0.5, y: 0.5 });
  assert.deepEqual(F.dvGesture({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.2 }, 350.4, {}), { t: 'swipe', x: 0.5, y: 0.8, x2: 0.5, y2: 0.2, ms: 350 });
  assert.equal(F.dvGesture({ x: 0, y: 0 }, { x: 1, y: 1 }, 99999, {}).ms, 2000);
  assert.deepEqual(F.dvGesture({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.2 }, 300, { liveDrag: true }, 9), { t: 'up', x: 0.5, y: 0.2 }, 'arrasto ao vivo: fecha com o up');
  assert.deepEqual(F.dvGesture({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.2 }, 40, { liveDrag: true }, 0), { t: 'swipe', x: 0.5, y: 0.8, x2: 0.5, y2: 0.2, ms: 80 }, 'rápido demais (sem movimentos): deslizar inteiro');
  assert.deepEqual(F.dvGesture({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 40, { liveDrag: true }, 0), { t: 'up', x: 0.5, y: 0.5 }, 'toque no Android: down + up');
  assert.deepEqual(F.dvNorm(150, 250, { left: 100, top: 200, width: 200, height: 400 }), { x: 0.25, y: 0.125 });
  assert.deepEqual(F.dvNorm(0, 9999, { left: 100, top: 200, width: 200, height: 400 }), { x: 0, y: 1 });
  // imagem com faixas (object-fit: contain): o toque mapeia na área REAL da imagem
  const r = F.dvContentRect({ left: 0, top: 0, width: 300, height: 400 }, 1080, 2400); // imagem 0,45 → 180×400, faixas de 60 px
  assert.deepEqual(r, { left: 60, top: 0, width: 180, height: 400 });
  assert.deepEqual(F.dvNorm(60 + 90, 200, r), { x: 0.5, y: 0.5 });
});

test('/stream: pedaços completos saem, o resto espera; codec do SPS pro WebCodecs', () => {
  const f = (k, bytes) => [k, 0, 0, 0, bytes.length, ...bytes];
  const buf = Uint8Array.from([...f(0, [123, 125]), ...f(1, [1, 2, 3]), 3, 0, 0, 0, 9, 1]);
  const { frames, rest } = F.dvParseFrames(buf);
  assert.deepEqual(frames.map((x) => [x.kind, [...x.data]]), [[0, [123, 125]], [1, [1, 2, 3]]]);
  assert.deepEqual([...rest], [3, 0, 0, 0, 9, 1], 'pedaço incompleto fica pro próximo read');
  assert.equal(F.dvCodecFromAu(Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x29, 0, 0, 0, 1, 0x65])), 'avc1.42c029');
  assert.equal(F.dvCodecFromAu(Uint8Array.from([0, 0, 1, 0x41, 9])), null);
});

test('marcação → mensagem do chat: plataforma, aparelho, instrução, área em PONTOS (iOS) / PIXELS (Android) e em %', () => {
  const ios = F.dvMarkMessage({ instr: '  botão colado na borda — dê 16 px  ', plat: 'ios', device: 'iPhone 17 · iOS 26.5', rect: { x: 0.25, y: 0.5, w: 0.5, h: 0.1 }, screen: { w: 1206, h: 2622, ptScale: 3 } });
  assert.equal(ios, 'Ajuste de design no app — iOS · iPhone 17 · iOS 26.5:\nbotão colado na borda — dê 16 px\n\n' +
    'Área marcada: x 101–302, y 437–524 pt (tela 402×874 pt) — 25%–75% da largura, 50%–60% da altura. O recorte e a tela inteira estão anexados. Depois de mudar, prove com um print novo (cardume mobile shot).');
  const and = F.dvMarkMessage({ instr: 'x', plat: 'android', device: 'starfork-pixel', rect: { x: 0, y: 0, w: 1, h: 0.5 }, screen: { w: 1080, h: 2400, ptScale: 1 } });
  assert.match(and, /^Ajuste de design no app — Android · starfork-pixel:\nx\n\nÁrea marcada: x 0–1080, y 0–1200 px \(tela 1080×2400 px\)/);
  assert.match(F.dvMarkMessage({ instr: 'x', plat: 'ios', rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, screen: {} }), /Área marcada: x 10%–40%, y 20%–60%/, 'sem tamanho da tela: só %');
  assert.equal(F.dvDeviceLabel(INFO, 'ios'), 'iPhone 17 · iOS 26.5');
  assert.equal(F.dvDeviceLabel(INFO, 'android'), 'starfork-pixel');
});

test('fonte: painel DOCADO ao lado das colunas (não modal), botão no cabeçalho, script/CSS carregados, comandos registrados', () => {
  assert.match(html, /<div class="fwrow" id="fwRow">\s*<div class="fwcols" id="fwCols">[\s\S]*?<\/div>\s*<aside class="fwdev" id="fwDev" hidden/);
  assert.match(html, /id="fwDevBtn"[^>]*>[\s\S]*?Dispositivo<\/button>/);
  assert.match(html, /<script src="js\/56-piloto\.js"><\/script>[\s\S]*<script src="js\/57-dispositivo\.js"><\/script>/);
  assert.match(html, /href="css\/91-dispositivo\.css"/);
  assert.match(css, /\.fwdev\{--dvw:360px;width:var\(--dvw\)/); assert.match(css, /\.dvresize\{[^}]*cursor:col-resize/);
  assert.ok(!/position:fixed/.test(css), 'nada flutuante');
  assert.match(ws, /if\(typeof dvSync==='function'\) dvSync\(t\);/, 'renderWorkspace chama o painel');
  for (const c of ['device_cli', 'device_mirror_start', 'device_mirror_stop']) assert.match(lib, new RegExp(`device::${c},`));
});

test('fonte: espelho SÓ com o painel visível (aba da tarefa na frente, janela visível), um por vez, quadros fora do Tauri', () => {
  const run = slice('function dvShouldRun', 'function dvWatch');
  const start = slice('async function dvStartStream', 'function errShortDv');
  for (const cond of ['!el.hidden', 'v.d.up', 'fwVisible()', "document.visibilityState==='visible'", 'DV.host.offsetParent!==null']) assert.ok(run.includes(cond), 'condição: ' + cond);
  assert.match(src, /document\.addEventListener\('visibilitychange', \(\)=>\{ if\(document\.visibilityState!=='visible'\) dvStopStream\(\); else dvCheckRun\(\); \}\)/);
  // F0 do canvas: o vigia não é mais um setInterval de 1 s — reage a eventos e arma UM setTimeout pra próxima tentativa
  const chk = slice('function dvCheckRun', 'function dvWatch');
  assert.ok(!/setInterval/.test(chk) && !/setInterval/.test(slice('function dvWatch', 'document.addEventListener')), 'vigia sem laço');
  assert.match(chk, /DV\.retryT=setTimeout\(dvCheckRun, wait\+20\)/);
  // teto de 1 stream no app (gerente de recursos) e sessão presa à demanda
  assert.match(start, /cvRmTake\('stream', dvKey\(id\)/);
  assert.match(slice('function dvStopStream', 'async function dvPollState'), /cvRmDrop\('stream', dvKey\(s\.id\)\)/);
  assert.match(slice('function dvStopStream', 'async function dvPollState'), /s\.ctl\.abort\(\)/, 'parar = abortar o fetch (o servidor para a captura)');
  assert.match(start, /invoke\('device_mirror_start'/); assert.match(start, /fetch\(`\$\{sess\.base\}\/stream\?t=/);
  assert.ok(!/invoke\('[^']*frame/.test(src), 'nenhum comando Tauri por quadro');
  // imagem chegando com outra decodificando → guarda só a mais nova (sem fila crescendo)
  assert.match(slice('function dvOnFrame', 'function dvDraw'), /if\(sess\.decoding\)\{ sess\.pendingImg=f\.data; return; \}/);
  // painel só remonta quando a assinatura muda
  assert.match(slice('function dvRender', '// vigia barato'), /if\(sig!==DV\.sig\)\{/);
  // marcar → anexos pelo sistema existente + fwSendText
  const ms = slice('async function dvMarkSend', '// ---------- ações');
  assert.match(ms, /invoke\('import_attachment_data'/); assert.match(ms, /attPromptBlock\(atts\)/); assert.match(ms, /fwSendText\(id, text\)/);
  assert.match(ms, /\/snapshot\?t=/, 'tela inteira em resolução cheia');
});
