// BATERIA DO COMANDO — roda as frases reais contra a IA de verdade, no mesmo modo enxuto do app, e confere o plano.
// Não entra no `node --test` (gasta IA): rode à mão →  node tests/comando-eval.mjs   (uns centavos e ~1 min)
// Dados fictícios (repo público). Cada caso: { pedido, foco?, conversa?, quer: [[acao, [tarefas…]]…], semMuta?, fala? }
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
const JS = readFileSync(new URL('../src/js/89-comando.js', import.meta.url), 'utf8');
const i = JS.indexOf('// @comando-puro-inicio'), j = JS.indexOf('// @comando-puro-fim', i);
const C = new Function(JS.slice(i, j) + '\nreturn { cmdPlanPrompt, cmdPlanParse, cmdRefTask, CMD_PLAN_SYS, CMD_MUTA };')();
const REFS = [
  { id:'a', ref:'LW-1168', code:'LW-1168', title:'Tracer: escala de risco, formato e premissas', st:'aguardando você', proj:'relay', criada:'ontem 09:10', mexida:'há 2 h', q:'O login expirou; posso rodar o login neste terminal?', ops:['Pode rodar o login', 'Não, eu mesmo faço o login'], fatos:'sem PR' },
  { id:'b', ref:'LW-1195', code:'LW-1195', title:'Auditoria de segurança do painel', st:'pronta pra revisar', criada:'ontem 14:00', mexida:'há 5 h', fatos:'3 de 3 requisitos com prova, PR aberto' },
  { id:'c', ref:'LW-1173', code:'LW-1173', title:'Lentidão no Fast após troca de roteador', st:'pronta pra revisar', proj:'relay', criada:'10/11', mexida:'há 1 d', fatos:'sem PR' },
  { id:'d', ref:'LW-1174', code:'LW-1174', title:'Lentidão no Fast após troca de roteador (parte 2)', st:'pronta pra revisar', proj:'relay', criada:'10/11', mexida:'há 1 d', fatos:'sem PR' },
  { id:'e', ref:'LW-1228', code:'LW-1228', title:'Catálogo Pro como caso do use_cases + bloqueio no MCP', st:'pronta pra revisar', criada:'hoje 10:12', mexida:'há 20 min', fatos:'0 de 26 requisitos com prova, sem PR' },
  { id:'f', ref:'LW-1208', code:'LW-1208', title:'Mock navegável: mapa de uso e replay', st:'rodando', criada:'hoje 08:30', mexida:'há 1 min', fatos:'sem PR' },
  { id:'g', ref:'T1', code:'', title:'Central de ajuda do use_cases em inglês', st:'rascunho', criada:'08/11' },
];
const FOCO_1228 = 'LW-1228 "Catálogo Pro como caso do use_cases" — selo: pronta pra revisar\nfatos: 0 de 26 requisitos com prova; sem PR; 11 arquivos mexidos nesta sessão; IA parada\núltima fala do agente:\nImplementei o catálogo e o roteador; faltam os testes de limite por plano.';
const CASOS = [
  { nome:'vários encerramentos + listagem', pedido:'Encerre a LW 1168 a 1195 a 1173 e a 1174 e depois me mostre as em aberto', quer:[['encerrar', ['LW-1168', 'LW-1195', 'LW-1173', 'LW-1174']], ['abertas|status', []]] },
  { nome:'não é a tarefa ao lado', foco:{ id:'a' }, pedido:'não estou falando dessa tarefa, falo da última tarefa que abrimos hoje, é sobre o catálogo pro no use cases. Como ela está?', tem:[['tarefa|perguntar_agente|instruir', 'LW-1228']], quer:[], naoPode:['LW-1168'] },
  { nome:'continuar rodando ela', foco:{ id:'e' }, conversa:['Pessoa: como está a LW-1228?', 'Comando: [Comando mostrou: tarefa de LW-1228]'], pedido:'eu sei, precisamos continuar rodando ela', tem:[['continuar|instruir', 'LW-1228']], quer:[] },
  { nome:'duvida do selo → usa os fatos', foco:{ id:'e', ctx:FOCO_1228 }, pedido:'acredito que ela não esteja pronta, pode conferir com o agente?', tem:[['instruir|perguntar_agente', 'LW-1228']], quer:[], fala:/26|prova|PR/i },
  { nome:'pergunta de estado não vira bloco de texto', pedido:'quais as tasks ainda estão abertas?', quer:[['abertas|status', []]], semMuta:true, falaMax:260 },
  { nome:'o que me espera', pedido:'tem alguma coisa travada esperando resposta minha?', quer:[['esperando', []]], semMuta:true },
  { nome:'provas por descrição', pedido:'me mostra as provas da auditoria de segurança', quer:[['provas', ['LW-1195']]], semMuta:true },
  { nome:'ambíguo → pergunta, não escolhe', pedido:'encerra a da lentidão no fast', quer:[], duvida:true },
  { nome:'instrução ditada', pedido:'fala pro agente da 1208 usar dados fictícios no replay', tem:[['instruir', 'LW-1208']], quer:[], texto:/fict/i },
  { nome:'aprovar', pedido:'pode aprovar a auditoria, tá tudo provado', tem:[['aprovar', 'LW-1195']], quer:[] },
  { nome:'código → ler_codigo', pedido:'onde no código fica a validação do limite de itens por plano?', quer:[['ler_codigo', []]], semMuta:true },
  { nome:'pergunta sobre a tarefa ao lado (caso real: foi pra outra tarefa)', foco:{ id:'e', ctx:FOCO_1228 }, conversa:['Pessoa: me mostra as provas da 1228', 'Comando: [Comando mostrou: provas de LW-1228]'], pedido:'O que falta para começar as provas?', quer:[], naoPode:['LW-1208', 'LW-1195', 'LW-1168'], fala:/prova|requisito|teste|PR/i },
  { nome:'vago → propõe com os fatos', foco:{ id:'e', ctx:FOCO_1228 }, pedido:'resolve isso pra mim, quero ela entregue', tem:[['instruir|continuar', 'LW-1228']], quer:[] },
  // 12–13/11: perguntou e levou uma proposta de instrução; respondeu no chat e nada foi entregue ao agente
  { nome:'pergunta de estado não vira instrução', pedido:'como esta a task 1228?', tem:[['tarefa', 'LW-1228']], quer:[], semMuta:true },
  { nome:'PR aberto pelo agente conta', foco:{ id:'e', ctx:'LW-1228 "Catálogo Pro" — selo: rodando\nfatos: 23 de 26 requisitos com prova; PR aberto pelo agente: https://github.com/acme/loja/pull/77; a IA está trabalhando agora' }, pedido:'abriu o pr de homol?', quer:[], semMuta:true, fala:/77|aberto|sim/i },
  { nome:'pedido de ação continua virando instrução', foco:{ id:'e', ctx:FOCO_1228 }, pedido:'preciso do pr de homol', tem:[['instruir', 'LW-1228']], quer:[] },
  { nome:'resposta curta à pergunta aberta', foco:{ id:'a' }, conversa:['Comando avisou: LW-1168 — tem uma pergunta pra você. Pergunta dela: «O login expirou; posso rodar o login neste terminal?»'], pedido:'pode sim', tem:[['responder', 'LW-1168']], quer:[], texto:/pode/i },
  { nome:'escolhe a opção pelo número', foco:{ id:'a' }, conversa:['Comando avisou: LW-1168 — tem uma pergunta pra você. Pergunta dela: «O login expirou; posso rodar o login neste terminal?»'], pedido:'a segunda', tem:[['responder', 'LW-1168']], quer:[], texto:/^Não, eu mesmo faço o login$/ },
  { nome:'responde ao que o executor disse (sem pergunta formal)', foco:{ id:'f' }, conversa:['Comando avisou: LW-1208 — parou. O executor disse: «Montei o replay. Uso dados reais do cliente ou fictícios?»'], pedido:'ficticios, sempre', tem:[['instruir|responder', 'LW-1208']], quer:[], texto:/^fict[ií]cios, sempre\.?$/i },
  { nome:'abrir o preview', pedido:'abre o preview da 1208 pra mim', tem:[['ambiente_subir', 'LW-1208']], quer:[], semMuta:true },
  { nome:'me passa a url', foco:{ id:'e', ctx:FOCO_1228 }, pedido:'quero ver ela rodando, me passa a url', tem:[['ambiente_subir', 'LW-1228']], quer:[], semMuta:true },
];
const args = (sys) => ['--strict-mcp-config', '--tools', '', '--system-prompt', sys, '--setting-sources', '', '--no-session-persistence', '--model', process.env.CMD_MODEL || 'claude-sonnet-5', '--output-format', 'json'];
let ok = 0, tempo = 0, custo = 0; const falhas = [];
for (const c of CASOS.filter(x => !process.env.CMD_SO || process.env.CMD_SO.split('|').some(k => x.nome.includes(k)))) {
  const refs = REFS.map(r => ({ ...r, foco: !!(c.foco && c.foco.id === r.id) }));
  const prompt = C.cmdPlanPrompt({ proj:'loja-web', refs, epics:[], foco:(c.foco && c.foco.ctx) || '', conversa:c.conversa || [], pedido:c.pedido });
  const t0 = Date.now();
  const r = spawnSync('claude', ['-p', prompt, ...args(C.CMD_PLAN_SYS)], { cwd: tmpdir(), encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'], env:{ ...process.env, ANTHROPIC_API_KEY:'' } });
  const s = (Date.now() - t0) / 1000; tempo += s;
  let env = null; try { env = JSON.parse(r.stdout); } catch (_) { }
  custo += (env && env.total_cost_usd) || 0;
  const P = C.cmdPlanParse(env ? String(env.result || '') : '');
  const erros = [];
  if (!P) erros.push('não veio JSON: ' + String((env && env.result) || r.stderr || r.stdout).slice(0, 120));
  else {
    const got = P.passos.map(p => [p.acao, p.tarefas.map(q => (C.cmdRefTask(q, refs) || {}).ref || '?' + q)]);
    c.quer.forEach(([acoes, ts], k) => { const g = got[k]; if (!g) return erros.push(`faltou o passo ${k + 1} (${acoes})`);
      if (!acoes.split('|').includes(g[0])) erros.push(`passo ${k + 1}: veio "${g[0]}", queria ${acoes}`);
      if (ts.length && JSON.stringify([...g[1]].sort()) !== JSON.stringify([...ts].sort())) erros.push(`passo ${k + 1}: tarefas ${g[1].join(',') || '(nenhuma)'}, queria ${ts.join(',')}`); });
    (c.tem || []).forEach(([acoes, ref]) => { if (!got.some(g => acoes.split('|').includes(g[0]) && g[1].includes(ref))) erros.push(`faltou um passo ${acoes} com ${ref} (veio: ${got.map(g => g[0] + ' ' + g[1].join(',')).join(' → ') || 'nenhum'})`); });
    if (c.quer.length === 0 && !c.tem && c.duvida && got.some(g => C.CMD_MUTA.has(g[0]))) erros.push('devia perguntar, mas propôs ' + got.map(g => g[0] + ' ' + g[1].join(',')).join(' → '));
    if (c.duvida && !P.duvida && !/\?/.test(P.fala)) erros.push('não perguntou qual');
    if (c.semMuta && got.some(g => C.CMD_MUTA.has(g[0]))) erros.push('propôs mexer em algo: ' + got.map(g => g[0]).join(','));
    if (c.naoPode && got.some(g => g[1].some(x => c.naoPode.includes(x)))) erros.push('usou a tarefa errada: ' + c.naoPode.join(','));
    if (c.fala && !c.fala.test(P.fala)) erros.push('a fala não citou os fatos: "' + P.fala.slice(0, 100) + '"');
    if (c.falaMax && P.fala.length > c.falaMax) erros.push(`fala longa (${P.fala.length} caracteres)`);
    if (c.texto && !P.passos.some(p => c.texto.test(p.texto))) erros.push('o texto da instrução não levou o que a pessoa disse');
    if (/\bT\d+\b/.test(P.fala + P.duvida)) erros.push('vazou identificador interno (T1…)');
  }
  if (erros.length) falhas.push({ caso:c.nome, erros, plano:P && P.passos.map(p => p.acao + ' ' + p.tarefas.join(',')).join(' → '), fala:P && P.fala.slice(0, 140), duvida:P && P.duvida.slice(0, 140) }); else ok++;
  console.log(`${erros.length ? '✗' : '✓'} ${s.toFixed(1)}s  ${c.nome}${erros.length ? '\n    ' + erros.join('\n    ') : ''}`);
}
console.log(`\n${ok} de ${CASOS.length} certos · tempo médio ${(tempo / CASOS.length).toFixed(1)} s · custo total US$ ${custo.toFixed(3)} (US$ ${(custo / CASOS.length).toFixed(4)} por pedido)`);
if (falhas.length) console.log('\nFALHAS:\n' + JSON.stringify(falhas, null, 1));
process.exit(falhas.length ? 1 : 0);
