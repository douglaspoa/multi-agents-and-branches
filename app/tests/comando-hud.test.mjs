// NÚCLEO DA VOZ do Comando: as regras puras (quem está com a palavra, as barras do anel, a frase ao lado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/js/89-comando-hud.js', import.meta.url), 'utf8');
const puro = src.slice(src.indexOf('// @hud-puro-inicio'), src.indexOf('// @hud-puro-fim'));
const H = new Function(puro + '\nreturn { cmdHudEstado, cmdHudBarras, cmdHudLinha, CMD_HUD_TX };')();

test('o estado do núcleo segue quem está com a palavra', () => {
  assert.equal(H.cmdHudEstado({ on: false, live: true }), 'off');
  assert.equal(H.cmdHudEstado({ on: true, speaking: true, busy: true, espera: true }), 'falando');
  assert.equal(H.cmdHudEstado({ on: true, busy: true, espera: true, live: true }), 'confirmar'); // o cartão espera o "sim": ele ouve, não "trabalha"
  assert.equal(H.cmdHudEstado({ on: true, busy: true }), 'pensando');
  assert.equal(H.cmdHudEstado({ on: true, live: true }), 'ouvindo');
  assert.equal(H.cmdHudEstado({ on: true }), 'pronto');
  ['falando', 'confirmar', 'pensando', 'ouvindo', 'pronto'].forEach(e => assert.ok(H.CMD_HUD_TX[e], 'estado sem rótulo: ' + e));
});

test('as barras ficam sempre entre 0 e 1 e reagem ao som', () => {
  for (const e of ['falando', 'confirmar', 'pensando', 'ouvindo', 'pronto', 'outro']) for (const t of [0, 0.37, 12.5, 999]) {
    const B = H.cmdHudBarras(56, t, e, 5, null); assert.equal(B.length, 56);
    B.forEach(v => assert.ok(v >= 0 && v <= 1 && Number.isFinite(v), e + ' fora da faixa: ' + v));
  }
  const media = B => B.reduce((a, b) => a + b, 0) / B.length;
  // falando: o espectro REAL manda — silêncio fica baixo, som alto sobe
  assert.ok(media(H.cmdHudBarras(56, 1, 'falando', 0, new Uint8Array(64).fill(240))) > 0.8);
  assert.ok(media(H.cmdHudBarras(56, 1, 'falando', 0, new Uint8Array(64))) < 0.1);
  // ouvindo: palavra entendida (energia) levanta o anel
  assert.ok(media(H.cmdHudBarras(56, 1, 'ouvindo', 1, null)) > media(H.cmdHudBarras(56, 1, 'ouvindo', 0, null)) + 0.2);
  // trabalhando: uma onda (poucas barras altas), não o anel inteiro aceso
  const P = H.cmdHudBarras(56, 1, 'pensando', 0, null); assert.ok(P.filter(v => v > 0.5).length < 16 && Math.max(...P) > 0.7);
});

test('a frase ao lado diz o que está acontecendo', () => {
  assert.equal(H.cmdHudLinha('ouvindo', {}), 'Pode falar.');
  assert.equal(H.cmdHudLinha('ouvindo', { ouvindo: ' abre  o código\nda frete ' }), 'abre o código da frete');
  assert.equal(H.cmdHudLinha('pensando', { agora: 'procurando “frete”…' }), 'procurando “frete”…');
  assert.equal(H.cmdHudLinha('pensando', {}), 'pensando…');
  assert.equal(H.cmdHudLinha('falando', { fala: 'Três tarefas abertas.' }), 'Três tarefas abertas.');
  assert.match(H.cmdHudLinha('confirmar', {}), /sim/);
});
