// Painel "Sua IA" (spec-painel-sua-ia): estados por motor, chave com o nome certo, testar, usar como padrão,
// passo pulável do primeiro acesso e estado nos seletores. Carrega 00-util + 29-ia-picker + 30-sua-ia num vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };

// status como o Rust (ai_engines_status) devolve — camelCase
const ST = {
  claude: { id: 'claude', label: 'Claude Code', installed: false, ready: false, state: 'install', reason: 'não instalado neste computador', fixes: ['npm install -g @anthropic-ai/claude-code && claude'], keyName: null, keySaved: false, models: [], detail: '', isDefault: true, inUse: false },
  codexLogin: { id: 'codex', label: 'Codex', installed: true, ready: false, state: 'login', reason: 'instalado, mas sem login — rode `codex login` ou cole a chave OpenAI', fixes: ['codex login'], keyName: 'OPENAI_API_KEY', keySaved: false, models: [], detail: '/x/codex', isDefault: false, inUse: false },
  codexOk: { id: 'codex', label: 'Codex', installed: true, ready: true, state: 'ready', reason: 'pronto', fixes: [], keyName: 'OPENAI_API_KEY', keySaved: false, models: [], detail: '/x/codex', isDefault: false, inUse: true },
  dsKey: { id: 'deepseek', label: 'DeepSeek Harness (beta)', installed: true, ready: false, state: 'key', reason: 'instalado, falta a chave da DeepSeek — cole abaixo', fixes: [], keyName: 'DEEPSEEK_API_KEY', keySaved: false, models: [], detail: '/x/dsh', isDefault: false, inUse: false },
  dsOk: { id: 'deepseek', label: 'DeepSeek Harness (beta)', installed: true, ready: true, state: 'ready', reason: 'pronto (beta)', fixes: [], keyName: 'DEEPSEEK_API_KEY', keySaved: true, models: [], detail: '/x/dsh', isDefault: false, inUse: false },
  gwNo: { id: 'gateway', label: 'Gateway da empresa', installed: false, ready: false, state: 'key', reason: 'não configurado — URL, chave e modelo ficam em Gateway próprio', fixes: [], keyName: null, keySaved: false, models: [], detail: '', isDefault: false, inUse: false },
};

function load(store = {}, opts = {}) {
  const calls = [];
  const noop = () => {};
  const ctx = {
    window: { addEventListener: noop, removeEventListener: noop },
    document: { getElementById: () => null, addEventListener: noop, querySelectorAll: () => [], querySelector: () => null, activeElement: null },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: { platform: 'MacIntel', userAgent: '' },
    console,
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escA: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    invoke: async (cmd, args) => {
      calls.push([cmd, args ? JSON.parse(JSON.stringify(args)) : null]);
      if (opts.invoke) return opts.invoke(cmd, args);
      return null;
    },
  };
  vm.createContext(ctx);
  const env = cut(read('11-ambiente-updater.js'), '// @env-puro-inicio', '// @env-puro-fim');
  vm.runInContext(read('00-util.js') + '\n' + env + '\n' + read('29-ia-picker.js') + '\n' + read('30-sua-ia.js'), ctx);
  return { ctx, calls, run: (code) => vm.runInContext(code, ctx) };
}
const setList = (P, list) => { P.ctx.__l = list; P.run('suaIaList=__l; suaIaAt=Date.now();'); };

test('render: estado ao lado do nome, correção com copiar, campo de chave sem nome de variável', () => {
  const P = load();
  setList(P, [ST.claude, ST.codexLogin, ST.dsKey, ST.gwNo]);
  const html = P.ctx.suaIaHtml(P.run('suaIaList'), { ctx: 'cfg' });
  // os 4 motores, cada um com o seu estado
  for (const t of ['falta instalar', 'falta login', 'falta chave', 'falta configurar']) assert.ok(html.includes(t), t);
  assert.match(html, /data-envfix="codex login"/, 'codex sem login: `codex login` com copiar');
  assert.match(html, /data-envfix="npm install -g @anthropic-ai\/claude-code &amp;&amp; claude"/);
  assert.match(html, /data-sakey="codex"/, 'ou o campo da chave OpenAI');
  assert.match(html, /data-sakey="deepseek"/);
  assert.ok(!/DEEPSEEK_API_KEY|OPENAI_API_KEY/.test(html), 'a pessoa nunca vê/digita o nome da variável');
  assert.match(html, /Gateway próprio/, 'gateway aponta pra config existente');
  assert.match(html, /beta/);
  // nada pronto: o caminho mais curto destacado (um login > uma chave > instalar)
  assert.match(html, /Nenhuma IA pronta/);
  assert.match(html, /class="suaia-card short" data-suaia="codex"/);
  assert.equal(P.ctx.suaIaShortest([ST.claude, ST.dsKey, ST.gwNo]).id, 'deepseek');
  assert.equal(P.ctx.suaIaShortest([ST.claude, ST.gwNo]).id, 'claude');
  assert.equal(P.ctx.suaIaShortest([ST.claude, ST.codexOk]), null);
});

test('chave salva: só "salva ✓" + trocar/remover; motor pronto pode testar; o padrão fica marcado', () => {
  const P = load({ defaultEngine: 'deepseek', defaultModel: '' });
  setList(P, [ST.claude, ST.codexOk, ST.dsOk, ST.gwNo]);
  const html = P.ctx.suaIaHtml(P.run('suaIaList'), {});
  assert.ok(!/Nenhuma IA pronta/.test(html));
  const ds = cut(html, 'data-suaia="deepseek"', 'data-suaia="gateway"');
  assert.match(ds, /chave da DeepSeek salva ✓/);
  assert.match(ds, /data-sa="keyedit"/);
  assert.match(ds, /data-sa="keydel"/);
  assert.ok(!/data-sakey="deepseek"/.test(ds), 'sem campo (e sem valor) quando já salva');
  assert.match(ds, /✓ seu padrão/);
  assert.match(html, /class="suaia-card def" data-suaia="deepseek"/);
  // testar: habilitado no pronto, desabilitado no que falta
  assert.ok(!/data-sa="test" data-id="codex" disabled/.test(html));
  assert.match(html, /data-sa="test" data-id="claude" disabled/);
  // modelos do catálogo do seletor
  assert.match(cut(html, 'data-suaia="codex"', 'data-suaia="deepseek"'), /<option value="gpt-6-astra"/);
});

test('chave colada vai pro cofre da conta com o NOME certo por motor e o estado é relido', async () => {
  let next = [ST.claude, ST.codexLogin, ST.dsOk, ST.gwNo];
  const P = load({}, { invoke: (cmd) => (cmd === 'ai_engines_status' ? next : null) });
  setList(P, [ST.claude, ST.codexLogin, ST.dsKey, ST.gwNo]);
  const saved = [];
  P.ctx.secretSet = async (n, v) => { saved.push([n, v]); };
  P.ctx.SB = { sess: () => null };
  await assert.rejects(() => P.ctx.suaIaSaveKey('deepseek', 'sk-ds'), /Entre na sua conta/);
  P.ctx.SB = { sess: () => ({ user: {} }) };
  assert.equal(await P.ctx.suaIaSaveKey('deepseek', '  sk-ds  '), true);
  assert.deepEqual(saved, [['DEEPSEEK_API_KEY', 'sk-ds']]);
  assert.ok(P.calls.some((c) => c[0] === 'ai_engines_status'), 'verifica de novo depois de salvar');
  assert.equal(P.ctx.suaIaOf('deepseek').state, 'ready', 'estado vira "pronto"');
  next = [ST.claude, Object.assign({}, ST.codexOk, { keySaved: true }), ST.dsOk, ST.gwNo];
  await P.ctx.suaIaSaveKey('codex', 'sk-oa');
  assert.deepEqual(saved[1], ['OPENAI_API_KEY', 'sk-oa']);
  assert.equal(await P.ctx.suaIaSaveKey('gateway', 'x'), false, 'gateway usa a config "Gateway próprio"');
  assert.equal(await P.ctx.suaIaSaveKey('codex', '   '), false);
  assert.equal(saved.length, 2);
});

test('usar como padrão chama aiSaveDefaults; motor não pronto confirma antes', async () => {
  const P = load();
  setList(P, [ST.claude, ST.codexOk, ST.dsKey, ST.gwNo]);
  const saves = [], asks = [];
  P.ctx.aiSaveDefaults = (e, m) => saves.push([e, m]);
  P.ctx.askYes = async (msg) => { asks.push(msg); return false; };
  assert.equal(await P.ctx.suaIaUseDefault('codex', 'gpt-5'), true);
  assert.deepEqual(saves, [['codex', 'gpt-5']]);
  assert.equal(asks.length, 0, 'pronto: sem pergunta');
  assert.equal(await P.ctx.suaIaUseDefault('deepseek'), false);
  assert.equal(asks.length, 1);
  assert.match(asks[0], /falta chave/);
  assert.equal(saves.length, 1, 'recusou: não muda o padrão');
  P.ctx.askYes = async () => true;
  assert.equal(await P.ctx.suaIaUseDefault('deepseek'), true);
  assert.deepEqual(saves[1], ['deepseek', '']);
});

test('testar: ai_test forçando o motor com o modelo do cartão; resposta e tempo, ou o erro humano do motor', async () => {
  let fail = false;
  const P = load({}, { invoke: (cmd) => {
    if (cmd !== 'ai_test') return null;
    if (fail) throw 'O Codex está sem login/chave — rode `codex login` num terminal.\n\n(401 Unauthorized)';
    return { engine: 'Codex', text: 'ok', ms: 1840, model: 'o4-mini', requested: 'o4-mini', fallback: false };
  } });
  setList(P, [ST.claude, ST.codexOk, ST.dsKey, ST.gwNo]);
  P.run("suaIaUi.model.codex='o4-mini'");
  const ok = await P.ctx.suaIaTest('codex');
  assert.deepEqual(P.calls.find((c) => c[0] === 'ai_test')[1], { engine: 'codex', model: 'o4-mini' });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /Codex respondeu “ok” com o4-mini em 1,8s$/);
  fail = true;
  const bad = await P.ctx.suaIaTest('codex');
  assert.equal(bad.ok, false);
  assert.equal(bad.text, '✕ O Codex está sem login/chave — rode `codex login` num terminal.');
  assert.match(bad.raw, /401/);
});

test('seletores (formulário/planner): estado em cada cartão + "configurar" que leva ao painel', () => {
  const P = load();
  setList(P, [ST.claude, ST.codexOk, ST.dsKey, ST.gwNo]);
  assert.match(P.ctx.aiPickStateHtml('codex'), /class="aist ok">pronto</);
  assert.match(P.ctx.aiPickStateHtml('deepseek'), /falta chave/);
  assert.match(P.ctx.aiPickStateHtml('gateway'), /falta configurar/);
  assert.equal(P.ctx.aiPickStateHtml('mock'), '');
  assert.match(P.ctx.aiPickCfgLink('deepseek'), /data-aicfg>configurar agora/);
  assert.match(P.ctx.aiPickCfgLink('codex'), /data-aicfg>configurar</);
  assert.equal(P.ctx.aiPickCfgLink('mock'), '');
  // o link "configurar" dos seletores abre o painel (não o openCfg cru)
  assert.match(read('29-ia-picker.js'), /\[data-aicfg\][^\n]*suaIaOpenCfg\(\)/);
});

test('Primeiros passos: passo "Escolher a IA" com o MESMO painel (aplica a escolha) e Ajustes › IA e modelos também', () => {
  const aj = read('67-ajustes.js');
  const P = new Function(cut(aj, '// @ajustes-puro-inicio', '// @ajustes-puro-fim') + '\nreturn { ppSteps };')();
  const ids = P.ppSteps({}).steps.map((s) => s.id);
  assert.ok(ids.indexOf('pc') < ids.indexOf('ia') && ids.indexOf('ia') < ids.indexOf('proj'), 'ordem nova: computador → IA → projeto');
  const step = cut(aj, "} else if(id==='ia'){", "} else if(id==='proj'){");
  assert.match(step, /suaIaMount\(\$id\('ppSuaIa'\), \{ ctx:'onboarding'/);
  assert.match(step, /suaIaObApply\(\)/, 'a escolha vira o padrão');
  // Ajustes: o mesmo componente no lugar do "IA padrão"
  const cfg = cut(aj, 'function ajRenderMotores(host){', '\n// a pílula');
  assert.match(cfg, /suaIaMount\(\$id\('suaIaCfg'\), \{ ctx:'ajustes'/);
  assert.ok(!/aiPickCfg/.test(cfg));
});

test('chave salva na nuvem que NÃO chegou neste computador (keySaved continua false) → erro humano, não sucesso', async () => {
  const P = load({}, { invoke: (cmd) => (cmd === 'ai_engines_status' ? [ST.claude, ST.codexLogin, ST.dsKey, ST.gwNo] : null) });
  setList(P, [ST.claude, ST.codexLogin, ST.dsKey, ST.gwNo]);
  P.ctx.secretSet = async () => {}; // o secretSet real engole a falha do sync
  P.ctx.SB = { sess: () => ({ user: {} }) };
  await assert.rejects(() => P.ctx.suaIaSaveKey('deepseek', 'sk-ds'), /salva na conta mas não chegou neste computador/);
});

test('leitura forçada durante outra em andamento espera e lê DE NOVO (não devolve o estado de antes)', async () => {
  let n = 0;
  const P = load({}, { invoke: async (cmd) => { if (cmd !== 'ai_engines_status') return null; n++; await new Promise((r) => setTimeout(r, 10)); return n === 1 ? [ST.dsKey] : [ST.dsOk]; } });
  const first = P.ctx.suaIaLoad(true);
  const forced = P.ctx.suaIaLoad(true);
  await first;
  const got = await forced;
  assert.equal(n, 2);
  assert.equal(got[0].state, 'ready');
});

test('remover chave: cancelar não remove; confirmar remove e relê', async () => {
  const P = load({}, { invoke: (cmd) => (cmd === 'ai_engines_status' ? [ST.claude, ST.codexOk, ST.dsKey, ST.gwNo] : null) });
  setList(P, [ST.claude, ST.codexOk, ST.dsOk, ST.gwNo]);
  const del = [];
  P.ctx.secretDel = async (n) => { del.push(n); };
  P.ctx.askYes = async () => false;
  assert.equal(await P.ctx.suaIaRemoveKey('deepseek'), false);
  assert.equal(del.length, 0);
  P.ctx.askYes = async () => true;
  assert.equal(await P.ctx.suaIaRemoveKey('deepseek'), true);
  assert.deepEqual(del, ['DEEPSEEK_API_KEY']);
  assert.equal(P.ctx.suaIaOf('deepseek').keySaved, false, 'relido depois de remover');
});

test('chip do seletor: carrega sob demanda uma vez, aparece depois; vazio/velho relê, falha não martela', async () => {
  let fail = false;
  const P = load({}, { invoke: (cmd) => { if (cmd !== 'ai_engines_status') return null; if (fail) throw new Error('backend'); return [ST.claude, ST.codexOk, ST.dsKey, ST.gwNo]; } });
  assert.equal(P.run('suaIaList'), null);
  assert.equal(P.ctx.aiPickStateHtml('codex'), '');
  assert.equal(P.ctx.aiPickStateHtml('deepseek'), '');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(P.calls.filter((c) => c[0] === 'ai_engines_status').length, 1, 'uma leitura só');
  assert.match(P.ctx.aiPickStateHtml('codex'), /class="aist ok">pronto</);
  // zerado por chave nova (suaIaAt=0) → relê
  P.run('suaIaAt=0');
  P.ctx.aiPickStateHtml('codex');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(P.calls.filter((c) => c[0] === 'ai_engines_status').length, 2);
  // falhou com lista vazia → não relê a cada desenho
  fail = true; P.run('suaIaList=[]; suaIaAt=0');
  P.ctx.aiPickStateHtml('codex'); await new Promise((r) => setTimeout(r, 20));
  P.ctx.aiPickStateHtml('codex'); await new Promise((r) => setTimeout(r, 20));
  assert.equal(P.calls.filter((c) => c[0] === 'ai_engines_status').length, 3);
});

test('primeiro acesso: padrão não pronto + UMA IA pronta → já escolhida e o "continuar" aplica; duas → a pessoa escolhe', () => {
  const P = load({ defaultEngine: 'claude' });
  const saves = [];
  P.ctx.aiSaveDefaults = (e, m) => saves.push([e, m]);
  // só Codex pronto (Claude, o padrão, não instalado)
  setList(P, [ST.claude, ST.codexOk, ST.dsKey, ST.gwNo]);
  assert.deepEqual(JSON.parse(JSON.stringify(P.ctx.suaIaObSuggest(P.run('suaIaList'), 'claude'))), { candidates: ['codex'], pick: 'codex' });
  const html = P.ctx.suaIaHtml(P.run('suaIaList'), { ctx: 'onboarding', hk: 'h1' });
  assert.match(html, /Vamos usar <b>Codex<\/b>/);
  assert.match(html, /class="suaia-card cand pick" data-suaia="codex"/);
  assert.equal(P.ctx.suaIaObApply(), 'codex');
  assert.deepEqual(saves, [['codex', '']]);
  // duas prontas: nada aplicado até escolher
  setList(P, [ST.claude, ST.codexOk, ST.dsOk, ST.gwNo]);
  P.ctx.localStorage.setItem('defaultEngine', 'claude');
  assert.equal(P.ctx.suaIaObApply(), null);
  assert.match(P.ctx.suaIaHtml(P.run('suaIaList'), { ctx: 'onboarding', hk: 'h1' }), /data-sa="obpick" data-id="deepseek"/);
  P.run("suaIaUi.obPick='deepseek'");
  assert.equal(P.ctx.suaIaObApply(), 'deepseek');
  // padrão pronto: nada a sugerir; nenhum pronto: idem
  assert.equal(P.ctx.suaIaObSuggest([ST.claude, ST.codexOk], 'codex'), null);
  assert.equal(P.ctx.suaIaObSuggest([ST.claude, ST.codexLogin], 'claude'), null);
  // Primeiros passos: o passo da IA mostra "vai usar" quando pronto (ppStepSub)
  assert.match(read('67-ajustes.js'), /'vai usar: '\+aiRunLabel/);
});

test('dois painéis montados (tour + Configurações): ids únicos por container e nenhuma busca global', () => {
  const P = load();
  setList(P, [ST.claude, ST.codexLogin, ST.dsKey, ST.gwNo]);
  P.run('suaIaUi.gwOpen=true');
  const a = P.ctx.suaIaHtml(P.run('suaIaList'), { ctx: 'onboarding', hk: 'h1' });
  const b = P.ctx.suaIaHtml(P.run('suaIaList'), { ctx: 'cfg', hk: 'h2' });
  const ids = (h) => [...h.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids(a).length >= 2);
  assert.equal(ids(a).filter((x) => ids(b).includes(x)).length, 0, 'nenhum id repetido entre os dois');
  assert.ok(!/id="raHost"/.test(a), 'form do gateway num container escopado, sem #raHost duplicado');
  assert.match(a, /data-sagw="h1"/);
  // toda busca de elemento do painel é escopada no host (só suaIaOpenCfg e os seletores olham o documento)
  const src = read('30-sua-ia.js');
  const glob = [...src.matchAll(/\$id\(([^)]*)\)|document\.querySelector(All)?\(([^)]*)\)/g)].map((m) => m[0]);
  assert.deepEqual(glob.sort(), ["$id('suaIaCfg')", "document.querySelector('.aipick')"].sort());
  assert.match(src, /suaIaFocusSel/);
});

test('gateway: o modelo padrão salvo pelo nome é a opção "padrão" (sem duplicar) e o ✓ bate; Node velho tem estado próprio', () => {
  const gw = Object.assign({}, ST.gwNo, { ready: true, state: 'ready', reason: 'pronto', installed: true, models: ['m1', 'm2'] });
  const P = load({ defaultEngine: 'gateway', defaultModel: 'm1' });
  setList(P, [ST.claude, ST.codexOk, ST.dsKey, gw]);
  const card = cut(P.ctx.suaIaHtml(P.run('suaIaList'), { hk: 'h' }) + '<END>', 'data-suaia="gateway"', '<END>');
  assert.ok(!/outro modelo/.test(card));
  assert.match(card, /✓ seu padrão/);
  assert.equal(P.ctx.suaIaStateText({ id: 'deepseek', state: 'node' }), 'falta atualizar o Node');
  // padrão não pronto: o próprio cartão avisa
  const P2 = load({ defaultEngine: 'codex' });
  setList(P2, [ST.claude, ST.codexLogin, ST.dsOk, ST.gwNo].map((s) => (s.id === 'deepseek' ? Object.assign({}, s, { inUse: true }) : s)));
  const c2 = cut(P2.ctx.suaIaHtml(P2.run('suaIaList'), { hk: 'h' }), 'data-suaia="codex"', 'data-suaia="deepseek"');
  assert.match(c2, /seu padrão não está pronto<\/b> — por enquanto as chamadas usam DeepSeek Harness/);
});

test('testar: modelo recusado/descartado é sinalizado', async () => {
  const P = load({}, { invoke: (cmd) => (cmd === 'ai_test' ? { engine: 'Codex', text: 'ok', ms: 900, model: '', requested: 'gpt-x', fallback: true } : null) });
  setList(P, [ST.claude, ST.codexOk, ST.dsKey, ST.gwNo]);
  P.run("suaIaUi.model.codex='gpt-x'");
  const r = await P.ctx.suaIaTest('codex');
  assert.match(r.text, /com o modelo padrão em 0,9s — atenção: “gpt-x” não foi aceito/);
});

// spec-medidor-v2-statusline: interruptor da % real do Claude (barra de status do Claude Code) no cartão do Claude
test('Claude: interruptor da % do plano no medidor — só com o Claude instalado; liga/desliga pelo CLI e relê', async () => {
  const claudeOk = { ...ST.claude, installed: true, ready: true, state: 'ready', reason: 'pronto', fixes: [], statuslineInstalled: false };
  let installed = false, fail = false;
  const P = load({}, { invoke: (cmd, a) => {
    if (cmd === 'claude_statusline_set') { if (fail) throw new Error('/x/.claude/settings.json não é um JSON válido — não mexi em nada.'); installed = a.on; return { ok: true, message: a.on ? 'barra do Starfork instalada' : 'barra do Starfork removida', installed: a.on }; }
    if (cmd === 'ai_engines_status') return [{ ...claudeOk, statuslineInstalled: installed }, ST.codexOk, ST.dsKey, ST.gwNo];
    return null;
  } });
  setList(P, [ST.claude, ST.codexOk, ST.dsKey, ST.gwNo]);
  assert.ok(!/data-sasl/.test(P.ctx.suaIaHtml(P.run('suaIaList'), { hk: 'h' })), 'Claude não instalado: sem interruptor');
  setList(P, [claudeOk, ST.codexOk, ST.dsKey, ST.gwNo]);
  const card = () => cut(P.ctx.suaIaHtml(P.run('suaIaList'), { hk: 'h' }), 'data-suaia="claude"', 'data-suaia="codex"');
  assert.match(card(), /<input type="checkbox" role="switch" id="suaIaSl-h" data-sasl="1" aria-describedby="suaIaSl-h-d"><label for="suaIaSl-h">Mostrar a % do plano do Claude no medidor<\/label>/);
  assert.match(card(), /Se você já tem uma barra de status, ela continua aparecendo; desligar desfaz/);
  let r = await P.ctx.suaIaSetStatusline(true);
  assert.deepEqual(P.calls.find((c) => c[0] === 'claude_statusline_set'), ['claude_statusline_set', { on: true }]);
  assert.equal(r.ok, true);
  assert.equal(r.text, '✓ barra do Starfork instalada');
  assert.ok(P.calls.some((c) => c[0] === 'ai_engines_status'), 'relê o estado');
  assert.match(card(), /data-sasl="1" checked/);
  r = await P.ctx.suaIaSetStatusline(false);
  assert.deepEqual(P.calls.filter((c) => c[0] === 'claude_statusline_set').at(-1), ['claude_statusline_set', { on: false }]);
  assert.ok(!/data-sasl="1" checked/.test(card()));
  fail = true;
  r = await P.ctx.suaIaSetStatusline(true);
  assert.equal(r.ok, false);
  assert.match(r.text, /^✕ Não consegui ativar a % do Claude: .*não é um JSON válido/);
  assert.ok(!/data-sasl="1" checked/.test(card()), 'falhou: continua desligado');
});

test('interruptor do Claude: ocupado = desabilitado ("ativando…"); Pro/Max na descrição; reparo e barra do projeto avisam', async () => {
  const claudeOn = { ...ST.claude, installed: true, ready: true, state: 'ready', reason: 'pronto', fixes: [], statuslineInstalled: true, statuslineRepair: false };
  let release;
  const gate = new Promise((r) => { release = r; });
  let slStatus = { ok: true, installed: true, nodeOk: true, overriddenBy: [] };
  const P = load({}, { invoke: async (cmd) => {
    if (cmd === 'claude_statusline_set') { await gate; return { ok: true, message: 'ok' }; }
    if (cmd === 'ai_engines_status') return [{ ...claudeOn, statuslineInstalled: false }, ST.codexOk, ST.dsKey, ST.gwNo];
    if (cmd === 'claude_statusline_status') return slStatus;
    return null;
  } });
  setList(P, [{ ...claudeOn, statuslineInstalled: false }, ST.codexOk, ST.dsKey, ST.gwNo]);
  const card = () => cut(P.ctx.suaIaHtml(P.run('suaIaList'), { hk: 'h' }), 'data-suaia="claude"', 'data-suaia="codex"');
  assert.match(card(), /Requer plano Pro\/Max no Claude Code \(com chave de API não há %\)/);
  const p = P.ctx.suaIaSetStatusline(true);
  assert.match(card(), /data-sasl="1" disabled aria-busy="true"/, 'ocupado: não dá pra clicar de novo');
  assert.match(card(), /<label for="suaIaSl-h">ativando…<\/label>/);
  release();
  await p;
  assert.ok(!/data-sasl="1"[^>]*disabled/.test(card()), 'terminou: habilitado de novo');
  // ligado + reparo pendente (boot não conseguiu reinstalar) ou node sumido (status)
  setList(P, [{ ...claudeOn, statuslineRepair: true }, ST.codexOk, ST.dsKey, ST.gwNo]);
  assert.match(card(), /a barra de status do Claude precisa ser reparada/);
  setList(P, [claudeOn, ST.codexOk, ST.dsKey, ST.gwNo]);
  P.run('suaIaUi.slStatus=null');
  assert.ok(!/precisa ser reparada|data-sasl-over/.test(card()));
  slStatus = { ok: true, installed: true, nodeOk: false, overriddenBy: ['/r/proj/.claude/settings.local.json'] };
  await P.ctx.suaIaSlStatusLoad();
  assert.match(card(), /precisa ser reparada/);
  assert.match(card(), /o projeto aberto define a própria barra de status \(\.claude\/settings\.local\.json\) — ela substitui a do Starfork/);
  // desligado: nada disso aparece
  setList(P, [{ ...claudeOn, statuslineInstalled: false, statuslineRepair: true }, ST.codexOk, ST.dsKey, ST.gwNo]);
  assert.ok(!/precisa ser reparada|data-sasl-over/.test(card()));
});

test('Codex pronto pelo login do ChatGPT: chave da OpenAI vira só um link (não um campo que parece obrigatório)', () => {
  const P = load();
  const pronto = { id: 'codex', ready: true, keyName: 'OPENAI_API_KEY', keySaved: false };
  const h1 = P.ctx.suaIaKeyHtml(pronto, 'h1');
  assert.match(h1, /usar uma chave da OpenAI em vez do login do ChatGPT/);
  assert.doesNotMatch(h1, /data-sakey=/, 'sem campo de chave');
  const semLogin = { id: 'codex', ready: false, keyName: 'OPENAI_API_KEY', keySaved: false };
  assert.match(P.ctx.suaIaKeyHtml(semLogin, 'h1'), /sem plano do ChatGPT\? cole uma chave da OpenAI \(opcional\)/);
  assert.match(P.ctx.suaIaKeyHtml(semLogin, 'h1'), /data-sakey="codex"/, 'sem login: o campo aparece como alternativa');
});
