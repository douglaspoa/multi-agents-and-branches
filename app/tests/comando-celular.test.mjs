// Comando pelo celular: a ponte do Mac (89-comando-celular.js). Dados fictícios.
// `node --test app/tests/comando-celular.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const JS = readFileSync(new URL('../src/js/89-comando-celular.js', import.meta.url), 'utf8');
const SQL = readFileSync(new URL('../../supabase/migrations/0034_comando_msgs.sql', import.meta.url), 'utf8');
const puro = JS.slice(JS.indexOf('// @celular-puro-inicio'), JS.indexOf('// @celular-puro-fim'));
const { cmdCelFala, cmdCelResposta, cmdCelEscolhe, CMD_CEL_JANELA_MS } = new Function(puro + '; return { cmdCelFala, cmdCelResposta, cmdCelEscolhe, CMD_CEL_JANELA_MS };')();

test('fala: tira markdown, código e link — fica só o que dá pra ouvir', () => {
  const t = cmdCelFala('## Resultado\n\n- **ABC-12** está `rodando`\n- veja [o PR](https://exemplo.test/pr/1)\n\n```js\nconst x=1\n```\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(!/[#*`|\[\]]/.test(t), t);
  assert.ok(!/https?:/.test(t) && !/const x/.test(t), t);
  assert.match(t, /ABC-12 está rodando/);
  assert.match(t, /veja o PR/);
});

test('fala: resposta comprida é cortada numa frase inteira e avisa onde está o resto', () => {
  const longo = Array.from({ length: 40 }, (_, i) => `Frase número ${i} com algum conteúdo.`).join(' ');
  const t = cmdCelFala(longo, 300);
  assert.ok(t.length < 380, String(t.length));
  assert.match(t, /\. O resto está no Starfork do Mac\.$/);
});

test('resposta: junta o que o Comando disse e ignora a fala da pessoa', () => {
  const r = cmdCelResposta([{ r: 'you', text: 'como estão as tarefas' }, { r: 'bot', k: 'agente', text: 'Três rodando e **uma** esperando você.' }], () => '');
  assert.deepEqual(r, { body: 'Três rodando e uma esperando você.', confirma: false });
  assert.equal(cmdCelResposta([], null).body, 'Feito.');
});

test('resposta: cartão de confirmação vira pergunta de sim ou não', () => {
  const cartao = { r: 'bot', k: 'plano', plan: { passos: [{ acao: 'encerrar', alvos: [{ code: 'ABC-12' }] }] } };
  const r = cmdCelResposta([{ r: 'bot', k: 'agente', text: 'Vou encerrar.' }, cartao], () => '', cartao, { encerrar: 'Encerrar sem entregar' });
  assert.equal(r.confirma, true);
  assert.match(r.body, /Vou encerrar\. Preciso da sua confirmação: encerrar sem entregar ABC-12\. Diga sim ou não\./);
  // cartão já decidido não pede de novo
  assert.equal(cmdCelResposta([{ ...cartao, done: 'sim' }], (m) => 'Comando: feito', null).confirma, false);
});

test('escolhe: só fala dentro da janela — a velha fica pra trás', () => {
  const agora = Date.parse('2026-11-26T12:00:00Z');
  const velha = { id: 1, body: 'oi', created_at: new Date(agora - CMD_CEL_JANELA_MS - 1000).toISOString() };
  const nova = { id: 2, body: 'status', created_at: new Date(agora - 5000).toISOString() };
  assert.equal(cmdCelEscolhe([velha, nova], agora).id, 2);
  assert.equal(cmdCelEscolhe([velha], agora), null);
  assert.equal(cmdCelEscolhe([{ id: 3, body: '', created_at: nova.created_at }], agora), null);
});

// ── a volta inteira, com nuvem e Comando de mentira ──
function mundo({ rows, agente }) {
  const chamadas = [], msgs = [], env = { CMD: { busy: false }, CMDAG: { espera: null } };
  const linhas = rows.map((r) => ({ state: 'novo', role: 'user', ...r }));
  const sbFetch = async (path, opts = {}) => {
    chamadas.push([opts.method || 'GET', path, opts.body ? JSON.parse(opts.body) : null]);
    if (opts.method === 'PATCH') { const id = Number(/id=eq\.(\d+)/.exec(path)[1]), de = (/state=eq\.(\w+)/.exec(path) || [])[1]; const l = linhas.find((x) => x.id === id && (!de || x.state === de)); if (!l) return []; Object.assign(l, JSON.parse(opts.body)); return [l]; }
    if (opts.method === 'POST') { linhas.push({ id: 100 + linhas.length, ...JSON.parse(opts.body) }); return []; }
    return linhas.filter((l) => l.role === 'user' && l.state === 'novo');
  };
  const fn = new Function('SB', 'sbFetch', 'sbGet', 'cloudAllowed', 'cloudUserId', 'cmdSay', 'cmdRepo', 'cmdMsgs', 'cmdAgDecide', 'cmdAgMsgTx', 'CMD', 'CMDAG', 'CMD_ACAO_TX', 'pathBase', 'tickErr', 'setInterval', 'console',
    JS.replace(/\nsetInterval\(\(\)=>\{ cmdCelTick[^\n]*\n?$/, '\n') + '; return { cmdCelTick, CMDCEL };');
  const reais = { setInterval: (f, ms) => setInterval(f, Math.min(ms, 5)) };
  const api = fn({ sess: () => ({}) }, sbFetch, (q) => sbFetch('/rest/v1/' + q), () => true, () => 'u1',
    (t) => agente(t, env, msgs), () => '/tmp/projeto-ficticio', () => msgs,
    (t) => { const m = env.CMDAG.espera; if (!m || m.done || !/^(sim|não)$/.test(t)) return false; m.done = t === 'sim' ? 'sim' : 'nao'; env.CMDAG.espera = null; msgs.push({ r: 'bot', k: 'agente', text: t === 'sim' ? 'Encerrei a ABC-12.' : 'Tudo bem, não fiz nada.' }); return true; },
    (m) => (m.text ? 'Comando: ' + m.text : ''), env.CMD, env.CMDAG, { encerrar: 'Encerrar sem entregar' }, (p) => p.split('/').pop(), () => {}, reais.setInterval, { log() {} });
  return { ...api, linhas, chamadas, msgs, env };
}
const agora = () => new Date().toISOString();

test('volta: pega a fala, entrega ao Comando e grava a resposta pro celular', async () => {
  const w = mundo({ rows: [{ id: 1, body: 'como estão as tarefas?', created_at: agora() }],
    agente: (t, env, msgs) => { msgs.push({ r: 'you', text: t }); env.CMD.busy = true; setTimeout(() => { msgs.push({ r: 'bot', k: 'agente', text: 'Duas rodando, **nenhuma** parada.' }); env.CMD.busy = false; }, 20); } });
  await w.cmdCelTick();
  const fala = w.linhas.find((l) => l.id === 1), resp = w.linhas.find((l) => l.role === 'bot');
  assert.equal(fala.state, 'pronto');
  assert.equal(resp.reply_to, 1);
  assert.equal(resp.body, 'Duas rodando, nenhuma parada.');
  assert.equal(resp.meta.confirma, false);
  assert.equal(resp.meta.projeto, 'projeto-ficticio');
  assert.equal(w.msgs[0].text, 'como estão as tarefas?', 'a fala aparece no chat do Mac');
});

test('volta: ação com confirmação — o celular ouve a pergunta e o "sim" seguinte executa', async () => {
  const w = mundo({ rows: [{ id: 1, body: 'encerra a ABC-12', created_at: agora() }],
    agente: (t, env, msgs) => { msgs.push({ r: 'you', text: t }); env.CMD.busy = true; setTimeout(() => { const c = { r: 'bot', k: 'plano', plan: { passos: [{ acao: 'encerrar', alvos: [{ code: 'ABC-12' }] }] } }; msgs.push(c); env.CMDAG.espera = c; }, 20); } });
  await w.cmdCelTick();
  let resp = w.linhas.filter((l) => l.role === 'bot');
  assert.equal(resp.length, 1);
  assert.equal(resp[0].meta.confirma, true);
  assert.match(resp[0].body, /confirmação: encerrar sem entregar ABC-12\. Diga sim ou não\./);
  // a pessoa diz "sim" no celular
  w.linhas.push({ id: 2, role: 'user', state: 'novo', body: 'sim', created_at: agora() });
  setTimeout(() => { w.env.CMD.busy = false; }, 30);
  await w.cmdCelTick();
  resp = w.linhas.filter((l) => l.role === 'bot');
  assert.equal(resp.length, 2);
  assert.equal(resp[1].reply_to, 2);
  assert.equal(resp[1].body, 'Encerrei a ABC-12.');
  assert.equal(w.msgs.filter((m) => m.r === 'you').length, 1, 'o "sim" não vira pedido novo');
});

test('volta: dois Macs — quem não conseguiu pegar a fala não responde', async () => {
  const w = mundo({ rows: [{ id: 1, body: 'status', created_at: agora() }], agente: () => { throw new Error('não era pra chamar'); } });
  // o outro Mac pegou a fala entre a minha leitura e a minha troca de estado
  const lido = [{ ...w.linhas[0] }]; w.linhas[0].state = 'atendendo';
  const ler = w.chamadas; const origLen = ler.length;
  // a leitura devolve a cópia velha (ainda 'novo'); a troca de estado encontra 'atendendo' e não muda nada
  const filtro = Array.prototype.filter; w.linhas.filter = function (f) { const r = filtro.call(this, f); return r.length || this !== w.linhas ? r : lido; };
  await w.cmdCelTick();
  assert.equal(w.linhas.find((l) => l.id === 1).state, 'atendendo');
  assert.equal(filtro.call(w.linhas, (l) => l.role === 'bot').length, 0, 'não respondeu');
  assert.ok(w.chamadas.length > origLen && w.chamadas.some(([m]) => m === 'PATCH'));
});

test('migration 0034: só o dono, corpo limitado, realtime, idempotente', () => {
  assert.match(SQL, /create table if not exists comando_msgs/);
  assert.match(SQL, /enable row level security/);
  for (const p of ['select', 'insert', 'update', 'delete']) assert.match(SQL, new RegExp(`create policy comando_msgs_${p} on comando_msgs for ${p}[\\s\\S]*?user_id = auth\\.uid\\(\\)`));
  assert.match(SQL, /char_length\(body\) between 1 and 4000/);
  assert.match(SQL, /alter publication supabase_realtime add table comando_msgs/);
  assert.equal((SQL.match(/drop policy if exists/g) || []).length, 4);
});
