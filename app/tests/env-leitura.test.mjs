// node --test app/tests/env-leitura.test.mjs — "pode ler o .env" por projeto (53-teto-protecao)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/js/53-teto-protecao.js', import.meta.url), 'utf8');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function load() {
  const calls = [];
  const c = { console, esc, escA: esc, toast: () => {}, lastSig: '', state: { repo: '/proj/loja', tasks: [] }, IC: { shield: '' }, showErr: () => {},
    invoke: async (cmd, args) => { calls.push([cmd, args]); return '{}'; }, document: { addEventListener: () => {} }, $id: () => null,
    setInterval: () => 0, setTimeout: () => 0, window: {}, navigator: {}, localStorage: { getItem: () => null, setItem: () => {} }, calls };
  vm.createContext(c);
  vm.runInContext(src + '\n;this.envAskHtml=envAskHtml;this.envReadSet=envReadSet;this.envBlockedSaid=envBlockedSaid;this.protectSet=protectSet;', c);
  return c;
}

test('o agente diz que o .env foi bloqueado → oferece liberar; outras falas não', () => {
  const c = load();
  assert.ok(c.envBlockedSaid('Não consigo ler o .env: a permissão foi negada pelo modo protegido.'));
  assert.ok(c.envBlockedSaid('Read(.env) denied'));
  assert.ok(c.envBlockedSaid('O modo protegido bloqueia arquivos *.key: pode salvar a chave como .txt?'));
  assert.ok(!c.envBlockedSaid('Criei o .env.example com as variáveis.'));
  assert.ok(!c.envBlockedSaid('A permissão do GitHub foi negada.'));
  assert.match(c.envAskHtml('não consigo ler o .env (bloqueado)'), /data-envallow="\/proj\/loja"/);
});

test('liberado ou projeto livre: sem botão; liberar grava envread:<repo>', async () => {
  const c = load();
  await c.envReadSet('/proj/loja', true);
  assert.equal(JSON.stringify(c.calls.at(-1)), JSON.stringify(['write_setting', { key: 'envread:/proj/loja', value: '1' }]));
  assert.equal(c.envAskHtml('não consigo ler o .env (bloqueado)'), '');
  const d = load();
  await d.protectSet('/proj/loja', false);
  assert.equal(d.envAskHtml('não consigo ler o .env (bloqueado)'), '', 'modo livre já lê');
});
