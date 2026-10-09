// Nome de pessoa, fonte única (08-pessoas · mesa 09/10 D1): "você" → nome → parte do e-mail → "pessoa sem nome",
// NUNCA o id nem "alguém do time". `node --test app/tests/pessoas.test.mjs` — recorta/roda o código real, sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const dir = new URL('../src/js/', import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const S = read('08-pessoas.js');
const P = new Function(cut(S, '// @puro-pessoas-inicio', '// @puro-pessoas-fim')
  + '\nreturn { personLabel, personFirst, personInitials, personLooksId, personEmailLocal, personBadText, PESSOA_SEM_NOME, PESSOA_CARREGANDO };')();
const UUID = '0000aaaa-0000-4000-8000-00000000000b';

test('ordem: você → nome → parte do e-mail → pessoa sem nome (nunca o id)', () => {
  assert.equal(P.personLabel({ name: 'Bruno Lima', email: 'bruno@exemplo.dev' }, { me: true }), 'você');
  assert.equal(P.personLabel({ name: 'Bruno Lima', email: 'bruno@exemplo.dev' }, { me: true, noYou: true }), 'Bruno Lima');
  assert.equal(P.personLabel({ name: '', email: 'carla.dias@exemplo.dev' }), 'carla.dias');
  assert.equal(P.personLabel({ name: UUID, email: '' }), 'pessoa sem nome', 'nome que é um uuid não vale');
  assert.equal(P.personLabel({ name: 'bruno@exemplo.dev' }), 'bruno', 'nome que é e-mail vira a parte antes do @');
  assert.equal(P.personLabel(null), 'pessoa sem nome');
  assert.equal(P.personLabel(null, { pending: true }), 'carregando…');
  assert.equal(P.personLabel(null, { hint: 'Diego Reis' }), 'Diego Reis', 'nome gravado em outro lugar (shared_by_name)');
  assert.equal(P.personLabel(null, { hint: UUID }), 'pessoa sem nome');
  assert.equal(P.personLabel(null, { email: UUID + '@x.dev' }), 'pessoa sem nome', 'e-mail com cara de id também não');
});

test('primeiro nome e iniciais: fallback fica inteiro; meu avatar usa o meu nome', () => {
  assert.equal(P.personFirst('Ana Souza'), 'Ana');
  assert.equal(P.personFirst('pessoa sem nome'), 'pessoa sem nome');
  assert.equal(P.personFirst('carregando…'), 'carregando…');
  assert.equal(P.personInitials('Ana Souza'), 'AS');
  assert.equal(P.personInitials('carla.dias'), 'CD');
  assert.equal(P.personInitials('pessoa sem nome'), '?');
});

test('cara de id / texto proibido na tela', () => {
  for (const s of [UUID, '0000aaaa-0000-40', 'id 1a2b', 'a1b2c3d4e5f6a7b8']) assert.ok(P.personLooksId(s), s);
  for (const s of ['Ana', 'bruno', 'carla.dias', 'Leo Martins']) assert.ok(!P.personLooksId(s), s);
  assert.ok(P.personBadText('com ' + UUID));
  assert.ok(P.personBadText('alguém do time assumiu'));
  assert.ok(P.personBadText('responsável: id 1a2b'));
  assert.ok(!P.personBadText('com Bruno Lima · rodando'));
});

// o arquivo INTEIRO rodando num mundo falso: perfil da nuvem, lote sob demanda, "carregando…" enquanto busca
function world(over = {}) {
  const calls = [];
  const ctx = {
    console, setTimeout: (fn) => { ctx.__t = fn; return 1; }, clearTimeout: () => {}, encodeURIComponent, CustomEvent: class { constructor(n) { this.type = n; } },
    window: { dispatchEvent() {} },
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'), escA: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    SB: { sess: () => ({ user: { id: 'eu-0000-4000-8000-000000000000', email: 'ana@exemplo.dev' } }) },
    cloudUserId: () => 'eu-0000-4000-8000-000000000000',
    cloudData: { profileByUser: { 'eu-0000-4000-8000-000000000000': { name: 'Ana Souza', email: 'ana@exemplo.dev' } } },
    teamProfiles: {},
    sbGet: async (q) => { calls.push(q); return over.rows || []; },
    renders: 0, render() { ctx.renders++; },
    ...over.ctx,
  };
  vm.createContext(ctx);
  vm.runInContext(S, ctx);
  return { ctx, calls };
}

test('perfil que falta: "carregando…" → busca EM LOTE (uma query) → nome; sem perfil → "pessoa sem nome"', async () => {
  const OTHER = '0000aaaa-0000-4000-8000-0000000000c1';
  const { ctx, calls } = world({ rows: [{ user_id: UUID, name: 'Bruno Lima', email: 'bruno@exemplo.dev' }] });
  assert.equal(ctx.personName(UUID), 'carregando…');
  assert.equal(ctx.personName(OTHER), 'carregando…');
  ctx.__t(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1, 'um lote só pros dois');
  assert.ok(calls[0].includes(UUID) && calls[0].includes(OTHER));
  assert.equal(ctx.personName(UUID), 'Bruno Lima');
  assert.equal(ctx.personName(OTHER), 'pessoa sem nome', 'a nuvem não devolveu → nunca o id');
  assert.ok(ctx.renders >= 1, 'a tela redesenha quando o lote volta');
});

test('eu = "você" (nas listas de escolha: "Ana Souza (você)"); e-mail só no tooltip; chip e avatar sem id', () => {
  const { ctx } = world({ ctx: { teamProfiles: { [UUID]: { name: '', email: 'bruno.lima@exemplo.dev' } } } });
  assert.equal(ctx.personName('eu-0000-4000-8000-000000000000'), 'você');
  assert.equal(ctx.personName('eu-0000-4000-8000-000000000000', { you: 'suffix' }), 'Ana Souza (você)');
  assert.equal(ctx.personName('ana@exemplo.dev'), 'você', 'por e-mail também');
  assert.equal(ctx.personName(UUID), 'bruno.lima');
  assert.equal(ctx.personName('fora@outra.dev'), 'fora', 'e-mail de quem não é do time: parte antes do @');
  assert.equal(ctx.personName(''), '—');
  const chip = ctx.personChip(UUID), av = ctx.personAv('eu-0000-4000-8000-000000000000');
  assert.match(chip, /bruno\.lima<\/span><\/span>$/);
  assert.match(chip, /title="bruno\.lima · bruno\.lima@exemplo\.dev"/, 'e-mail completo só no tooltip');
  assert.match(av, />AS<\/span>$/, 'meu avatar: minhas iniciais');
  assert.ok(!P.personBadText(chip.replace(/title="[^"]*"/g, '')) && !chip.includes(UUID));
});

// varredura: nenhum fallback de nome que imprime o id, o e-mail cru ou "alguém do time" sobrou nas telas
test('varredura das telas: sem "alguém do time", sem id cortado, sem p.name||p.email cru', () => {
  const bad = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js') && x !== '08-pessoas.js')) {
    const lines = read(f).split('\n');
    lines.forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '');
      if (/['"`]alguém do time['"`]/.test(code)) bad.push(`${f}:${i + 1} "alguém do time"`);
      if (/(uid|who|user_id|assignee|created_by|by|id|pid)\)?\.slice\(0, ?(4|6|8)\)/.test(code) && !/hash|sessionId|commit/i.test(code)) bad.push(`${f}:${i + 1} id cortado`);
      if (/\.name\s*\|\|\s*\w+\.email\s*\|\|\s*String\(/.test(code)) bad.push(`${f}:${i + 1} nome||email||id`);
      if (/'id '\s*\+/.test(code)) bad.push(`${f}:${i + 1} "id 1a2b"`);
    });
  }
  assert.deepEqual(bad, []);
  assert.ok(read('42-nuvem-sync-mobile.js').includes('function tmName(uid){ return personName(uid); }'), 'tmName passa pela fonte única');
  assert.ok(read('43-espaco-times.js').includes('function tsAv(uid, on){ return personAv(uid, { on }); }'), 'tsAv é o avatar único');
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('js/08-pessoas.js') > 0 && html.indexOf('js/08-pessoas.js') < html.indexOf('js/10-core.js'), '08 carrega antes de quem usa');
});

test('falha do lote: sai do "carregando…" pra "pessoa sem nome" e tenta de novo depois de 1 min; troca de conta descarta o lote', async () => {
  let fail = true, n = 0; const now = { t: 1_000_000 };
  const { ctx } = world({ ctx: { Date: class extends Date { static now() { return now.t; } }, sbGet: async () => { n++; if (fail) throw new Error('rede'); return [{ user_id: UUID, name: 'Bruno Lima', email: 'b@exemplo.dev' }]; } } });
  assert.equal(ctx.personName(UUID), 'carregando…');
  ctx.__t(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(ctx.personName(UUID), 'pessoa sem nome');
  assert.equal(n, 1);
  fail = false; now.t += 61_000;
  assert.equal(ctx.personName(UUID), 'carregando…', 'nova janela: volta a buscar');
  ctx.__t(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(ctx.personName(UUID), 'Bruno Lima');
  ctx.personReset();
  assert.equal(ctx.personName(UUID), 'carregando…', 'conta nova: cache limpo');
  assert.equal(ctx.personName(UUID, { settled: true }), 'pessoa sem nome', 'texto gravado nunca leva "carregando…"');
});

test('personEnsure espera o lote (toast/pergunta/mensagem gravada saem com o nome)', async () => {
  const { ctx } = world({ rows: [{ user_id: UUID, name: 'Bruno Lima', email: 'b@exemplo.dev' }] });
  await ctx.personEnsure([UUID, null]);
  assert.equal(ctx.personName(UUID, { settled: true }), 'Bruno Lima');
});

test('atividade: "assigned" guarda o id → "pra Fulano"; comentário com SHA continua texto', () => {
  const { ctx } = world({ ctx: { teamProfiles: { [UUID]: { name: 'Bruno Lima', email: 'b@exemplo.dev' } } } });
  assert.equal(ctx.personActBody({ kind: 'assigned', body: UUID }), 'pra Bruno Lima');
  assert.equal(ctx.personActBody({ kind: 'comment', body: 'a1b2c3d4e5f6a7b8c9d0' }), 'a1b2c3d4e5f6a7b8c9d0');
  assert.equal(ctx.personActBody({ kind: 'comment', body: 'x'.repeat(200) }, 80).length, 80);
  assert.equal(ctx.personLabel({ email: '5511999998888@exemplo.dev' }), '5511999998888', 'telefone no e-mail é gente');
});

test('painel de Issues (trkPerson): e-mail → pessoa do time; código sem mapa → "sem nome no painel"; mapa novo (e-mail) e antigo (nome)', () => {
  const S14 = read('14-issues-projeto.js');
  const fn = (h) => { const i = S14.indexOf(h); const j = S14.indexOf('\n}\n', i); return S14.slice(i, j + 3); };
  const { ctx } = world({ ctx: { teamProfiles: { [UUID]: { name: 'Bruno Lima', email: 'bruno@exemplo.dev' } } } });
  vm.runInContext('var trk={ people:{ "u-77":"bruno@exemplo.dev", "u-88":"Fulano Antigo" } };\n' + S14.slice(S14.indexOf('function trkPretty'), S14.indexOf('\n', S14.indexOf('function trkPretty'))) + '\n' + fn('function trkPerson('), ctx);
  assert.equal(ctx.trkPerson('bruno@exemplo.dev').label, 'Bruno Lima');
  assert.equal(ctx.trkPerson('ana@exemplo.dev').label, 'você');
  const cod = ctx.trkPerson('77a1b2c3-0d0e-4f00-9a00-00000000beef');
  assert.equal(cod.label, 'sem nome no painel'); assert.equal(cod.unnamed, true); assert.ok(!cod.tip.includes('77a1'));
  assert.equal(ctx.trkPerson('12345').label, 'sem nome no painel', 'id numérico (GitHub) também');
  assert.equal(ctx.trkPerson('u-77').label, 'Bruno Lima', '"quem é?" grava o e-mail');
  assert.equal(ctx.trkPerson('u-88').label, 'Fulano Antigo', 'nome dado antes desta mudança continua');
  assert.equal(ctx.trkPerson('77a1b2c3-0d0e-4f00-9a00-00000000beef', 'bruno@exemplo.dev').label, 'Bruno Lima', 'o e-mail do painel vence o código');
});
