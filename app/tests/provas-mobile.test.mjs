// Provas mobile no app (spec-provas-mobile): vídeo vira <video controls> servido pelo protocolo sfart:// (sem base64),
// no visualizador, na prévia e na galeria; cada requisito mostra as miniaturas/vídeos das SUAS evidências; vídeo não
// sobe em base64 pro time; itens do Ambiente com texto de gente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const kan = read('23-kanban-artefatos-editor.js'), ent = read('27-entregas.js');
const slice = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const escA = (s) => esc(s).replace(/"/g, '&quot;');

function loadFront(tauri = true) {
  const window = tauri ? { __TAURI__: { core: { convertFileSrc: (p, proto) => `${proto}://localhost/${encodeURIComponent(p)}` } } } : {};
  const code = slice(kan, 'function pvKind', '// BUG-23') + '\n' + slice(ent, 'function enEvName', '// ---- lightbox das provas');
  return new Function('window', 'esc', 'escA', 'IC', 'artThumb', 'skeletonHtml', 'mdToHtml', 'csvTableHtml',
    code + '\nreturn { pvKind, artMediaUrl, artVideoHtml, artPreviewHtml, enEvName, enEvResolve, enEvMediaHtml, enVideoPlaying };')(
    window, esc, escA, { play: '▶', image: '🖼' }, (t, n) => 'data:image/png;base64,TH-' + n, () => 'SKEL', (t) => t, (t) => t);
}

test('vídeo: tipo próprio e player <video controls> pelo protocolo sfart:// (sem base64), sem precisar ler o arquivo', () => {
  const F = loadFront();
  assert.equal(F.pvKind('mobile-ios-1.mp4'), 'video');
  assert.equal(F.pvKind('demo.MOV'), 'video');
  assert.equal(F.pvKind('x.webm'), 'video');
  assert.equal(F.pvKind('mobile-ios-1.png'), 'image');
  assert.equal(F.artMediaUrl('t1', '.cardume/artifacts/mobile-ios-1.mp4'), 'sfart://localhost/' + encodeURIComponent('t1/mobile-ios-1.mp4'));
  const h = F.artPreviewHtml('mobile-ios-1.mp4', undefined, 't1');
  assert.match(h, /<video class="pvvid" controls preload="metadata" playsinline src="sfart:\/\/localhost\/t1%2Fmobile-ios-1\.mp4"/);
  assert.ok(!/base64/.test(h), 'vídeo nunca em data URL');
  // fora do Tauri (preview no navegador): URL do mesmo esquema, sem quebrar
  assert.match(loadFront(false).artMediaUrl('t1', 'a.mp4'), /^sfart:\/\/localhost\/t1%2Fa\.mp4$/);
});

test('entrega: cada requisito mostra a miniatura do print e o player do vídeo DAS SUAS evidências', () => {
  const F = loadFront();
  const arts = [{ name: 'mobile-ios-1-login.png', kind: 'image' }, { name: 'mobile-ios-1.mp4', kind: 'video' }, { name: 'notas.md', kind: 'doc' }];
  const imgs = arts.filter((a) => a.kind === 'image');
  const h = F.enEvMediaHtml({ id: 't1' }, ['.cardume/artifacts/mobile-ios-1-login.png', './mobile-ios-1.mp4', 't1/mobile-ios-1.mp4', 'notas.md', 'sumiu.png'], arts, imgs);
  assert.match(h, /<div class="en-evm">/);
  assert.match(h, /<button class="en-evi" data-lb="0" title="mobile-ios-1-login\.png"><img src="data:image\/png;base64,TH-mobile-ios-1-login\.png"/, 'print abre no lightbox');
  assert.equal((h.match(/<video /g) || []).length, 1, 'mesmo vídeo citado 2x aparece 1x');
  assert.match(h, /class="en-evvid" controls preload="metadata"/);
  assert.ok(!/notas\.md/.test(h), 'doc não vira mídia');
  // print citado que não existe: aviso legível, nunca caixa vazia
  assert.match(h, /<div class="en-evi en-evmiss" title="sumiu\.png"><span class="en-miss" role="img" aria-label="arquivo da prova não encontrado: sumiu\.png"/);
  assert.equal(F.enEvMediaHtml({ id: 't1' }, [], arts, imgs), '');
  assert.equal(F.enEvName('t1', 't1/sub/x.mp4'), 'sub/x.mp4');
  // nome do arquivo como último recurso SÓ quando um artefato bate (ambíguo → nada, não chuta)
  const two = [{ name: 'ios/a.png', kind: 'image' }, { name: 'android/a.png', kind: 'image' }, { name: 'sub/v.mp4', kind: 'video' }];
  assert.equal(F.enEvResolve('t1', 'a.png', two), null);
  assert.equal(F.enEvResolve('t1', 'v.mp4', two), 'sub/v.mp4');
  assert.match(F.enEvMediaHtml({ id: 't1' }, ['a.png'], two, []), /arquivo da prova não encontrado/, 'ambíguo: não chuta, avisa');
  // caminhos reais de evidência (Pou): relativo, com a pasta da tarefa e absoluto da worktree → o MESMO artefato
  const pou = [{ name: 'mobile-ios-1.png', kind: 'image' }];
  for (const e of ['mobile-ios-1.png', '.cardume/artifacts/mobile-ios-1.png', '.cardume/artifacts/t1/mobile-ios-1.png', '/Users/x/pou/.cardume/worktrees/t1/.cardume/artifacts/mobile-ios-1.png']) {
    assert.equal(F.enEvResolve('t1', e, pou), 'mobile-ios-1.png', e);
    assert.equal(F.artMediaUrl('t1', e), 'sfart://localhost/' + encodeURIComponent('t1/mobile-ios-1.png'), e);
  }
  // a miniatura leva a chave pro aviso em caso de 404
  assert.match(F.enEvMediaHtml({ id: 't1' }, ['mobile-ios-1.png'], pou, pou), /data-sfthumb="t1\|mobile-ios-1\.png"/);
  assert.equal(F.enVideoPlaying({ querySelectorAll: () => [{ paused: false, ended: false }] }), true);
  assert.equal(F.enVideoPlaying({ querySelectorAll: () => [{ paused: true, ended: false }] }), false);
});

test('fonte: visualizador toca vídeo; galeria de provas tem vídeos; docs não listam vídeo; time não recebe vídeo em base64', () => {
  assert.match(slice(kan, 'async function openArtifact', 'function closeArtifact'), /c\.kind==='video'[\s\S]*artVideoHtml\(taskId, name, 'artvid'\)/);
  const r = slice(ent, 'function fwRenderEntrega', '// ---- provas DENTRO');
  assert.match(r, /const vids=arts\.filter\(a=>pvKind\(a\.name\)==='video'\)/);
  assert.match(r, /vids\.map\(a=>`<div class="en-proof en-vproof"/);
  assert.match(r, /mp4\|m4v\|mov\|webm\)\$\/i\.test\(a\.name\)\)/, 'documentos sem os vídeos');
  assert.match(r, /enEvMediaHtml\(t, r\.evidence, arts, imgs\)/);
  assert.match(r, /const evNorm=new Set\(\[\.\.\.evidenceNames\]\.map\(e=>enEvResolve\(t\.id, e, arts\)\)/, 'selo "evidência" e mídia por requisito com a MESMA regra');
  assert.match(r, /enVideoPlaying\(main\)\)\{ main\._enPending=true; return; \}/, 'vídeo tocando não é reconstruído');
  assert.match(r, /artPreviewHtml|enPvHtml/);
  assert.match(ent, /artPreviewHtml\(a\.name, c, t\.id\)/, 'prévia recebe a tarefa (URL do vídeo)');
  const pub = slice(read('43-espaco-times.js'), 'async function cloudPublishProofs', "if(btn){ btn.disabled=true; }");
  assert.match(pub, /a\.kind!=='video'/);
  const times = read('43-espaco-times.js');
  const note = new Function(slice(times, 'function ctVideoNote', '\nasync function cloudPublishProofs') + '\nreturn ctVideoNote;')();
  assert.match(note({ evidence: ['mobile-ios-1.mp4'] }), /vídeo fica na máquina de quem fez/);
  assert.equal(note({ evidence: ['mobile-ios-1.png'] }), '');
  assert.match(times, /\$\{ctVideoNote\(x\)\}/, 'requisito da nuvem mostra o aviso');
});

test('Ambiente: itens mobile com texto de gente (o Rust manda os nomes do doctor do motor)', () => {
  const amb = read('11-ambiente-updater.js');
  const i = amb.indexOf('// @env-puro-inicio'), j = amb.indexOf('// @env-puro-fim');
  const { envWhat, envKind } = new Function(amb.slice(i, j) + '\nreturn { envWhat, envKind };')();
  assert.match(envWhat({ name: 'Simulador iOS (Xcode)' }), /iPhone[\s\S]*cada tarefa ganha o seu simulador/);
  assert.match(envWhat({ name: 'Emulador Android (SDK + AVD)' }), /Android[\s\S]*revezam/);
  assert.match(envWhat({ name: 'Maestro (fluxos de toque)' }), /Fluxos de toque/);
  assert.equal(envKind({ kind: 'opt', name: 'Maestro (fluxos de toque)' }), 'opt', 'opcional: não acende pendência');
});

test('miniatura que falha ao carregar (404 no sfart://) vira "arquivo da prova não encontrado" e fica lembrada', () => {
  const window = { __TAURI__: { core: { convertFileSrc: (p, proto) => `${proto}://localhost/${encodeURIComponent(p)}` } } };
  const code = slice(kan, 'function pvKind', '// BUG-23') + '\n' + slice(ent, 'function enEvName', '// ---- lightbox das provas');
  const F = new Function('window', 'esc', 'escA', 'IC', 'artThumb', code + '\nreturn { enThumbHtml, enMediaErr, artMissing };')(
    window, esc, escA, { play: '▶', image: '🖼' }, (t, n) => 'sfart://localhost/' + encodeURIComponent(t + '/' + n));
  assert.match(F.enThumbHtml('t1', 'cores-1.png', 'print'), /<img src="sfart:[^"]+" alt="print" data-sfthumb="t1\|cores-1\.png"/);
  const el = { dataset: { sfthumb: 't1|cores-1.png' }, outerHTML: '' };
  F.enMediaErr({ target: el });
  assert.match(el.outerHTML, /arquivo da prova não encontrado/);
  assert.ok(F.artMissing.has('t1|cores-1.png'));
  assert.match(F.enThumbHtml('t1', 'cores-1.png', 'print'), /en-miss/, 'próximo redesenho já vem com o aviso');
  F.enMediaErr({ target: { dataset: {} } }); // outra imagem qualquer: ignora
});
