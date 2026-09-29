// Rastreio de erros (app_errors): o que NÃO vai pra nuvem, anti-flood e "só o app de verdade reporta".
// `node --test app/tests/` — carrega o 00-util.js num contexto vm (mesmo esquema do human-err.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/js/00-util.js', import.meta.url), 'utf8');
const noop = () => {};
const ctx = {
  window: { addEventListener: noop },
  document: { getElementById: () => null, addEventListener: noop },
  localStorage: { getItem: () => null, setItem: noop },
  navigator: { platform: 'MacIntel', userAgent: '' },
  console,
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { errIsExpected, errRateOk, isRealApp, humanErr } = ctx;

test('estado legítimo / ação do usuário não é erro do produto', () => {
  assert.ok(errIsExpected('SECRET_UNBOUND:API_ISSUES:issues.exemplo.com'));
  assert.ok(errIsExpected('SECRET_MISSING:API_ISSUES'));
  assert.ok(errIsExpected('PROJECT_CHAT_STOPPED'));
  assert.ok(errIsExpected('ORQ_CHAT_STOPPED'));
  assert.ok(errIsExpected('GH_NO_ACCESS: a conta logada no gh não tem acesso a org/repo — …'));
  assert.ok(errIsExpected('a cópia de trabalho desta tarefa não existe mais (já foi limpa) — mande…'));
  assert.ok(errIsExpected('esta tarefa não está neste projeto (foi apagada ou pertence a outro projeto)'));
  assert.ok(errIsExpected('o arquivo src/a.ts não existe mais nesta cópia da tarefa (foi apagado ou renomeado)'));
  assert.ok(errIsExpected('artefato não encontrado: print.png (ainda não foi gerado ou já foi removido)'));
  assert.ok(errIsExpected('mesa_ask: rede indisponível (mock)'));
  // defeito de verdade continua indo
  assert.ok(!errIsExpected('Query returned no rows'));
  assert.ok(!errIsExpected("Cannot read properties of undefined (reading 'filter')"));
  assert.ok(!errIsExpected('gh pr view falhou: HTTP 500'));
});

test('anti-flood: mesma origem+mensagem 1x por janela e teto global', () => {
  const book = {};
  const t0 = 1_000_000;
  assert.ok(errRateOk(book, 'invoke:x|boom', t0, 600000, 3));
  assert.ok(!errRateOk(book, 'invoke:x|boom', t0 + 1000, 600000, 3), 'repetida dentro da janela');
  assert.ok(errRateOk(book, 'invoke:x|boom', t0 + 600001, 600000, 3), 'passou a janela');
  assert.ok(errRateOk(book, 'a|1', t0 + 600002, 600000, 3));
  assert.ok(errRateOk(book, 'b|2', t0 + 600003, 600000, 3));
  assert.ok(!errRateOk(book, 'c|3', t0 + 600004, 600000, 3), 'teto global da janela');
  // um laço de 500 chamadas vira no máximo `cap` registros
  const b2 = {}; let n = 0;
  for (let i = 0; i < 500; i++) if (errRateOk(b2, 'k' + i, t0 + i, 600000, 30)) n++;
  assert.equal(n, 30);
});

test('só o binário Tauri reporta (preview/harness com __TAURI__ falso não)', () => {
  const I = {};
  assert.ok(isRealApp({ __TAURI_INTERNALS__: I, location: { protocol: 'tauri:', hostname: 'localhost' } }));
  assert.ok(isRealApp({ __TAURI_INTERNALS__: I, location: { protocol: 'http:', hostname: 'tauri.localhost' } }));
  assert.ok(!isRealApp({ __TAURI__: {}, location: { protocol: 'http:', hostname: 'localhost' } }), 'shim do preview');
  assert.ok(!isRealApp({ __TAURI_INTERNALS__: I, location: { protocol: 'http:', hostname: 'localhost' } }));
  assert.ok(!isRealApp({ __SF_MOCK__: true, __TAURI_INTERNALS__: I, location: { protocol: 'tauri:' } }));
  assert.ok(!isRealApp(null));
});

test('gh sem acesso ao repo e worktree limpa viram mensagem acionável (não "Algo deu errado")', () => {
  const a = humanErr("gh pr view falhou: GraphQL: Could not resolve to a Repository with the name 'market4u-ti/x'.");
  assert.equal(a.id, 'gh-no-access');
  assert.match(a.msg, /gh auth switch/);
  assert.equal(humanErr('GH_NO_ACCESS: a conta logada no gh não tem acesso a o/r — rode `gh auth login`').id, 'gh-no-access');
  assert.equal(humanErr('a cópia de trabalho desta tarefa não existe mais (já foi limpa)').id, 'wt-gone');
});

test('nenhum window.confirm / confirm( solto no front (no Tauri vira SIM automático — use await askYes)', () => {
  const dir = new URL('../src/js/', import.meta.url);
  const bad = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    readFileSync(new URL(f, dir), 'utf8').split('\n').forEach((ln, i) => {
      const code = ln.replace(/\/\/.*$/, '');
      if (/(^|[^\w.])confirm\s*\(/.test(code.replace(/window\.confirm\(String\(message\)\)/, '')) || /plugin:dialog\|confirm/.test(code)) bad.push(f + ':' + (i + 1));
    });
  }
  assert.deepEqual(bad, []);
});
