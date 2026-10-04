// Fábrica de apps e de features (spec-fabrica-mvp, 65-fabrica.js): `node --test app/tests/fabrica.test.mjs`
// Triagem/contagens/mock pelo fixture DOURADO (o mesmo que o Rust confere em fabrica.rs), custo em faixa, ideia nossa,
// o épico da feature (tarefa 0 só leitura, owns disjuntos, fila por sobreposição), a ponte pro "Começar por uma ideia"
// (relatório que passa na checagem da Ideia; mock vira requisito) e o registro como ABA — sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const SRC = read('js/65-fabrica.js');
const F = new Function(cut(SRC, '// @fabrica-puro-inicio', '// @fabrica-puro-fim') +
  '\nreturn { fabFold, fabSrcKey, fabFontes, fabAutores, fabIdeiaNossa, fabResumo, fabMockCheck, fabUsd, fabCustoTxt, fabCustoSub, fabMeter, fabDisjoint, fabFeaturePlan, fabPlanoProblema, fabPayloads, fabTelaIdx, fabMockBody, fabReportFromOp, fabIdeaTurn, fabDefaultMode, FAB_MOCK_MAX, fabSessRows, fabSessFilter, fabSessCounts, fabRoute };')();
const MESA_PURE = cut(read('js/38-mesa.js'), '// @puro-inicio', '// @puro-fim');
const I = new Function(MESA_PURE + cut(read('js/59-ideia.js'), '// @ideia-puro-inicio', '// @ideia-puro-fim') + '\nreturn { ideiaCheckReport, ideiaSanitize, ideiaBuildPlan, ideiaPanel, ideiaTaskPayloads };')();
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/fabrica-golden.json', import.meta.url), 'utf8'));
const plain = (v) => JSON.parse(JSON.stringify(v));

test('fixture dourado: autores distintos, fontes independentes, ideia nossa e resumo iguais ao Rust', () => {
  for (const c of GOLDEN.sinais) {
    assert.equal(F.fabAutores(c.sinais), c.autores, 'autores: ' + c.nome);
    assert.equal(F.fabFontes(c.sinais), c.fontes, 'fontes: ' + c.nome);
    assert.equal(F.fabIdeiaNossa(c.sinais), c.ideiaNossa, 'ideia nossa: ' + c.nome);
    assert.equal(F.fabResumo(c.sinais), c.resumo, 'resumo: ' + c.nome);
  }
});

test('triagem: mesmo site 2× é 1 fonte; concorrente não conta; autor repetido conta uma vez', () => {
  const s = (origem, autores, tipo = 'user') => ({ tipo, origem, autores });
  assert.equal(F.fabFontes([s('a.com', ['x']), s('a.com', ['y'])]), 1);
  assert.equal(F.fabFontes([s('a.com', []), s('b.com', [])]), 2);
  assert.equal(F.fabFontes([s('a.com', []), s('loja.com', [], 'comp')]), 1, 'concorrente é contexto, não prova');
  assert.equal(F.fabAutores([s('a.com', ['Ana', 'ana']), s('b.com', ['ANA'])]), 1, 'o mesmo autor em 2 sites = 1 pessoa');
  assert.equal(F.fabAutores([s('a.com', ['?', 'desconhecido']), s('b.com', [])]), 2, 'sem autor conhecido: 1 por fonte');
  // fonte local: chave pelo id (2 issues = 2 fontes), código = UMA fonte
  assert.equal(F.fabFontes([{ tipo: 'user', id: '#1' }, { tipo: 'user', id: '#2' }, { tipo: 'code', origem: 'a.ts' }, { tipo: 'code', origem: 'b.ts' }]), 3);
});

test('ideia nossa: sem pedido humano (só achado de código / concorrente)', () => {
  assert.equal(F.fabIdeiaNossa([{ tipo: 'code' }, { tipo: 'comp' }]), true);
  assert.equal(F.fabIdeiaNossa([{ tipo: 'code' }, { tipo: 'int', id: 'D:1' }]), false, 'atrito interno é pedido humano registrado');
  assert.equal(F.fabIdeiaNossa([]), true);
  assert.match(F.fabResumo([{ tipo: 'code', origem: 'a' }]), /^0 pedidos de usuário \+ 1 evidência técnica$/);
});

test('mock: a mesma validação do Rust (fixture dourado) + limites', () => {
  for (const c of GOLDEN.mocks) assert.equal(F.fabMockCheck(c.html).length === 0, c.ok, 'mock ' + c.nome + ': ' + F.fabMockCheck(c.html).join('; '));
  assert.ok(F.fabMockCheck('<div class="mk-app">' + 'x'.repeat(F.FAB_MOCK_MAX) + '</div>').some((e) => /grande demais/.test(e)));
  assert.ok(F.fabMockCheck('<div class="mk-app">a@exemplo.com e b@empresa.com.br xxxxxxxxxxxxxxxx</div>').some((e) => /e-mail/.test(e)), 'um e-mail real basta pra recusar');
  assert.ok(F.fabMockCheck('<div class="mk-app"><svg><script>x</script></svg>Produto Exemplo aqui</div>').length >= 2);
  assert.ok(F.fabMockCheck('<div class="mk-app" style="x">CPF 123.456.789-00 Produto Exemplo</div>').some((e) => /CPF/.test(e)));
});

test('custo SEMPRE em faixa, com a base (mediana do projeto ou sem histórico)', () => {
  assert.equal(F.fabCustoTxt({ min: 15, max: 36 }), 'US$ 15–36 com IA');
  assert.equal(F.fabCustoTxt({ min: 1.5, max: 3.6 }), 'US$ 1,50–3,60 com IA');
  assert.equal(F.fabCustoTxt(null), 'sem estimativa');
  assert.equal(F.fabCustoTxt({ min: 0, max: 0 }), 'sem estimativa', 'nunca um valor único inventado');
  assert.equal(F.fabCustoSub({ tarefas: 6, base: 'Claude · sem histórico seu' }), '6 tarefas · Claude · sem histórico seu');
  assert.equal(F.fabCustoSub({ tarefas: 1, base: 'mediana do projeto: US$ 4,10 por tarefa' }), '1 tarefa · mediana do projeto: US$ 4,10 por tarefa');
  assert.equal(F.fabUsd(1.425), 'US$ 1,43');
});

test('medidor do teto: % e "parou no teto"', () => {
  assert.deepEqual(plain(F.fabMeter({ teto: 3, gasto: 1.42, status: 'rodando' })).pct, 47);
  assert.match(F.fabMeter({ teto: 3, gasto: 3.1, status: 'teto' }).msg, /parou no teto de US\$ 3,00/);
  assert.equal(F.fabMeter({ teto: 3, gasto: 9, status: 'teto' }).pct, 100);
  assert.match(F.fabMeter({ teto: 3, gasto: 0.8, status: 'pronta' }).msg, /nada roda em segundo plano/);
  assert.equal(F.fabDefaultMode(true), 'feature');
  assert.equal(F.fabDefaultMode(false), 'app');
});

const OP_FEAT = {
  titulo: 'Avisar quando um módulo "Em breve" abrir', problema: 'Quem clica num módulo Em breve não sabe quando abre.',
  sinais: [{ tipo: 'user', id: '#212', origem: 'issue #212', autores: ['a', 'b', 'c'] }, { tipo: 'code', origem: 'src/UseCases.tsx' }],
  dentro: ['botão Avise-me', 'inscrição por e-mail'], fora: ['notificação no app'],
  impacto: { arquivos: ['src/UseCases.tsx', 'src/api/avisos/'], areas: ['src/'], naoToca: ['login'], regressao: 'a ordem dos módulos', cobertura: 'parcial' },
  tarefasPlano: [{ titulo: 'Botão Avise-me', owns: ['src/components/ModuleHeader.tsx'] }, { titulo: 'Rota de inscrição', owns: ['src/api/avisos/', 'src/components/ModuleHeader.tsx'] }, { titulo: 'E-mail', owns: ['src/api/avisos/mail.ts', 'src/workspace/notify/'] }],
  mock: { estado: 'ok', html: '<html></html>' }, ideiaNossa: false,
};

test('owns disjuntos: o que uma tarefa anterior já tem (ou está dentro) sai das seguintes', () => {
  const d = plain(F.fabDisjoint(OP_FEAT.tarefasPlano));
  assert.deepEqual(d.map((t) => t.owns), [['src/components/ModuleHeader.tsx'], ['src/api/avisos/'], ['src/workspace/notify/']]);
  assert.deepEqual(d.map((t) => t.cortou), [0, 1, 1]);
});

test('épico da feature: tarefa 0 confirma o impacto SÓ LEITURA; sobreposição avisa honesto; formato do normalizePlan', () => {
  const ov = { 2: [{ taskId: 'FND-1048', agent: 'a', theirs: 'src/workspace/', yours: 'src/workspace/notify/' }] };
  const p = plain(F.fabFeaturePlan(OP_FEAT, ov, 'mock-avise.html'));
  assert.equal(p.tasks.length, 4);
  assert.equal(p.tasks[0].title, 'Confirmar impacto (só leitura)');
  assert.equal(p.tasks[0].readOnly, true);
  assert.ok(p.tasks[0].requirements.some((r) => /Nenhum arquivo do projeto alterado/.test(r)));
  assert.equal(p.tasks[0].owns, '');
  assert.ok(p.tasks.slice(1).every((t) => t.after.length === 1 && t.after[0] === 0), 'tudo depois da tarefa 0');
  assert.equal(p.tasks[3].aguarda, 'FND-1048');
  assert.ok(p.tasks[3].requirements.some((r) => /Não começa sozinha: FND-1048 mexe na mesma área .* inicie depois dela/.test(r)));
  assert.ok(!JSON.stringify(p).includes('na fila'), 'nada promete fila que não existe');
  assert.ok(p.tasks[1].mock && p.tasks[1].requirements.some((r) => /mock aprovado na Fábrica \(anexo \.cardume\/refs\/mock-avise\.html\)/.test(r)), 'o mock vai pra tarefa que DONA a tela (components/)');
  assert.equal(p.tasks.filter((t) => t.mock).length, 1);
  assert.equal(F.fabPlanoProblema(p), '');
  assert.ok(p.doneWhen.some((d) => /continua funcionando/.test(d)), 'regressão como pronto-quando');
  assert.ok(p.boundaries.some((b) => /Não toca: login/.test(b)));
  // vira payload de new_task pelo MESMO construtor da Ideia (rascunho: start:false)
  const pay = plain(I.ideiaTaskPayloads(p, 'fab-x', { engine: 'claude' }));
  assert.equal(pay.length, 4);
  assert.ok(pay.every((x) => x.payload.start === false && x.payload.epicId === 'fab-x'), 'nada roda até iniciar');
  // o mapeamento que o fabMakeEpic usa (puro): tarefa 0 investigação sem PR/prova/teste; owns juntado; mock só na tela
  const fp = plain(F.fabPayloads(p, I.ideiaTaskPayloads(p, 'fab-x', { engine: 'claude', proof: true, tests: true }), '/r/.cardume/tmp/refs/1/mock-avise.html'));
  assert.deepEqual([fp[0].payload.branchType, fp[0].payload.autoPr, fp[0].payload.proof, fp[0].payload.tests, fp[0].payload.owns], ['invest', 'no', false, false, null]);
  assert.equal(fp[1].payload.owns, 'src/components/ModuleHeader.tsx');
  assert.equal(fp[2].payload.owns, 'src/api/avisos/');
  assert.deepEqual(fp[1].payload.refs, ['/r/.cardume/tmp/refs/1/mock-avise.html']);
  assert.deepEqual(fp[2].payload.refs, [], 'sem mock fora da tarefa da tela');
  assert.equal(fp[1].payload.proof, true, 'as outras herdam a política');
});

test('épico bloqueado sem tarefas ou com tarefa sem arquivos (nunca owns:null dizendo "arquivos diferentes")', () => {
  assert.match(F.fabPlanoProblema(F.fabFeaturePlan(Object.assign({}, OP_FEAT, { tarefasPlano: [] }))), /não sugeriu tarefas/);
  const dup = Object.assign({}, OP_FEAT, { tarefasPlano: [{ titulo: 'A', owns: ['src/'] }, { titulo: 'B', owns: ['src/x.ts'] }] });
  assert.match(F.fabPlanoProblema(F.fabFeaturePlan(dup)), /"B" ficou sem arquivos próprios/);
  assert.equal(F.fabTelaIdx([{ titulo: 'Rota', owns: ['src/api/'] }, { titulo: 'Botão', owns: [] }]), 1);
  assert.equal(F.fabTelaIdx([{ titulo: 'Rota', owns: ['src/api/'] }]), 0, 'sem tarefa de tela: a 1ª');
});

test('fixture dourado: a feature normalizada pelo Rust vira épico no front', () => {
  const n = GOLDEN.featureNorm, op = Object.assign({ titulo: GOLDEN.featureRaw.titulo, problema: 'p', dentro: [], fora: [] }, n);
  const p = plain(F.fabFeaturePlan(op));
  assert.deepEqual(p.tasks.map((t) => t.owns), ['', 'src/components/Header.tsx', 'src/api/avisos/']);
  assert.equal(p.tasks.length, n.tarefas + 1, 'tarefa 0 + as que o Rust contou');
  assert.equal(F.fabPlanoProblema(p), '');
});

test('fixture dourado: o documento do mock do Rust passa na validação do front', () => {
  assert.deepEqual(F.fabMockCheck(F.fabMockBody(GOLDEN.mockDoc.doc)), []);
  assert.equal(F.fabMockBody(GOLDEN.mockDoc.doc), GOLDEN.mockDoc.body);
});

test('ponte pro "Começar por uma ideia": relatório passa na checagem da Ideia; votos viram a 1ª rodada; mock vira requisito', () => {
  const op = { titulo: 'Confirmação de consulta', problema: 'A recepção confirma uma por uma.', quem: 'recepção de clínica', risco: 'API do WhatsApp exige aprovação', confianca: 'media',
    sinais: [{ tipo: 'user', origem: 'reddit.com', url: 'https://reddit.com/r/x/1', autores: ['a'], texto: 'confirmo na mão' }, { tipo: 'user', origem: 'capterra.com', url: 'https://capterra.com/p/1', autores: [], texto: 'sem lembrete' }],
    concorrentes: [{ nome: 'Agenda X', url: 'https://agendax.com.br', preco: 'R$ 89/mês', reclamacao: 'cobra por profissional' }],
    votos: [{ persona: 'Bia', voto: 'y', porque: 'resolve' }, { persona: 'Júlia', voto: 'n', porque: 'API' }], objecao: 'Sem plano B se a Meta negar.' };
  const r = F.fabReportFromOp(op);
  const chk = I.ideiaCheckReport('```json\n' + JSON.stringify(r) + '\n```');
  assert.equal(chk.ok, true, chk.errors.join('; '));
  assert.equal(chk.report.fontes.length, 3);
  assert.match(r.veredito.texto, /não demanda comprovada/);
  const turn = plain(F.fabIdeaTurn(op, 'clínicas', I.ideiaPanel()));
  assert.equal(turn.resp.bia.st, 'ok');
  assert.match(turn.resp.julia.text, /descartar.*Meta/);
  assert.equal(turn.resp.rafa.st, 'na fila', 'quem não votou responde na Ideia');
  assert.equal(turn.resp.pesq.st, 'ok');
  const plan = plain(I.ideiaBuildPlan({ titulo: 'Confirmação de consulta', fabrica: { mockHtml: '<div class="mk-app">x</div>' } }, { plataforma: 'web', mvp: [{ titulo: 'Lembrete', descricao: '' }], naoObjetivos: [] }, ''));
  assert.ok(plan.tasks[0].requirements.some((x) => /mock aprovado na Fábrica \(docs\/mock-confirmacao-consulta\.md\)/.test(x)));
  assert.ok(plan.docs.some((d) => d.path === 'docs/mock-confirmacao-consulta.md' && /```html/.test(d.content) && /dados falsos/.test(d.content)));
});

test('aba, não modal: registro no motor de abas, overlay, CSS/JS no index e fabOpen global', () => {
  const html = read('index.html');
  assert.match(html, /id="fabOverlay"/);
  assert.match(html, /<div class="mbody" id="fabBody">/);
  assert.match(html, /js\/65-fabrica\.js/);
  assert.match(html, /css\/98-fabrica\.css/);
  assert.match(SRC, /VIEW_META\.fabrica=\{ title:'Fábrica'/);
  assert.match(SRC, /VIEW_OVERLAY\.fabrica='fabOverlay'/);
  assert.match(SRC, /window\.fabOpen=fabOpen/);
  assert.match(SRC, /window\.openTab\('fabrica'\)/);
  assert.match(SRC, /fabrica-progress/, 'progresso por evento');
  assert.doesNotMatch(SRC, /setInterval\(/, 'sem polling');
  // mock isolado: iframe sandbox VAZIO (sem allow-scripts) e validado de novo no front
  assert.match(SRC, /<iframe sandbox="" /);
  assert.doesNotMatch(SRC, /allow-scripts|allow-same-origin/);
  assert.match(SRC, /fabMockCheck\(fabMockBody\(k\.html\)\)/);
  // a criação passa por confirmação inline e nasce em rascunho
  assert.match(SRC, /data-fmk=/);
  assert.match(SRC, /nada roda até você iniciar/);
});

test('CSS só com tokens do app (a paleta muda depois)', () => {
  const css = read('css/98-fabrica.css');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, 'cor fixa no CSS da Fábrica');
});

// ---------------- F4 · G2: Fábrica unificada ----------------
test('Sessões: UMA lista (ideias, mesas, varreduras, pilotos) normalizada, mais nova primeiro; ilegível marcada', () => {
  const rows = plain(F.fabSessRows({
    ideias: [{ id: 'i1', titulo: 'Confirmação', updatedAt: 5, costUsd: 0.42, turnos: 1, decisao: 'ok' }, { id: 'i2', titulo: '(arquivo x ilegível)', corrompida: true, updatedAt: 1 }],
    mesas: [{ id: 'm1', repo: '/r/logcomex', tema: 'Em breve', status: 'rodando', personas: 5, rounds: 2, costUsd: 0.58, updatedAt: 9 }],
    varreduras: [{ id: 'f1', mode: 'feature', projeto: '/r/logcomex', foco: 'o que pedem', status: 'pronta', gasto: 0.86, opcoes: [{}, {}], updatedAt: 7 }],
    pilotos: [{ dir: '/d/studio', name: 'studio', alive: true, tasks: [{ stage: 'merged' }, { stage: 'running' }], costUsd: 11.2, updatedAt: 3 }],
    liveMesas: [] }));
  assert.deepEqual(rows.map((r) => r.k + ':' + r.id), ['m:m1', 'v:f1', 'i:i1', 'p:/d/studio', 'i:i2']);
  assert.equal(rows[0].sit, 'interrompida · continuar', 'mesa "rodando" sem processo vivo = interrompida');
  assert.equal(rows[0].onde, 'logcomex');
  assert.equal(rows[1].small, '2 opções · feature');
  assert.equal(rows[2].sit, 'MVP decidido · falta criar');
  assert.equal(rows[3].sit, 'construindo · 1/2');
  assert.equal(rows[4].bad, true);
  const c = plain(F.fabSessCounts(rows));
  assert.deepEqual(c, { all: 5, i: 2, m: 1, v: 1, p: 1 });
  assert.deepEqual(plain(F.fabSessFilter(rows, { k: 'i' })).map((r) => r.id), ['i1', 'i2']);
  assert.deepEqual(plain(F.fabSessFilter(rows, { proj: '/r/logcomex' })).map((r) => r.id), ['m1', 'f1']);
  assert.deepEqual(plain(F.fabSessFilter(rows, { proj: '-' })).map((r) => r.id), ['i1', 'i2'], 'sem projeto (app novo)');
  assert.deepEqual(plain(F.fabSessFilter(rows, { q: 'CONFIRMACAO' })).map((r) => r.id), ['i1'], 'busca sem acento/caixa');
});

test('rotas antigas → lugares novos: lista de mesas vai pra Fábrica › Sessões; mesa específica abre na aba dela', () => {
  assert.deepEqual(plain(F.fabRoute('mesa', {})), { kind: 'fabrica', view: 'sessoes', filter: 'm' });
  assert.deepEqual(plain(F.fabRoute('mesa', { mesaId: 'm-1' })), { kind: 'mesa' });
  assert.deepEqual(plain(F.fabRoute('mesanova', {})), { kind: 'fabrica', view: 'nova', mode: 'feature' });
  assert.deepEqual(plain(F.fabRoute('ideias', {})), { kind: 'fabrica', view: 'sessoes', filter: 'i' });
  assert.deepEqual(plain(F.fabRoute('ideia', {})), { kind: 'ideia' }, '"Tenho uma ideia" É a sessão da Fábrica');
  assert.deepEqual(plain(F.fabRoute('piloto', {})), { kind: 'piloto' }, 'piloto = fim de caminho "construir sozinho"');
  // o motor de abas da casca conhece os apelidos (VIEW_ROUTES) e o openTab passa pelo fabRoute
  const abas = read('js/15-config-abas-onboarding.js');
  assert.match(abas, /mesas:\['fabrica','sessoes'\], ideias:\['fabrica','sessoes'\], novoprojeto:\['fabrica','nova'\]/);
  assert.match(SRC, /openTab=function\(kind, opts\)\{ const r=fabRoute\(kind/);
  // as portas antigas: menu "Mais › Mesa" e o seletor de 5 modos não existem mais
  assert.match(read('js/38-mesa.js'), /bindClick\('mesaBtn', \(\)=>\{[^\n]*fabOpen\('sessoes', \{ filter:'m' \}\)/);
  assert.doesNotMatch(read('js/14-nova-demanda-inicio.js'), /tab:'(orq|piloto|ideia)'/);
});

test('hub: App novo | Feature, sub-nav Nova sessão · Sessões · Personas, 4 pontos de partida e o fim do caminho', () => {
  assert.match(SRC, /data-fview="\$\{k\}"/);
  for (const v of ["b('nova','plus','Nova sessão')", "b('sessoes','list','Sessões'", "b('personas','users','Personas'"]) assert.ok(SRC.includes(v), v);
  for (const t of ['Já sei o que quero', 'Tenho uma ideia', 'Me mostre opções', 'Discutir um tema']) assert.ok(SRC.includes(t), t);
  assert.match(SRC, /construir sozinho<\/b> \(o antigo piloto automático, com teto obrigatório\)/);
  assert.match(SRC, /épico criado só com confirmação/);
  assert.match(SRC, /fabToNova', \(\)=>\{ if\(window\.openTab\) window\.openTab\('planner'\)/, 'Feature › Já sei o que quero abre a Nova demanda (não duplica o planejador)');
  assert.match(SRC, /mesaStartWith\(\{ repo:state\.repo, tema:FAB_HUB\.tema, ids:\[\.\.\.FAB_HUB\.pick\]/);
  assert.match(SRC, /Sem sessões ainda/);
  assert.match(SRC, /Não consegui ler as sessões/);
  assert.match(read('index.html'), /id="varOverlay"/);
  assert.match(SRC, /<nav class="g2crumb"[^`]*Fábrica<\/button>›<button type="button" data-fgo="sessoes">Sessões<\/button>› varredura/);
});
