// node --test app/tests/publicar-release-marca.test.mjs
// "Publicar release pro time" no app instalado pelo deploy-local: a marca de instalação dev
// entra no .app do dono (antes de assinar) e NUNCA no portable dos colegas; o pacote diz de
// qual commit veio; as recusas chegam inteiras e em pt-BR no diálogo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync, realpathSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MARK = join(ROOT, 'scripts/build-mark.sh');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const sh = (cwd, script, ...args) => execFileSync('bash', ['-euo', 'pipefail', '-c', `source "${MARK}"; ${script}`, 'x', ...args], { cwd, encoding: 'utf8' });
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, encoding: 'utf8' }).trim();

function fonte() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sf-mark-')));
  git(d, 'init', '-q', '-b', 'main');
  writeFileSync(join(d, 'a.txt'), '1');
  git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'base');
  return d;
}
function app(d, name) {
  const a = join(d, 'dist', name);
  mkdirSync(join(a, 'Contents/Resources/engine'), { recursive: true });
  mkdirSync(join(a, 'Contents/MacOS'), { recursive: true });
  return a;
}
const markOf = (a) => join(a, 'Contents/Resources/dev-source.json');

test('deploy-local: a marca dev grava raiz do fonte + commit/branch; sujeira detectada', () => {
  const d = fonte();
  const a = app(d, 'Starfork.app');
  sh(d, 'write_dev_mark "$1" .', a);
  const m = JSON.parse(readFileSync(markOf(a), 'utf8'));
  assert.equal(m.source, d);
  assert.equal(m.commit, git(d, 'rev-parse', 'HEAD'));
  assert.equal(m.branch, 'main');
  assert.equal(m.dirty, false);
  writeFileSync(join(d, 'a.txt'), '2');
  sh(d, 'write_dev_mark "$1" "$2"', a, d);
  assert.equal(JSON.parse(readFileSync(markOf(a), 'utf8')).dirty, true);
  rmSync(d, { recursive: true, force: true });
});

test('package-app: o portable copiado do template do dono NÃO carrega a marca; o pacote diz o commit e o tamanho', () => {
  const d = fonte();
  const tpl = app(d, 'Starfork.app');
  sh(d, 'write_dev_mark "$1" .', tpl); // estado real: o template dist/Starfork.app vem do deploy-local
  const port = join(d, 'dist/Starfork-portable.app');
  cpSync(tpl, port, { recursive: true });
  sh(d, 'strip_dev_mark "$1"', port);
  assert.ok(!existsSync(markOf(port)), 'colega não é instalação dev');
  assert.ok(existsSync(markOf(tpl)), 'o app do dono continua marcado');
  writeFileSync(join(d, 'dist/Starfork-portable.zip'), 'PK'.repeat(50));
  sh(d, 'write_portable_meta . dist/Starfork-portable.zip dist/Starfork-portable.json');
  const m = JSON.parse(readFileSync(join(d, 'dist/Starfork-portable.json'), 'utf8'));
  assert.equal(m.commit, git(d, 'rev-parse', 'HEAD'));
  assert.equal(m.branch, 'main');
  assert.equal(m.dirty, false);
  assert.equal(m.zipBytes, 100);
  rmSync(d, { recursive: true, force: true });
});

test('ordem nos scripts: marca antes de assinar; portable sem marca antes de assinar; carimbo só depois do zip', () => {
  const dl = read('scripts/deploy-local.sh');
  const w = dl.indexOf('write_dev_mark "$APP"');
  assert.ok(w > 0, 'deploy-local grava a marca');
  assert.ok(w > dl.indexOf('cp app/src-tauri/target/release/cardume-app'), 'depois do binário');
  assert.ok(w < dl.indexOf('codesign --force'), 'ANTES de assinar (Resources é selado)');
  assert.ok(w < dl.indexOf('cp -R "$APP" /Applications/Starfork.app'));

  const pk = read('scripts/package-app.sh');
  const rmMeta = pk.indexOf('rm -f dist/Starfork-portable.json');
  const cp = pk.indexOf('cp -R "$TPL" "$PORT"');
  const strip = pk.indexOf('strip_dev_mark "$PORT"');
  const sign = pk.indexOf('codesign --force');
  const zip = pk.indexOf('ditto -c -k --sequesterRsrc');
  const meta = pk.indexOf('write_portable_meta');
  assert.ok(rmMeta > 0 && rmMeta < pk.indexOf('cargo build'), 'carimbo antigo some antes de compilar (pacote que falha não herda)');
  assert.ok(cp > 0 && strip > cp && strip < sign, 'remove a marca do portable depois de copiar o template e ANTES de assinar');
  assert.ok(meta > zip, 'carimbo do commit só depois do zip pronto');
  assert.ok(pk.indexOf('PKG_HEAD') < pk.indexOf('cargo build'), 'commit capturado antes do build');
});

test('recusas do publish_release chegam inteiras e sem cair num erro de catálogo errado', () => {
  const util = read('app/src/js/00-util.js');
  const noop = () => {};
  const ctx = { window: { addEventListener: noop }, document: { getElementById: () => null, addEventListener: noop },
    localStorage: { getItem: () => null, setItem: noop }, navigator: { platform: 'MacIntel', userAgent: '' }, console };
  vm.createContext(ctx); vm.runInContext(util, ctx);
  const rs = read('app/src-tauri/src/release.rs') + read('app/src-tauri/src/lib.rs').match(/fn publish_release[\s\S]*?\n}\n/)[0];
  const msgs = [...rs.matchAll(/"((?:[^"\\]|\\.)*?(?:rode scripts\/|merge na main|publique de novo)(?:[^"\\]|\\.)*?)"/g)].map(m => m[1]);
  assert.ok(msgs.length >= 10, `achou ${msgs.length} recusas`);
  for (const m of msgs) {
    assert.equal(ctx.humanErr(m, 'Não consegui publicar a versão').id, 'generic', `catálogo engoliria: ${m}`);
    assert.ok(!/[A-Za-z]{4,}ing\b|failed|missing/.test(m.replace(/\{[^}]*\}/g, '')), `pt-BR: ${m}`);
  }
  assert.ok(msgs.some(m => m.includes('este build tem commits fora da main (branch {branch}') && m.includes('a release do time só sai da main')));
  // o diálogo mostra a recusa inteira (humanErr genérico corta em 140 e sumiria o "o que fazer")
  const sw = read('app/src/js/33-switcher-projetos.js');
  const body = sw.slice(sw.indexOf("$id('pubGo').onclick"));
  assert.match(body, /ph\.id==='generic' \? 'Não consegui publicar a versão: '\+errText\(e\)/);
  assert.match(body, /\$\{esc\(shown\)\}/);
});
