// Starfork — 65-fabrica: FÁBRICA DE APPS E DE FEATURES (spec-fabrica-mvp)
// Aba "Fábrica" (aba, não modal) com seletor "App novo | Feature neste projeto" (padrão Feature com projeto aberto).
// Uma SESSÃO sob demanda, nada em segundo plano: foco + teto em US$ → fabrica.rs varre (motor da Ideia), faz a
// triagem sem IA (≥2 fontes independentes, autores distintos, sinal sem fonte some), a mesa vota em lote e cada opção
// ganha um mock HTML validado num <iframe sandbox> sem script. O progresso chega pelo evento `fabrica-progress` (sem
// polling). Escolher: App → abre o "Começar por uma ideia" já com a pesquisa e o mock (59-ideia: o mock vira requisito
// da tela principal); Feature → épico em RASCUNHO no projeto, tarefa 0 "confirmar impacto (só leitura)", owns
// disjuntos e overlap_check (50-coordenacao) — depois da confirmação inline. Nada roda até a pessoa iniciar.
// Registro no motor de abas por fora do 15-config-abas (VIEW_META/VIEW_OVERLAY + viewOpen embrulhado só pra 'fabrica').

// @fabrica-puro-inicio — funções sem DOM (testadas em app/tests/fabrica.test.mjs; fixture dourado = o mesmo do Rust)
const FAB_TIPOS={ user:'pedido de usuário', int:'atrito interno', code:'achado de código', comp:'concorrente (contexto, não prova)' };
const FAB_MOCK_MAX=16000;
const FAB_TETO_PADRAO=3;
const FAB_DISCARD=['fora do foco','não é pra agora','já existe','custo alto'];
function fabFold(s){ return String(s==null?'':s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
const FAB_AUTOR_VAZIO=new Set(['','desconhecido','anonimo','autor desconhecido','n a','na','usuario','usuarios','varios','nao informado','unknown','anonymous']);
function fabAutorVazio(a){ return FAB_AUTOR_VAZIO.has(fabFold(a)); }
// chave de independência: o site, a fonte local (id) ou "código" (toda leitura do código é UMA fonte)
function fabSrcKey(s){ const t=s&&s.tipo; if(t==='code') return 'code'; if(t==='comp') return 'comp:'+(s.origem||''); return s&&s.id?'loc:'+s.id:'web:'+((s&&s.origem)||''); }
function fabHumano(s){ return !!s && (s.tipo==='user'||s.tipo==='int'); }
// fontes independentes que contam como evidência (concorrente é contexto, não conta)
function fabFontes(sinais){ return new Set((sinais||[]).filter(s=>s&&s.tipo!=='comp').map(fabSrcKey)).size; }
// autores DISTINTOS dos pedidos humanos; fonte sem autor conhecido conta como 1 pessoa (no máximo) por fonte
function fabAutores(sinais){
  const nomes=new Set(), sem=new Set(), com=new Set();
  (sinais||[]).filter(fabHumano).forEach(s=>{ const k=fabSrcKey(s), a=(s.autores||[]).filter(x=>!fabAutorVazio(x)).map(fabFold); if(a.length){ com.add(k); a.forEach(x=>nomes.add(x)); } else sem.add(k); });
  return nomes.size+[...sem].filter(k=>!com.has(k)).length;
}
function fabIdeiaNossa(sinais){ return !(sinais||[]).some(fabHumano); }
// "1 pedido de usuário (3 autores) + 1 atrito interno + 1 evidência técnica" — nunca "2 fontes" misturando tipos
function fabResumo(sinais){
  const xs=sinais||[], n=t=>new Set(xs.filter(s=>s&&s.tipo===t).map(fabSrcKey)).size;
  const u=n('user'), i=n('int'), c=n('code'), au=fabAutores(xs.filter(s=>s&&s.tipo==='user'));
  const p=[`${u} pedido${u===1?'':'s'} de usuário${u>0?` (${au} autor${au===1?'':'es'})`:''}`];
  if(i>0) p.push(`${i} atrito${i===1?'':'s'} interno${i===1?'':'s'}`);
  if(c>0) p.push(`${c} evidência${c===1?'':'s'} técnica${c===1?'':'s'}`);
  return p.join(' + ');
}
// a MESMA validação do mock_check do Rust: sem script/handler/rede/embutidos, sem dado realista, tamanho máximo
const FAB_MOCK_RULES=[
  [/<\s*script/i,'tem <script>'],
  [/<\s*(iframe|object|embed|link|meta|base|form|img|video|audio|svg|math|style)\b/i,'tem elemento proibido (iframe, img, svg, style, form…)'],
  [/\son[a-z]+\s*=/i,'tem handler de evento (on…=)'],
  [/javascript\s*:/i,'tem javascript:'],
  [/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i,'tem endereço externo'],
  [/url\s*\(|@import/i,'tem url()/@import'],
  [/\s(src|href|action|srcset|poster|data)\s*=/i,'tem atributo que carrega recurso (src/href…)'],
  [/\b(fetch|xmlhttprequest|websocket|eventsource|import)\s*\(/i,'tem chamada de rede'],
  [/[a-z0-9._%+-]+@([a-z0-9-]+\.)+[a-z]{2,}/gi,'tem e-mail (use dados claramente falsos)'],
  [/\(?\b\d{2}\)?\s?9?\d{4}-\d{4}\b/,'tem telefone (use dados claramente falsos)'],
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/,'tem CPF (use dados claramente falsos)'],
];
function fabMockCheck(body){
  const b=String(body==null?'':body), out=[];
  if(b.trim().length<40) out.push('mock vazio');
  const n=[...b].length; if(n>FAB_MOCK_MAX) out.push(`mock grande demais (${n} caracteres, máx. ${FAB_MOCK_MAX})`);
  for(const [re,m] of FAB_MOCK_RULES){
    if(m.startsWith('tem e-mail')){ if((b.match(re)||[]).some(x=>!/exemplo/i.test(x))) out.push(m); }
    else if(re.test(b)) out.push(m);
  }
  return out;
}
// o corpo do documento do mock (o que o Rust validou) — validado de novo antes do iframe
function fabMockBody(html){ const s=String(html||''); const i=s.indexOf('<body>'), j=s.lastIndexOf('</body>'); return i>=0&&j>i?s.slice(i+6,j):s; }
function fabUsd(v){ return 'US$ '+(Math.round((+v||0)*100)/100).toFixed(2).replace('.',','); }
// custo de construir SEMPRE em faixa: "US$ 18–35 com IA" (abaixo de US$ 10 com centavos)
function fabCustoTxt(c){
  if(!c || !(+c.max>0)) return 'sem estimativa';
  const lo=+c.min||0, hi=+c.max, big=hi>=10, f=v=>big?String(Math.round(v)):(Math.round(v*100)/100).toFixed(2).replace('.',',');
  return `US$ ${f(lo)}–${f(hi)} com IA`;
}
function fabCustoSub(c){ if(!c) return ''; const t=+c.tarefas||0; return `${t} tarefa${t===1?'':'s'} · ${c.base||''}`; }
// a barra do teto: % (0–100) e o texto do estado
function fabMeter(sess){
  const teto=+(sess&&sess.teto)||FAB_TETO_PADRAO, g=+(sess&&sess.gasto)||0, st=(sess&&sess.status)||'';
  const pct=Math.max(0, Math.min(100, Math.round(g/teto*100)));
  const msg={ rodando:'rodando · o gasto atualiza a cada etapa', pronta:'parou sozinha ao terminar · nada roda em segundo plano', teto:`parou no teto de ${fabUsd(teto)} — mostra o que achou até ali`,
    parada:'você parou — ficou o que já tinha', vazia:'terminou sem opção que passasse na triagem', falhou:'a varredura falhou', interrompida:'o app fechou no meio — rode de novo' }[st]||'nada roda até você mandar · para sozinha no teto';
  return { teto, gasto:g, pct, msg };
}
// owns DISJUNTOS: o caminho que uma tarefa anterior já tem (ou que está dentro dele) sai das seguintes
function fabDisjoint(tarefas){
  const taken=[], norm=p=>String(p||'').trim().replace(/^\.\//,'').replace(/\\/g,'/');
  const inside=(a,b)=>a===b || a.startsWith(b.replace(/\/?$/,'/')) || b.startsWith(a.replace(/\/?$/,'/'));
  return (tarefas||[]).map(t=>{ const owns=(t.owns||[]).map(norm).filter(p=>p && !taken.some(x=>inside(p,x))); owns.forEach(p=>taken.push(p)); return Object.assign({}, t, { owns, cortou:(t.owns||[]).length-owns.length }); });
}
// o épico da FEATURE no formato do normalizePlan (o mesmo do ideiaBuildPlan): tarefa 0 confirma o impacto (só leitura);
// as outras, 1 por tarefa sugerida com owns disjuntos. `ov[i]` = sobreposições da tarefa i (overlap_check) → aviso honesto: não começa sozinha, inicie depois da outra.
// a tarefa que DONA a tela (título/arquivos de interface); sem nenhuma, a 1ª tarefa depois da 0
const FAB_TELA_RE=/\b(tela|ui|bot[aã]o|componente|p[aá]gina|layout|menu|modal|formul[aá]rio)\b|\.(tsx|jsx|vue|svelte|html|css|scss)$|(^|\/)(components?|pages?|views?|screens?|ui)\//i;
function fabTelaIdx(ts){ const i=(ts||[]).findIndex(t=>FAB_TELA_RE.test(t.titulo||'') || (t.owns||[]).some(o=>FAB_TELA_RE.test(o))); return i<0?0:i; }
// `ov[i]` = sobreposições da tarefa i (overlap_check); `mockRef` = nome do anexo do mock (.cardume/refs/<nome>)
function fabFeaturePlan(op, ov, mockRef){
  const cut=(s,n)=>{ s=String(s==null?'':s).replace(/\s+/g,' ').trim(); return s.length>n?s.slice(0,n-1).trimEnd()+'…':s; };
  const im=op.impacto||{}, areas=(im.areas||[]).concat(im.arquivos||[]).slice(0,8);
  const ts=fabDisjoint(op.tarefasPlano||[]);
  const tasks=[{ title:'Confirmar impacto (só leitura)', after:[], covers:[], owns:'', readOnly:true,
    objective:`Antes de mexer em código, confirmar o impacto de "${cut(op.titulo,80)}": listar os arquivos que a mudança realmente toca, os testes que já existem perto e se a estimativa (${areas.join(', ')||'sem áreas estimadas'}) bate. NÃO altera nenhum arquivo. Se o impacto for maior que o estimado, pare e devolva pra confirmação com o custo corrigido.`,
    requirements:['Lista os arquivos que a mudança realmente toca, com caminho', 'Aponta os testes que já existem nessas áreas (ou diz que não há)', 'Diz se as áreas estimadas batem; se não, explica a diferença e o custo corrigido', 'Nenhum arquivo do projeto alterado (só leitura)'],
    verify:'ler o relatório da tarefa 0' }];
  const tela=op.mock && op.mock.estado==='ok' ? fabTelaIdx(ts) : -1;
  ts.forEach((t,i)=>{
    const o=(ov&&ov[i])||[], hit=o.length?o[0]:null, quem=hit?(hit.taskId||hit.agent||'outra demanda'):'';
    tasks.push({ title:cut(t.titulo,80), after:[0], covers:['R'+(i+1)], owns:(t.owns||[]).join(','), aguarda:quem, mock:i===tela,
      objective:`${t.objetivo||t.titulo}. Parte da feature "${cut(op.titulo,80)}" (Fábrica).${t.cortou?' Parte do escopo sugerido saiu pra não sobrepor outra tarefa do épico.':''}`,
      requirements:[`Feito de ponta a ponta: ${cut(t.titulo,80)}`, 'Os testes que já existiam nessas áreas continuam passando'].concat(im.regressao?[`O que já funciona continua igual (prova antes/depois): ${cut(im.regressao,160)}`]:[])
        .concat(i===tela?[`A tela nova segue o mock aprovado na Fábrica (anexo .cardume/refs/${mockRef||'mock.html'}): layout e elementos, com prova por captura`]:[])
        .concat(hit?[`Não começa sozinha: ${quem} mexe na mesma área (${hit.theirs||'mesmos arquivos'}) — inicie depois dela`]:[]),
      verify:`usar "${cut(t.titulo,60)}" no app e ver o resultado` });
  });
  return { epic:cut('Feature: '+op.titulo,90), outcome:cut(op.problema,300),
    requirements:ts.map((t,i)=>({ id:'R'+(i+1), text:cut(t.titulo,120) })),
    doneWhen:(op.dentro||[]).slice(0,5).map(d=>`Dá pra ${cut(d,80)}`).concat(['O que já funcionava continua funcionando (testes e tela antes/depois)']),
    boundaries:(op.fora||[]).slice(0,4).concat((im.naoToca||[]).length?['Não toca: '+im.naoToca.join(', ')]:[]), platform:'web', tasks };
}
// por que o épico NÃO pode nascer ('' = pode): sem tarefa sugerida, ou tarefa que ficou sem arquivos próprios
function fabPlanoProblema(plan){
  const ts=(plan&&plan.tasks||[]).slice(1);
  if(!ts.length) return 'a IA não sugeriu tarefas pra esta feature — rode a Fábrica de novo ou monte pela Nova demanda';
  const vazia=ts.find(t=>!t.owns);
  if(vazia) return `a tarefa "${vazia.title}" ficou sem arquivos próprios (sobrepunha outra tarefa) — rode de novo ou monte pela Nova demanda`;
  return '';
}
// plano → payloads do new_task (sobre os do ideiaTaskPayloads): owns da tarefa, tarefa 0 = investigação só leitura
// (sem PR, sem prova/teste), o mock anexado SÓ na tarefa da tela
function fabPayloads(plan, all, mockPath){
  return (all||[]).map((x,k)=>{ const t=plan.tasks[k]||{}, p=Object.assign({}, x.payload);
    p.owns=t.owns||null;
    if(t.readOnly){ p.proof=false; p.tests=false; p.autoPr='no'; p.branchType='invest'; }
    if(t.mock && mockPath) p.refs=[mockPath];
    return { afterIdx:x.afterIdx, payload:p }; });
}
// o relatório no formato da Ideia (ideiaReportMd/ideiaSanitize leem isto): sinal com URL = fato com fonte
function fabReportFromOp(op){
  const urls=new Set(), it=(texto, rot, f)=>{ (f||[]).forEach(u=>u&&urls.add(u)); return { texto, rotulo:rot, fontes:(f||[]).filter(Boolean) }; };
  const sinais=op.sinais||[];
  const r={ resumo:op.problema||'',
    demanda:sinais.filter(s=>s.tipo==='user'&&s.url).map(s=>it(`${s.texto||s.origem}${s.data?' ('+s.data+')':''}${(s.autores||[]).length?' — '+s.autores.length+' autor'+(s.autores.length===1?'':'es'):''}`,'fato',[s.url])),
    tendencias:[], reclamacoes:[],
    concorrentes:(op.concorrentes||[]).map(c=>Object.assign(it([c.preco,c.reclamacao].filter(Boolean).join(' — ')||'concorrente','fato',[c.url]), { nome:c.nome||c.url, url:c.url })),
    publico:op.quem?[it(op.quem,'inferencia',[])]:[], riscos:op.risco?[it(op.risco,'inferencia',[])]:[],
    veredito:{ resposta:'talvez', confianca:op.confianca==='alta'?'alta':op.confianca==='baixa'?'baixa':'media', texto:`Dor documentada, não demanda comprovada: ${op.resumoSinais||fabResumo(sinais)}. A validação de verdade é alguém usar ou pagar.`, porque:[] } };
  r.fontes=[...urls];
  return r;
}
// 1ª rodada da conversa da Ideia: o que a Fábrica trouxe + a mesa (votos viram as falas; quem não votou fica na fila)
function fabIdeaTurn(op, foco, panel){
  const you=`Vim da Fábrica (foco "${foco}") com esta opção: ${op.titulo}. ${op.problema||''}${(op.dentro||[]).length?' MVP: '+op.dentro.join('; ')+'.':''}`;
  const resp={}, V={ y:'seguir', m:'talvez', n:'descartar' };
  (panel||[]).forEach(p=>{
    if(p.id==='pesq'){ resp[p.id]={ st:'ok', text:`Sinais: ${op.resumoSinais||fabResumo(op.sinais)}. As fontes estão na pesquisa ao lado — é dor documentada, não demanda comprovada.` }; return; }
    const v=(op.votos||[]).find(x=>fabFold(x.persona)===fabFold(p.nome));
    resp[p.id]=v?{ st:'ok', text:`Meu voto na Fábrica: ${V[v.voto]||'talvez'}. ${v.porque||''}${p.id==='julia'&&op.objecao?' '+op.objecao:''}`.trim() }:{ st:'na fila' };
  });
  return { you, at:Date.now(), resp };
}
function fabDefaultMode(hasRepo){ return hasRepo?'feature':'app'; }
// @fabrica-puro-fim

Object.assign(IC, { fabrica:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 13V7l3 2V7l3 2V7l3 2V3h3v10z" stroke-linejoin="round"/></svg>' });
// ---- registro na barra de abas (aba única) ----
if(typeof VIEW_META!=='undefined'){ VIEW_META.fabrica={ title:'Fábrica', icon:'<path d="M2 13V7l3 2V7l3 2V7l3 2V3h3v10z" stroke-linejoin="round"/>' }; VIEW_OVERLAY.fabrica='fabOverlay'; }
if(typeof KEEP_ON_SWITCH!=='undefined') KEEP_ON_SWITCH.add('fabrica'); // voltar pela aba só mostra (a sessão segue na memória)
if(typeof viewOpen==='function' && !viewOpen.__fab){ const vo=viewOpen; viewOpen=function(kind, tab){ if(kind==='fabrica'){ if(tab) tab.fresh=false; return openFabrica(); } return vo.apply(this, arguments); }; viewOpen.__fab=true; }
function fabOpen(){ if(window.openTab) window.openTab('fabrica'); }
window.fabOpen=fabOpen;

const FAB={ mode:null, foco:{ app:'', feature:'' }, teto:null, colado:'', showColado:false, by:{ app:null, feature:null }, confirm:null, disc:{}, ov:{}, busy:false };
function fabEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fabCall(){ return typeof invokeQuiet==='function'?invokeQuiet:invoke; }
function fabSess(){ return FAB.by[FAB.mode]||null; }
function fabVisible(){ const o=$id('fabOverlay'); return !!(o && o.style.display!=='none'); }
const FAB_TETO_MAX=50; // o mesmo corte do fabrica.rs
function fabTeto(){ if(FAB.teto!=null) return Math.min(FAB.teto, FAB_TETO_MAX); const v=parseFloat(String((typeof lsGet==='function'&&lsGet('fabTeto'))||'').replace(',','.')); return v>0?v:FAB_TETO_PADRAO; }
function fabEngineLabel(){ return typeof aiChatRunLabel==='function'?aiChatRunLabel():(typeof defaultAiEngine==='function'?defaultAiEngine():'a IA padrão'); }
function fabProjName(p){ return typeof pathBase==='function'?pathBase(p):String(p||'').split(/[\\/]/).pop(); }

async function openFabrica(){
  const ov=$id('fabOverlay'); if(!ov) return;
  if(!FAB.mode) FAB.mode=fabDefaultMode(typeof state!=='undefined' && !!state.repo);
  if(typeof ovShow==='function') ovShow(ov); else ov.style.display='flex';
  fabRender();
  // a última sessão de cada modo volta (só leitura do arquivo; nada roda sozinho)
  for(const m of ['app','feature']){
    if(FAB.by[m]) continue;
    const id=(typeof lsGet==='function'&&lsGet('fabLast:'+m))||''; if(!id) continue;
    try{ const s=await fabCall()('fabrica_read',{ id }); if(s && s.id && (m==='app' || !s.projeto || typeof state==='undefined' || s.projeto===state.repo)) FAB.by[m]=s; }catch(_){ }
  }
  fabRender(); fabLoadOverlaps();
}
window.openFabrica=openFabrica;

// ---- progresso: evento do Rust, nada de polling ----
try{ window.__TAURI__.event.listen('fabrica-progress', async ev=>{
  const p=ev&&ev.payload; if(!p||!p.id) return;
  const m=['app','feature'].find(k=>FAB.by[k]&&FAB.by[k].id===p.id); if(!m) return;
  const s=FAB.by[m];
  s.gasto=+p.gasto||s.gasto; s.fase=p.fase||s.fase;
  if(p.line){ (s.linhas=s.linhas||[]).push({ line:p.line, url:p.url||null }); if(s.linhas.length>30) s.linhas.shift(); }
  if(p.reload || p.fase==='fim'){ try{ FAB.by[m]=await fabCall()('fabrica_read',{ id:p.id }); }catch(_){ } }
  if(p.fase==='fim'){
    const f=FAB.by[m], n=(f.opcoes||[]).length;
    const msg={ pronta:`Fábrica pronta: ${n} opç${n===1?'ão':'ões'} · gastou ${fabUsd(f.gasto)}.`, teto:`Parou no teto de ${fabUsd(f.teto)} com ${n} opç${n===1?'ão':'ões'}.`, vazia:'A Fábrica terminou sem opção que passasse na triagem.', parada:'Fábrica parada.', falhou:'A Fábrica falhou: '+(f.erro||'') }[f.status];
    if(msg) toast(msg, f.status==='pronta'?'ok':f.status==='falhou'?'err':'warn');
    fabLoadOverlaps();
  }
  if(fabVisible() && FAB.mode===m){ if(p.reload||p.fase==='fim') fabRender(); else fabPaintLive(); }
}); }catch(_){ }

async function fabStart(){
  const inp=$id('fabFoco'); const foco=String(inp&&inp.value||'').trim(); FAB.foco[FAB.mode]=foco;
  if(foco.length<4){ toast(FAB.mode==='app'?'Diga o território, ex.: "apps pra pequenas clínicas".':'Diga o foco, ex.: "o que os usuários mais pedem?".','warn'); if(inp) inp.focus(); return; }
  const tIn=$id('fabTeto'); if(tIn){ let v=parseFloat(String(tIn.value).replace(',','.')); if(v>FAB_TETO_MAX){ v=FAB_TETO_MAX; toast(`O teto máximo por sessão é ${fabUsd(FAB_TETO_MAX)} — usei esse.`,'warn'); } if(v>0){ FAB.teto=v; try{ lsSet('fabTeto', String(v)); }catch(_){ } } }
  const feat=FAB.mode==='feature';
  if(feat && (typeof state==='undefined' || !state.repo)){ toast('Abra o projeto da feature primeiro.','warn'); return; }
  if(FAB.busy) return; FAB.busy=true; FAB.confirm=null; FAB.disc={};
  const col=$id('fabColado'); if(col) FAB.colado=col.value;
  const tracker=feat && typeof trkIssues!=='undefined' && Array.isArray(trkIssues) ? trkIssues.filter(i=>!/done|closed|conclu|fechad/i.test(String(i.status||''))).slice(0,60).map(i=>({ code:i.code, title:i.title, desc:String(i.description||'').slice(0,300), autor:i.createdBy||'', data:i.createdAt||'', url:i.url||'' })) : [];
  // a sessão aparece ANTES do invoke voltar (o "fim" pode chegar antes dele); depois do id, uma leitura pega o atraso
  const mode=FAB.mode, prev=FAB.by[mode];
  FAB.by[mode]={ id:null, mode, foco, teto:fabTeto(), status:'rodando', fase:'inicio', gasto:0, linhas:[], opcoes:[], projeto:feat?state.repo:null };
  fabRender();
  try{
    const id=await invoke('fabrica_start',{ mode:FAB.mode, foco, tetoUsd:fabTeto(), project:feat?state.repo:null, model:(typeof aiClaudeModel==='function'?aiClaudeModel():null),
      colado:feat?String(FAB.colado||'').slice(0,8000):null, tracker, personas:(typeof MESA_PERSONAS!=='undefined'?MESA_PERSONAS:[]) });
    FAB.by[mode].id=id;
    try{ lsSet('fabLast:'+mode, id); }catch(_){ }
    try{ const cur=await fabCall()('fabrica_read',{ id }); if(cur && cur.id===id && FAB.by[mode] && FAB.by[mode].id===id) FAB.by[mode]=Object.assign(cur, { linhas:(cur.linhas&&cur.linhas.length)?cur.linhas:FAB.by[mode].linhas }); }catch(_){ }
  }catch(e){ FAB.by[mode]=prev; showErr(e,'Não consegui começar a Fábrica'); }
  finally{ FAB.busy=false; fabRender(); }
}
async function fabStop(){ const s=fabSess(); if(!s) return; try{ await invoke('fabrica_stop',{ id:s.id }); toast('Parando — fica o que já achou.','info'); }catch(e){ showErr(e,'Não consegui parar'); } }
// sobreposição com demandas ativas (overlap_check): só no projeto ABERTO (o comando lê o projeto ativo)
async function fabLoadOverlaps(){
  const s=FAB.by.feature; if(!s || !s.id || s.status==='rodando' || typeof state==='undefined' || s.projeto!==state.repo || FAB.ov[s.id]) return;
  const all={};
  if(!window.Coordenacao){ all.semConferir=true; }
  else for(const [i,op] of (s.opcoes||[]).entries()){
    const ts=fabDisjoint(op.tarefasPlano||[]);
    all[i]=await Promise.all(ts.map(t=>(t.owns||[]).length?Promise.resolve().then(()=>Coordenacao.overlapCheck(t.owns)).catch(()=>[]):Promise.resolve([]))); // falhou = sem sobreposição conhecida, nunca "conferindo…" pra sempre
  }
  FAB.ov[s.id]=all; if(fabVisible() && FAB.mode==='feature') fabRender();
}
async function fabDiscard(i, why){
  const s=fabSess(); if(!s) return;
  try{ FAB.by[FAB.mode]=await invoke('fabrica_discard',{ id:s.id, idx:i, motivo:why||null }); FAB.disc[i]=false; }catch(e){ showErr(e,'Não consegui descartar'); }
  fabRender();
}
// App → "Começar por uma ideia" pré-preenchido (pesquisa + mesa + mock); nada nasce sem a mesa decidir o MVP lá
async function fabToIdeia(i){
  const s=fabSess(), op=s&&s.opcoes&&s.opcoes[i]; if(!op) return;
  const data0=fabReportFromOp(op), data=(typeof ideiaSanitize==='function'&&ideiaSanitize(data0))||data0;
  if(!(data.fontes||[]).length){ toast('Esta opção não tem fonte com URL pra virar pesquisa.','warn'); return; }
  const titulo=typeof ideiaCut==='function'?ideiaCut(op.titulo,60):op.titulo, date=new Date().toLocaleDateString('pt-BR');
  const id='i-'+Date.now().toString(36)+'-'+(Math.random().toString(36).slice(2)+'0000').slice(0,4)+'x';
  const m={ id, v:1, titulo, createdAt:Date.now(), updatedAt:Date.now(), turns:[fabIdeaTurn(op, s.foco, typeof ideiaPanel==='function'?ideiaPanel():[])],
    report:{ status:'ok', data, md:(typeof ideiaReportMd==='function'?ideiaReportMd(data, titulo, { engine:'Fábrica', date }):''), engine:s.engine||'', costUsd:0, at:Date.now(), sites:(data.fontes||[]).length, avisos:data.avisos||[] },
    decision:null, project:null, costUsd:0, tokUsd:0, tokens:0, fabrica:{ sessao:s.id, idx:i, foco:s.foco, mockHtml:op.mock&&op.mock.estado==='ok'?op.mock.html:'' } };
  try{
    await invoke('ideia_save',{ id, data:m });
    await invoke('fabrica_choose',{ id:s.id, idx:i, criado:{ ideia:id } });
    FAB.confirm=null; s.escolha={ idx:i, criado:{ ideia:id } };
    if(typeof ideiaOpenTab==='function') ideiaOpenTab(id);
    toast('Abri no "Começar por uma ideia" com a pesquisa e o mock — a mesa decide o MVP e só então o projeto nasce.','ok');
  }catch(e){ showErr(e,'Não consegui levar pro Começar por uma ideia'); }
}
// Feature → épico em RASCUNHO no projeto (tarefa 0 só leitura + owns disjuntos); nada roda até iniciar
async function fabMakeEpic(i){
  const s=fabSess(), op=s&&s.opcoes&&s.opcoes[i]; if(!op || FAB.busy) return;
  if(typeof state==='undefined' || state.repo!==s.projeto){ if(window.switchProject && s.projeto){ try{ await window.switchProject(s.projeto); }catch(e){ showErr(e,'Não consegui abrir o projeto'); return; } } else { toast('Abra o projeto da feature primeiro.','warn'); return; } }
  // criação que parou no meio: RETOMA com o mesmo épico e as tarefas já criadas (nada duplicado)
  const part=s.escolha && s.escolha.idx===i && s.escolha.criado && s.escolha.criado.partial ? s.escolha.criado : null;
  const slug=typeof ideiaSlug==='function'?ideiaSlug(op.titulo):'feature';
  const epicId=part?part.epicId:'fab-'+slug+'-'+Date.now().toString(36).slice(-4), mockRef=`mock-${slug}.html`;
  const plan=fabFeaturePlan(op, (FAB.ov[s.id]||{})[i], mockRef), why=fabPlanoProblema(plan);
  if(why){ toast('Não dá pra criar o épico: '+why+'.','warn'); return; }
  FAB.busy=true; fabRender();
  const made=part?(part.tasks||[]).slice():[];
  let mockPath=part?part.mockPath||'':'';
  const mark=async(partial)=>{ const criado={ partial, epicId, epic:plan.epic, tasks:made.slice(), mockPath, projeto:s.projeto }; await invoke('fabrica_choose',{ id:s.id, idx:i, criado }); s.escolha={ idx:i, criado }; };
  try{
    // o mock vai como ANEXO da tarefa da tela (.cardume/refs/mock-<slug>.html) — o agente vê o que foi aprovado
    if(!mockPath && op.mock && op.mock.estado==='ok' && plan.tasks.some(t=>t.mock)) mockPath=await invoke('write_ref_file',{ name:mockRef, text:op.mock.html });
    const pol=typeof ntPolicy!=='undefined'?ntPolicy:{};
    const all=fabPayloads(plan, ideiaTaskPayloads(plan, epicId, { engine:defaultAiEngine(), model:defaultAiModel(), proof:pol.proofRequired, tests:pol.testsRequired }), mockPath);
    for(let k=made.length;k<all.length;k++){
      const { afterIdx, payload }=all[k];
      payload.after=afterIdx.map(j=>made[j]).filter(Boolean);
      made.push(await invoke('new_task', typeof trkBeforeNewTask==='function'?await trkBeforeNewTask(payload):payload));
      await mark(k<all.length-1); // cada tarefa criada fica gravada na sessão
    }
    if(!made.length || made.length<all.length) throw new Error('nem todas as tarefas foram criadas');
    await mark(false);
    FAB.confirm=null;
    if(typeof lastSig!=='undefined') lastSig=''; try{ await refresh(); }catch(_){ }
    toast(`Épico criado em ${fabProjName(s.projeto)} · ${made.length} tarefas · nada roda até você iniciar`,'ok');
  }catch(e){ showErr(e, made.length?`Parou depois de criar ${made.length} tarefa(s) — clique de novo pra continuar de onde parou`:'Não consegui criar o épico'); }
  finally{ FAB.busy=false; fabRender(); }
}

// ---------------- tela ----------------
function fabCapture(){
  const f=$id('fabFoco'); if(f) FAB.foco[FAB.mode]=f.value;
  const t=$id('fabTeto'); if(t){ const v=parseFloat(String(t.value).replace(',','.')); if(v>0) FAB.teto=v; }
  const c=$id('fabColado'); if(c) FAB.colado=c.value;
}
function fabMeterHtml(s){
  const m=fabMeter(s||{ teto:fabTeto() }), running=s&&s.status==='rodando', est=!!(s&&s.tetoEstimado);
  const teto=`<label class="fab-tetoin">US$ <input class="in" id="fabTeto" type="text" inputmode="decimal" value="${fabEsc(String(running?m.teto:fabTeto()).replace('.',','))}" aria-label="teto da varredura em dólares"${running?' disabled':''}></label>`;
  return `<div class="fab-meter" id="fabMeter"><div class="r"><span>${est?'Teto estimado':'Teto da varredura'} ${teto}</span><span>gasto <b id="fabGasto">${fabUsd(m.gasto)}</b></span></div><div class="m" role="progressbar" aria-label="gasto da varredura" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${m.pct}"><i id="fabBar" style="width:${m.pct}%"></i></div><small id="fabMeterMsg">${fabEsc(m.msg)}</small>${est?'<small class="fab-est">esta IA não tem teto por chamada: o app estima o pior caso antes de cada uma</small>':''}</div>`;
}
function fabMockHtml(op, feat){
  const k=op.mock||{};
  if(k.estado==='ok' && !fabMockCheck(fabMockBody(k.html)).length){
    const novo=k.selo==='mock sobre a sua tela'?'<span class="fab-new">novo</span>':'';
    return `<div class="fab-mock${feat?' inapp':''}"><span class="fab-mk">${fabEsc(k.selo||'mock')}</span>${novo}<iframe sandbox="" referrerpolicy="no-referrer" loading="lazy" tabindex="-1" title="${fabEsc('mock (ilustração, não app): '+op.titulo)}" srcdoc="${fabEsc(fabMockDoc(k.html))}"></iframe></div>`;
  }
  if(k.estado==='gerando') return `<div class="fab-mock fab-mockoff"><span class="fab-mk">mock</span><span class="dim">desenhando o mock…</span></div>`;
  return `<div class="fab-mock fab-mockoff"><span class="fab-mk">mock</span><span class="dim">${fabEsc(k.aviso||'mock indisponível')}</span></div>`;
}
// o corpo validado de novo antes de ir pro iframe (defesa em profundidade) + as cores do app nas variáveis do kit
function fabMockDoc(html){
  let vars='';
  try{ const cs=getComputedStyle(document.documentElement), g=k=>cs.getPropertyValue(k).trim(); const v={ '--mk-bg':g('--bg'), '--mk-card':g('--surface'), '--mk-ink':g('--text'), '--mk-line':g('--border'), '--mk-acc':g('--accent'), '--mk-on-acc':g('--on-accent') };
    vars=':root{'+Object.entries(v).filter(([,x])=>x && /^[#a-z0-9(),.%\s-]+$/i.test(x)).map(([k,x])=>k+':'+x).join(';')+'}'; }catch(_){ }
  return String(html||'').replace('</head>', vars?'<style>'+vars+'</style></head>':'</head>');
}
function fabSinalHtml(x){
  const ty=x.tipo==='comp'?'comp':x.tipo, a=(x.autores||[]).length;
  const link=x.url?` <a href="#" data-furl="${fabEsc(x.url)}" title="${fabEsc(x.url)}">${fabEsc(String(x.url).replace(/^https?:\/\/(www\.)?/,'').slice(0,60))}</a>`:'';
  return `<div class="fab-sg"><span class="fab-ty ${fabEsc(ty)}">${fabEsc(x.rotulo||FAB_TIPOS[x.tipo]||'sinal')}</span>${fabEsc(x.origem||'')}${a?` · ${a} autor${a===1?'':'es'}`:''}${x.texto?` — ${fabEsc(x.texto)}`:''}${link}${x.data?` <span class="dt">· ${fabEsc(x.data)}</span>`:''}${x.lida?' <span class="dt">· lida agora</span>':''}</div>`;
}
function fabVotesHtml(op){
  const vs=op.votos||[]; if(!vs.length) return '<p class="dim">a mesa não votou nesta sessão</p>';
  const L={ y:'seguir', m:'talvez', n:'descartar' };
  return `<div class="fab-votes">${vs.map(v=>`<span class="fab-vt ${fabEsc(v.voto)}" title="${fabEsc(v.porque||'')}">${fabEsc(v.persona)} <b>${L[v.voto]||'talvez'}</b></span>`).join('')}</div>`;
}
function fabFooterHtml(s, i, op){
  const feat=s.mode==='feature', d=(s.descartes||{})[i], ch=s.escolha&&s.escolha.idx===i&&s.escolha.criado;
  if(ch) return `<div class="fab-done">${IC.ok||''} ${feat?'Épico criado neste projeto — as tarefas estão em rascunho':'Levada pro Começar por uma ideia'}${!feat&&ch.ideia?` <button type="button" class="btn sm" data-fideia="${fabEsc(ch.ideia)}">abrir</button>`:''}</div>`;
  if(d) return `<div class="fab-discarded">Descartada — motivo: <b>${fabEsc(d)}</b> <button type="button" class="fab-lnk" data-fundisc="${i}">desfazer</button></div>`;
  if(FAB.confirm===i) return fabConfirmHtml(s, i, op);
  let h=`<div class="row1"><button type="button" class="btn sm primary" data-fbuild="${i}"${s.status==='rodando'?' disabled title="espere a varredura terminar"':''}>${feat?'Montar o épico neste projeto':'Escolher e montar o épico'}</button><button type="button" class="btn sm" data-fdisc="${i}" aria-expanded="${!!FAB.disc[i]}">Descartar com motivo</button></div>`;
  if(FAB.disc[i]) h+=`<div class="fab-discard"><span class="dim">Por quê? O motivo afina a próxima varredura.</span><div class="chips">${FAB_DISCARD.map(m=>`<button type="button" class="fab-dchip" data-fwhy="${i}" data-why="${fabEsc(m)}">${fabEsc(m)}</button>`).join('')}</div></div>`;
  return h;
}
function fabConfirmHtml(s, i, op){
  const busy=FAB.busy;
  if(s.mode!=='feature'){
    return `<div class="fab-confirm"><h5>Vai abrir o "Começar por uma ideia" com esta opção</h5><ol><li><b>pesquisa</b><span>os sinais com fonte viram o relatório (${(op.sinais||[]).filter(x=>x.url).length} com URL)</span></li><li><b>mesa</b><span>os votos daqui entram na conversa; a mesa decide o MVP lá</span></li><li><b>épico</b><span>tarefa 0 = esqueleto do app, depois 1 tarefa por item do MVP${op.mock&&op.mock.estado==='ok'?' · o mock vira requisito da tela principal':''}</span></li></ol>`+
      `<div class="note">o projeto só nasce quando você clicar em criar lá · <b>nada roda até você iniciar</b></div><div class="row1"><button type="button" class="btn sm primary" data-fmk="${i}"${busy?' disabled':''}>Levar pro Começar por uma ideia</button><button type="button" class="btn sm" data-funbuild>Voltar</button></div></div>`;
  }
  const plan=fabFeaturePlan(op, (FAB.ov[s.id]||{})[i], 'mock.html'), q=plan.tasks.filter(t=>t.aguarda).length, proj=fabProjName(s.projeto), why=fabPlanoProblema(plan);
  const part=s.escolha && s.escolha.idx===i && s.escolha.criado && s.escolha.criado.partial ? s.escolha.criado : null;
  if(why) return `<div class="fab-confirm"><h5>Ainda não dá pra montar o épico</h5><div class="note">${fabEsc(why)}.</div><div class="row1"><button type="button" class="btn sm" data-funbuild>Voltar</button></div></div>`;
  return `<div class="fab-confirm"><h5>Vai criar 1 épico + ${plan.tasks.length} tarefas em ${fabEsc(proj)}</h5><ol>${plan.tasks.map((t,k)=>`<li class="${t.aguarda?'q':''}"><b>tarefa ${k}</b><span>${fabEsc(k===0?'confirmar impacto (só leitura)':t.title)}${t.owns?` · arquivos: <code>${fabEsc(t.owns)}</code>`:''}${t.mock?' · leva o mock':''}${t.aguarda?` · inicie depois de ${fabEsc(t.aguarda)} (mesma área)`:''}</span></li>`).join('')}</ol>`+
    `<div class="note">${part?`<b>retomando:</b> ${(part.tasks||[]).length} tarefa(s) já criadas não se repetem · `:''}${q?`${q} tarefa${q===1?'':'s'} mexe${q===1?'':'m'} na área de uma demanda ativa e não começa${q===1?'':'m'} sozinha${q===1?'':'s'} · `:''}cada tarefa mexe em arquivos diferentes · <b>nada roda até você iniciar</b>${op.ideiaNossa?' · <b>ideia nossa: sem pedido registrado</b>':''}${op.grande?' · <b>grande: considere dividir antes</b>':''}</div>`+
    `<div class="row1"><button type="button" class="btn sm primary" data-fmk="${i}"${busy?' disabled':''}>${busy?'criando…':op.ideiaNossa?'Criar mesmo sem pedido':'Criar o épico'}</button><button type="button" class="btn sm" data-funbuild>Voltar</button></div></div>`;
}
function fabCardHtml(s, op, i){
  const feat=s.mode==='feature', out=!!(s.descartes||{})[i], sinais=op.sinais||[];
  const k=t=>`<div class="k">${t}</div>`, li=(xs,no)=>`<ul>${(xs||[]).map(x=>`<li${no?' class="no"':''}>${fabEsc(x)}</li>`).join('')||'<li class="no">—</li>'}</ul>`;
  const conc=(op.concorrentes||[]).length?`<div class="fab-src">${op.concorrentes.map(c=>`<div class="fab-sg">${fabEsc(c.nome)}${c.preco?' · '+fabEsc(c.preco):''}${c.reclamacao?' · '+fabEsc(c.reclamacao):''} <a href="#" data-furl="${fabEsc(c.url)}">${fabEsc(String(c.url).replace(/^https?:\/\/(www\.)?/,'').slice(0,50))}</a></div>`).join('')}</div>`:'<p>Não achei concorrente direto — e isso pode significar que ninguém quer.</p>';
  let body=`<h3>${fabEsc(op.titulo)}</h3>${op.ideiaNossa?'<span class="fab-ours">ideia nossa — sem pedido registrado</span>':''}`+
    `<div>${k('Problema')}<p>${fabEsc(op.problema)}</p></div>`+
    `<div>${k('Sinais')}<div class="fab-sum">${fabEsc(op.resumoSinais||fabResumo(sinais))}</div><div class="fab-src">${sinais.map(fabSinalHtml).join('')}</div></div>`;
  if(feat){
    const im=op.impacto||{}, ov=(FAB.ov[s.id]||{})[i], hits=(ov||[]).flat();
    const dep=hits.length?`<div class="fab-dep"><b>${fabEsc(hits[0].taskId||hits[0].agent||'outra demanda')}</b> está mexendo em ${fabEsc(hits[0].theirs||'')} — as tarefas dessa área não começam sozinhas: inicie depois dela</div>`
      :ov?'<div class="fab-dep none">Nenhuma demanda ativa nesses arquivos.</div>':(FAB.ov[s.id]||{}).semConferir?'<div class="fab-dep none">não deu pra conferir as demandas ativas agora</div>':`<div class="fab-dep none">${s.projeto===(typeof state!=='undefined'&&state.repo)?'conferindo as demandas ativas…':'abra este projeto pra conferir as demandas ativas'}</div>`;
    const mt=op.manutencao||{};
    body+=`<div>${k('Arquivos que esta mudança toca <span class="kx">(estimado; a tarefa 0 confirma)</span>')}<p class="fab-files">${((im.arquivos||[]).length?im.arquivos:(im.areas||[])).map(x=>`<code>${fabEsc(x)}</code>`).join(' · ')||'—'}</p>${(im.naoToca||[]).length?`<p>Não toca: ${fabEsc(im.naoToca.join(' · '))}</p>`:''}</div>`+
      `<div>${k('O que já funciona e será conferido')}<p>${fabEsc(im.regressao||'—')}${im.cobertura?` <span class="dim">· tem teste perto: ${fabEsc(im.cobertura)}</span>`:''}</p></div>`+
      `<div>${k('Em andamento na mesma área')}${dep}</div>`+
      (op.conflitoMemoria?`<div class="fab-dep"><b>Contraria a memória do projeto:</b> ${fabEsc(op.conflitoMemoria)}</div>`:'')+
      (op.grande?'<div class="fab-dep"><b>Grande:</b> mexe em muitas áreas — divida em fatias antes de virar épico.</div>':'')+
      `<div class="two"><div>${k('Escopo · dentro')}${li(op.dentro)}</div><div>${k('fora')}${li(op.fora,true)}</div></div>`+
      `<div class="two"><div>${k('Custo')}<div class="fab-cost">${fabEsc(fabCustoTxt(op.custo))}</div><p class="fab-costsub">${fabEsc(fabCustoSub(op.custo))}</p></div><div>${k('Superfície nova a manter')}<p class="fab-maint">+${+mt.telas||0} tela${+mt.telas===1?'':'s'} · +${+mt.rotas||0} rota${+mt.rotas===1?'':'s'} · +${+mt.tabelas||0} tabela${+mt.tabelas===1?'':'s'}</p></div></div>`;
  } else {
    body+=`<div>${k('Concorrentes <span class="kx">(contexto, não prova)</span>')}${conc}</div>`+
      `<div class="two"><div>${k('MVP · dentro')}${li(op.dentro)}</div><div>${k('fora')}${li(op.fora,true)}</div></div>`+
      `<div class="two"><div>${k('Custo')}<div class="fab-cost">${fabEsc(fabCustoTxt(op.custo))}</div><p class="fab-costsub">${fabEsc(fabCustoSub(op.custo))}</p></div><div>${k('Risco')}<p>${fabEsc(op.risco||'—')} · confiança ${fabEsc(op.confianca||'média')}</p></div></div>`;
  }
  body+=`<div>${k('Mesa')}${fabVotesHtml(op)}</div>${op.objecao?`<div class="fab-obj"><b>Júlia:</b> “${fabEsc(op.objecao)}”</div>`:''}`+
    ((op.avisos||[]).length?`<div class="dim fab-av">${op.avisos.map(fabEsc).join(' · ')}</div>`:'');
  return `<article class="fab-oc${out?' out':''}" aria-label="${fabEsc('opção '+(i+1)+': '+op.titulo)}">${fabMockHtml(op, feat)}<div class="bd">${body}</div><div class="ft">${fabFooterHtml(s, i, op)}</div></article>`;
}
function fabProgressHtml(s){
  const fases=s.mode==='feature'?[['fontes','fontes do projeto'],['varredura','varredura'],['triagem','triagem'],['mesa','mesa'],['mocks','mocks']]:[['varredura','varredura'],['triagem','triagem'],['mesa','mesa'],['mocks','mocks']];
  const at=Math.max(0, fases.findIndex(f=>f[0]===s.fase));
  const lines=(s.linhas||[]).slice(-8).reverse();
  return `<div class="fab-prog" role="status"><div class="fab-progh"><span class="pltyping"><i></i><i></i><i></i></span><ol class="fab-steps">${fases.map(([,l],k)=>`<li class="${k<at?'ok':k===at?'cur':''}">${fabEsc(l)}</li>`).join('')}</ol><span class="fab-sp"></span><button type="button" class="btn sm" id="fabStop">${IC.stopsq||''}Parar</button></div>`+
    `<ul class="fab-acts" id="fabActs">${fabActsHtml(lines)}</ul><div class="dim">segue rodando se você trocar de aba — e para sozinha no teto.</div></div>`;
}
function fabActsHtml(lines){ return (lines||[]).map(a=>`<li>${a.url?`<a href="#" data-furl="${fabEsc(a.url)}">${fabEsc(a.line)}</a>`:fabEsc(a.line)}</li>`).join('')||'<li class="dim">preparando…</li>'; }
// progresso sem redesenhar a aba (a cada linha do evento)
function fabPaintLive(){
  const s=fabSess(); if(!s) return;
  const m=fabMeter(s), g=$id('fabGasto'), b=$id('fabBar'), msg=$id('fabMeterMsg'), acts=$id('fabActs');
  if(g) g.textContent=fabUsd(m.gasto); if(b){ b.style.width=m.pct+'%'; b.parentElement.setAttribute('aria-valuenow', m.pct); } if(msg) msg.textContent=m.msg;
  if(acts) acts.innerHTML=fabActsHtml((s.linhas||[]).slice(-8).reverse()); else fabRender();
}
function fabFormHtml(s){
  const feat=FAB.mode==='feature', running=s&&s.status==='rodando', repo=typeof state!=='undefined'?state.repo:'';
  const foco=`<label class="fab-field">Foco <input class="in" id="fabFoco" value="${fabEsc(FAB.foco[FAB.mode]||(s&&s.foco)||'')}" placeholder="${feat?'ex.: o que os usuários mais pedem?':'ex.: apps pra pequenas clínicas'}" aria-label="Foco"${running?' disabled':''}></label>`;
  const go=`<button type="button" class="btn primary" id="fabGo"${running||FAB.busy?' disabled':''}>${s&&s.status&&s.status!=='rodando'?'Rodar de novo':'Rodar a fábrica'}</button>`;
  if(!feat) return `<div class="fab-meta">${foco}${go}</div>`;
  if(!repo) return `<div class="fab-empty">Abra um projeto pra gerar features pra ele — ou troque pra <b>App novo</b>.</div>`;
  const projs=(typeof projects!=='undefined'&&Array.isArray(projects)?projects:[]).filter(p=>p&&p.path);
  const sel=projs.length>1?`<select class="in" id="fabProj" aria-label="Projeto"${running?' disabled title="espere a varredura terminar (ou pare) pra trocar de projeto"':''}>${projs.map(p=>`<option value="${fabEsc(p.path)}"${p.path===repo?' selected':''}>${fabEsc(p.name||fabProjName(p.path))}</option>`).join('')}</select>`:`<b>${fabEsc(fabProjName(repo))}</b>`;
  return `<div class="fab-meta"><label class="fab-field">Projeto ${sel}</label>${foco}${go}</div>`+
    `<div class="fab-legend">Fontes lidas: <span class="fab-ty user">pedido de usuário</span> issues do projeto · <span class="fab-ty int">atrito interno</span> demandas e pedidos passados · <span class="fab-ty code">achado de código</span> leitura do repositório · <span class="fab-ty comp">concorrente</span> páginas públicas (contexto, não prova) · a memória do projeto entra como restrição</div>`+
    `<div class="fab-colado"><button type="button" class="fab-lnk" id="fabColTog" aria-expanded="${FAB.showColado}">${FAB.showColado?'esconder':'colar'} texto de suporte (opcional)</button>`+
    (FAB.showColado?`<div class="fab-warn" role="note"><b>Pode ter dado pessoal:</b> tire nomes, e-mails e telefones antes. Este texto vai pra <b>${fabEsc(fabEngineLabel())}</b> junto com a varredura e aparece como “fornecido por você”.</div><textarea class="in" id="fabColado" rows="4" placeholder="cole e-mails/tickets de suporte (sem dados pessoais)"${running?' disabled':''}>${fabEsc(FAB.colado)}</textarea>`:'')+`</div>`;
}
function fabResultHtml(s){
  if(!s) return '';
  const ops=s.opcoes||[], feat=s.mode==='feature';
  if(s.status==='rodando' && !ops.length) return fabProgressHtml(s);
  let h=s.status==='rodando'?fabProgressHtml(s):'';
  if(['falhou','interrompida'].includes(s.status) && !ops.length) return h+`<div class="fab-note warn" role="alert">${fabEsc(s.erro||'A varredura parou.')}</div>`;
  if(!ops.length && s.status!=='rodando'){
    return h+`<div class="fab-empty"><b>${s.status==='teto'?`Parou no teto de ${fabUsd(s.teto)} antes de juntar opções com fonte.`:'Nenhuma opção passou na triagem.'}</b><p>${s.status==='teto'?'Aumente o teto ou estreite o foco.':'A triagem exige 2 fontes independentes.'} Tente um foco mais concreto: quem sofre + onde${feat?' (ex.: "o que quem usa a Carteira mais pede?")':' (ex.: "recepção de clínica odontológica que confirma consulta no WhatsApp")'}.</p>${(s.cortadas||[]).length?`<p class="dim">Cortadas: ${s.cortadas.slice(0,5).map(c=>fabEsc(`${c.titulo} (${c.motivo})`)).join(' · ')}</p>`:''}</div>`;
  }
  const nc=(s.cortadas||[]).length;
  h+=`<div class="fab-sumline">Foco: <b>${fabEsc(s.foco)}</b> · ${+s.encontradas||ops.length} oportunidade${(+s.encontradas||ops.length)===1?'':'s'} encontrada${(+s.encontradas||ops.length)===1?'':'s'}, ${ops.length} com fontes suficientes${ops.some(o=>(o.votos||[]).length)?' · a mesa votou em lote':''}</div>`;
  if(ops.length<3 && nc) h+=`<div class="dim fab-cut">Só ${ops.length} opç${ops.length===1?'ão':'ões'}: ${s.cortadas.filter(c=>c.motivo!=='ficou fora das 3 melhores').slice(0,4).map(c=>fabEsc(`"${c.titulo}" — ${c.motivo}`)).join(' · ')||'as outras não tinham fontes suficientes'}.</div>`;
  return h+`<div class="fab-opts">${ops.map((o,i)=>fabCardHtml(s,o,i)).join('')}</div>`;
}
function fabRender(){
  const body=$id('fabBody'); if(!body) return;
  fabCapture();
  const s=fabSess(), feat=FAB.mode==='feature';
  const top=`<div class="fab-top"><h2>${IC.fabrica}Fábrica</h2><div class="fab-seg" role="tablist" aria-label="Tipo">`+
    `<button type="button" role="tab" data-fmode="app" aria-selected="${!feat}" class="${!feat?'on':''}">App novo</button><button type="button" role="tab" data-fmode="feature" aria-selected="${feat}" class="${feat?'on':''}">Feature neste projeto</button></div>${fabMeterHtml(s)}</div>`;
  const warn=`<div class="fab-warnline"><b>Leia antes:</b> isto é dor documentada, não demanda comprovada. Autores são contados uma vez, não menções. O custo é só pra construir com IA; manter fica de fora${feat?' e aparece como superfície nova':''}.</div>`;
  const html=`<div class="fab">${top}${fabFormHtml(s)}${warn}${fabResultHtml(s)}</div>`;
  if(body.__html===html) return;
  const ae=document.activeElement, fid=ae&&body.contains(ae)&&ae.id?ae.id:null, sel=fid&&typeof ae.selectionStart==='number'?[ae.selectionStart, ae.selectionEnd]:null;
  const sc=body.scrollTop;
  body.innerHTML=html; body.__html=html; body.scrollTop=sc;
  if(fid){ const el=$id(fid); if(el){ el.focus(); if(sel && el.setSelectionRange) try{ el.setSelectionRange(sel[0], sel[1]); }catch(_){ } } }
  fabWire(body);
}
function fabWire(body){
  bindClick('fabGo', fabStart);
  bindClick('fabStop', fabStop);
  bindClick('fabColTog', ()=>{ fabCapture(); FAB.showColado=!FAB.showColado; fabRender(); });
  const f=$id('fabFoco'); if(f) f.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); fabStart(); } };
  const p=$id('fabProj'); if(p) p.onchange=async()=>{ if(FAB.by.feature && FAB.by.feature.status==='rodando'){ toast('Espere a varredura terminar (ou pare) pra trocar de projeto.','warn'); fabRender(); return; } if(window.switchProject){ try{ await window.switchProject(p.value); }catch(e){ showErr(e,'Não consegui abrir o projeto'); } } FAB.by.feature=null; fabRender(); };
  body.querySelectorAll('[data-fmode]').forEach(b=>b.onclick=()=>{ fabCapture(); FAB.mode=b.dataset.fmode; FAB.confirm=null; FAB.disc={}; fabRender(); fabLoadOverlaps(); });
  body.querySelectorAll('[data-fbuild]').forEach(b=>b.onclick=()=>{ FAB.confirm=+b.dataset.fbuild; fabRender(); });
  body.querySelectorAll('[data-funbuild]').forEach(b=>b.onclick=()=>{ FAB.confirm=null; fabRender(); });
  body.querySelectorAll('[data-fdisc]').forEach(b=>b.onclick=()=>{ const i=+b.dataset.fdisc; FAB.disc[i]=!FAB.disc[i]; fabRender(); });
  body.querySelectorAll('[data-fwhy]').forEach(b=>b.onclick=()=>fabDiscard(+b.dataset.fwhy, b.dataset.why));
  body.querySelectorAll('[data-fundisc]').forEach(b=>b.onclick=()=>fabDiscard(+b.dataset.fundisc, ''));
  body.querySelectorAll('[data-fmk]').forEach(b=>b.onclick=()=>{ const i=+b.dataset.fmk; if(FAB.mode==='feature') fabMakeEpic(i); else fabToIdeia(i); });
  body.querySelectorAll('[data-fideia]').forEach(b=>b.onclick=()=>{ if(typeof ideiaOpenTab==='function') ideiaOpenTab(b.dataset.fideia); });
  // segmentado com setas (padrão de abas acessíveis)
  const seg=body.querySelector('.fab-seg'); if(seg) seg.onkeydown=e=>{ if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight') return; e.preventDefault(); fabCapture(); FAB.mode=FAB.mode==='app'?'feature':'app'; FAB.confirm=null; fabRender(); const on=body.querySelector('.fab-seg .on'); if(on) on.focus(); };
}
document.addEventListener('click', e=>{ const u=e.target.closest&&e.target.closest('[data-furl]'); if(u){ e.preventDefault(); invoke('open_url',{ url:u.dataset.furl }).catch(()=>{}); } });
bindClick('fabClose', ()=>{ if(typeof ovHide==='function') ovHide('fabOverlay'); });
