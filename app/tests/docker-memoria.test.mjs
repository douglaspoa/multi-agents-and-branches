// Ajustes › Docker e memória (05/11): quanto cada projeto ocupa no Docker e "parar" por projeto
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const JS = read('js/67-ajustes.js');
const pure = JS.slice(JS.indexOf('// @docker-puro-inicio'), JS.indexOf('// @docker-puro-fim'));
const M = new Function(pure + '\nreturn { dkMb, dkNivel, DK_KIND };')();
test('tamanho legível e nível de uso', () => {
  assert.equal(M.dkMb(245.4), '245 MB'); assert.equal(M.dkMb(2662), '2,6 GB');
  assert.equal(M.dkNivel(5700, 7936), 'medio'); assert.equal(M.dkNivel(6200, 7936), 'alto'); assert.equal(M.dkNivel(300, 7936), 'ok'); assert.equal(M.dkNivel(300, 0), 'ok');
});
test('seção registrada, pede confirmação antes de parar e chama o comando', () => {
  assert.match(JS, /\{ id:'docker', grp:'pc', label:'Docker e memória'/);
  assert.match(JS, /docker:ajRenderDocker/);
  assert.match(JS, /await askYes\(`Parar \$\{p\.name\}/);
  assert.match(JS, /invoke\('docker_stop_project', \{ name:p\.name \}\)/);
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(lib, /docker_mem::docker_usage,/); assert.match(lib, /docker_mem::docker_stop_project,/);
});
test('Supabase local do repo sem analytics', () => {
  const cfg = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
  assert.match(cfg, /\[analytics\]\nenabled = false/);
});
