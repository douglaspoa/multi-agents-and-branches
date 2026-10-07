// "Começar por uma ideia" (spec-ideia-mesa-pesquisa, 59-ideia.js): `node --test app/tests/ideia.test.mjs`
// Relatório da pesquisa (estrutura + checagem de citação: fato sem URL e número sem fonte são RECUSADOS), a mesa da
// ideia (Pesquisadora + as 5 vozes), prompts isolados por persona, plataforma votada, custo previsto por motor e a
// aba (registro no motor de abas, entradas, botões por passo, conversa rodando só com a aba à mostra, pesquisa
// parável, criar projeto nas duas opções) — sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const MESA_PURE = cut(read('js/38-mesa.js'), '// @puro-inicio', '// @puro-fim');
const IDEIA_SRC = read('js/59-ideia.js');
// F4: o fim de caminho da ideia (aba Projeto) é o MESMO formulário do "construir sozinho" (56-piloto)
const PILOTO_PURE = cut(read('js/00-util.js'), '// DINHEIRO DIGITADO', '// @helpers-comuns-fim') + cut(read('js/56-piloto.js'), '// @piloto-puro-inicio', '// @piloto-puro-fim');
const P = new Function(MESA_PURE + cut(IDEIA_SRC, '// @ideia-puro-inicio', '// @ideia-puro-fim') +
  '\nreturn { IDEIA_PESQ, ideiaPanel, ideiaTitle, ideiaSlug, ideiaPlat, ideiaCheckReport, ideiaSanitize, ideiaReportMd, ideiaResearchCost, ideiaTurnPrompt, ideiaHistory, ideiaPersonaSys, ideiaResearchPrompt, ideiaFixPrompt, ideiaPickPlatform, ideiaDecisionView, ideiaBuildPlan, ideiaEpicMd, ideiaTaskPayloads, ideiaStage, ideiaRevive, ideiaR1Prompt, ideiaR2Prompt };')();
const plain = (v) => JSON.parse(JSON.stringify(v)); // valores de outro contexto do vm
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const item = (texto, rotulo, fontes = []) => ({ texto, rotulo, fontes });
const good = () => ({
  resumo: 'Existe procura por rotinas guiadas de skincare.',
  demanda: [item('Comunidade r/SkincareAddiction tem discussões diárias sobre rotina', 'fato', ['https://www.reddit.com/r/SkincareAddiction/'])],
  tendencias: [item('Rotinas curtas ganharam espaço', 'inferencia', ['https://exemplo.com/tendencias'])],
  concorrentes: [{ nome: 'TroveSkin', url: 'https://troveskin.com', texto: 'diário de pele com fotos', rotulo: 'fato', fontes: ['https://troveskin.com'] }],
  reclamacoes: [item('Usuários reclamam de assinatura cara', 'fato', ['https://apps.apple.com/app/troveskin/id1'])],
  publico: [item('Pessoas de 18 a 35 anos que já seguem rotina', 'suposicao')],
  riscos: [item('Mercado saturado de apps de beleza', 'inferencia')],
  veredito: { resposta: 'talvez', confianca: 'media', texto: 'Há espaço se o foco for lembrete e simplicidade.', porque: [item('Reclamações de preço abrem espaço pra um app grátis', 'inferencia', ['https://apps.apple.com/app/troveskin/id1'])] },
});
const json = (o) => '```json\n' + JSON.stringify(o) + '\n```';

test('mesa da ideia: a Pesquisadora + as 5 vozes da Mesa, cada uma com o próprio system prompt curto', () => {
  assert.deepEqual(P.ideiaPanel().map((p) => p.nome), ['Pesquisadora', 'Bia', 'Rafa', 'Carla', 'Marcos', 'Júlia']);
  const s = P.ideiaPersonaSys(P.IDEIA_PESQ);
  assert.match(s, /Você é Pesquisadora/);
  assert.match(s, /no máximo 3 frases/);
  assert.match(P.IDEIA_PESQ.desc, /nunca inventa número/);
});

test('título e slug da ideia: 1ª frase curta, pasta sem acento nem palavra vazia', () => {
  assert.equal(P.ideiaTitle('Quero criar um app de rotina de skincare com lembretes. Será que vende?'), 'Um app de rotina de skincare com lembretes');
  assert.equal(P.ideiaTitle('   '), 'Ideia sem nome');
  assert.equal(P.ideiaSlug('App de rotina de skincare com lembretes'), 'rotina-skincare-lembretes');
  assert.equal(P.ideiaSlug('!!!'), 'ideia');
  assert.equal(P.ideiaPlat('iOS e Android (Expo)'), 'mobile');
  assert.equal(P.ideiaPlat('iPhone'), 'ios');
  assert.equal(P.ideiaPlat('site'), 'web');
  assert.equal(P.ideiaPlat('???'), '');
});

test('relatório bom: estrutura completa, rótulos normalizados e fontes deduplicadas', () => {
  const r = P.ideiaCheckReport('Pronto:\n' + json(good()) + '\nfim');
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.deepEqual(Object.keys(r.report).sort(), ['concorrentes', 'demanda', 'fontes', 'publico', 'reclamacoes', 'resumo', 'riscos', 'tendencias', 'veredito']);
  assert.equal(r.report.concorrentes[0].url, 'https://troveskin.com');
  assert.equal(r.report.veredito.resposta, 'talvez');
  assert.equal(r.report.fontes.length, 4, 'URL repetida conta uma vez');
  const acc = P.ideiaCheckReport(json({ ...good(), tendencias: [item('x', 'Inferência')], publico: [item('y', 'SUPOSIÇÃO')], veredito: { resposta: 'Não', confianca: 'Alta', texto: 'não', porque: [] } }));
  assert.equal(acc.report.tendencias[0].rotulo, 'inferencia');
  assert.equal(acc.report.publico[0].rotulo, 'suposicao');
  assert.deepEqual([acc.report.veredito.resposta, acc.report.veredito.confianca], ['nao', 'alta']);
});

test('citação obrigatória: fato SEM URL é recusado (e URL que não é http não conta)', () => {
  const o = good(); o.demanda.push(item('O app líder tem 2 milhões de usuários', 'fato', []), item('Muita gente pesquisa isso', 'fato', ['ftp://x', 'não é link']));
  const r = P.ideiaCheckReport(json(o));
  assert.equal(r.ok, false);
  assert.equal(r.errors.filter((e) => /^fato sem fonte/.test(e)).length, 2);
  assert.match(r.errors.join('\n'), /fato sem fonte \(sinais de demanda\): "O app líder tem 2 milhões/);
});

test('nunca inventar número: número em inferência/suposição é recusado; em fato com URL vale', () => {
  const o = good(); o.publico = [item('Uns 40% das mulheres usam app de beleza', 'suposicao')]; o.riscos = [item('Custa R$ 30 mil pra lançar', 'inferencia')];
  const r = P.ideiaCheckReport(json(o));
  assert.equal(r.ok, false);
  assert.equal(r.errors.filter((e) => /^número sem fonte/.test(e)).length, 2);
  const f = good(); f.demanda = [item('O subreddit tem 1,9 milhão de membros', 'fato', ['https://www.reddit.com/r/SkincareAddiction/'])];
  assert.equal(P.ideiaCheckReport(json(f)).ok, true);
});

test('relatório sem NENHUMA fonte ou sem veredito é recusado; sem JSON também', () => {
  const o = good(); for (const k of ['demanda', 'tendencias', 'concorrentes', 'reclamacoes', 'publico', 'riscos']) o[k] = [item('palpite', 'suposicao')]; o.veredito.porque = [];
  const r = P.ideiaCheckReport(json(o));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /nenhuma fonte/);
  assert.equal(P.ideiaSanitize(r.report), null, 'sem fonte nenhuma não há o que salvar');
  const v = good(); delete v.veredito;
  assert.match(P.ideiaCheckReport(json(v)).errors.join('\n'), /faltou o veredito/);
  assert.deepEqual(P.ideiaCheckReport('não sei').errors, ['a resposta não trouxe o JSON do relatório']);
});

test('depois da correção que não veio: fato sem URL vira suposição marcada; número sem fonte ganha aviso', () => {
  const o = good(); o.demanda.push(item('Todo mundo quer isso', 'fato', [])); o.riscos = [item('Uns 30% desistem', 'inferencia')];
  const r = P.ideiaCheckReport(json(o));
  const s = P.ideiaSanitize(r.report);
  const d = s.demanda.find((x) => /Todo mundo/.test(x.texto));
  assert.deepEqual([d.rotulo, d.semFonte], ['suposicao', true]);
  assert.equal(s.riscos[0].numSemFonte, true);
  assert.equal(s.avisos.length, 2);
  const md = P.ideiaReportMd(s, 'Skincare', { engine: 'Claude', date: '02/10/2026' });
  assert.match(md, /\*\*\[suposição\]\*\* \*\(sem fonte\)\* Todo mundo quer isso/);
  assert.match(md, /número sem fonte — confira/);
  assert.match(md, /## Avisos da checagem/);
  assert.match(P.ideiaFixPrompt(r.errors), /Corrija SEM pesquisar de novo/);
});

test('documento: veredito no topo, item com rótulo e referência numerada, concorrente com link, lista de fontes', () => {
  const r = P.ideiaCheckReport(json(good())).report;
  const md = P.ideiaReportMd(r, 'App de skincare', { engine: 'Claude', date: '02/10/2026' });
  assert.match(md, /^# Pesquisa: App de skincare/);
  assert.match(md, /> \*\*Vale a pena agora\? Talvez\*\* \(confiança média\)/);
  assert.match(md, /- \*\*\[fato\]\*\* \[TroveSkin\]\(https:\/\/troveskin\.com\) — diário de pele com fotos \[\d\]\(https:\/\/troveskin\.com\)/);
  assert.match(md, /## Fontes\n1\. \[https:\/\/www\.reddit\.com\/r\/SkincareAddiction\/\]\(https:\/\/www\.reddit\.com/);
  for (const sec of ['Sinais de demanda', 'Tendências e por que agora', 'Concorrentes e alternativas', 'Do que os usuários reclamam', 'Público-alvo', 'Riscos']) assert.ok(md.includes('## ' + sec), sec);
});

test('prompt da pesquisa pede tudo do pedido e a regra de citação; custo previsto por motor', () => {
  const p = P.ideiaResearchPrompt({ titulo: 'Skincare', turns: [] });
  assert.match(p, /^IDEIA: Skincare/, 'a 1ª linha vira a busca da pesquisa ampliada (ideia.rs query_of)');
  for (const k of ['"demanda"', '"tendencias"', '"concorrentes"', '"reclamacoes"', '"publico"', '"riscos"', '"veredito"', 'fato|inferencia|suposicao']) assert.ok(p.includes(k), k);
  const [lo, hi] = P.ideiaResearchCost('claude', 'claude-sonnet-5');
  assert.ok(lo > 0 && hi > lo);
  assert.ok(P.ideiaResearchCost('claude', 'claude-opus-5')[1] > hi);
  assert.ok(P.ideiaResearchCost('deepseek')[1] < hi);
  assert.ok(P.ideiaResearchCost('codex')[0] > 0);
});

test('conversa: cada persona responde sem ver as outras da MESMA rodada; o histórico entra', () => {
  const idea = { titulo: 'Skincare', turns: [
    { you: 'quero um app de skincare', resp: { bia: { st: 'ok', text: 'quero simples' }, rafa: { st: 'falhou' } } },
    { you: 'e se for só lembretes?', resp: { bia: { st: 'ok', text: 'RESPOSTA-DA-BIA-AGORA' }, pesq: { st: 'pendente' } } },
  ] };
  const pr = P.ideiaTurnPrompt(idea, P.IDEIA_PESQ, idea.turns[1]);
  assert.match(pr, /Bia: quero simples/);
  assert.ok(!pr.includes('RESPOSTA-DA-BIA-AGORA'), 'não vê a resposta da colega na mesma rodada');
  assert.match(pr, /"e se for só lembretes\?"/);
  assert.match(pr, /NÃO afirme números/);
});

test('decisão: plataforma da maioria (empate cai na rodada 1, nada → web); MVP respeita a escolha da pessoa', () => {
  const ok = (plataforma) => ({ st: 'ok', plataforma });
  assert.equal(P.ideiaPickPlatform({ a: ok('ios'), b: ok('ios'), c: ok('web') }, {}), 'ios');
  assert.equal(P.ideiaPickPlatform({ a: ok('ios'), b: ok('web') }, { a: ok('web') }), 'web');
  assert.equal(P.ideiaPickPlatform({}, {}), 'web');
  const ps = P.ideiaPanel();
  const cands = [{ id: 'F1', titulo: 'Rotina', descricao: 'd1' }, { id: 'F2', titulo: 'Lembrete', descricao: 'd2' }];
  const v = (top) => ({ st: 'ok', plataforma: 'web', voto: { fala: '', top: top.map(([id, peso]) => ({ id, peso })), vetos: [] } });
  const dc = { rounds: [{ resp: {} }, { resp: Object.fromEntries(ps.map((p) => [p.id, v([['F1', 2], ['F2', 1]])])) }], cands, escolhas: { F2: 'rejeitada' }, plataforma: 'ios' };
  const view = P.ideiaDecisionView(dc, ps);
  assert.deepEqual(view.mvp.map((f) => f.id), ['F1']);
  assert.deepEqual(view.naoObjetivos, ['Lembrete']);
  assert.equal(view.plataforma, 'ios', 'a escolha da pessoa vence a votada');
  assert.equal(view.plataformaVotada, 'web');
  assert.match(P.ideiaR2Prompt({ titulo: 'Skincare' }, ps, {}, cands), /"plataforma":"web\|ios\|android\|mobile"/);
  assert.match(P.ideiaR1Prompt({ titulo: 'Skincare', turns: [] }), /"naoObjetivos"/);
});

test('opção "seguir eu mesmo": tarefas em rascunho sob o épico local, ondas e dependências pelo índice', () => {
  const view = { mvp: [{ id: 'F1', titulo: 'Rotina', descricao: 'd' }, { id: 'F2', titulo: 'Lembrete', descricao: 'd' }], naoObjetivos: ['loja'], plataforma: 'web' };
  const plan = P.ideiaBuildPlan({ titulo: 'Skincare' }, view, '');
  assert.equal(plan.docs, undefined, 'sem pesquisa, sem doc');
  const ps = P.ideiaTaskPayloads(plan, 'ideia-skincare', { engine: 'codex', model: 'gpt-5' });
  assert.equal(ps.length, 3);
  assert.deepEqual(ps.map((x) => x.afterIdx), [[], [0], [0]]);
  assert.deepEqual(ps.map((x) => x.payload.wave), [1, 2, 2]);
  for (const { payload } of ps) {
    assert.equal(payload.start, false, 'rascunho: nada começa sozinho');
    assert.equal(payload.epicId, 'ideia-skincare');
    assert.equal(payload.engine, 'codex');
    assert.deepEqual(payload.boundaries, ['loja']);
    assert.ok(payload.epicDoneWhen.length >= 2);
  }
  const md = P.ideiaEpicMd(plan, 'Skincare');
  assert.match(md, /## Pronto quando/);
  assert.match(md, /## Fora do MVP \(não-objetivos\)\n- loja/);
});

test('passo da ideia e retomada depois de fechar o app (o que pensava vira "interrompida")', () => {
  assert.equal(P.ideiaStage({ turns: [] }), 'conversar');
  assert.equal(P.ideiaStage({ turns: [{}] }), 'pesquisar');
  assert.equal(P.ideiaStage({ turns: [{}], report: { status: 'ok' } }), 'decidir');
  assert.equal(P.ideiaStage({ turns: [{}], decision: { status: 'ok' } }), 'criar');
  assert.equal(P.ideiaStage({ project: { dir: '/x' } }), 'criado');
  const m = P.ideiaRevive({ turns: [{ resp: { bia: { st: 'pendente' } } }], report: { status: 'rodando' }, decision: { status: 'rodando', rounds: [{ resp: { rafa: { st: 'pendente' } } }] } });
  assert.equal(m.turns[0].resp.bia.st, 'interrompida');
  assert.equal(m.report.status, 'interrompida');
  assert.equal(m.decision.status, 'interrompida');
  assert.equal(m.decision.rounds[0].resp.rafa.st, 'interrompida');
});

// ---------------- a aba (59-ideia.js inteiro num contexto com DOM mínimo) ----------------
function load(opts = {}) {
  const calls = [], els = {}, toasts = [], tabs = [], listeners = {};
  const el = (id) => (els[id] ??= { id, innerHTML: '', value: '', style: { display: opts.hidden ? 'none' : 'block' }, dataset: {}, focus() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], contains: () => false });
  const ctx = {
    console, Promise, JSON, Date, Math, setTimeout: (fn) => 0, clearTimeout() {},
    window: { __TAURI__: { event: { listen: (n, fn) => { listeners[n] = fn; return Promise.resolve(() => {}); } } }, openTab: (k) => tabs.push(k), ndTakeCarry: () => opts.carry || '' },
    document: { getElementById: el, addEventListener() {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [] },
    IC: { ok: '<svg ok/>', x: '<svg x/>', back: '', stopsq: '', play: '', ai: '' },
    $id: el, bindClick: (id, fn) => { const e = el(id); e.onclick = fn; return e; },
    toast: (m, k) => toasts.push([m, k]), showErr: (e, w) => toasts.push([w + ': ' + (e && e.message || e), 'err']), askYes: async () => true,
    humanErr: (e, w) => ({ msg: (w ? w + ': ' : '') + String(e && e.message || e) }),
    mdToHtml: (s) => '<md>' + String(s).replace(/</g, '&lt;') + '</md>',
    fmtCost: (v) => 'US$ ' + (+v || 0).toFixed(2), fmtCostRange: (a, b) => `~US$ ${a.toFixed(2)}–${b.toFixed(2)}`,
    chatComposerHtml: (o) => `<div class="cc"><textarea id="${o.input}"></textarea>${o.stop ? `<button id="${o.stop}">parar</button>` : ''}<button id="${o.send}">${o.sendHtml}</button></div>`,
    chatComposer() {}, aiChatModelPill: (id) => ({ id, label: 'Claude · Sonnet' }), aiChatRunLabel: () => 'Claude · Sonnet', aiClaudeModel: () => null,
    defaultAiEngine: () => opts.engine || 'claude', defaultAiModel: () => null, lsGet: () => '', lsSet() {}, renderTabs() {}, chatPinBottom() {}, stickBottom: () => () => {},
    ovShow: (o) => { o.style.display = 'block'; }, roughEstimate: (n, m) => [0.12 * n, 0.5 * n],
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'), escA: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    invoke: (cmd, args) => { calls.push([cmd, args]); return opts.invoke ? opts.invoke(cmd, args) : Promise.resolve(null); },
  };
  ctx.invokeQuiet = ctx.invoke;
  vm.createContext(ctx);
  vm.runInContext(MESA_PURE + '\n' + PILOTO_PURE + '\n' + IDEIA_SRC + '\n;globalThis.__I=IDEIA;', ctx);
  return { ctx, el, calls, toasts, tabs, listeners, run: (c) => vm.runInContext(c, ctx) };
}
const idea0 = (extra = {}) => Object.assign({ id: 'i-test-1', v: 1, titulo: 'App de rotina de skincare', turns: [], report: null, decision: null, project: null, costUsd: 0, tokUsd: 0, capUsd: 5 }, extra); // toda ideia tem teto da sessão (B2)

test('aba registrada no motor de abas: instância múltipla, overlay próprio, sem exigir projeto; entradas na Nova demanda, no +, na Mesa e na tela inicial', () => {
  const abas = read('js/15-config-abas-onboarding.js');
  assert.match(abas, /ideia:\{title:'Ideia',icon:/);
  assert.match(abas, /ideia:'ideiaOverlay'/);
  assert.match(abas, /MULTI_KINDS=new Set\(\[[^\]]*'ideia'/);
  assert.match(abas, /ideia:\(\)=>window\.openIdeia&&window\.openIdeia\(fresh\)/);
  assert.ok(!/\['nova','form','planner','orq'\]\.includes\(kind\) && typeof state!=='undefined' && !state\.repo/.test(abas) || !/'ideia'\]\.includes\(kind\) && typeof state/.test(abas), 'a ideia não exige projeto');
  // F4 (G2, D8): a Ideia saiu do seletor da Nova demanda (cria PROJETO) e virou Fábrica › App novo › "Tenho uma ideia"
  assert.doesNotMatch(read('js/14-nova-demanda-inicio.js'), /\{ k:'ideia', tab:'ideia'/);
  assert.match(read('js/65-fabrica.js'), /id="fabIdeia"[\s\S]*Tenho uma ideia/);
  assert.match(read('js/65-fabrica.js'), /bindClick\('fabIdeia', \(\)=>\{ if\(typeof ideiaNew==='function'\) ideiaNew\(/);
  // F4 (G1, D8): "Ideia nova" saiu do "+" — o "+" leva a Novo projeto… (Fábrica › App novo, onde mora Tenho uma ideia)
  assert.match(read('js/58-canvas.js'), /k:'novoproj', label:'Novo projeto…'/);
  assert.doesNotMatch(read('js/38-mesa.js'), /id="mesaIdeia"/, 'a lista de mesas (com "Ideia nova") foi pra Fábrica › Sessões');
  const html = read('index.html');
  assert.match(html, /id="ideiaOverlay"/);
  assert.match(html, /<script src="js\/59-ideia\.js"><\/script>/);
  assert.match(html, /css\/94-ideia\.css/);
  assert.match(html, /id="emIdeia"/);
  assert.ok(html.indexOf('js/38-mesa.js') < html.indexOf('js/59-ideia.js'), 'a ideia usa a apuração da Mesa');
});

test('título da aba "Ideia: <título>" e estado por aba (cada aba lembra a sua ideia)', () => {
  const { ctx, run } = load();
  run(`IDEIA.cur=${JSON.stringify(idea0())}; IDEIA.mem['i-test-1']=IDEIA.cur;`);
  const st = ctx.window.TAB_STATE_ideia.get();
  assert.equal(st._title, 'Ideia: App de rotina de skincare');
  assert.equal(st.id, 'i-test-1');
  ctx.window.TAB_STATE_ideia.set({ id: '' });
  assert.equal(run('IDEIA.cur'), null);
  ctx.window.TAB_STATE_ideia.set({ id: 'i-test-1' });
  assert.equal(run('IDEIA.cur.id'), 'i-test-1');
});

test('início: composer com a pílula da IA e as ideias recentes; abrir sem projeto funciona', async () => {
  const { run, calls } = load({ invoke: (c) => Promise.resolve(c === 'ideia_list' ? [{ id: 'i-a', titulo: 'Pou', updatedAt: 1, pesquisa: 'ok' }] : c === 'ideia_research_mode' ? { engine: 'claude', mode: 'native', tools: 'WebSearch' } : null) });
  await run('openIdeia(true)');
  const h = run('$id("ideiaBody").innerHTML');
  assert.match(h, /Tenho uma ideia/);
  assert.match(h, /data-igo="sessoes">Sessões/, 'migalha Fábrica › Sessões › ideia');
  assert.match(h, /id="ideiaNewIn"/);
  assert.match(h, /data-iopen="i-a"/);
  assert.match(text(h), /Pou pesquisada/);
  assert.ok(calls.some(([c]) => c === 'ideia_list'));
});

test('mandar a ideia: cria o arquivo, a mesa inteira responde (Pesquisadora + 5) e grava a conversa', async () => {
  const asked = [];
  const { run, calls } = load({ invoke: (c, a) => { if (c === 'ideia_ask') { asked.push(a); return Promise.resolve({ text: 'resposta de ' + a.personaSys.slice(8, 20), costUsd: 0.01 }); } return Promise.resolve(c === 'ideia_research_mode' ? { engine: 'claude', mode: 'native' } : null); } });
  await run('openIdeia(true)');
  run('$id("ideiaNewIn").value="um app de rotina de skincare com lembretes"; $id("ideiaNewCap").value="2"');
  await run('ideiaStart()');
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 6);
  assert.ok(asked.every((a) => a.id === run('IDEIA.cur.id') && a.json === false));
  const m = run('IDEIA.cur');
  assert.equal(m.titulo, 'Um app de rotina de skincare com lembretes');
  assert.deepEqual(Object.values(m.turns[0].resp).map((x) => x.st), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.ok(Math.abs(m.costUsd - 0.06) < 1e-9);
  assert.ok(calls.filter(([c]) => c === 'ideia_save').length >= 2);
  assert.match(run('$id("ideiaBody").innerHTML'), /Ideia: Um app de rotina/);
});

test('aba escondida: nenhuma persona nova começa (fica "na fila" até a aba voltar)', async () => {
  const asked = [];
  const { run } = load({ hidden: true, invoke: (c, a) => { if (c === 'ideia_ask') asked.push(a); return Promise.resolve(c === 'ideia_ask' ? { text: 'oi' } : null); } });
  run(`IDEIA.cur=${JSON.stringify(idea0())}; IDEIA.mem['i-test-1']=IDEIA.cur;`);
  await run('ideiaSend(IDEIA.cur, "e aí?")');
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 0);
  assert.equal(run('ideiaLive("i-test-1").paused'), true);
  assert.ok(Object.values(run('IDEIA.cur.turns[0].resp')).every((x) => x.st === 'na fila'));
  run('$id("ideiaOverlay").style.display="block"; ideiaResumePaused(IDEIA.cur)');
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 6);
});

test('passos e botões: pesquisar (com custo previsto e teto) → decidir → criar nas duas opções', () => {
  const { run } = load();
  run('IDEIA.mode={ engine:"claude", mode:"native", tools:"busca e leitura de páginas do Claude Code (WebSearch, WebFetch)" }');
  const html = (m) => run(`ideiaIdeaHtml(${JSON.stringify(m)})`);
  let h = html(idea0({ turns: [{ you: 'oi', resp: { pesq: { st: 'ok', text: 'pesquise' } } }] }));
  assert.match(h, /id="ideiaResGo"/);
  assert.match(text(h), /deve custar ~US\$/);
  assert.match(h, /id="ideiaCap"/, 'teto da pesquisa (Claude)');
  assert.match(h, /aria-current="step"><span class="c"><\/span><b>Pesquisar/, 'mesma barra de etapas do Piloto e da Tarefa');
  assert.match(h, /id="ideiaDecGo"/);
  assert.ok(!/id="ideiaMkManual"/.test(h), 'criar só depois da decisão');
  const r = P.ideiaCheckReport(json(good())).report;
  const ps = P.ideiaPanel(), v = (top) => ({ st: 'ok', plataforma: 'web', voto: { fala: '', top: top.map(([id, peso]) => ({ id, peso })), vetos: [] } });
  const decision = { status: 'ok', rounds: [{ n: 1, resp: {} }, { n: 2, resp: Object.fromEntries(ps.map((p) => [p.id, v([['F1', 2]])])) }], cands: [{ id: 'F1', titulo: 'Rotina guiada', descricao: 'd' }], escolhas: {} };
  h = html(idea0({ turns: [{ you: 'oi', resp: {} }], report: { status: 'ok', data: r, md: P.ideiaReportMd(r, 'x', {}), costUsd: 0.31, sites: 7 }, decision }));
  assert.match(text(h), /Vale a pena agora\? Talvez · confiança média/);
  assert.match(text(h), /4 fontes · 7 páginas lidas/);
  assert.match(h, /data-ichoose="F1:aprovada"/);
  assert.match(h, /data-iplat="web"/, 'plataforma votada vira botão');
  // aba Projeto = fim de caminho: seguir à mão | construir sozinho (teto OBRIGATÓRIO) — mesmo formulário do 56-piloto
  assert.match(h, /data-pil-eo="hand"/);
  assert.match(h, /data-pil-eo="auto"/);
  assert.match(h, /id="ipilGh"/, 'GitHub opcional, como no projeto novo');
  assert.match(h, /id="ipilBudget"/);
  assert.match(h, /id="ipilGo" disabled>Construir sozinho/, 'sem teto o botão fica desligado');
  assert.match(h, /data-itab="pes"[\s\S]*data-itab="mvp"[\s\S]*data-itab="proj"/, 'painel com abas Pesquisa · MVP · Projeto');
  h = html(idea0({ project: { dir: '/Users/x/Documents/Starfork/skincare', mode: 'piloto', at: 1 } }));
  assert.match(text(h), /Entregue pro piloto \(construir sozinho\) ~\/Documents\/Starfork\/skincare/);
  assert.match(h, /Ver o progresso do piloto/);
});

test('IA sem web (gateway sem pesquisa ampliada): explica e não oferece "Pesquisar"', () => {
  const { run } = load();
  run('IDEIA.mode={ engine:"gateway", mode:"none", msg:"A pesquisa precisa de uma IA com busca na web: Claude, Codex ou DeepSeek." }');
  const h = run(`ideiaIdeaHtml(${JSON.stringify(idea0({ turns: [{ you: 'oi', resp: {} }] }))})`);
  assert.ok(!/id="ideiaResGo"/.test(h));
  assert.match(text(h), /Claude, Codex ou DeepSeek/);
  assert.match(h, /id="ideiaGoEnv"/);
});

test('pesquisa: progresso pelo evento, PARAR derruba só a pesquisa (<id>-r), relatório recusado sem fonte, aceito com', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { run, calls, listeners } = load({ invoke: async (c, a) => {
    if (c === 'ideia_research') { await gate; return a.fix ? { text: json(good()), costUsd: 0.02 } : { text: json({ ...good(), demanda: [item('2 milhões de buscas', 'fato', [])] }), costUsd: 0.3, sessionId: 's1' }; }
    if (c === 'ideia_research_mode') return { engine: 'claude', mode: 'native' };
    return null;
  } });
  run(`IDEIA.cur=${JSON.stringify(idea0({ turns: [{ you: 'oi', resp: {} }] }))}; IDEIA.mem['i-test-1']=IDEIA.cur;`);
  const p = run('ideiaResearch(IDEIA.cur)');
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  listeners['ideia-activity']({ payload: { id: 'i-test-1', line: 'consultando https://troveskin.com', url: 'https://troveskin.com' } });
  listeners['ideia-activity']({ payload: { id: 'outra', line: 'não é desta ideia' } });
  assert.deepEqual(plain(run('ideiaLive("i-test-1").research.sites')), ['https://troveskin.com']);
  assert.match(run('$id("ideiaBody").innerHTML'), /id="ideiaResStop"/);
  release(); await p;
  const rs = calls.filter(([c]) => c === 'ideia_research').map(([, a]) => a);
  assert.equal(rs.length, 2, 'a 1ª veio com fato sem fonte → UMA correção na mesma sessão');
  assert.deepEqual(plain([rs[1].fix, rs[1].sessionId, rs[1].budgetUsd]), [true, 's1', 0.7], 'a correção também tem teto: o que sobrou da reserva da pesquisa (B2)');
  assert.equal(rs[0].budgetUsd, 1, 'teto padrão US$ 1 vai pro Claude');
  const m = run('IDEIA.cur');
  assert.equal(m.report.status, 'ok');
  assert.match(m.report.md, /## Fontes/);
  assert.ok(Math.abs(m.report.costUsd - 0.32) < 1e-9);
  // parar: só a chave da pesquisa
  run('ideiaLive("i-test-1").research={ running:true, acts:[], sites:[] }');
  await run('ideiaStopResearch(IDEIA.cur)');
  assert.deepEqual(plain(calls.filter(([c]) => c === 'mesa_stop').pop()[1]), { id: 'i-test-1-r' });
});

test('pesquisa sem nenhuma fonte (nem depois da correção) é recusada e a ideia fica sem relatório', async () => {
  const none = { ...good(), demanda: [], concorrentes: [], reclamacoes: [], tendencias: [], publico: [], riscos: [item('palpite', 'suposicao')], veredito: { resposta: 'sim', confianca: 'baixa', texto: 'acho que sim', porque: [] } };
  const { run, toasts } = load({ invoke: async (c) => c === 'ideia_research' ? { text: json(none), costUsd: 0.1 } : c === 'ideia_research_mode' ? { engine: 'claude', mode: 'native' } : null });
  run(`IDEIA.cur=${JSON.stringify(idea0({ turns: [{ you: 'oi', resp: {} }] }))}; IDEIA.mem['i-test-1']=IDEIA.cur;`);
  await run('ideiaResearch(IDEIA.cur)');
  assert.equal(run('IDEIA.cur.report.status'), 'falhou');
  assert.match(run('IDEIA.cur.report.erro'), /sem nenhuma fonte/);
  assert.ok(toasts.some(([m, k]) => k === 'err'));
});

test('criar e seguir eu mesmo: projeto local, pesquisa + épico commitados, tarefas em rascunho com dependência', async () => {
  const r = P.ideiaCheckReport(json(good())).report;
  const ps = P.ideiaPanel(), v = (top) => ({ st: 'ok', plataforma: 'web', voto: { fala: '', top: top.map(([id, peso]) => ({ id, peso })), vetos: [] } });
  const decision = { status: 'ok', rounds: [{ n: 1, resp: {} }, { n: 2, resp: Object.fromEntries(ps.map((p) => [p.id, v([['F1', 2], ['F2', 1]])])) }], cands: [{ id: 'F1', titulo: 'Rotina guiada', descricao: 'd' }, { id: 'F2', titulo: 'Lembrete', descricao: 'd' }], escolhas: {} };
  let n = 0;
  const { run, calls, tabs } = load({ invoke: async (c) => c === 'quick_create_project' ? '/Users/x/Documents/Starfork/rotina-skincare' : c === 'new_task' ? 't' + (++n) : null });
  run('var selected=null, lastSig=""; async function refresh(){}');
  run(`IDEIA.cur=${JSON.stringify(idea0({ titulo: 'App de rotina de skincare', turns: [{ you: 'oi', resp: {} }], report: { status: 'ok', data: r, md: P.ideiaReportMd(r, 'x', {}) }, decision }))}; IDEIA.mem['i-test-1']=IDEIA.cur;`);
  await run('ideiaCreate(IDEIA.cur, "manual")');
  const names = calls.map(([c]) => c);
  assert.ok(names.includes('quick_create_project') && !names.includes('create_project'), 'sem GitHub por padrão');
  const docs = calls.filter(([c]) => c === 'ideia_commit_doc').map(([, a]) => a.rel);
  assert.deepEqual(docs, ['docs/pesquisa-rotina-skincare.md', 'docs/epico-rotina-skincare.md']);
  const tasks = calls.filter(([c]) => c === 'new_task').map(([, a]) => a);
  assert.equal(tasks.length, 3);
  assert.deepEqual(plain(tasks.map((t) => t.after)), [[], ['t1'], ['t1']]);
  assert.ok(tasks.every((t) => t.start === false && t.epicId === 'ideia-rotina-skincare'));
  assert.equal(run('IDEIA.cur.project.mode'), 'manual');
  assert.deepEqual(plain(tabs), ['flow']);
});

test('criar e entregar pro piloto: autopilot_start com o --plan (épico + pesquisa) e abre o progresso', async () => {
  const r = P.ideiaCheckReport(json(good())).report;
  const ps = P.ideiaPanel(), v = (top) => ({ st: 'ok', plataforma: 'mobile', voto: { fala: '', top: top.map(([id, peso]) => ({ id, peso })), vetos: [] } });
  const decision = { status: 'ok', rounds: [{ n: 1, resp: {} }, { n: 2, resp: Object.fromEntries(ps.map((p) => [p.id, v([['F1', 2]])])) }], cands: [{ id: 'F1', titulo: 'Rotina guiada', descricao: 'd' }], escolhas: {} };
  const { run, calls, tabs } = load({ invoke: async (c) => c === 'autopilot_start' ? { dir: '/Users/x/Documents/Starfork/rotina-skincare' } : null });
  run(`IDEIA.cur=${JSON.stringify(idea0({ titulo: 'App de rotina de skincare', turns: [{ you: 'oi', resp: {} }], report: { status: 'ok', data: r, md: '# Pesquisa' }, decision }))}; IDEIA.mem['i-test-1']=IDEIA.cur;`);
  await run('ideiaCreate(IDEIA.cur, "piloto")');
  assert.ok(!calls.some(([c]) => c === 'autopilot_start'), 'sem teto: não dispara (teto obrigatório)');
  assert.match(run('IDEIA.endErr'), /Defina um teto/);
  run('ideiaEndForm(IDEIA.cur).budget="30,00"');
  await run('ideiaCreate(IDEIA.cur, "piloto")');
  const a = calls.find(([c]) => c === 'autopilot_start')[1];
  assert.equal(a.budgetUsd, 30);
  assert.equal(a.attempts, 3);
  assert.equal(a.platform, 'mobile');
  assert.equal(a.name, 'rotina-skincare');
  assert.equal(a.plan.tasks.length, 2);
  assert.deepEqual(plain(a.plan.docs.map((d) => d.path)), ['docs/pesquisa-rotina-skincare.md']);
  assert.ok(!calls.some(([c]) => c === 'quick_create_project'), 'o piloto cria a pasta ele mesmo');
  assert.deepEqual(plain(tabs), ['pilotorun']);
  assert.equal(run('IDEIA.cur.project.mode'), 'piloto');
});

test('Ambiente: pesquisa ampliada opcional, uma linha sobre cookies/ToS, instalar quando falta', () => {
  const { run } = load();
  run('REACH.st={ installed:false, pinned:"1.5.0", installer:"uv", dir:"/Users/x/.constellation/tools/agent-reach" }');
  let h = run('reachEnvInner()');
  assert.match(text(h), /Pesquisa ampliada \(Agent Reach\) opcional/);
  assert.match(text(h), /Canais com login ou cookies \(X, Reddit, Instagram, LinkedIn…\) ficam desligados: usar cookies viola os termos desses sites e pode banir a conta\./);
  assert.match(h, /id="reachInstall"/);
  run('REACH.st={ installed:true, version:"1.5.0", pinned:"1.5.0" }; REACH.ch=[{ id:"web", nome:"Páginas da web (Jina Reader)", uso:"ativo" },{ id:"twitter", nome:"Twitter/X", uso:"bloqueado", nota:"login/cookies — o Starfork não configura nem usa" }]');
  h = run('reachEnvInner()');
  assert.match(text(h), /instalado · v1\.5\.0 \(versão fixa\)/);
  assert.match(text(h), /Twitter\/X — desligado: login\/cookies/);
  assert.match(h, /id="reachDoctor"/);
  assert.ok(!/configure|from-browser/.test(IDEIA_SRC.replace(/\/\/.*$/gm, '')), 'a tela nunca chama configure/cookies');
});

// ---------------- achados da revisão (4 lentes) ----------------
test('revisão: "responder quem faltou" refaz quem FALHOU; conversa e votação têm chaves de parar separadas', async () => {
  const asked = [];
  const { run, calls } = load({ invoke: (c, a) => { if (c === 'ideia_ask') { asked.push(a); return Promise.resolve({ text: 'oi' }); } return Promise.resolve(null); } });
  const t = { you: 'oi', resp: { pesq: { st: 'falhou', erro: 'limite' }, bia: { st: 'ok', text: 'a' }, rafa: { st: 'ok', text: 'a' }, carla: { st: 'ok', text: 'a' }, marcos: { st: 'ok', text: 'a' }, julia: { st: 'ok', text: 'a' } } };
  run(`IDEIA.cur=${JSON.stringify(idea0({ turns: [t] }))}; IDEIA.mem['i-test-1']=IDEIA.cur;`);
  await run('ideiaRunTurn(IDEIA.cur, IDEIA.cur.turns[0])');
  assert.equal(asked.length, 1, 'só a Pesquisadora (que falhou) de novo');
  assert.equal(run('IDEIA.cur.turns[0].resp.pesq.st'), 'ok');
  await run('ideiaStopTurn(IDEIA.cur)'); await run('ideiaStopDecide(IDEIA.cur)');
  assert.deepEqual(plain(calls.filter(([c]) => c === 'mesa_stop').map(([, a]) => a.id)), ['i-test-1', 'i-test-1-d']);
});

test('revisão: a votação usa a própria chave, espera a conversa e não fecha com persona parada', async () => {
  const keys = [];
  const { run } = load({ invoke: (c, a) => { if (c === 'ideia_ask') { keys.push(a.id); return Promise.reject(new Error('MESA_STOPPED')); } return Promise.resolve(null); } });
  run(`IDEIA.cur=${JSON.stringify(idea0({ turns: [{ you: 'oi', resp: {} }] }))}; IDEIA.mem['i-test-1']=IDEIA.cur;`);
  run('ideiaLive("i-test-1").turn=true');
  await run('ideiaDecide(IDEIA.cur, false)');
  assert.equal(run('IDEIA.cur.decision'), null, 'com a conversa rodando, a votação não começa');
  run('ideiaLive("i-test-1").turn=false');
  await run('ideiaDecide(IDEIA.cur, false)');
  assert.ok(keys.length && keys.every((k) => k === 'i-test-1-d'));
  assert.equal(run('IDEIA.cur.decision.status'), 'parada', 'persona parada = rodada incompleta, nada de apuração');
  assert.equal(run('IDEIA.cur.decision.rounds.length'), 1);
});

test('revisão: 2 cliques em Pesquisar = 1 pesquisa; a correção leva o JSON anterior (gateway não tem sessão)', async () => {
  let n = 0;
  const bad = json({ ...good(), demanda: [item('2 milhões de buscas', 'fato', [])] });
  const { run, calls } = load({ invoke: async (c, a) => {
    if (c === 'ideia_research_mode') { await new Promise((r) => setImmediate(r)); return { engine: 'gateway', mode: 'reach' }; }
    if (c === 'ideia_research') { n++; return a.fix ? { text: json(good()), inTok: 10, outTok: 10, engine: 'gateway' } : { text: bad, inTok: 1000, outTok: 500, engine: 'gateway', sessionId: 'gateway' }; }
    return null;
  } });
  run(`IDEIA.cur=${JSON.stringify(idea0({ turns: [{ you: 'oi', resp: {} }] }))}; IDEIA.mem['i-test-1']=IDEIA.cur; var mesaTokUsd=(e,i,o)=>(i+o)/1e6;`);
  await Promise.all([run('ideiaResearch(IDEIA.cur)'), run('ideiaResearch(IDEIA.cur)')]);
  assert.equal(n, 2, 'uma pesquisa + uma correção (não duas pesquisas)');
  const fix = calls.filter(([c]) => c === 'ideia_research').map(([, a]) => a).find((a) => a.fix);
  assert.match(fix.prompt, /O relatório que você devolveu:\n```json/);
  assert.equal(fix.budgetUsd, null);
  assert.equal(run('IDEIA.cur.report.status'), 'ok');
  assert.equal(run('IDEIA.cur.report.engine'), 'gateway');
});

test('revisão: app fechou no meio de uma pesquisa NOVA → o relatório anterior continua valendo', () => {
  const r = P.ideiaCheckReport(json(good())).report;
  const m = P.ideiaRevive({ turns: [], report: { status: 'rodando', data: r, md: '# x' } });
  assert.equal(m.report.status, 'ok');
  assert.match(m.report.erro, /ficou o relatório anterior/);
  const v = good(); v.veredito.texto = 'Uns 40% querem isso'; v.veredito.porque = [];
  const c = P.ideiaCheckReport(json(v));
  assert.match(c.errors.join('\n'), /número sem fonte \(veredito\)/);
  const s = P.ideiaSanitize(c.report);
  assert.equal(s.veredito.numSemFonte, true);
  assert.equal(P.ideiaSanitize({ ...c.report, veredito: null }), null, 'sem veredito não é relatório');
});

test('revisão: criar que parou no meio CONTINUA na mesma pasta, sem repetir tarefa nem criar outra pasta', async () => {
  const r = P.ideiaCheckReport(json(good())).report;
  const ps = P.ideiaPanel(), v = (top) => ({ st: 'ok', plataforma: 'web', voto: { fala: '', top: top.map(([id, peso]) => ({ id, peso })), vetos: [] } });
  const decision = { status: 'ok', rounds: [{ n: 1, resp: {} }, { n: 2, resp: Object.fromEntries(ps.map((p) => [p.id, v([['F1', 2], ['F2', 1]])])) }], cands: [{ id: 'F1', titulo: 'Rotina guiada', descricao: 'd' }, { id: 'F2', titulo: 'Lembrete', descricao: 'd' }], escolhas: {} };
  let n = 0, fail = true;
  const { run, calls } = load({ invoke: async (c) => {
    if (c === 'quick_create_project') return '/Users/x/Documents/Starfork/rotina-skincare';
    if (c === 'new_task') { if (++n === 2 && fail) { fail = false; throw new Error('banco ocupado'); } return 't' + n; }
    return null;
  } });
  run('var selected=null, lastSig=""; async function refresh(){}');
  run(`IDEIA.cur=${JSON.stringify(idea0({ titulo: 'App de rotina de skincare', turns: [{ you: 'oi', resp: {} }], report: { status: 'ok', data: r, md: '# P' }, decision }))}; IDEIA.mem['i-test-1']=IDEIA.cur;`);
  await run('ideiaCreate(IDEIA.cur, "manual")');
  assert.equal(run('IDEIA.cur.project'), null, 'não marca como criado');
  assert.equal(run('IDEIA.cur.partial.tasks.length'), 1);
  assert.match(text(run('ideiaIdeaHtml(IDEIA.cur)')), /A criação parou no meio .* continuar a criação/);
  await run('ideiaCreate(IDEIA.cur, "manual")');
  assert.equal(calls.filter(([c]) => c === 'quick_create_project').length, 1, 'a pasta é criada UMA vez');
  const tasks = calls.filter(([c]) => c === 'new_task').map(([, a]) => a.title);
  assert.equal(tasks.length, 4, '1 ok + 1 que falhou + as 2 que faltavam');
  assert.equal(run('IDEIA.cur.project.tasks.length'), 3);
  assert.equal(run('IDEIA.cur.partial'), undefined);
});

// ---------------- revisão F4 ----------------
test('a mesa da ideia fica CONGELADA nela (m.panel): editar personas depois não muda histórico nem apuração', () => {
  const { run } = load();
  run(`IDEIA.cur=${JSON.stringify(idea0({ panel: [{ id: 'pesq', nome: 'Pesquisadora', papel: 'p', desc: '' }, { id: 'zeca', nome: 'Zeca', papel: 'z', desc: '' }], turns: [{ you: 'oi', resp: { zeca: { st: 'ok', text: 'opa' } } }] }))};`);
  const h = run('ideiaIdeaHtml(IDEIA.cur)');
  assert.match(h, /Zeca/); assert.doesNotMatch(h, />Bia </, 'quem não estava na mesa não aparece');
  assert.equal(run('ideiaPanelOf(IDEIA.cur).length'), 2);
  assert.ok(run('ideiaPanelSnap().length') >= 6, 'ideia nova congela a mesa do momento');
});

test('criação parcial + "Construir sozinho" NÃO cria um 2º projeto; criar pede confirmação (projeto, GitHub, teto)', async () => {
  const r = P.ideiaCheckReport(json(good())).report;
  const ps = P.ideiaPanel(), v = (top) => ({ st: 'ok', plataforma: 'web', voto: { fala: '', top: top.map(([id, peso]) => ({ id, peso })), vetos: [] } });
  const decision = { status: 'ok', rounds: [{ n: 1, resp: {} }, { n: 2, resp: Object.fromEntries(ps.map((p) => [p.id, v([['F1', 2]])])) }], cands: [{ id: 'F1', titulo: 'Rotina', descricao: 'd' }], escolhas: {} };
  const asked = [];
  const { run, calls, ctx } = load({ invoke: async (c) => c === 'autopilot_start' ? { dir: '/x' } : null });
  ctx.askYes = async (q) => { asked.push(q); return false; };
  run(`IDEIA.cur=${JSON.stringify(idea0({ turns: [{ you: 'oi', resp: {} }], report: { status: 'ok', data: r, md: '# P' }, decision, partial: { mode: 'manual', dir: '/x/rotina', tasks: [] } }))}; IDEIA.mem['i-test-1']=IDEIA.cur;`);
  run('ideiaEndForm(IDEIA.cur).budget="30"');
  await run('ideiaCreate(IDEIA.cur, "piloto")');
  assert.ok(!calls.some(([c]) => c === 'autopilot_start'));
  assert.match(run('IDEIA.endErr'), /Seguir à mão/);
  run('delete IDEIA.cur.partial; ideiaEndForm(IDEIA.cur).budget="30"');
  await run('ideiaCreate(IDEIA.cur, "piloto")');
  assert.equal(asked.length, 1, 'confirmação antes de gastar');
  assert.match(asked[0], /Constrói sozinho[\s\S]*US\$ 30/);
  assert.ok(!calls.some(([c]) => c === 'autopilot_start'), 'recusou: nada começa');
  assert.equal(run('ideiaEndForm(IDEIA.cur).gh'), false, 'GitHub só vem marcado com conta conectada');
});
