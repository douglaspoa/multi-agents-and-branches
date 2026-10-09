// MESA DE BUGS 2 · FÁBRICA E TIME — itens que atrapalham (A1–A17) e cosméticos (C1–C5).
// Funções puras recortadas por marcador + `new Function`; o resto confere o gancho no código.
// `node --test app/tests/atrap-fabrica.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const FABJS = read('js/65-fabrica.js'), MESA = read('js/38-mesa.js'), IDEIA = read('js/59-ideia.js'), TIME = read('js/43-espaco-times.js'),
  EPICO = read('js/46-epico-time.js'), LINHA = read('js/69-linha.js'), PUB = read('js/33-switcher-projetos.js'), CORE = read('js/10-core.js'), USO = read('js/55-uso.js');

const F = new Function(cut(FABJS, '// @fabrica-puro-inicio', '// @fabrica-puro-fim') + '\nreturn { fabMeter, fabTetoIn, fabVazioTxt, fabSessRows, fabSessCusto };')();
const MESA_PURE = cut(MESA, '// @puro-inicio', '// @puro-fim');
const M = new Function(MESA_PURE + '\nreturn { mesaCapNext, mesaCallBudget, MESA_MIN_CALL };')();
const I = new Function(MESA_PURE + cut(IDEIA, '// @ideia-puro-inicio', '// @ideia-puro-fim') + '\nreturn { ideiaResearchFits, ideiaResearchCost };')();
const E = new Function(cut(LINHA, '// @puro-linha-inicio', '// @puro-linha-fim') + cut(EPICO, '// @atrap-epico-inicio', '// @atrap-epico-fim') + '\nreturn { epDoneWhenParse, epStatusView, epEntregue };')();

// 00-util inteiro num vm (como o human-err.test)
const ctx = { window: { addEventListener() {} }, document: { getElementById: () => null, addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} }, navigator: { platform: 'MacIntel', userAgent: '' }, console };
vm.createContext(ctx); vm.runInContext(read('js/00-util.js'), ctx);
const { humanErr } = ctx;

test('A1: erro cru da varredura vira frase de gente + "ver detalhes" (toast e corpo)', () => {
  const h = humanErr('claude exited with code 1: Error: spawn /usr/local/bin/claude ENOENT at ChildProcess._handle.onexit', 'A varredura falhou');
  assert.doesNotMatch(h.msg, /ENOENT|ChildProcess|exited with code/);
  assert.match(h.raw, /ENOENT/, 'o cru continua disponível em "ver detalhes"');
  const ev = cut(FABJS, "listen('fabrica-progress'", 'async function fabStart');
  assert.match(ev, /showErr\(f\.erro\|\|'erro sem detalhe', 'A varredura falhou'\)/);
  assert.doesNotMatch(ev, /'A Fábrica falhou: '\+/);
  const body = cut(FABJS, 'function fabResultHtml', 'function fabRender');
  assert.match(body, /humanErr\(s\.erro/); assert.match(body, /<summary>ver detalhes<\/summary>/);
});

test('A2: teto da varredura "0", "abc", negativo ou vazio é recusado (nunca roda calado com o último salvo)', () => {
  for (const v of ['0', 'abc', '-2', '', '  ', '0,00']) assert.equal(F.fabTetoIn(v, 50).ok, false, JSON.stringify(v));
  assert.deepEqual(F.fabTetoIn('2,5', 50), { ok: true, v: 2.5 });
  assert.deepEqual(F.fabTetoIn('US$ 3', 50), { ok: true, v: 3 });
  assert.deepEqual(F.fabTetoIn('80', 50), { ok: true, v: 50, cortou: true });
  const st = cut(FABJS, 'async function fabStart', 'async function fabStop');
  assert.match(st, /fabTetoIn\(tIn\.value, FAB_TETO_MAX\)/); assert.match(st, /if\(!t\.ok\)\{[^}]*return; \}/);
});

test('A3: parada por você sem opção diz "você parou", não "nenhuma passou na triagem"', () => {
  assert.match(F.fabVazioTxt('parada', 3).t, /Você parou/);
  assert.match(F.fabVazioTxt('vazia', 3).t, /triagem/);
  assert.match(F.fabVazioTxt('teto', 1).t, /teto de US\$ 1,00/);
});

test('A4: gasto acima do teto explica quanto passou e por quê', () => {
  const m = F.fabMeter({ teto: 1, gasto: 1.07, status: 'teto' });
  assert.equal(m.pct, 100); assert.equal(m.passou, 0.07);
  assert.match(m.msg, /passou US\$ 0,07 do teto \(a IA confere o gasto entre um passo e outro\)/);
  assert.equal(F.fabMeter({ teto: 1, gasto: 0.5, status: 'rodando' }).passou, 0);
  assert.doesNotMatch(F.fabMeter({ teto: 1, gasto: 1, status: 'teto' }).msg, /passou/);
});

test('A5: o título da varredura não some a 920 (a linha quebra com o seletor e o medidor)', () => {
  assert.match(read('css/99-paginas.css'), /\.pgh-t:has\(\.fab-meter\)\{[^}]*flex-wrap:wrap/);
  assert.match(read('css/99-paginas.css'), /\.pgh-t:has\(\.fab-meter\) \.pgh-title\{[^}]*min-width:min\(16ch,100%\)/);
});

test('A6: "Continuar com mais US$" sai do aviso — o teto novo cobre a próxima fala mesmo com o gasto acima do teto', () => {
  // print 10: gasto 1,60, teto 0,50, botão +0,50 → teto 1,00 (abaixo do gasto) e pausava na hora
  const n = M.mesaCapNext(0.5, 1.6, 0.5, 0.4);
  assert.equal(n.cap, 2.1); assert.equal(n.add, 0.5);
  assert.notEqual(M.mesaCallBudget(1.6, 0, n.cap, 1, null, 0.4), null, 'cabe uma fala depois de continuar');
  // a fala custa MAIS que o "+US$ X" padrão: soma o custo de uma fala
  const n2 = M.mesaCapNext(1, 1.07, 0.5, 0.62);
  assert.equal(n2.add, 0.63); assert.notEqual(M.mesaCallBudget(1.07, 0, n2.cap, 1, null, 0.62), null);
  assert.ok(M.mesaCapNext(0, 0, 0, 0).add >= M.MESA_MIN_CALL);
  const w = cut(MESA, "bindClick('mesaCapUp'", "bindClick('mesaCapNo'");
  assert.match(w, /mesaCapNext\(/); assert.match(w, /\n\s*await mesaSave\(m\);/, 'o save não pode ficar dentro do comentário');
  const av = cut(MESA, 'const capNx=', 'let left=');
  assert.doesNotMatch(av, /fmtCost\(/, 'um formato só de US$ no aviso (antes "US$ 1" e "US$ 1,00")');
  assert.match(av, /'Definir teto de '\+mesaEsc\(U\(capNx\.cap\)\)/, 'mesa sem teto que já gastou: o botão diz o teto que vai gravar (gasto + X)');
});

test('A7: o Quadro do Time rola na horizontal em vez de cortar "Concluídas"', () => {
  assert.match(read('css/60-grafo-times-nova-demanda.css'), /\.tsboard\.ts5\{[^}]*overflow-x:auto/);
});

test('A8 + revisão: "assumir" leva pra Execução com a tarefa selecionada SEM zerar os filtros — só limpa o que a esconde', () => {
  const c = cut(TIME, 'async function teamClaimStart', 'async function teamDeleteCard');
  assert.match(c, /tsClaimShow\(localId\)/); assert.match(c, /toast\('Você assumiu/); assert.doesNotMatch(c, /flowJump\(/);
  const H = new Function(cut(TIME, '// @atrap-time-inicio', '// @atrap-time-fim') + '\nreturn tsClaimHiders;')();
  const fn = { bucket: () => 'andamento', type: () => 'build', agents: () => ['dev'], inPeriod: () => true };
  const t = { title: 'Filtro por data', epic: { epicId: 'e1' } };
  const f0 = { query: '', status: 'all', epic: 'all', type: 'all', agent: 'all', proj: 'all', repo: '/r' };
  assert.deepEqual(H(t, f0, fn), [], 'nada esconde: nenhum filtro mexido');
  assert.deepEqual(H(t, { ...f0, query: 'filtro', status: 'andamento', epic: 'e1', proj: '/r' }, fn), [], 'filtros que mostram a tarefa ficam');
  assert.deepEqual(H(t, { ...f0, query: 'pagamento', status: 'aguardando', proj: '/outro' }, fn), ['busca', 'situação', 'projeto']);
  assert.deepEqual(H(t, f0, { ...fn, inPeriod: () => false }), ['período']);
  const show = cut(TIME, 'function tsClaimShow', '\n}\n');
  assert.doesNotMatch(show, /flowClearFilters|flowJump/);
});

test('A9: notificação do time abre a ABA Time (não o #viewSeg escondido)', () => {
  const r = cut(CORE, 'function notifRoute', '// clique na notificação');
  assert.match(r, /id==='view:team'\)\{ if\(window\.openTab\) window\.openTab\('time'\)/);
  assert.doesNotMatch(r, /data-v="team"/);
});

test('A10: "dev ativo" e "em andamento" por pessoa = UMA regra (responsável, ou quem criou)', () => {
  const T = new Function('teamTasks', 'tsBucket', cut(TIME, '// @atrap-time-inicio', '// @atrap-time-fim') + '\nreturn { tsWho, tsRunningOf };');
  const tasks = [{ id: 1, assignee: 'douglas', st: 'andamento' }, { id: 2, assignee: null, created_by: 'beto', st: 'andamento' }, { id: 3, assignee: 'beto', st: 'fila' }];
  const R = T(tasks, (t) => t.st);
  assert.equal(R.tsWho(tasks[1]), 'beto');
  assert.equal(R.tsRunningOf('beto').length, 1, 'cartão sem responsável conta pra quem criou (antes: 0 em Pessoas, 1 em Entregas)');
  const devs = ['douglas', 'beto', 'ana'].filter((u) => R.tsRunningOf(u).length);
  assert.deepEqual(devs, ['douglas', 'beto'], 'KPI = quem aparece em "Agora no time"');
  assert.doesNotMatch(TIME, /assignee\|\|t\.created_by\)===|const w=t\.assignee\|\|t\.created_by/, 'nenhuma conta paralela');
  const ov = cut(TIME, "<div class=\"tsph\">Entregas por membro", "</div></div>`;");
  assert.match(ov, /tsRunningOf\(u\)\.length/);
});

test('A11: épico sem "pronto quando" com tudo entregue é concluído na página dele (mesma regra do Time/Linha)', () => {
  const ep = { id: 'e', status: 'open', spec: {} };
  const ok = [{ status: 'merged' }, { status: 'done' }];
  assert.deepEqual(E.epStatusView(ep, ok, true, E.epEntregue), { st: 'done', entregue: true });
  assert.deepEqual(E.epStatusView(ep, [{ status: 'merged' }, { status: 'review' }], true, E.epEntregue), { st: 'open', entregue: false });
  assert.equal(E.epStatusView(ep, ok, false, E.epEntregue).entregue, false, 'antes de carregar as tarefas não chuta');
  assert.equal(E.epStatusView({ ...ep, status: 'archived' }, ok, true, E.epEntregue).st, 'archived');
  const pg = cut(EPICO, 'function epicPageRender', 'async function epicPatch');
  assert.match(pg, /epStatusView\(ep, tasks0, c\.loaded/); assert.match(pg, /ep-st-\$\{escA\(sv\.st\)\}/);
  assert.match(pg, /!dw\.length&&!sv\.entregue&&can/, 'não pede "marcar como concluído" no que já está entregue');
  assert.doesNotMatch(pg, /épico antigo/);
});

test('revisão: "pronto quando" todo marcado com tarefa ainda ATIVA não é entregue (regra única do 69)', () => {
  const dw = [{ id: 'D1', text: 'a', checkedBy: 'u' }, { id: 'D2', text: 'b', checkedBy: 'u' }];
  const ep = { id: 'e', status: 'open', spec: { doneWhen: dw } };
  for (const st of ['running', 'backlog', 'queued', 'review', 'error'])
    assert.equal(E.epEntregue(ep, [{ status: 'merged' }, { status: st }]), false, st + ' ainda ativa');
  assert.equal(E.epEntregue(ep, [{ status: 'merged' }, { status: 'cancelled' }, { status: 'review', flag: 'closed' }]), true, 'cancelada/encerrada não conta');
  assert.equal(E.epEntregue(ep, []), true, 'tudo provado e nenhuma tarefa');
  assert.equal(E.epEntregue({ ...ep, status: 'done' }, [{ status: 'running' }]), true, 'status done continua entregue');
  assert.equal(E.epStatusView(ep, [{ status: 'running' }], true, E.epEntregue).entregue, false);
  assert.match(cut(EPICO, 'async function epicToggleDoneRun', 'async function epicSetStatus'), /epEntregue\(\{ \.\.\.ep, status:'open', spec \}/, 'marcar o último item só grava done sem tarefa ativa');
});

test('A12: "+ épico" e a página do épico definem o "pronto quando"', () => {
  assert.deepEqual(E.epDoneWhenParse('dá pra filtrar por data; o filtro fica salvo ;; '), [{ id: 'D1', text: 'dá pra filtrar por data' }, { id: 'D2', text: 'o filtro fica salvo' }]);
  assert.deepEqual(E.epDoneWhenParse('- um\n• dois'), [{ id: 'D1', text: 'um' }, { id: 'D2', text: 'dois' }]);
  assert.deepEqual(E.epDoneWhenParse(''), []);
  assert.equal(E.epDoneWhenParse(Array.from({ length: 12 }, (_, i) => 'i' + i).join(';')).length, 8);
  const add = cut(TIME, "el.querySelector('#tbEpicAdd')", "if(tmView!=='entregas') periodPickerWire");
  assert.match(add, /epDoneWhenAsk\(b\)/); assert.match(add, /spec:\{ doneWhen:dw \}/); assert.match(add, /if\(dw==null\) return;/);
  assert.match(EPICO, /bindClick\('epDwSet'/); assert.match(EPICO, /sheetAsk\(\{ anchor, title:'Pronto quando'/, 'folha, não modal');
});

test('A13/A14/A15: Publicar release — fechar no meio não perde o resultado nem publica 2×; 413 diz a causa; Esc fecha', () => {
  const p = cut(PUB, 'let pubBusy=false;', '// busca central do topo');
  assert.match(p, /if\(pubBusy\) return; pubBusy=true;/);
  assert.match(p, /if\(!pubBusy\) pubSetState\('form'\)/, 'reabrir durante o envio mostra o progresso');
  assert.match(p, /if\(!pubOpen\(\)\) toast\('Release publicada/); assert.match(p, /if\(!pubOpen\(\)\) showErr\(e/);
  assert.match(p, /e\.key==='Escape'[^}]*closePub\(\)/);
  for (const m of ['storage upload failed: 413 Payload Too Large {"statusCode":"413","error":"Payload too large"}', 'upload do Starfork-portable.zip falhou (HTTP 413) — você é o owner do canal?']) {
    const h = humanErr(m); assert.equal(h.id, 'too-large', m); assert.doesNotMatch(h.msg, /conexão|internet/i);
  }
  assert.equal(humanErr('Failed to fetch').id, 'network', 'sem internet continua sem internet');
});

test('A15: Enter em "Escolher/Montar o épico" leva o foco pra confirmação; Voltar/Esc devolvem pro botão', () => {
  const w = cut(FABJS, 'function fabFocusIn', 'document.addEventListener(\'click\'');
  assert.match(w, /FAB\.confirm=i; fabRender\(\); fabFocusIn\(i, '\[data-fmk\],\[data-funbuild\]'\)/);
  assert.match(w, /e\.key==='Escape' && FAB\.confirm!=null/);
  assert.match(w, /function fabUnconfirm\(\)\{[^}]*fabFocusIn\(i, '\[data-fbuild\]/);
  assert.match(FABJS, /class="fab-oc\$\{out\?' out':''\}" data-fi="\$\{i\}" tabindex="-1"/);
});

test('A16: Sessões soma o gasto por tokens (Codex/DeepSeek/gateway) — nada de "—" nem fora do total', () => {
  const rows = F.fabSessRows({ ideias: [{ id: 'i1', titulo: 'x', costUsd: 0, tokUsd: 0.31, updatedAt: 2 }], mesas: [{ id: 'm1', tema: 't', costUsd: 0.2, tokUsd: 0.05, updatedAt: 1, status: 'concluida' }] });
  assert.equal(rows.find((r) => r.k === 'i').custo, 0.31);
  assert.equal(Math.round(rows.find((r) => r.k === 'm').custo * 100), 25);
  assert.match(readFileSync(new URL('../src-tauri/src/ideia.rs', import.meta.url), 'utf8'), /"tokUsd": v\["tokUsd"\]/);
  assert.match(readFileSync(new URL('../src-tauri/src/mesa.rs', import.meta.url), 'utf8'), /"tokUsd": v\["tokUsd"\]/);
});

test('A17: pesquisa da Ideia fora do Claude só começa se a reserva cobre o pior caso', () => {
  const worst = I.ideiaResearchCost('codex')[1];
  assert.equal(I.ideiaResearchFits('codex', worst - 0.01, worst), false);
  assert.equal(I.ideiaResearchFits('codex', worst, worst), true);
  assert.equal(I.ideiaResearchFits('claude', 0.1, 1), true, 'no Claude o teto vai por chamada');
  assert.equal(I.ideiaResearchFits('deepseek', null, 0.1), false);
  const r = cut(IDEIA, 'const lim=purse.free()', 'm.report=Object.assign({}, prev||{}, { status:\'rodando\'');
  assert.match(r, /ideiaResearchFits\(engine, budget, worst\)/); assert.match(r, /purse\.give\(budget\); budget=null;/);
  assert.doesNotMatch(IDEIA, /não tem teto por pesquisa/);
});

test('C1–C5: medidor corta no fim, Uso sem rótulo repetido nem "ex-", persona sem nome não salva, "por entrega" e "1 time"', () => {
  const pm = cut(read('css/40-sidebar-quadro.css'), '.planmeter .pm-sum{', '}');
  assert.doesNotMatch(pm, /justify-content:flex-end/); assert.match(pm, /flex:1 1 auto;min-width:0/, 'encolhe: nunca passa da largura do botão');
  const S = new Function(cut(USO, '// @uso-puro-inicio', '// @uso-puro-fim') + '\nreturn { USO_SOURCES, USO_PERIODS, usoSinceFor };')();
  const labels = Object.values(S.USO_SOURCES);
  assert.equal(new Set(labels).size, labels.length, 'cada origem com um nome');
  assert.ok(labels.every((l) => !/\bex-/.test(l)), 'sem jargão "ex-…"');
  assert.ok(S.USO_PERIODS.some(([k]) => k === 'mes'), 'Uso confere o "uso deste mês" do medidor');
  const s = new Date(S.usoSinceFor('mes', new Date(2026, 9, 7, 15).getTime())); assert.equal(s.getDate(), 1); assert.equal(s.getHours(), 0);
  assert.match(readFileSync(new URL('../src-tauri/src/usage_ledger.rs', import.meta.url), 'utf8'), /"mes" => since/);
  assert.match(cut(FABJS, 'function fabPSaveSoon', 'function fabOpenSess'), /if\(!String\(d\.nome\|\|''\)\.trim\(\)\)\{[^\n]*return; \}/);
  assert.match(TIME, /done\?fmtCost\(custo\/done,\{usdOnly:true\}\)\+' por entrega':inP\.length\?'nenhuma entrega no período'/);
  assert.match(TIME, /nPl\(\(cloudData\.teams\|\|\[\]\)\.length,'time','times'\)/);
});

test('revisão: nenhum código engolido por comentário de fim de linha nos js do app', () => {
  const dir = new URL('../src/js/', import.meta.url);
  const CODE = /\b(const|let|var) [A-Za-z_$][\w$]*\s*=(?!=)|\bawait [A-Za-z_$][\w$.]*\(|;\s*(if\(|return\b|const |let )|\b[A-Za-z_$][\w$.]*\([^)]*\);\s*[A-Za-z_$}]|\b[A-Za-z_$][\w$]*:[^,\s]+, ?[A-Za-z_$][\w$]*:[^,\s]+,|\b[A-Za-z_$][\w$.]*=[^=\s][^;]*;\s*[A-Za-z_$]/;
  const EXC = ["63-revisao-pr.js:const rvUi={};"]; // comentário que descreve o formato do objeto (não é código)
  const achados = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    readFileSync(new URL(f, dir), 'utf8').split('\n').forEach((l, i) => {
      const re = /(^|[\s;{}),])\/\/(?!\/)/g; let m;
      while ((m = re.exec(l))) {
        const pre = l.slice(0, m.index + m[1].length);
        if (/:$/.test(pre) || !pre.trim()) break; // URL, ou linha só de comentário
        if ((pre.match(/'/g) || []).length % 2 || (pre.match(/"/g) || []).length % 2 || (pre.match(/`/g) || []).length % 2) continue; // dentro de string
        const c = l.slice(m.index + m[1].length + 2);
        if (CODE.test(c) && !EXC.some((x) => (f + ':' + l.trim()).startsWith(x))) achados.push(f + ':' + (i + 1) + ': // ' + c.slice(0, 90));
        break;
      }
    });
  }
  assert.deepEqual(achados, [], 'código depois de // na mesma linha não roda');
});
