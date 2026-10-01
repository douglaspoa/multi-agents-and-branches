// Faixa "o que o agente está fazendo agora" na conversa da tarefa (29/09): `node --test app/tests/`
// Evento do motor (read/bash/edit/write/claim/note de ferramenta) → frase curta em pt-BR, e as ações do turno atual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const core = readFileSync(new URL('../src/js/10-core.js', import.meta.url), 'utf8');
const ws = readFileSync(new URL('../src/js/20-workspace-tarefa.js', import.meta.url), 'utf8');
const grab = (src, re) => { const m = src.match(re); assert.ok(m, 'trecho não achado: ' + re); return m[0]; };
const code = [
  grab(core, /function evIsUserMsg\(e\)\{[^\n]*\n/),
  'function nPl(n,s,p){ return n+" "+(n===1?s:p); }',
  grab(ws, /function fwEvTs\(e\)\{[^\n]*\n/),
  grab(ws, /function fwRelPath\(p\)\{[^\n]*\n/),
  grab(ws, /function fwBashShort\(cmd\)\{[\s\S]*?\n\}\n/),
  grab(ws, /const FW_BROWSER_PT=[^\n]*\n/),
  grab(ws, /function fwActLabel\(e\)\{[\s\S]*?\n\}\n/),
  grab(ws, /function fwTurnActs\(evs\)\{[\s\S]*?\n\}\n/),
  grab(ws, /function fwTempo\(ms\)\{[^\n]*\n/),
  grab(ws, /function fwLiveHead\(since, n, now\)\{[^\n]*\n/),
].join('\n') + '\nthis.fwActLabel=fwActLabel; this.fwTurnActs=fwTurnActs; this.fwLiveHead=fwLiveHead; this.fwBashShort=fwBashShort;';
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);
const { fwActLabel, fwTurnActs, fwLiveHead, fwBashShort } = ctx;

test('evento → frase em pt-BR (arquivo, comando, busca, edição, navegador)', () => {
  assert.equal(fwActLabel({ type: 'read', text: '/Users/x/repo/backend/main.py' }), 'lendo backend/main.py');
  assert.equal(fwActLabel({ type: 'edit', text: '/r/src/App.tsx' }), 'editando src/App.tsx');
  assert.equal(fwActLabel({ type: 'write', text: '/r/tests/test_a.py' }), 'criando tests/test_a.py');
  assert.equal(fwActLabel({ type: 'bash', text: 'export DEVELOPER_DIR=/Library/Dev GIT_CONFIG_GLOBAL=/dev/null; cd /r && pytest -q tests' }), 'rodando pytest -q tests');
  assert.equal(fwActLabel({ type: 'read', text: 'buscando "use_cases" em backend' }), 'buscando "use_cases" em backend');
  assert.equal(fwActLabel({ type: 'read', text: 'use_cases' }), 'buscando "use_cases"', 'evento antigo: padrão cru do Grep');
  assert.equal(fwActLabel({ type: 'read', text: '**/*.py' }), 'listando **/*.py');
  assert.equal(fwActLabel({ type: 'note', text: 'mcp__playwright__browser_take_screenshot' }), 'tirando print');
  assert.equal(fwActLabel({ type: 'note', text: 'mcp__playwright__browser_navigate' }), 'abrindo a página');
  assert.equal(fwActLabel({ type: 'note', text: 'subagente: varrer o código' }), 'subagente: varrer o código');
  assert.equal(fwActLabel({ type: 'claim', text: 'src/a.ts (write)' }), 'reservando src/a.ts');
  // fala/nota comum NÃO é ação (fica na conversa)
  assert.equal(fwActLabel({ type: 'think', text: 'Commitando.' }), '');
  assert.equal(fwActLabel({ type: 'note', text: 'resumo técnico do commit gerado' }), '');
  assert.ok(fwBashShort('x'.repeat(200)).endsWith('…'));
});
test('ações do turno ATUAL: começam depois da sua última mensagem', () => {
  const evs = [
    { type: 'bash', text: 'npm test', ts: 1000 },
    { agent: 'Você', type: 'note', text: 'Você: não daria pra criar um login dev?', ts: 2000 },
    { agent: 'A', type: 'think', text: 'Vou olhar o login.', ts: 2500 },
    { agent: 'A', type: 'read', text: '/r/backend/auth.py', ts: 3000 },
    { agent: 'A', type: 'bash', text: 'pytest tests/test_auth.py', ts: 4000 },
  ];
  const a = fwTurnActs(evs);
  assert.deepEqual([...a.acts.map(x => x.label)], ['lendo backend/auth.py', 'rodando pytest tests/test_auth.py']);
  assert.equal(a.since, 2000);
  assert.equal(fwLiveHead(a.since, a.acts.length, 2000 + 65_000), 'trabalhando · 1min 05s · 2 ações');
  assert.equal(fwLiveHead(0, 0, 5), 'trabalhando');
});
