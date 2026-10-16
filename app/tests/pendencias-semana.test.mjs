// Pendências da Semana/épico (16/10): épico entregue na grade, ações do painel de provas a 1000×700 e o aviso
// "padrão do time desligado". `node --test app/tests/pendencias-semana.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const SEM = read('js/76-casca-semana.js'), PAD = read('js/75-padroes.js'), SW = read('js/33-switcher-projetos.js');
const S = new Function(cut(SEM, '// @semana-puro-inicio', '// @semana-puro-fim') + '\nreturn { semDiasDaSemana, semEpicosEntregues, semPadraoVale };')();
const P = new Function(cut(PAD, '// @padroes-puro-inicio', '// @padroes-puro-fim') + '\nreturn { padSkAvisoOff, padAgAvisosOff };')();
const QUA = new Date(2026, 9, 14, 10).getTime(); // quarta 14/10
const iso = (d, h) => new Date(2026, 9, d, h).toISOString();

test('1 · épico entregue cai no dia da entrega (só os da semana da grade), mais recente primeiro, com quem aprovou', () => {
  const dias = S.semDiasDaSemana(QUA);
  const eps = [
    { id: 'e1', name: 'Checkout novo', spec: { delivery: { at: iso(13, 16), by: 'u-ana', tasks: 5, prs: 4 } } },
    { id: 'e2', name: 'Vitrine', spec: { delivery: { at: iso(14, 9), by: 'u-bruno', tasks: 2 } } },
    { id: 'e3', name: 'Semana passada', spec: { delivery: { at: iso(6, 9), by: 'u-ana' } } },
    { id: 'e4', name: 'Ainda aberto', spec: { doneWhen: [] } },
    { id: 'e5', name: 'Data ruim', spec: { delivery: { at: 'ontem', by: 'u-ana' } } },
  ];
  const L = S.semEpicosEntregues(eps, dias);
  assert.deepEqual(L.map((x) => [x.id, x.key, x.by, x.tarefas]), [['e2', '2026-10-14', 'u-bruno', 2], ['e1', '2026-10-13', 'u-ana', 5]]);
  assert.deepEqual(S.semEpicosEntregues(null, dias), []);
});

test('1 · grade: linha "Épicos" com bloco próprio (roxo, ÉPICO, aprovado por), dia recolhido vira contagem, clique abre o épico', () => {
  assert.match(SEM, /semEpicosEntregues\(\(typeof teamEpics!=='undefined'&&teamEpics\)\|\|\[\], dias\)/);
  assert.match(SEM, /function semBlocoEpico\(x\)\{[\s\S]*?'aprovado por '\+apr[\s\S]*?class="semtb semep" data-semep=/);
  assert.match(SEM, /personName\(x\.by,\{ noYou:true \}\)/, 'nome de quem aprovou, nunca id');
  assert.match(SEM, /class="semnum ep" data-semdia=/);
  assert.match(SEM, /\[data-semep\]'\)\.forEach\(b=>b\.onclick=\(e\)=>\{ e\.stopPropagation\(\); if\(typeof epOpenById==='function'\) epOpenById/);
  assert.match(SEM, /window\.addEventListener\('sf:epico-entregue', \(\)=>semRepintar\(\)\)/);
  const css = read('css/99-casca-semana.css');
  assert.match(css, /\.semtb\.semep\{[^}]*var\(--purple\)/);
  assert.match(css, /\.semtb\.semep:focus-visible\{box-shadow:var\(--ring\)/);
});

test('2 · Central a 1000×700: .ctwrap recorta com overflow:clip (hidden prendia o sticky) e o rodapé do painel gruda no pé', () => {
  const css = read('css/40-sidebar-quadro.css');
  assert.match(css, /\.ctwrap\{[^}]*overflow:hidden;overflow:clip;/);
  assert.doesNotMatch(css.match(/\.ctwrap\{[^}]*\}/)[0], /overflow:hidden;margin/, 'clip depois do hidden (fallback)');
  const ap = read('css/99-aprovar.css');
  assert.match(ap, /\.ctexp-apb \.apv-acts\{bottom:-20px;/);
  assert.match(ap, /\.apv-acts\{[^}]*position:sticky;bottom:0/);
  assert.match(read('css/30-refino-macos.css'), /#flowPane\{padding:12px 12px 20px\}/, 'o -20px acompanha o padding de baixo do #flowPane');
});

test('3 · skill: desligar onde estava ligada ou tirar do "sempre…" avisa; ligar ou mudar entre "sempre" não', () => {
  const R = '/tmp/demo/loja-web';
  assert.deepEqual(P.padSkAvisoOff('testes-carrinho', R, { on: true, quando: 'codigo' }, false, ''), { padrao: 'a skill Testes carrinho', onde: 'loja-web' });
  assert.deepEqual(P.padSkAvisoOff('testes-carrinho', R, { on: true, quando: 'UI' }, true, ''), { padrao: 'o "sempre em tarefas de UI" da skill Testes carrinho (agora só quando pedir)', onde: 'loja-web' });
  assert.equal(P.padSkAvisoOff('x', R, {}, true, 'UI'), null, 'ligar não avisa');
  assert.equal(P.padSkAvisoOff('x', R, { on: true, quando: 'UI' }, true, 'todas'), null, 'trocar entre "sempre" não desliga');
  assert.equal(P.padSkAvisoOff('x', R, undefined, false, ''), null);
  assert.match(PAD, /const av=padSkAvisoOff\(s\.name, repo, was, on, \(r&&r\.quando\)\|\|quando\|\|''\); if\(av\) padAvisoDesligado/);
  assert.match(PAD, /new CustomEvent\('sf:padrao-desligado', \{ detail:Object\.assign\(\{ quem:padMe\(\), at:Date\.now\(\) \}/);
});

test('3 · agentes: o que saiu do catálogo ou de uma equipe vira aviso; reordenar ou adicionar não', () => {
  const antes = { agents: [{ id: 'vega', name: 'Vega' }, { id: 'nyx', name: 'Nyx' }, { id: 'iris', name: 'Íris' }], workflows: [{ id: 'w1', name: 'Código', steps: ['iris', 'vega', 'nyx'] }, { id: 'w2', name: 'Docs', steps: ['vega'] }] };
  assert.deepEqual(P.padAgAvisosOff(antes, JSON.parse(JSON.stringify(antes))), []);
  assert.deepEqual(P.padAgAvisosOff(antes, { agents: antes.agents, workflows: [{ id: 'w1', name: 'Código', steps: ['vega', 'iris'] }, antes.workflows[1]] }), [{ padrao: 'Nyx da equipe Código', onde: 'Agentes' }]);
  assert.deepEqual(P.padAgAvisosOff(antes, { agents: antes.agents.filter((a) => a.id !== 'nyx'), workflows: [{ id: 'w1', name: 'Código', steps: ['iris', 'vega'] }, antes.workflows[1]] }), [{ padrao: 'o agente Nyx', onde: 'Agentes' }], 'agente removido não repete por equipe');
  assert.deepEqual(P.padAgAvisosOff(antes, { agents: antes.agents, workflows: [antes.workflows[0]] }), [{ padrao: 'a equipe Docs', onde: 'Agentes' }]);
  assert.deepEqual(P.padAgAvisosOff(antes, { agents: [...antes.agents, { id: 'z', name: 'Zed' }], workflows: [{ id: 'w1', name: 'Código', steps: ['nyx', 'vega', 'iris', 'z'] }, antes.workflows[1]] }), []);
  assert.match(SW, /let antes=null; try\{ antes=agBase\?JSON\.parse\(agBase\):null; \}catch\(_\)\{ \}\s*await invoke\("save_config"/);
  assert.match(SW, /padAgAvisosOff\(antes, cfgEdit\)/);
});

test('3 · a Semana guarda o aviso por 7 dias nesta máquina e esconde depois', () => {
  const now = Date.now();
  assert.equal(S.semPadraoVale({ padrao: 'a skill X', at: now - 3600e3 }, now).padrao, 'a skill X');
  assert.equal(S.semPadraoVale({ padrao: 'a skill X', at: now - 8 * 86400e3 }, now), null);
  assert.equal(S.semPadraoVale({ padrao: 'a skill X' }, now), null, 'sem data não vale');
  assert.equal(S.semPadraoVale(null, now), null);
  assert.match(SEM, /lsSet\('sem:padraoOff', JSON\.stringify\(semPadraoOff\)\)/);
  assert.match(SEM, /semPadraoOff=semPadraoVale\(JSON\.parse\(lsGet\('sem:padraoOff'\)\|\|'null'\)\)/);
});
