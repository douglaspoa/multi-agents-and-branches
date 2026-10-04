// Starfork — 64-terminal-integrado
// ===== TERMINAL INTEGRADO (mock aprovado pelo dono em 04/10 — "Terminal integrado: a tarefa inteira acontece no terminal") =====
// O terminal é o lugar da conversa — quem não programa clica, quem programa digita:
//  - DIGITAR no xterm sempre funciona: no histórico (sessão parada) a 1ª tecla — ou um clique — retoma a sessão
//    (term_open resume) e o que foi digitado é escrito no PTY quando o Claude Code termina de desenhar;
//  - embaixo do terminal, o DOCK substitui o compositor: chips de resposta (evento `suggest` do MCP suggest_replies,
//    o mais novo depois da sua última fala), "anexar" e os botões Etapa/Skills/Tarefa/Revisão — botão = comando no
//    terminal: abre a folha (mesma cara da folha de pergunta do 60-terminal-layout), você escolhe, e o app manda o
//    comando pelo term_send (/starfork-etapa provar…; no Codex/Gateway vai uma frase em pt-BR com o mesmo pedido);
//  - anexo: arrastar no terminal, colar (⌘V com arquivo/print) ou o botão → salva em .cardume/refs e digita
//    `@.cardume/refs/<arquivo> ` no prompt (o Claude Code lê pelo @);
//  - entregáveis viram LINK: no painel "Requisitos e provas" (nomes das provas e a seção Entregáveis) e na Entrega —
//    abre na aba Documento ao lado do terminal (cvOpenTop doc) ou no app padrão (open_artifact).
// O compositor antigo continua a um clique ("compositor", lembrado no localStorage) e aparece sozinho quando é
// preciso: teto de custo aberto, anexo/nota já esperando nele, ou quem pede o campo (pergunta do plano, trecho da revisão).

// @ti-puro-inicio (puro: só esc/escA — testado em app/tests/terminal-integrado.test.mjs)
const TI_MAX_BUF=4096; // teclas guardadas enquanto a sessão abre
const TI_SLASH=new Set(['claude','deepseek']); // motores que rodam no Claude Code: entendem os /comandos instalados pelo Starfork
const TI_IC={
  etapa:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h12M12 6l6 6-6 6"/></svg>',
  skill:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z"/></svg>',
  tarefa:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  pr:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4"/></svg>',
  clip:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5L5 8a2 2 0 0 0 2.8 2.8l4.7-4.7a3 3 0 0 0-4.2-4.2L3.4 6.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ext:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3.5h3.5V7M12.2 3.8L7 9M7.5 3.5H4.2c-.4 0-.7.3-.7.7v7.6c0 .4.3.7.7.7h7.6c.4 0 .7-.3.7-.7V8.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/></svg>',
};
// tecla que RETOMA a sessão: texto/Enter/colagem; setas, PgUp/PgDn e Esc (sequências \x1b…) só rolam o histórico
function tiKeyOpens(d){ return !!d && !/^\x1b/.test(String(d)); }
// fila das teclas digitadas enquanto a sessão abre: FIFO, Enter (\r/\n) e tudo mais intactos; passou do teto, sai o mais velho
function tiBufPush(buf, d, max){ const s=String(buf||'')+String(d==null?'':d); return max && s.length>max ? s.slice(-max) : s; }
/** Pra onde vai cada pedaço do onData: 'buf' enquanto a abertura está em voo (MESMO com o PTY já vivo, até o flush
 *  único — senão o fim do texto chegava antes do começo e o Enter se perdia), 'pty' direto, 'hist' = tecla no histórico. */
function tiKeyRoute(going, alive){ return going ? 'buf' : alive ? 'pty' : 'hist'; }
// fala SUA (o chip é a resposta ao último turno do agente: depois de você falar, os chips velhos saem)
function tiIsUserEv(e){ const tx=String((e&&e.text)||''); return !!e && ((e.agent==='Você' && /^Você:\s/.test(tx)) || (e.type==='note' && /^Você:\s/.test(tx)) || /^humano respondeu:/.test(tx)); }
// texto do evento `suggest` (JSON com 2–4 strings) → chips limpos; lixo vira []
function tiParseSuggest(text){
  let a; try{ a=JSON.parse(String(text||'')); }catch(_){ return []; }
  if(!Array.isArray(a)) return [];
  const out=[];
  for(const x of a){
    const s=String(typeof x==='string'?x:(x&&(x.text||x.label))||'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,160);
    if(s && !out.includes(s)) out.push(s);
    if(out.length>=4) break;
  }
  return out;
}
/** Chips da vez: o `suggest` mais novo que veio DEPOIS da sua última fala. → { id, list } | null */
function tiSuggest(evs){
  const L=evs||[];
  for(let i=L.length-1;i>=0;i--){ const e=L[i]; if(!e) continue;
    if(tiIsUserEv(e)) return null;
    if(e.type==='suggest'){ const list=tiParseSuggest(e.text); if(list.length) return { id:e.id, list }; }
  }
  return null;
}
function tiTitleClean(s){ return String(s==null?'':s).replace(/[\x00-\x1f\x7f"“”]/g,' ').replace(/\s+/g,' ').trim().slice(0,120); }
// motores sem os /comandos (Codex, Gemini CLI, opencode, Gateway…): frase em pt-BR + o comando `starfork …` que o agente
// roda no shell (o CLI do Starfork está no PATH do terminal pra qualquer IA)
const TI_NL={
  'etapa:provar':'Starfork: avance esta tarefa para Provar — rode os testes, junte as provas que faltam e mapeie os requisitos; use `starfork status` e, no fim, `starfork etapa review`.',
  'etapa:entregar':'Starfork: confira as provas desta tarefa (`starfork status`); se todos os requisitos estiverem provados, abra o PR (`starfork pr`); senão me diga o que falta.',
  'etapa:construir':'Starfork: volte esta tarefa para Construir — retome a implementação do que falta, diga numa linha o motivo da volta e rode `starfork etapa running`.',
  'tarefa-quebrar:':'Starfork: quebre o que falta desta tarefa em sub-tarefas paralelas — uma por vez com `starfork tarefa "<título>" --objetivo "<objetivo>"`.',
  'revisao:':'Starfork: peça a revisão desta tarefa — confira com `starfork status`, rode `starfork etapa review` e me mostre o que falta corrigir.',
  'pr:abrir':'Starfork: confira os portões (requisitos, provas, testes) com `starfork status` e abra o PR desta tarefa com `starfork pr`.',
  'pr:rascunho':'Starfork: abra o PR desta tarefa como rascunho com `starfork pr --rascunho`.',
  'pr:atualizar':'Starfork: faça o push do que mudou e atualize o PR desta tarefa com `starfork pr` (o corpo leva as provas novas).',
};
/**
 * O comando que o botão digita no terminal. Claude Code (e DeepSeek dentro dele): o /comando instalado pelo Starfork;
 * os outros (Codex, Gemini CLI, opencode, Gateway): uma frase em pt-BR com o mesmo pedido e o `starfork …` a rodar.
 * '' = pedido inválido (não manda nada).
 * cmd: 'etapa' (provar|entregar|construir) · 'skill' (nome) · 'tarefa-nova' (título) · 'tarefa-quebrar' · 'revisao' · 'pr' (abrir|rascunho|atualizar)
 */
function tiCmdText(engineKind, cmd, arg){
  const a=String(arg==null?'':arg).trim(); const slash=TI_SLASH.has(String(engineKind||'claude'));
  if(cmd==='etapa'){ if(!['provar','entregar','construir'].includes(a)) return ''; return slash?'/starfork-etapa '+a:TI_NL['etapa:'+a]; }
  if(cmd==='pr'){ if(!['abrir','rascunho','atualizar'].includes(a)) return ''; return slash?'/starfork-pr '+a:TI_NL['pr:'+a]; }
  if(cmd==='revisao') return slash?'/starfork-revisao':TI_NL['revisao:'];
  if(cmd==='tarefa-quebrar') return slash?'/starfork-tarefa quebrar':TI_NL['tarefa-quebrar:'];
  if(cmd==='tarefa-nova'){ const t=tiTitleClean(a); if(!t) return ''; return slash?`/starfork-tarefa nova "${t}"`:`Starfork: crie uma tarefa nova de ajuste chamada "${t}", no mesmo épico desta, com o contexto desta conversa — rode \`starfork tarefa "${t}" --objetivo "<objetivo>"\`.`; }
  if(cmd==='skill'){ if(!/^[\w.:-]{1,80}$/.test(a)) return ''; return slash?'/starfork-skill '+a:`Starfork: rode a skill "${a}" do projeto nesta tarefa — leia com \`starfork skill ${a}\`, siga as instruções e registre o resultado com \`starfork entregavel "<item>"\`.`; }
  return '';
}
// ---- IA que roda no terminal (o PTY é um shell; `starfork ia <nome>` liga uma IA nele) ----
const TI_AIS=[ { id:'claude', label:'Claude Code', short:'Claude' }, { id:'codex', label:'Codex', short:'Codex' }, { id:'deepseek', label:'DeepSeek (via Claude Code)', short:'DeepSeek' },
  { id:'gemini', label:'Gemini CLI', short:'Gemini', exp:true }, { id:'opencode', label:'opencode', short:'opencode', exp:true } ];
// modelo → nome curto pro `--modelo` ("claude-sonnet-4-5" → "sonnet"; o resto vai como veio)
function tiModelShort(m){ const s=String(m||'').trim(); const k=s.match(/\b(opus|sonnet|haiku)\b/i); return k?k[1].toLowerCase():s.replace(/[^\w.:/-]/g,''); }
/** Comando recomendado pra esta tarefa: o do backend (TermInfo.recommended) ou montado do motor/modelo da tarefa. */
function tiRecommended(rec, engineKind, model){
  if(rec && rec.command) return { ai:String(rec.ai||engineKind||'claude'), model:tiModelShort(rec.model), command:String(rec.command) };
  const ai=TI_AIS.some(x=>x.id===engineKind)?engineKind:'claude'; const m=tiModelShort(model);
  return { ai, model:m, command:'starfork ia '+ai+(m?' --modelo '+m:'') };
}
// "Claude · sonnet" — o MESMO formato no seletor e no recomendado (o modelo vem só do recomendado)
function tiAiLabel(ai, model){ const x=TI_AIS.find(a=>a.id===ai); return (x?x.short:String(ai||''))+(model?' · '+model:''); }
// seletor da IA: a que está rodando (cli; '' = shell sem IA). Só a IA do recomendado leva o modelo (uma fonte só).
function tiAiSelHtml(cli, rec){
  const opts=TI_AIS.map(x=>`<option value="${x.id}"${x.id===cli?' selected':''}>${esc(tiAiLabel(x.id, x.id===rec.ai?rec.model:'')+(x.exp?' (experimental)':''))}</option>`).join('');
  const odd=cli && !TI_AIS.some(x=>x.id===cli) ? `<option value="${escA(cli)}" selected>${esc(cli)}</option>` : '';
  return `<select class="tiai" data-ti="ai" aria-label="IA rodando no terminal — trocar" title="a IA que roda no terminal — trocar (ou digite starfork ia &lt;nome&gt; no terminal)">${cli===''?'<option value="" selected disabled>shell (sem IA)</option>':''}${odd}${opts}<option value="__cmd">Outro comando…</option></select>`;
}
/** Anexo salvo (rel dentro da worktree) → menção que o Claude Code lê. Nome com espaço vai entre aspas. */
function tiAtRef(rel){ const r=String(rel||'').replace(/^\.\//,'').replace(/[\x00-\x1f\x7f]/g,''); if(!r) return ''; return (/\s/.test(r)?'@"'+r.replace(/"/g,'')+'"':'@'+r)+' '; }
// opções de cada folha. skills: [{ name, description, active }] (list_skills) · quick: CHAT_SKILLS ({ id, label, desc, prompt() })
function tiSheetDef(kind, ctx){
  ctx=ctx||{};
  if(kind==='etapa') return { kind, title:'Etapa e status', sub:'O agente muda a etapa e explica o que falta pra ela valer.', opts:[
    { id:'provar', title:'Avançar pra Provar', desc:'roda os testes e junta as provas que faltam', cmd:'etapa', arg:'provar' },
    { id:'entregar', title:'Avançar pra Entregar', desc:'só passa se todos os requisitos tiverem prova', cmd:'etapa', arg:'entregar' },
    { id:'construir', title:'Voltar pra Construir', desc:'reabre a implementação com um motivo', cmd:'etapa', arg:'construir' } ] };
  if(kind==='tarefa') return { kind, title:'Tarefa ou épico', sub:'O agente cria e preenche usando o contexto desta conversa.', opts:[
    { id:'nova', title:'Nova tarefa de ajuste', desc:'a partir do que foi falado aqui, no mesmo épico', cmd:'tarefa-nova', input:'título da tarefa nova' },
    { id:'quebrar', title:'Quebrar em sub-tarefas', desc:'divide o que falta em tarefas paralelas', cmd:'tarefa-quebrar' } ] };
  if(kind==='pr') return { kind, title:'Revisão e PR', sub:'Os portões rodam antes — o que estiver aberto aparece no terminal.', opts:[
    { id:'revisao', title:'Pedir revisão', desc:'as lentes de revisão, com o veredito no terminal', cmd:'revisao' },
    { id:'abrir', title:'Abrir PR', desc:'checa os portões e abre o PR com as provas', cmd:'pr', arg:'abrir' },
    { id:'rascunho', title:'Abrir como rascunho', desc:'PR em rascunho, mesmo com portão aberto', cmd:'pr', arg:'rascunho' },
    { id:'atualizar', title:'Atualizar PR', desc:'push + corpo do PR com as provas novas', cmd:'pr', arg:'atualizar' } ] };
  if(kind==='skill'){
    const sk=(ctx.skills||[]).filter(s=>s && s.name);
    const on=sk.filter(s=>s.active).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
    const off=sk.filter(s=>!s.active).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
    const desc=(s)=>String(s.description||'').replace(/\s+/g,' ').trim().slice(0,110)||'(sem descrição)';
    const opts=[...on.map(s=>({ id:'sk:'+s.name, title:s.name, desc:desc(s), cmd:'skill', arg:s.name, tag:'do projeto' })),
      ...(ctx.quick||[]).map(q=>({ id:'q:'+q.id, title:'/'+q.label, desc:q.desc||'', text:typeof q.prompt==='function'?q.prompt():String(q.prompt||''), tag:'atalho' })),
      ...off.map(s=>({ id:'sk:'+s.name, title:s.name, desc:desc(s), cmd:'skill', arg:s.name, tag:'desligada no projeto' }))];
    return { kind, title:'Rodar uma skill', sub:ctx.loading?'buscando as skills…':'As skills do projeto (as mesmas do "/" no terminal) e os atalhos do Starfork.', opts, filter:opts.length>8 };
  }
  return null;
}
// opções visíveis com o filtro da folha (skills)
function tiSheetVisible(def, st){
  const q=String((st&&st.q)||'').trim().toLowerCase();
  return (def.opts||[]).map((o,i)=>({ o, i })).filter(x=>!q || (x.o.title+' '+x.o.desc).toLowerCase().includes(q));
}
/** O texto que vai pro terminal com a opção escolhida (st.sel = índice em def.opts, st.title = campo da tarefa nova). */
function tiSheetText(def, st, engineKind){
  const o=def && def.opts[st && st.sel]; if(!o) return '';
  if(o.text!=null) return String(o.text);
  return tiCmdText(engineKind, o.cmd, o.cmd==='tarefa-nova'?(st.title||''):o.arg);
}
function tiSheetHtml(def, st, engineKind){
  const vis=tiSheetVisible(def, st);
  const cur=def.opts[st.sel];
  const txt=tiSheetText(def, st, engineKind);
  const prev=txt ? (txt.length>220?txt.slice(0,220)+'…':txt) : (cur && cur.input ? 'escreva o título acima' : 'escolha uma opção');
  const opts=vis.map((x,k)=>{ const on=x.i===st.sel;
    return `<button type="button" class="tlopt tiopt${on?' sel':''}" role="radio" aria-checked="${on}" data-tiopt="${x.i}" tabindex="${on||(!cur&&!k)?0:-1}"><span class="k">${k<9?k+1:''}</span><span class="tlot"><b>${esc(x.o.title)}${x.o.tag?` <span class="titag">${esc(x.o.tag)}</span>`:''}</b>${x.o.desc?`<small>${esc(x.o.desc)}</small>`:''}</span></button>`+
      (on && x.o.input?`<div class="tiin"><input class="in" data-ti="title" maxlength="120" placeholder="${escA(x.o.input)}" aria-label="${escA(x.o.input)}" value="${escA(st.title||'')}"></div>`:''); }).join('');
  return `<div class="tlsheet tisheet" role="dialog" aria-modal="true" aria-labelledby="tiShT" aria-describedby="tiShP">`+
    `<div class="tlsh"><span class="tlshk">botão = comando no terminal</span><span class="sp"></span><button type="button" class="tlmin tix" data-ti="close" title="fechar (Esc)" aria-label="fechar">${TI_IC.x}</button></div>`+
    `<div class="tlq" id="tiShT">${esc(def.title)}</div><p class="tisub" id="tiShP">${esc(def.sub||'')}</p>`+
    (def.filter?`<div class="tiin tifilter"><input class="in" data-ti="q" placeholder="filtrar skills" aria-label="filtrar skills" value="${escA(st.q||'')}"></div>`:'')+
    `<div class="tlopts" role="radiogroup" aria-labelledby="tiShT">${opts||'<div class="tiempty">nada com esse filtro</div>'}</div>`+
    `<div class="ticmd"><em>vai ser digitado no terminal</em><code>${esc(prev)}</code></div>`+
    `<div class="tlsf"><span class="tlkeys tikeys">↑↓ escolhe · Enter manda · Esc fecha</span><span class="sp"></span>`+
    `<button type="button" class="btn sm" data-ti="close">cancelar</button><button type="button" class="btn sm primary" data-ti="ok"${txt?'':' disabled'}>mandar pro terminal</button></div></div>`;
}
// teclado da folha (puro): ↑↓ andam nas opções visíveis, 1–9 escolhem, Enter manda, Esc fecha
function tiSheetKey(def, st, key, inInput){
  const s={ ...st }; const vis=tiSheetVisible(def, st).map(x=>x.i);
  if(key==='Escape') return { st:s, act:'close' };
  if(key==='Enter') return { st:s, act:'send' };
  if(inInput) return { st:s, act:null, pass:true };
  const at=vis.indexOf(s.sel);
  if(key==='ArrowDown' && vis.length){ s.sel=vis[(at+1+vis.length)%vis.length]; return { st:s, act:null }; }
  if(key==='ArrowUp' && vis.length){ s.sel=at<0 ? vis[vis.length-1] : vis[(at-1+vis.length)%vis.length]; return { st:s, act:null }; }
  if(/^[1-9]$/.test(key) && +key<=vis.length){ s.sel=vis[+key-1]; return { st:s, act:null }; }
  return { st:s, act:null, pass:true };
}
// tipo curto do arquivo (selo do entregável)
function tiKindLabel(name){ const e=(String(name||'').toLowerCase().match(/\.([a-z0-9]+)$/)||[])[1]||'';
  return /^(png|jpe?g|gif|webp|svg)$/.test(e)?'IMG':/^(mp4|m4v|mov|webm)$/.test(e)?'VÍDEO':e==='md'?'MD':e==='pdf'?'PDF':e==='csv'?'CSV':/^html?$/.test(e)?'HTML':/^(txt|log)$/.test(e)?'TXT':e==='json'?'JSON':'ARQ'; }
/** Entregáveis do painel: arquivos (mais novos primeiro, sem o requirements.json) + o combinado no spec. */
function tiDelivList(arts, dels){
  const files=(arts||[]).filter(a=>a && a.name && a.name!=='requirements.json').slice().sort((a,b)=>(+b.created||0)-(+a.created||0));
  return { files, todo:(dels||[]).map(x=>String(x||'').trim()).filter(Boolean) };
}
function tiDelivHtml1(d, o){
  o=o||{}; const max=o.all?d.files.length:8;
  const rows=d.files.slice(0, max).map(a=>`<div class="tidli"><button type="button" class="tilink tidlf" data-tidoc="${escA(a.name)}" title="${escA('abrir '+a.name+' na aba Documento, ao lado do terminal')}"><span class="tidlk">${tiKindLabel(a.name)}</span><span class="tidln">${esc(a.name)}</span></button><button type="button" class="tiapp" data-tiapp="${escA(a.name)}" title="abrir no app padrão do computador" aria-label="${escA('abrir '+a.name+' no app padrão')}">${TI_IC.ext}</button></div>`).join('');
  const more=d.files.length>8?`<button type="button" class="lnk tidlmore" data-tidlall="1">${o.all?'mostrar menos':'mais '+(d.files.length-8)}</button>`:'';
  const empty=!d.files.length?`<div class="tidle">${o.loading?'buscando os arquivos…':'nenhum arquivo ainda — o agente salva em .cardume/artifacts'}</div>`:'';
  const todo=d.todo.length?`<div class="tidlc"><span>combinado</span>${d.todo.slice(0,6).map(x=>`<div>◆ ${esc(x)}</div>`).join('')}</div>`:'';
  return `<section class="tidl" aria-label="Entregáveis"><div class="tidlh">Entregáveis${d.files.length?` <span class="n">${d.files.length}</span>`:''}</div>${rows}${more}${empty}${todo}</section>`;
}
/** A linha da IA no dock. o: { cli ('' = shell sem IA · null = não sei ainda), taskAi, rec:{ai,model,command}, shell (PTY vivo no shell sem IA) } */
function tiAiRowHtml(o){
  const cli=o.cli==null?o.rec.ai:o.cli; const rl=tiAiLabel(o.rec.ai, o.rec.model); // sem terminal vivo: a IA da tarefa (o recomendado)
  const cmd=`<span class="tirecd">ou digite: <code title="${escA(o.rec.command)}">${esc(o.rec.command)}</code></span>`;
  if(o.shell) return `<div class="tiairow shell" role="status"><span class="tishell">a IA parou</span><button type="button" class="btn sm primary" data-ti="rec" title="${escA('roda no terminal: '+o.rec.command)}">Continuar com ${esc(rl)}</button>${cmd}<span class="sp"></span>${tiAiSelHtml('', o.rec)}</div>`;
  const exp=TI_AIS.some(x=>x.id===cli && x.exp) ? `<span class="tiaiexp">sem chips automáticos nem custo — a IA usa os comandos starfork</span>` : '';
  const recBtn=(cli===o.rec.ai) ? '' : `<span class="tireck">recomendado:</span><button type="button" class="btn sm" data-ti="rec" title="${escA('roda no terminal: '+o.rec.command)}">${esc(rl)}</button>`;
  return `<div class="tiairow">${tiAiSelHtml(cli, o.rec)}${recBtn}${exp}<span class="sp"></span><span class="tiaihint">ou digite <code>starfork ia &lt;nome&gt;</code> no terminal</span></div>`;
}
/** Chips da vez pra mostrar: some com a IA no meio de um turno (busy) e depois do clique (usedId). */
function tiChipsFor(evs, usedId, busy){ if(busy) return null; const s=tiSuggest(evs); return (!s || s.id===usedId) ? null : s; }
/**
 * Faixa "Responder" (redesenho F1), COLADA ao terminal e separada da linha de comandos: responder ≠ comandar.
 * o: { chips:{ id, list }|null, busy (IA no meio de um turno), live (PTY vivo), shell (PTY vivo sem IA), rec:{ai,model,command} }
 * shell → "a IA parou · Continuar com <IA · modelo>"; busy → só "Interromper (esc)"; chips → 1·2·3 com o atalho; nada → ''.
 */
function tiReplyHtml(o){
  o=o||{};
  if(o.shell && o.rec) return `<div class="tireply shell" role="status"><span class="tirl">a IA parou</span><button type="button" class="btn sm primary tirecbtn" data-ti="rec" title="${escA('roda no terminal: '+o.rec.command)}">Continuar com ${esc(tiAiLabel(o.rec.ai, o.rec.model))}</button></div>`;
  if(o.busy) return o.live ? `<div class="tireply busy"><span class="tirl">a IA está trabalhando</span><span class="sp"></span><button type="button" class="btn sm tiesc" data-ti="esc" title="manda Esc pro terminal — a IA para o turno e espera você">Interromper <span class="kbd">esc</span></button></div>` : '';
  const c=o.chips; if(!c || !c.list || !c.list.length) return '';
  return `<div class="tireply"><span class="tirl" id="tiReplyL">Responder</span><div class="tichips" role="group" aria-labelledby="tiReplyL">${c.list.map((x,i)=>`<button type="button" class="tichip${i?'':' pri'}" data-tichip="${i}" data-sid="${escA(String(c.id))}" title="${escA('manda pro terminal: '+x)}"${i<3?` aria-keyshortcuts="${i+1}"`:''}><span class="tichx">${esc(x)}</span>${i<3?`<span class="tik" aria-hidden="true">${i+1}</span>`:''}</button>`).join('')}</div></div>`;
}
/** O compositor de texto aparece? o: { pref (localStorage tiComp), tmp (alguém pediu o campo), budget (teto aberto), pend (anexos esperando), draft } */
function tiCompVisible(o){ o=o||{}; return o.pref==='1' || !!o.tmp || !!o.budget || !!(o.pend && o.pend.length) || !!String(o.draft||'').trim(); }
// @ti-puro-fim

// ---------------------------------------------------------------- estado
const TI={ stat:{}, statAt:{}, buf:{}, going:{}, hintAt:{}, used:{}, lastData:{}, sheet:null, skills:null, skillsAt:0, artAt:{}, artSig:{}, artT:{}, evSig:{}, seenAt:{}, compTmp:{}, dlAll:{}, drag:0 };
function tiTask(id){ return (state.tasks||[]).find(x=>x.id===id)||null; }
function tiTaskAi(t){ return typeof aiEngineOf==='function'?aiEngineOf(t&&t.engine):'claude'; }
function tiTaskModel(t){ if(!t) return ''; if(t.model) return t.model; const r=(t.roles||[]).find(x=>x.role==='builder')||(t.roles||[])[0]; return (r&&r.model)||''; }
// motor que vai LER o comando: a IA rodando no terminal (term_status.cli); shell parado → a que o backend vai ligar
// (o recomendado); sem saber → o da tarefa
function tiEngine(t){ const s=t&&TI.stat[t.id]; return String((s && s.cli) || (s && s.recommended && s.recommended.ai) || tiTaskAi(t)); }
function tiRec(t){ const s=TI.stat[t.id]; return tiRecommended(s&&s.recommended, tiTaskAi(t), tiTaskModel(t)); }
function tiAiRow(t){ const s=TI.stat[t.id]; const st=TERM[t.id]; const live=!!(st && st.alive);
  // "shell (sem IA)" só com o PTY VIVO e nada rodando nele; sem terminal vivo o seletor mostra a IA da tarefa
  // shell: o "Continuar com…" mora na faixa Responder (tiReplyHtml) — aqui fica só o seletor, sem repetir o botão
  if(live && s && s.cli==='') return `<div class="tiairow">${tiAiSelHtml('', tiRec(t))}</div>`;
  return tiAiRowHtml({ cli:(live && s && typeof s.cli==='string')?s.cli:null, taskAi:tiTaskAi(t), rec:tiRec(t), shell:false }); }
function tiShellNow(t){ const s=TI.stat[t.id], st=TERM[t.id]; return !!(st && st.alive && s && s.cli===''); }
function tiAiRowReset(t){ const box=$id('tiAiRow'); if(box) box.__html=''; tiAiRowPaint(t); } // o <select> ficou na opção escolhida: volta pro real
// trocar/rodar com a IA no meio de um turno interrompe o trabalho: pergunta antes
async function tiBusyOk(taskId){
  let s=null; try{ s=await invokeQuiet('term_status', { taskId }); if(s) TI.stat[taskId]=s; }catch(_){ }
  if(!s || !s.busy) return true;
  return askYes('A IA está no meio de um turno. Trocar agora interrompe o que ela está fazendo. Trocar mesmo?');
}
/** "Continuar com…"/recomendado: o backend roda o comando recomendado (não fixa a escolha como faria o seletor). */
async function tiRunRec(taskId){
  const t=tiTask(taskId); if(!t) return;
  if(!await tiBusyOk(taskId)) return;
  try{ await invoke('term_run_recommended', { taskId }); }
  catch(e){ showErr(e, 'Não consegui rodar o recomendado no terminal'); tiAiRowReset(t); return; }
  if(typeof termGoLive==='function') termGoLive(taskId);
  setTimeout(()=>tiStatRefresh(t, true), 1500);
  tlFocusTerm(taskId);
}
/** Status do terminal (IA rodando, recomendado): no máx. 1x a cada 2,5s, só da tarefa na tela. */
async function tiStatRefresh(t, force){
  const id=t.id; if(!force && Date.now()-(TI.statAt[id]||0)<2500) return; TI.statAt[id]=Date.now();
  try{ const s=await invokeQuiet('term_status', { taskId:id }); if(s){ TI.stat[id]=s; const t2=tiTask(id); tiAiRowPaint(t2); tiChipsPaint(t2); } }catch(_){ }
}
function tiAiRowPaint(t){ const box=$id('tiAiRow'), dock=$id('tiDock'); if(!t || !box || !dock || dock.dataset.task!==t.id || box.contains(document.activeElement)) return; const h=tiAiRow(t); if(box.__html!==h){ box.__html=h; box.innerHTML=h; } }
/** Troca a IA do terminal (term_switch_ai: o backend fecha a IA/shell e reabre o shell já ligando a escolhida). */
async function tiSwitchAi(taskId, ai, model){
  const t=tiTask(taskId); if(!t) return;
  if(ai==='__cmd'){ tiAiRowReset(t); tlFocusTerm(taskId); termSayLine(taskId, 'digite o comando no terminal — ex.: starfork ia gemini, starfork ia codex, ou qualquer comando do shell', '36'); return; }
  if(!await tiBusyOk(taskId)){ tiAiRowReset(t); return; }
  try{ await invoke('term_switch_ai', { taskId, ai, model:model||null }); }
  catch(e){ showErr(e, 'Não consegui trocar a IA do terminal'); tiAiRowReset(t); return; }
  toast('abrindo '+((TI_AIS.find(x=>x.id===ai)||{}).label||ai)+' no terminal…', 'info');
  if(typeof termGoLive==='function') termGoLive(taskId);
  setTimeout(()=>tiStatRefresh(t, true), 1500);
  tlFocusTerm(taskId);
}
function tiBudgetOpen(t){ return !!t && pendingOf(t.id).some(p=>typeof fwIsBudgetAsk==='function' && fwIsBudgetAsk(p)); }
/** O compositor de texto aparece? (escolha lembrada · teto de custo · algo já esperando nele · alguém pediu o campo) */
function tiCompOn(t){
  if(!t) return true;
  return tiCompVisible({ pref:lsGet('tiComp'), tmp:TI.compTmp[t.id], budget:tiBudgetOpen(t), pend:(typeof fwPend!=='undefined' && fwPend[t.id])||[], draft:(typeof fwDraft!=='undefined' && fwDraft[t.id])||'' });
}
/** Quem precisa do campo de texto (pergunta do plano, trecho da revisão, mudar o rumo): mostra o compositor desta tarefa. */
function tiCompShow(taskId){
  const col=document.querySelector(`[data-tlwrap="${CSS.escape(taskId)}"] .tlcol`);
  if(!col || !col.classList.contains('ti-nocomp')) return;
  TI.compTmp[taskId]=1; if(typeof renderWorkspace==='function') renderWorkspace();
}
function tiResumable(taskId){
  const st=TERM[taskId], t=tiTask(taskId); if(!st || !t) return false;
  return !termHeadless(t); // integrada também retoma (o backend recria a pasta)
}
// um aviso por vez no próprio terminal (não repete a cada tecla)
function tiHint(taskId, text){ const now=Date.now(); if(now-(TI.hintAt[taskId]||0)<4000) return; TI.hintAt[taskId]=now; termSayLine(taskId, text); }
function tiBlockedWhy(taskId){
  const st=TERM[taskId], t=tiTask(taskId);
  if(termHeadless(t)) return 'rodando em segundo plano (modo automático) — use as sugestões e os botões embaixo, ou o compositor: entram na fila';
  return '';
}

// ---------------------------------------------------------------- digitar no histórico = retomar
/** onData do xterm sem PTY vivo (60-terminal): guarda a tecla e abre a sessão; o que foi digitado entra quando ela abrir. */
function tiHistKey(taskId, d){
  const st=TERM[taskId]; if(!st || !tiKeyOpens(d)) return;
  const why=tiBlockedWhy(taskId); if(why){ tiHint(taskId, why); return; }
  TI.buf[taskId]=tiBufPush(TI.buf[taskId], d, TI_MAX_BUF);
  tiGoLive(taskId);
}
/** onData do xterm (60-terminal chama ANTES de tudo): true = guardou na fila da abertura em voo. */
function tiTakeKey(taskId, d){
  const st=TERM[taskId]; if(!st || !d) return false;
  if(tiKeyRoute(!!TI.going[taskId], !!st.alive)!=='buf') return false;
  TI.buf[taskId]=tiBufPush(TI.buf[taskId], d, TI_MAX_BUF); return true;
}
/** Abre (retoma) a sessão no PTY e escreve o que estava guardado depois que o CLI desenhar. */
async function tiGoLive(taskId){
  const st=TERM[taskId]; if(!st) return false;
  if(st.alive){ tiFlush(taskId); return true; }
  if(TI.going[taskId]) return false;
  TI.going[taskId]=1;
  try{
    termSayLine(taskId, 'abrindo a sessão… o que você digitar entra assim que o terminal estiver pronto', '2');
    TI.lastData[taskId]=0;
    await termOpen(taskId);
    if(!st.alive){ delete TI.buf[taskId]; return false; } // termOpen já mostrou o erro
    // o PTY é um SHELL que roda `starfork ia …` antes de a IA desenhar: espera o term_status dizer que a IA subiu
    // (cli) e ~0,7s de silêncio depois disso (máx. ~12s) — antes disso a tecla iria pro shell ou se perderia
    const t0=Date.now(), wait=(ms)=>new Promise(r=>setTimeout(r, ms)); let up=0;
    while(Date.now()-t0<12000){
      if(!up){ try{ const s=await invokeQuiet('term_status', { taskId }); if(s){ TI.stat[taskId]=s; if(s.cli) up=Date.now(); } }catch(_){ } }
      if(up){ const ld=Math.max(TI.lastData[taskId]||0, up); if(Date.now()-ld>700) break; }
      await wait(250);
    }
    if(!up && TI.buf[taskId]) termSayLine(taskId, 'a IA não subiu a tempo — o que você digitou foi pro shell do terminal', '33');
    tiFlush(taskId); // UM term_write com tudo, em ordem; só depois disso as teclas voltam a ir direto pro PTY
    return true;
  }finally{ delete TI.going[taskId]; }
}
function tiFlush(taskId){ const d=TI.buf[taskId]; delete TI.buf[taskId]; if(d) invokeQuiet('term_write',{ taskId, data:d }).catch(()=>{}); }
/** Digita um texto no prompt do terminal (anexo @arquivo): vivo → direto; parado → abre e escreve. */
function tiType(taskId, text){
  const st=TERM[taskId]; if(!st || !text) return;
  if(st.alive){ invokeQuiet('term_write',{ taskId, data:text }).catch(()=>{}); try{ st.term.focus(); }catch(_){ } return; }
  TI.buf[taskId]=tiBufPush(TI.buf[taskId], text, TI_MAX_BUF);
  tiGoLive(taskId);
}
try{ window.__TAURI__.event.listen('term-data', ev=>{ const p=ev&&ev.payload; if(p && p.taskId) TI.lastData[p.taskId]=Date.now(); }); }catch(_){ }

// ---------------------------------------------------------------- o host do xterm: clique, colar e arrastar arquivo
function tiHostWire(taskId, st){
  const host=st.host;
  // clique no histórico (sem selecionar texto) retoma a sessão — o foco já fica no xterm
  st.box.addEventListener('mouseup', (e)=>{
    if(e.button!==0 || st.alive || st.mode!=='hist' || !tiResumable(taskId)) return;
    try{ if(st.term && st.term.hasSelection && st.term.hasSelection()) return; }catch(_){ }
    tiGoLive(taskId);
  });
  // ⌘V com arquivo/print: na CAPTURA, antes do xterm (que colaria o nome como texto); texto puro segue pro xterm
  host.addEventListener('paste', (e)=>{
    const files=[...((e.clipboardData && e.clipboardData.files)||[])]; if(!files.length) return;
    e.preventDefault(); e.stopPropagation();
    tiAttachFiles(taskId, files);
  }, true);
  const drop=document.createElement('div'); drop.className='tidrop'; drop.hidden=true;
  drop.innerHTML='<b>solte pra anexar à conversa</b><small>o agente recebe o arquivo</small>';
  host.appendChild(drop);
  const hasFiles=(e)=>{ const ty=e.dataTransfer && e.dataTransfer.types; return !!ty && [...ty].includes('Files'); };
  host.addEventListener('dragenter', (e)=>{ if(!hasFiles(e)) return; e.preventDefault(); st.tiDrag=(st.tiDrag||0)+1; drop.hidden=false; });
  host.addEventListener('dragover', (e)=>{ if(!hasFiles(e)) return; e.preventDefault(); if(e.dataTransfer) e.dataTransfer.dropEffect='copy'; });
  host.addEventListener('dragleave', ()=>{ if(--st.tiDrag<=0){ st.tiDrag=0; drop.hidden=true; } });
  host.addEventListener('drop', (e)=>{ st.tiDrag=0; drop.hidden=true; const files=[...((e.dataTransfer && e.dataTransfer.files)||[])]; if(!files.length) return; e.preventDefault(); e.stopPropagation(); tiAttachFiles(taskId, files); });
}
async function tiAttachFiles(taskId, files){ if(!tiAttachOk(taskId)) return; tiAttached(taskId, await attImportFiles(files, taskId)); }
async function tiAttachPick(taskId){ if(!tiAttachOk(taskId)) return; tiAttached(taskId, await attPick(taskId)); }
function tiAttachOk(taskId){ return !!taskId; } // integrada também anexa: o backend recria a pasta ao retomar
/** Anexos salvos → @arquivo no prompt. Rodando em segundo plano (sem terminal pra digitar): vão pro compositor. */
function tiAttached(taskId, atts){
  atts=(atts||[]).filter(a=>a && a.rel); if(!atts.length) return;
  const t=tiTask(taskId);
  if(termHeadless(t)){
    (fwPend[taskId]=fwPend[taskId]||[]).push(...atts); TI.compTmp[taskId]=1;
    toast('anexo salvo — vai junto da próxima mensagem do compositor (a tarefa roda em segundo plano)', 'info');
    if(typeof renderWorkspace==='function') renderWorkspace(); return;
  }
  tiType(taskId, atts.map(a=>tiAtRef(a.rel)).join(''));
  toast(atts.length===1?'anexo salvo em '+atts[0].rel+' — entrou como @arquivo no prompt':atts.length+' anexos salvos em .cardume/refs — entraram como @arquivo no prompt', 'ok');
}

// ---------------------------------------------------------------- dock embaixo do terminal
// faixa Responder da tarefa: chips (sugestões do agente), "Interromper" no meio do turno ou "Continuar com…" no shell
function tiChipsHtml(t){
  const st=TI.stat[t.id]; const busy=!!(st && st.busy); const live=!!(TERM[t.id] && TERM[t.id].alive);
  return tiReplyHtml({ chips:tiChipsFor(termEvents(t.id), TI.used[t.id], busy), busy, live, shell:tiShellNow(t), rec:tiRec(t) });
}
// redesenho F1: [faixa Responder colada ao terminal] + [linha de comandos: IA ▾ · Anexar · ✎ | Etapa · Skills · Tarefa ·
// Revisão / PR · "botão só digita o comando"]. O compositor virou ícone (✎) — sem o rótulo "compositor" solto.
function tiDockHtml(t){
  const comp=tiCompOn(t);
  const act=(k, label)=>`<button type="button" class="tiact" data-tisheet="${k}" aria-haspopup="dialog">${TI_IC[k]}<span>${esc(label)}</span></button>`;
  return `<div class="tidock" id="tiDock" data-task="${escA(t.id)}"><div id="tiChips">${tiChipsHtml(t)}</div>`+
    `<div class="tiacts"><div id="tiAiRow" class="tiaipick">${tiAiRow(t)}</div><button type="button" class="tiact ticlip" data-ti="att" title="anexar print, PDF ou arquivo — ou arraste/cole (⌘V) no terminal">${TI_IC.clip}<span>Anexar</span></button>`+
    `<button type="button" class="tiact ticomp" data-ti="comp" aria-pressed="${comp}" aria-label="${comp?'esconder o compositor de texto':'mostrar o compositor de texto'}" title="${comp?'esconder o compositor de texto':'escrever num compositor de texto (anexos, vira requisito, IA da tarefa)'}"><span aria-hidden="true">✎</span></button><span class="tisep" aria-hidden="true"></span>`+
    act('etapa','Etapa')+act('skill','Skills')+act('tarefa','Tarefa')+act('pr','Revisão / PR')+
    `<span class="sp"></span><span class="tihint">botão só digita o comando</span></div></div>`;
}
/** Depois do render (tlWire): liga o dock, devolve a folha aberta e põe o foco no terminal quando a tarefa abre. */
function tiWire(t){
  const dock=$id('tiDock'); if(dock){ dock.__chips=tiChipsHtml(t); dock.onclick=(e)=>tiDockClick(t.id, e); dock.onkeydown=(e)=>tiReplyKey(t.id, e);
    const row=$id('tiAiRow'); if(row) row.__html=tiAiRow(t);
    dock.onchange=(e)=>{ const sel=e.target.closest('[data-ti="ai"]'); if(!sel) return; const ai=sel.value; sel.blur(); const r=tiRec(t); tiSwitchAi(t.id, ai, ai===r.ai?r.model:null); };
    if(TI.stat[t.id]===undefined) tiStatRefresh(t, true); }
  const col=document.querySelector(`[data-tlwrap="${CSS.escape(t.id)}"] .tlcol`);
  if(TI.sheet && TI.sheet.taskId===t.id && col){ const el=TI.sheet.el; if(el.parentNode!==col){ const back=!document.activeElement || document.activeElement===document.body; col.appendChild(el); if(back) tiSheetFocus(); } }
  // tarefa ABRIU (não foi só um repintar): o foco vai pro terminal — dá pra digitar de cara
  const now=Date.now(), fresh=now-(TI.seenAt[t.id]||0)>2500; TI.seenAt[t.id]=now;
  // (de novo depois de um respiro: no 1º render a tela da tarefa ainda pode estar escondida e o foco não pega)
  if(fresh && !TI.sheet && !pendingOf(t.id).length){ const ae=document.activeElement; if(!ae || ae===document.body) [0, 350].forEach(ms=>setTimeout(()=>{ const a2=document.activeElement; if((!a2 || a2===document.body) && !TI.sheet) tlFocusTerm(t.id); }, ms)); }
}
function tiDockClick(taskId, e){
  const c=e.target.closest('[data-tichip]'); if(c){ tiChip(taskId, c); return; }
  const s=e.target.closest('[data-tisheet]'); if(s){ tiSheetOpen(taskId, s.dataset.tisheet, s); return; }
  const b=e.target.closest('[data-ti]'); if(!b) return;
  if(b.dataset.ti==='att'){ tiAttachPick(taskId); return; }
  if(b.dataset.ti==='rec'){ tiRunRec(taskId); return; }
  if(b.dataset.ti==='esc'){ tiInterrupt(taskId); return; }
  if(b.dataset.ti==='comp'){ const t=tiTask(taskId); const on=!tiCompOn(t); lsSet('tiComp', on?'1':'0'); if(!on) delete TI.compTmp[taskId];
    if(typeof renderWorkspace==='function') renderWorkspace();
    if(on){ const i=$id('fwInput'); if(i) i.focus(); } else tlFocusTerm(taskId); }
}
/** "Interromper (esc)": o MESMO Esc que você apertaria no terminal (o CLI para o turno e espera) — só com o PTY vivo. */
function tiInterrupt(taskId){
  const st=TERM[taskId]; if(!st || !st.alive){ toast('o terminal não está aberto — nada pra interromper aqui', 'info'); return; }
  invokeQuiet('term_write', { taskId, data:'\x1b' }).catch(()=>{});
  tlFocusTerm(taskId);
  setTimeout(()=>{ const t=tiTask(taskId); if(t) tiStatRefresh(t, true); }, 900);
}
// atalho 1–3 SÓ com o foco na faixa Responder (no terminal e na linha de comandos o número não é dela)
function tiReplyKey(taskId, e){
  if(e.metaKey||e.ctrlKey||e.altKey || !/^[1-3]$/.test(e.key) || !e.target.closest('.tireply')) return;
  const b=document.querySelector(`#tiDock[data-task="${CSS.escape(taskId)}"] [data-tichip="${+e.key-1}"]`); if(!b) return;
  e.preventDefault(); b.click();
}
async function tiChip(taskId, btn){
  const s=tiSuggest(termEvents(taskId)); const i=+btn.dataset.tichip; if(!s || String(s.id)!==btn.dataset.sid || !s.list[i]) return;
  TI.used[taskId]=s.id; tiChipsPaint(tiTask(taskId));
  const ok=await tiSend(taskId, s.list[i]);
  if(!ok){ delete TI.used[taskId]; tiChipsPaint(tiTask(taskId)); }
}
function tiChipsPaint(t){ const box=$id('tiChips'), dock=$id('tiDock'); if(!t || !box || !dock || dock.dataset.task!==t.id) return; const h=tiChipsHtml(t); if(dock.__chips!==h){ const had=dock.__chips; dock.__chips=h; box.innerHTML=h;
  // F3: respostas NOVAS depois de um turno entram com mola (a dock recém-montada e o poll igual não animam)
  if(had!=null && typeof springIn==='function'){ const sid=(x)=>{ const m=String(x||'').match(/data-sid="([^"]*)"/); return m?m[1]:''; }; if(sid(h) && sid(h)!==sid(had)) springIn(box.querySelectorAll('.tichip')); } } }
/**
 * Manda um texto pro terminal (chip, comando de botão). Vivo/retomável: term_send (entra na fila se ele estiver no meio
 * de um turno; sem PTY, abre a sessão já com o texto). Rodando em segundo plano: o mesmo caminho do compositor (talk_task).
 */
async function tiSend(taskId, text){
  const t=tiTask(taskId); if(!t || !String(text||'').trim()) return false;
  const st=TERM[taskId];
  if(tiBudgetOpen(t)){ toast('a tarefa está pausada no teto de custo — decida no cartão do teto primeiro', 'warn'); return false; }
  if(termHeadless(t) || (st && !st.alive && st.hinfo && st.hinfo.resumes===false)) return (typeof fwSendText==='function') ? fwSendText(taskId, text) : false;
  const live=!!(st && st.alive), busy=!!(t.busy || ACTIVE_ST.has(t.status) || t.status==='thinking' || pendingOf(taskId).length);
  try{ await invoke('term_send', { taskId, text, mode:'queue' }); }
  catch(e){ showErr(e, 'Não consegui mandar pro terminal'); return false; }
  if(live && busy) toast('na fila — o agente lê assim que terminar o turno', 'info');
  else if(!live){ toast('retomando a sessão no terminal com o pedido…', 'info'); if(typeof termGoLive==='function') termGoLive(taskId); }
  lastSig=''; refresh().catch(()=>{});
  tlFocusTerm(taskId);
  return true;
}

// ---------------------------------------------------------------- folhas dos botões (botão → comando no terminal)
async function tiSkillsLoad(){
  if(TI.skills && Date.now()-TI.skillsAt<60000) return TI.skills;
  try{ TI.skills=(await invokeQuiet('list_skills'))||[]; TI.skillsAt=Date.now(); }catch(_){ TI.skills=TI.skills||[]; }
  return TI.skills;
}
function tiSheetCtx(){ return { skills:TI.skills||[], quick:typeof CHAT_SKILLS!=='undefined'?CHAT_SKILLS:[], loading:!TI.skills }; }
function tiSheetOpen(taskId, kind, opener){
  const col=document.querySelector(`[data-tlwrap="${CSS.escape(taskId)}"] .tlcol`); if(!col) return;
  tiSheetClose(false);
  const def=tiSheetDef(kind, tiSheetCtx()); if(!def) return;
  const el=document.createElement('div'); el.className='tisheethost';
  TI.sheet={ taskId, kind, def, st:{ sel:def.opts.length?0:-1, title:'', q:'' }, el, opener, last:'opt' };
  el.innerHTML='<div class="tiscrim" data-ti="close"></div><div class="tisheetbox"></div>';
  col.appendChild(el); tiSheetWire(el);
  tiSheetPaint(); tiSheetFocus();
  if(typeof mvFromOrigin==='function'){ mvFromOrigin(el.querySelector('.tisheetbox'), opener); mvAnim(el.querySelector('.tiscrim'), [{ opacity:0 }, { opacity:1 }], { duration:180 }); } // F3: a folha nasce do botão
  if(kind==='skill' && (!TI.skills || Date.now()-TI.skillsAt>=60000)) tiSkillsLoad().then(()=>{ const s=TI.sheet; if(!s || s.kind!=='skill' || s.el!==el) return; s.def=tiSheetDef('skill', tiSheetCtx()); if(s.st.sel<0 && s.def.opts.length) s.st.sel=0; tiSheetPaint(); tiSheetFocus(); });
}
function tiSheetPaint(){
  const s=TI.sheet; if(!s) return; const t=tiTask(s.taskId);
  const box=s.el.querySelector('.tisheetbox'); const h=tiSheetHtml(s.def, s.st, tiEngine(t));
  if(box.__html!==h){ box.__html=h; box.innerHTML=h; }
}
// foco: volta onde estava (campo do título/filtro ou a opção escolhida)
function tiSheetFocus(){
  const s=TI.sheet; if(!s) return;
  requestAnimationFrame(()=>{ if(!TI.sheet || TI.sheet!==s) return; const box=s.el;
    const pick=s.last==='title'?box.querySelector('[data-ti="title"]'):s.last==='q'?box.querySelector('[data-ti="q"]'):null;
    const el=pick||box.querySelector('.tiopt.sel')||box.querySelector('[data-ti="q"]')||box.querySelector('.tiopt')||box.querySelector('[data-ti="close"]');
    if(el){ el.focus({ preventScroll:true }); if(el.tagName==='INPUT') try{ el.setSelectionRange(el.value.length, el.value.length); }catch(_){ } } });
}
function tiSheetClose(back){
  const s=TI.sheet; if(!s) return; TI.sheet=null; s.el.remove();
  if(back!==false){ if(s.opener && s.opener.isConnected) s.opener.focus(); else tlFocusTerm(s.taskId); }
}
async function tiSheetSend(){
  const s=TI.sheet; if(!s) return; const t=tiTask(s.taskId);
  const txt=tiSheetText(s.def, s.st, tiEngine(t));
  if(!txt){ const o=s.def.opts[s.st.sel]; if(o && o.input){ s.last='title'; tiSheetFocus(); toast('escreva o título da tarefa nova', 'info'); } return; }
  const taskId=s.taskId; tiSheetClose(false);
  await tiSend(taskId, txt);
}
function tiSheetWire(el){
  el.addEventListener('click', (e)=>{
    const s=TI.sheet; if(!s || s.el!==el) return;
    const o=e.target.closest('[data-tiopt]'); if(o){ s.st.sel=+o.dataset.tiopt; s.last=s.def.opts[s.st.sel]&&s.def.opts[s.st.sel].input?'title':'opt'; tiSheetPaint(); tiSheetFocus(); return; }
    const b=e.target.closest('[data-ti]'); if(!b) return;
    if(b.dataset.ti==='close') tiSheetClose();
    else if(b.dataset.ti==='ok') tiSheetSend();
  });
  el.addEventListener('input', (e)=>{
    const s=TI.sheet; if(!s || s.el!==el) return; const i=e.target.closest('[data-ti]'); if(!i) return;
    if(i.dataset.ti==='title'){ s.st.title=i.value; s.last='title'; }
    else if(i.dataset.ti==='q'){ s.st.q=i.value; s.last='q'; const vis=tiSheetVisible(s.def, s.st).map(x=>x.i); if(vis.length && !vis.includes(s.st.sel)) s.st.sel=vis[0]; }
    tiSheetPaint(); tiSheetFocus();
  });
  el.addEventListener('keydown', (e)=>{
    const s=TI.sheet; if(!s || s.el!==el) return;
    if(e.key==='Tab'){ // foco preso na folha
      const f=[...el.querySelectorAll('button:not([disabled]),input')].filter(x=>x.offsetParent!==null && x.tabIndex!==-1); if(!f.length) return;
      const i=f.indexOf(document.activeElement);
      if(e.shiftKey && i<=0){ e.preventDefault(); f[f.length-1].focus(); } else if(!e.shiftKey && i===f.length-1){ e.preventDefault(); f[0].focus(); }
      return; }
    if(e.metaKey||e.ctrlKey||e.altKey) return;
    if(e.key==='Enter' && e.target.closest('button[data-ti]')) return; // Enter em cancelar/fechar é o clique dele
    const inInput=!!e.target.closest('input');
    const r=tiSheetKey(s.def, s.st, e.key, inInput); if(r.pass) return;
    e.preventDefault(); e.stopPropagation();
    if(r.act==='close'){ tiSheetClose(); return; }
    if(r.act==='send'){ tiSheetSend(); return; }
    s.st=r.st; const o=s.def.opts[s.st.sel]; s.last=o&&o.input?'title':(inInput?s.last:'opt'); tiSheetPaint(); tiSheetFocus();
  });
}

// ---------------------------------------------------------------- provas e entregáveis viram link
/** Linha de baixo do requisito no painel: os nomes das provas abrem na aba Documento. */
function tiProofSubHtml(t, v){
  const ev=Array.isArray(v.ev)?v.ev:[];
  if(v.ck!=='ok' || !ev.length) return esc(v.sub);
  const arts=(artifactsCache[t.id] && artifactsCache[t.id].list)||null;
  const one=(e)=>{ const label=String(e).split('/').pop(); const n=(arts && typeof enEvResolve==='function')?enEvResolve(t.id, e, arts):null;
    return n?`<button type="button" class="tilink" data-tidoc="${escA(n)}" title="${escA('abrir '+n+' na aba Documento')}">${esc(label)}</button>`:esc(label); };
  return 'prova: '+ev.slice(0,3).map(one).join(' · ')+(ev.length>3?' +'+(ev.length-3):'');
}
function tiDelivHtml(t){
  const c=artifactsCache[t.id];
  if(c===undefined) tiArtsRefresh(t, true);
  return tiDelivHtml1(tiDelivList(c && c.list, t.deliverables), { all:!!TI.dlAll[t.id], loading:c===undefined });
}
// lista de arquivos da tarefa: relida quando os eventos mudam (o agente salvou uma prova), no máx. 1x a cada 4s — só o painel repinta
function tiArtsRefresh(t, now){
  const id=t.id; if(TI.artT[id]) return;
  const wait=now?0:Math.max(0, 4000-(Date.now()-(TI.artAt[id]||0)));
  TI.artT[id]=setTimeout(async()=>{
    TI.artAt[id]=Date.now();
    try{
      const list=(await invokeQuiet('list_artifacts', { taskId:id }))||[];
      const sig=list.map(a=>a.name+':'+(a.size||0)+':'+(a.created||0)).join('|');
      const cur=tiTask(id);
      if(sig!==TI.artSig[id] || artifactsCache[id]===undefined){ TI.artSig[id]=sig; artifactsCache[id]={ status:cur?cur.status:'', list }; if(cur && typeof fwTask!=='undefined' && fwTask===id) tlSidePaint(cur, true); }
    }catch(_){ }
    finally{ delete TI.artT[id]; }
  }, wait);
}
/** Clique no painel lateral (60-terminal-layout chama antes do dele). true = era nosso. */
function tiSideClick(taskId, e){
  const d=e.target.closest('[data-tidoc]'); if(d){ tiOpenDoc(taskId, d.dataset.tidoc); return true; }
  const a=e.target.closest('[data-tiapp]'); if(a){ tiOpenApp(taskId, a.dataset.tiapp); return true; }
  const m=e.target.closest('[data-tidlall]'); if(m){ TI.dlAll[taskId]=!TI.dlAll[taskId]; const t=tiTask(taskId); if(t) tlSidePaint(t, true); return true; }
  return false;
}
/** Abre o arquivo entregue na aba Documento, DIVIDINDO a tela com a tarefa (no painel do canvas, quem abre é a janela de cima). */
function tiOpenDoc(taskId, name){
  let top=null; try{ top=(typeof SF_PANE!=='undefined' && SF_PANE && window.parent && window.parent.cvOpenTop) ? window.parent.cvOpenTop : null; }catch(_){ }
  if(!top && typeof cvOpenTop==='function') top=cvOpenTop;
  if(top) top({ kind:'doc', taskId, ref:'art:'+name }, { split:'right' });
  else if(typeof openArtifact==='function') openArtifact(taskId, name);
}
function tiOpenApp(taskId, name){ invoke('open_artifact', { taskId, name }).catch(e=>showErr(e, 'Não consegui abrir no app padrão')); }

/** Poll (tlLivePaint): chips e, se chegou evento novo, a lista de entregáveis. */
function tiLivePaint(t){
  TI.seenAt[t.id]=Date.now();
  tiChipsPaint(t);
  tiStatRefresh(t, false); tiAiRowPaint(t);
  const evs=termEvents(t.id); const sig=evs.length+':'+(evs.length?evs[evs.length-1].id:0);
  if(TI.evSig[t.id]!==sig){ const first=TI.evSig[t.id]===undefined; TI.evSig[t.id]=sig; if(!first) tiArtsRefresh(t, false); }
  if(TI.sheet && TI.sheet.taskId===t.id && !TI.sheet.el.isConnected) tiSheetClose(false); // a tarefa saiu da tela
}
