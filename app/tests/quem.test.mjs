// QUEM ESTÁ FALANDO (bug 14/10): o colega mandou "teste" e a IA o chamou pelo nome do dono do time.
// `node --test app/tests/quem.test.mjs` — (1) a tela grava SEMPRE a pessoa logada nesta máquina (personMeName → quem_set),
// rodando o 08-pessoas.js de verdade num vm com a nuvem de mentira; (2) nenhum nome próprio fixo no que vai pra IA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const UID_P = '0000aaaa-0000-4000-8000-00000000000b', UID_D = '0000aaaa-0000-4000-8000-00000000000c';

function pessoas(me) {
  const calls = [];
  const ctx = {
    me, calls, console, setTimeout: () => 0, setInterval: () => 0, Promise,
    window: { dispatchEvent() {}, addEventListener() {} }, CustomEvent: function () {},
    cloudUserId: () => ctx.me.uid,
    cloudData: { profileByUser: { [UID_P]: { name: 'Pedro Alves', email: 'pedro@exemplo.dev' }, [UID_D]: { name: 'Dora Lima', email: 'dora@exemplo.dev' } } },
    SB: { sess: () => (ctx.me.uid ? { user: { email: ctx.me.email || '' } } : null) },
    invoke: (cmd, args) => { calls.push({ cmd, ...args }); return Promise.resolve(); },
  };
  vm.createContext(ctx);
  vm.runInContext(read('app/src/js/08-pessoas.js') + '\nthis.personMeName=personMeName; this.quemSync=quemSync; this.personReset=personReset;', ctx);
  return ctx;
}

test('a tela grava quem está logado AGORA (nome do perfil); troca de conta e saída também', async () => {
  const c = pessoas({ uid: UID_P, email: 'pedro@exemplo.dev' });
  assert.equal(c.personMeName(), 'Pedro Alves');
  await c.quemSync();
  assert.deepEqual(c.calls.at(-1), { cmd: 'quem_set', name: 'Pedro Alves', uid: UID_P });
  await c.quemSync();
  assert.equal(c.calls.length, 1, 'sem mudança, não regrava');
  c.me = { uid: UID_D, email: 'dora@exemplo.dev' }; // trocou de conta na mesma máquina
  await c.quemSync();
  assert.deepEqual(c.calls.at(-1), { cmd: 'quem_set', name: 'Dora Lima', uid: UID_D });
  c.me = { uid: '' }; // saiu
  assert.equal(c.personMeName(), '');
  await c.quemSync();
  assert.deepEqual(c.calls.at(-1), { cmd: 'quem_set', name: null, uid: null }, 'sem conta: nenhum nome');
});

test('perfil ainda sem nome: parte do e-mail da PRÓPRIA conta; sem nada, vazio (nunca "você"/"pessoa sem nome")', () => {
  const c = pessoas({ uid: '0000aaaa-0000-4000-8000-0000000000ff', email: 'carla.dias@exemplo.dev' });
  assert.equal(c.personMeName(), 'carla.dias');
  c.me = { uid: '0000aaaa-0000-4000-8000-0000000000ff', email: '' };
  assert.equal(c.personMeName(), '');
});

test('antes de cada chat a tela ESPERA a gravação de quem fala (aiCallResumeSafe → quemSync) e só então chama a IA', async () => {
  const core = read('app/src/js/10-core.js');
  const order = [];
  let release;
  const ctx = { console, Promise, String, Object, RegExp, setTimeout,
    quemSync: () => { order.push('quemSync'); return new Promise((r) => { release = () => { order.push('gravou'); r(); }; }); },
    aiEngineIsGateway: () => false };
  vm.createContext(ctx);
  vm.runInContext(core.slice(core.indexOf('// @resume-inicio'), core.indexOf('// @resume-fim')) + '\nthis.safe=aiCallResumeSafe;', ctx);
  const p = ctx.safe(async () => { order.push('ia'); return { text: 'ok' }; }, 'sid', 'teste', [], '');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['quemSync'], 'a IA não é chamada antes de gravar quem fala');
  release();
  await p;
  assert.deepEqual(order, ['quemSync', 'gravou', 'ia']);
});

test('memória assina com a pessoa logada (mesma fonte); sem conta, "você (nesta máquina)"', () => {
  const S = read('app/src/js/37-memoria.js');
  const i = S.indexOf('function memWho(){'), j = S.indexOf('\n}', i) + 2;
  const run = (me) => { const c = { personMeName: () => me }; vm.createContext(c); vm.runInContext(S.slice(i, j) + '\nthis.w=memWho();', c); return c.w; };
  assert.equal(run('Pedro Alves'), 'Pedro Alves');
  assert.equal(run(''), 'você (nesta máquina)');
});

test('nada de nome próprio FIXO no que vai pra IA (prompts do Rust, do motor e da tela)', () => {
  const dirs = ['app/src-tauri/src/', 'src/', 'src/engine/', 'src/mcp/', 'app/src/js/'];
  const bad = [];
  for (const d of dirs) {
    for (const f of readdirSync(new URL(d, root))) {
      if (!/\.(rs|ts|js|mjs)$/.test(f) || /\.test\./.test(f)) continue;
      const lines = read(d + f).split('\n');
      lines.forEach((l, n) => {
        const t = l.trim();
        // comentário não vai pra IA; assert! é o teste do Rust conferindo que o nome NÃO está lá
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || /assert/.test(t)) return;
        if (/\bDouglas\b/.test(l.replace(/\/\/.*$/, ''))) bad.push(`${d}${f}:${n + 1}`);
      });
    }
  }
  assert.deepEqual(bad, [], 'nome do dono fixo em código que monta prompt');
  // e o planner pergunta pra "a pessoa", com o nome vindo de quem.rs
  const lib = read('app/src-tauri/src/lib.rs');
  assert.match(lib, /const PLANNER_SYS: &str = "[^\n]*conversando com a pessoa que está usando o Starfork/);
  assert.match(read('app/src-tauri/src/memoria.rs'), /let sys = crate::quem::with_speaker\(sys\);/);
});
