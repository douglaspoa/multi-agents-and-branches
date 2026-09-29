/* ===== MESA DE PERSONAS (party mode) — decidir "o que construir a seguir" com uma mesa de vozes =====
   Aba "mesa": o usuário escreve o tema; personas independentes (uma chamada ao claude cada, com o cérebro
   do projeto) passam por RODADA 1 (posição + propostas, sem ver as outras) e RODADA 2 (debate + voto:
   top 5 com peso 5→1 e vetos). A apuração é uma função pura (mesaTally) e a decisão sai da tabela +
   as escolhas do usuário (mesaDecision) — nunca de uma persona sozinha. Argumentar com a mesa abre uma
   rodada de revoto; com uma persona, só ela responde. Aprovadas viram demandas (épico ou tarefas) e uma
   nota "decisão" no cérebro. A discussão inteira mora só local: .cardume/mesas/<id>.json (mesa.rs). */

// @puro-inicio — funções sem DOM (testadas em app/tests/mesa.test.mjs)
const MESA_MODEL='claude-sonnet-5';
const MESA_TURN=0.4; // uma fala de persona ≈ 40% de um agente de tarefa na régua do roughEstimate (medido: ~US$ 0,14 por fala com Sonnet lendo o repo)
const MESA_MAX_CANDS=15;
// as 5 vozes da mesa de 27/09 (docs/ux-auditoria/party-mode-decisao.md), em versão que serve pra qualquer projeto
const MESA_PERSONAS=[
  { id:'bia', nome:'Bia', papel:'vibe coder', desc:'Designer que constrói com IA sem saber programar (ex.: o app de agendamento do pilates da irmã). Quer ver resultado rápido, sem jargão, terminal ou configuração. Julga tudo por "eu conseguiria usar isso sozinha hoje?".' },
  { id:'rafa', nome:'Rafa', papel:'tech lead', desc:'Tech lead de um squad numa fintech. Pensa em entrega confiável: diff antes de merge, testes, revisão, custo de manutenção. Desconfia de mágica que esconde o que a IA fez.' },
  { id:'carla', nome:'Carla', papel:'operações e marketing', desc:'Toca projetos que NÃO são software: campanhas, documentos, pesquisas, processos. Quer entregáveis (PDF, planilha, texto) e não quer ouvir falar de branch, PR ou GitHub.' },
  { id:'marcos', nome:'Marcos', papel:'estratégia de produto', desc:'Olha ativação, retenção e receita. Pergunta sempre: isso leva a pessoa ao primeiro valor mais rápido? Alguém pagaria por isso? Corta o que é bonito mas não move número.' },
  { id:'julia', nome:'Júlia', papel:'a cética', desc:'Cuida da confiabilidade num time de 1 dev + IA. Prefere pouca coisa funcionando de verdade a muita coisa pela metade. Aponta riscos, custo escondido e o que vai quebrar.' },
];
function mesaFold(s){ return String(s==null?'':s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function mesaPersonaSys(p){
  return `Você é ${p.nome}, ${p.papel}. ${p.desc}\n\nVocê está numa MESA DE DECISÃO com outras personas (cada uma responde separada, sem ver o raciocínio das outras). Defenda a SUA perspectiva com franqueza — discordar é útil, concordar por educação não. Seja concreto e curto, na primeira pessoa.`;
}
// JSON dentro de ```json … ```, ou o primeiro {…} cercado de texto
function mesaParseJson(text){
  const src=String(text==null?'':text), tries=[];
  const f=src.match(/```(?:json)?\s*([\s\S]*?)```/i); if(f) tries.push(f[1]);
  const i=src.indexOf('{'), j=src.lastIndexOf('}'); if(i>=0 && j>i) tries.push(src.slice(i,j+1));
  for(const t of tries){ try{ const o=JSON.parse(t.trim()); if(o && typeof o==='object' && !Array.isArray(o)) return o; }catch(_){ } }
  return null;
}
// ---- D1: gerar personas pra este projeto ----
const MESA_GEN_SYS='Você é o facilitador de uma mesa de decisão. Monta personas que representam quem de fato usa, paga, opera ou sofre com ESTE projeto — não personas genéricas de software.';
function mesaGenPrompt(tema){
  return `Tema da mesa: "${tema||'o que construir a seguir neste projeto'}"\n\nProponha de 3 a 5 personas pra discutir esse tema NESTE projeto. Use o cérebro e o resumo do projeto (ex.: o dono do negócio, o cliente final, quem opera no dia a dia, quem paga). Misture perspectivas que discordam entre si; se o projeto não é só software, inclua quem não programa.\n\nResponda SOMENTE com um bloco \`\`\`json no formato {"personas":[{"nome":"primeiro nome","papel":"até 5 palavras","desc":"2-3 frases: quem é, o que quer, do que desconfia"}]}`;
}
function mesaParsePersonas(text, taken){
  const o=mesaParseJson(text); const arr=o&&Array.isArray(o.personas)?o.personas:[];
  const used=new Set(taken||[]), out=[];
  for(const x of arr){
    if(!x||typeof x!=='object') continue;
    const nome=String(x.nome||x.name||'').trim().slice(0,30), desc=String(x.desc||x.descricao||'').trim().slice(0,500);
    if(!nome||!desc) continue;
    let id='g-'+(mesaFold(nome).replace(/ /g,'-')||'persona'), k=2; while(used.has(id)) id=id.replace(/-\d+$/,'')+'-'+(k++);
    used.add(id); out.push({ id, nome, papel:String(x.papel||x.role||'persona').trim().slice(0,60), desc, gerada:true });
    if(out.length>=5) break;
  }
  return out;
}
// ---- prompts das rodadas ----
const MESA_JSON_VOTO='{"fala":"sua reação ao debate em 1-2 parágrafos curtos","top5":[{"id":"F1","peso":5,"porque":"..."}],"vetos":[{"id":"F2","motivo":"..."},{"texto":"princípio que não pode entrar","motivo":"..."}]}';
const MESA_RETRY='\n\nATENÇÃO: a sua resposta anterior não veio no JSON pedido. Responda SOMENTE com o bloco ```json no formato pedido, nada fora dele.';
function mesaR1Prompt(tema){
  return `Tema da mesa: "${tema}"\n\nRODADA 1 — a sua posição. Sem ver as outras personas, diga o que acha que deve ser feito sobre esse tema neste projeto, do seu ponto de vista, e proponha de 2 a 4 features ou mudanças concretas.\n\nResponda SOMENTE com um bloco \`\`\`json no formato {"posicao":"sua posição em 1 a 3 parágrafos curtos (markdown)","propostas":[{"titulo":"nome curto (até 70 caracteres)","descricao":"o que é, em 1-2 frases","porque":"por que importa pra você"}]}`;
}
function mesaCandsText(cands){ return (cands||[]).map(c=>`${c.id} — ${c.titulo}${c.descricao?': '+c.descricao:''}${c.autores&&c.autores.length?' (proposta por '+c.autores.join(', ')+')':''}`).join('\n'); }
function mesaVoteAsk(cands){
  const n=Math.min(5,(cands||[]).length);
  return `VOTE: escolha as ${n} features que devem entrar (peso ${n===5?'5 = a mais importante, depois 4, 3, 2, 1':'de '+n+' (a mais importante) até 1'} — cada peso uma vez só) e vete o que NÃO pode entrar agora (por id, ou um princípio em texto livre), sempre com motivo. Vetos pode ficar vazio.\n\nResponda SOMENTE com um bloco \`\`\`json no formato ${MESA_JSON_VOTO}`;
}
function mesaR2Prompt(tema, personas, r1, cands){
  const pos=(personas||[]).map(p=>{ const r=r1&&r1[p.id]; return `### ${p.nome} (${p.papel})\n${r&&r.st==='ok'&&r.texto?r.texto:'(não respondeu)'}`; }).join('\n\n');
  return `Tema da mesa: "${tema}"\n\nRODADA 2 — debate e voto. Estas foram as posições da rodada 1 (cada persona respondeu sem ver as outras):\n\n${pos}\n\nFeatures em votação:\n${mesaCandsText(cands)}\n\nReaja às outras posições (cite nomes, concorde ou discorde) e depois ${mesaVoteAsk(cands)}`;
}
function mesaVoteLine(v, cands){
  if(!v) return 'sem voto válido';
  const t=id=>{ const c=(cands||[]).find(x=>x.id===id); return c?c.titulo:id; };
  return 'votos: '+v.top.map(x=>`${x.id} ${t(x.id)} (${x.peso})`).join(', ')+((v.vetos||[]).length?' · vetos: '+v.vetos.map(x=>x.id?x.id+' '+t(x.id):x.texto).join(', '):'');
}
function mesaArgPrompt(tema, personas, prev, cands, tally, argumento){
  const falas=(personas||[]).map(p=>{ const r=prev&&prev[p.id]; return `### ${p.nome} (${p.papel})\n${r&&r.texto?r.texto:'(não respondeu)'}\n${mesaVoteLine(r&&r.voto, cands)}`; }).join('\n\n');
  const ap=(tally&&tally.rows||[]).filter(r=>r.total>0).map(r=>`${r.id} ${r.titulo}: ${r.total} pts${r.vetadoPor.length?' (vetada)':''}`).join('\n');
  return `Tema da mesa: "${tema}"\n\nREVOTO — a pessoa dona do projeto trouxe um argumento novo pra mesa:\n> ${String(argumento||'').replace(/\n/g,'\n> ')}\n\nComo a mesa estava na última rodada:\n\n${falas}\n\nApuração até aqui:\n${ap||'(nenhum voto válido)'}\n\nFeatures em votação:\n${mesaCandsText(cands)}\n\nLeve o argumento a sério — ele pode mudar ou não o seu voto; diga por quê na fala. Depois ${mesaVoteAsk(cands)}`;
}
function mesaAskPrompt(tema, persona, hist, pergunta){
  const h=hist||{}, chat=(h.chat||[]).slice(-10).map(x=>(x.who==='you'?'Dono do projeto: ':persona.nome+': ')+x.text).join('\n');
  return `Tema da mesa: "${tema}"\n\nO seu histórico nesta mesa:\n- Sua posição (rodada 1): ${h.posicao||'(não respondeu)'}\n- Seu último voto: ${mesaVoteLine(h.voto, h.cands)}${h.fala?'\n- Sua última fala: '+h.fala:''}${chat?'\n\nA conversa até aqui:\n'+chat:''}\n\nO dono do projeto pergunta pra você (só pra você, não pra mesa):\n"${pergunta}"\n\nResponda só como ${persona.nome}, direto, em até 2 parágrafos curtos. Se mudou de ideia, diga.`;
}
// propostas da rodada 1 → lista numerada F1..Fn (mesmo título, sem acento/caixa, vira uma só com os dois autores)
function mesaCandidates(personas, resp){
  const out=[], byKey={};
  for(const p of personas||[]){
    const r=resp&&resp[p.id]; if(!r||r.st!=='ok'||!Array.isArray(r.propostas)) continue;
    for(const x of r.propostas.slice(0,6)){
      const titulo=String(x&&x.titulo||'').trim().slice(0,90), k=mesaFold(titulo); if(!k) continue;
      if(byKey[k]){ if(!byKey[k].autores.includes(p.nome)) byKey[k].autores.push(p.nome); continue; }
      if(out.length>=MESA_MAX_CANDS) continue;
      const c={ id:'F'+(out.length+1), titulo, descricao:String(x.descricao||'').trim().slice(0,400), autores:[p.nome] };
      out.push(c); byKey[k]=c;
    }
  }
  return out;
}
function mesaParsePosition(text){
  const o=mesaParseJson(text);
  if(!o) return { texto:String(text||'').trim(), propostas:[], aviso:'resposta sem JSON — as propostas desta persona ficaram de fora da votação' };
  const propostas=(Array.isArray(o.propostas)?o.propostas:[]).filter(x=>x&&typeof x==='object'&&String(x.titulo||'').trim())
    .map(x=>({ titulo:String(x.titulo).trim().slice(0,90), descricao:String(x.descricao||'').trim().slice(0,400), porque:String(x.porque||'').trim().slice(0,400) })).slice(0,6);
  return { texto:String(o.posicao||'').trim()||String(text||'').trim(), propostas, aviso:propostas.length?'':'nenhuma proposta válida' };
}
// voto de UMA persona: aceita JSON cercado de texto; descarta item inválido com aviso; sem nenhum voto válido → ok:false
function mesaParseVote(text, candIds){
  const o=mesaParseJson(text); if(!o) return { ok:false, erro:'a resposta não trouxe JSON', warns:[] };
  const ids=new Set((candIds||[]).map(String)), warns=[];
  const normId=v=>String(v==null?'':v).trim().toUpperCase().replace(/^F?\s*(\d+)$/,'F$1');
  const src=Array.isArray(o.top5)?o.top5:Array.isArray(o.top)?o.top:Array.isArray(o.votos)?o.votos:null;
  if(!src) return { ok:false, erro:'o JSON não tem a lista top5', warns };
  const top=[], usedId=new Set(), usedPeso=new Set();
  for(const x of src){
    if(!x||typeof x!=='object'){ warns.push('item de voto inválido ignorado'); continue; }
    const id=normId(x.id!=null?x.id:x.feature), peso=Number(x.peso!=null?x.peso:x.weight);
    if(!ids.has(id)){ warns.push('voto em feature desconhecida ('+(id||'sem id')+') ignorado'); continue; }
    if(!Number.isInteger(peso)||peso<1||peso>5){ warns.push('peso inválido em '+id+' ignorado'); continue; }
    if(usedId.has(id)){ warns.push(id+' votada duas vezes — valeu a primeira'); continue; }
    if(usedPeso.has(peso)){ warns.push('peso '+peso+' repetido ('+id+') ignorado'); continue; }
    if(top.length>=5){ warns.push('mais de 5 votos — o excedente foi ignorado'); break; }
    usedId.add(id); usedPeso.add(peso); top.push({ id, peso, porque:String(x.porque||x.motivo||'').trim().slice(0,400) });
  }
  if(!top.length) return { ok:false, erro:'nenhum voto válido', warns };
  top.sort((a,b)=>b.peso-a.peso);
  const vetos=[];
  for(const x of (Array.isArray(o.vetos)?o.vetos:[])){
    if(typeof x==='string'){ if(x.trim()) vetos.push({ texto:x.trim().slice(0,200), motivo:'' }); continue; }
    if(!x||typeof x!=='object') continue;
    const motivo=String(x.motivo||x.porque||'').trim().slice(0,400), id=(x.id!=null&&x.id!=='')?normId(x.id):'';
    if(id && ids.has(id)){
      if(usedId.has(id)){ warns.push('vetou '+id+' e votou nela — o veto foi ignorado'); continue; }
      if(!vetos.some(v=>v.id===id)) vetos.push({ id, motivo }); continue; }
    const texto=String(x.texto||x.feature||x.principio||'').trim();
    if(texto) vetos.push({ texto:texto.slice(0,200), motivo }); else if(id) warns.push('veto em feature desconhecida ('+id+') ignorado');
  }
  return { ok:true, vote:{ fala:String(o.fala||o.debate||o.posicao||'').trim(), top, vetos }, warns };
}
// apuração: soma dos pesos, quem vetou, empate e "votada por todos" (entre as personas com voto válido)
function mesaTally(cands, votes, personas){
  votes=votes||{}; const pres=[], aus=[];
  for(const p of personas||[]) (votes[p.id]&&Array.isArray(votes[p.id].top)?pres:aus).push(p.id);
  const rows=(cands||[]).map((c,i)=>({ id:c.id, titulo:c.titulo, ord:i, total:0, pesos:{}, votos:0, vetadoPor:[], todos:false, empate:false, pos:0 }));
  const by={}; rows.forEach(r=>{ by[r.id]=r; });
  const livres=[];
  for(const pid of pres){
    const v=votes[pid];
    for(const t of v.top){ const r=by[t.id]; if(!r||r.pesos[pid]) continue; r.pesos[pid]=t.peso; r.total+=t.peso; r.votos++; }
    for(const x of v.vetos||[]){
      if(x.id && by[x.id]){ if(!by[x.id].vetadoPor.includes(pid)) by[x.id].vetadoPor.push(pid); }
      else if(x.texto) livres.push({ pid, texto:x.texto, motivo:x.motivo||'' });
    }
  }
  rows.forEach(r=>{ r.todos=pres.length>1 && r.votos===pres.length; });
  rows.sort((a,b)=>b.total-a.total||b.votos-a.votos||a.ord-b.ord);
  rows.forEach((r,i)=>{ r.pos=i+1; r.empate=r.total>0 && rows.some(o=>o!==r && o.total===r.total); });
  return { rows, presentes:pres, ausentes:aus, vetosLivres:livres };
}
// decisão = apuração + escolhas do usuário. Sugeridas: as `max` mais votadas sem veto (empate no corte entra junto)
// + a votada por todos. A escolha do usuário (aprovada/rejeitada) sempre vence a sugestão.
function mesaDecision(tally, escolhas, max){
  max=max||5; escolhas=escolhas||{};
  const ok=(tally&&tally.rows||[]).filter(r=>r.total>0 && !r.vetadoPor.length);
  const cutTotal=ok.length>=max?ok[max-1].total:0;
  const sug=new Set(ok.filter((r,i)=>i<max || (cutTotal>0 && r.total===cutTotal)).map(r=>r.id));
  ok.filter(r=>r.todos).forEach(r=>sug.add(r.id));
  const rows=(tally&&tally.rows||[]).map(r=>{
    const e=(escolhas[r.id]==='aprovada'||escolhas[r.id]==='rejeitada')?escolhas[r.id]:null, s=sug.has(r.id);
    return Object.assign({}, r, { sugerida:s, escolha:e, status:e||(s?'sugerida':(r.vetadoPor.length?'vetada':'fora')) });
  });
  return { rows, sugeridas:rows.filter(r=>r.sugerida), aprovadas:rows.filter(r=>r.escolha==='aprovada'), rejeitadas:rows.filter(r=>r.escolha==='rejeitada') };
}
// custo previsto (US$ [lo,hi]): personas × rodadas na régua do roughEstimate (est), ou a tabela própria sem ela
function mesaCost(nPersonas, nRounds, model, est){
  const calls=Math.max(1,+nPersonas||1)*Math.max(1,+nRounds||1);
  const m=String(model||'').toLowerCase().replace(/.*(opus|sonnet|haiku).*/,'$1');
  const base=typeof est==='function'?est(calls, m):null;
  if(Array.isArray(base)) return [base[0]*MESA_TURN, base[1]*MESA_TURN];
  const per=({ opus:[0.16,0.64], sonnet:[0.05,0.20], haiku:[0.012,0.05] })[m]||[0.06,0.26];
  return [per[0]*calls, per[1]*calls];
}
function mesaCapHit(usd, capBrl, rate){ return +capBrl>0 && (+usd||0)*(+rate>0?+rate:5.5) >= +capBrl; }
// variação de pontos entre duas apurações (tabela "antes → depois")
function mesaDiff(prev, cur){
  const a={}; (prev&&prev.rows||[]).forEach(r=>{ a[r.id]=r.total; });
  const out={}; (cur&&cur.rows||[]).forEach(r=>{ const antes=a[r.id]||0; out[r.id]={ antes, depois:r.total, delta:r.total-antes }; });
  return out;
}
function mesaVotesOf(round){ const v={}; for(const k in (round&&round.resp)||{}){ const r=round.resp[k]; v[k]=(r&&r.st==='ok'&&r.voto)?r.voto:null; } return v; }
function mesaVoteRounds(m){ return ((m&&m.rounds)||[]).filter(r=>r.tipo==='voto'); }
// a justificativa que viaja com a demanda
function mesaJustify(m, row){
  const vr=mesaVoteRounds(m), last=vr[vr.length-1]||{ resp:{} };
  const nome=pid=>((m.personas||[]).find(p=>p.id===pid)||{}).nome||pid;
  const c=(m.cands||[]).find(x=>x.id===row.id)||{};
  const pres=Object.keys(row.pesos||{}).sort((a,b)=>row.pesos[b]-row.pesos[a]);
  const nVal=Object.values(last.resp||{}).filter(r=>r&&r.st==='ok'&&r.voto).length;
  const L=[`Decidido na mesa de personas "${m.tema}". Apuração: ${row.total} ponto${row.total===1?'':'s'}, votada por ${row.votos} de ${nVal}${pres.length?' ('+pres.map(p=>nome(p)+' '+row.pesos[p]).join(', ')+')':''}.`];
  if(row.todos) L.push('Teve voto de todas as personas.');
  const why=pres.map(p=>{ const v=last.resp[p]&&last.resp[p].voto, t=v&&v.top.find(x=>x.id===row.id); return t&&t.porque?`- ${nome(p)} (${t.peso}): ${t.porque}`:null; }).filter(Boolean);
  if(why.length) L.push('Por quê:\n'+why.join('\n'));
  if((row.vetadoPor||[]).length){
    const mot=row.vetadoPor.map(p=>{ const v=last.resp[p]&&last.resp[p].voto, x=v&&(v.vetos||[]).find(y=>y.id===row.id); return `- ${nome(p)}${x&&x.motivo?': '+x.motivo:''}`; });
    L.push('Vetada por (aprovada mesmo assim por você):\n'+mot.join('\n'));
  }
  if(c.autores&&c.autores.length) L.push('Proposta por: '+c.autores.join(', ')+'.');
  return L.join('\n\n');
}
// a nota "decisão" do cérebro
function mesaNoteBody(m, dec, criadas){
  const nome=pid=>((m.personas||[]).find(p=>p.id===pid)||{}).nome||pid;
  const L=[`Mesa de personas sobre **${m.tema}**, com ${(m.personas||[]).map(p=>p.nome+' ('+p.papel+')').join(', ')}.`];
  L.push('## Aprovadas\n'+(dec.aprovadas.length?dec.aprovadas.map(r=>{ const c=(m.cands||[]).find(x=>x.id===r.id)||{}; return `- **${r.titulo}** — ${r.total} pts, ${r.votos} voto(s)${r.vetadoPor.length?', vetada por '+r.vetadoPor.map(nome).join(', '):''}${c.descricao?'. '+c.descricao:''}`; }).join('\n'):'- (nenhuma)'));
  if(dec.rejeitadas.length) L.push('## Rejeitadas por você\n'+dec.rejeitadas.map(r=>`- ${r.titulo} (${r.total} pts)`).join('\n'));
  const vr=mesaVoteRounds(m), t=vr.length?mesaTally(m.cands, mesaVotesOf(vr[vr.length-1]), m.personas):null;
  if(t && t.vetosLivres.length) L.push('## Vetos (princípios)\n'+t.vetosLivres.map(v=>`- ${nome(v.pid)}: ${v.texto}${v.motivo?' — '+v.motivo:''}`).join('\n'));
  if(criadas) L.push('## Demandas\n'+criadas);
  L.push(`Rastro: mesa ${m.tema} · \`.cardume/mesas/${m.id}.json\``);
  return L.join('\n\n');
}
// @puro-fim

Object.assign(IC, {
  mesa:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="7.4" width="11" height="2.6" rx=".8"/><circle cx="4.6" cy="4.4" r="1.3"/><circle cx="8" cy="3.8" r="1.3"/><circle cx="11.4" cy="4.4" r="1.3"/><path d="M4.4 10v3.2M11.6 10v3.2" stroke-linecap="round"/></svg>',
  stopsq:'<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2"/></svg>',
  play:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 3.6v8.8L12 8z" stroke-linejoin="round"/></svg>',
  back:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9.8 3.5L5.3 8l4.5 4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
});
function mesaEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const MESA={ repo:'', list:[], cur:null, view:'lista', gen:[], pick:null, tema:'', genBusy:false, runs:{}, open:{}, target:'mesa', draft:'', chatBusy:false, creating:false };
function mesaVisible(){ const o=$id('mesaOverlay'); return !!(o && o.style.display!=='none'); }
function mesaCapBase(){ const v=parseFloat(String(lsGet('mesaCapBrl')||'').replace(',','.')); return v>=0&&!isNaN(v)?v:15; }
function mesaRunning(m){ return !!(m && MESA.runs[m.id]); }
function mesaStatusOf(m){ if(!m) return ''; if(m.status==='rodando' && !mesaRunning(m)) return 'interrompida'; return m.status||'concluida'; }
const MESA_ST={ rodando:['rodando','var(--info)'], pausada:['pausada no teto','var(--warn)'], parada:['parada','var(--muted)'], interrompida:['interrompida','var(--warn)'], concluida:['concluída','var(--accent)'] };
function mesaStBadge(st){ const x=MESA_ST[st]||[st,'var(--muted)']; return `<span class="mesast" style="--c:${x[1]}">${mesaEsc(x[0])}</span>`; }
function mesaPersonas(){ return MESA_PERSONAS.concat(MESA.gen||[]); }
function mesaNewId(){ return 'm-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,6); }

// ---- disco: grava a mesa a cada resposta (fila por mesa: nunca duas escritas cruzadas) ----
// _q (fila de gravação) fica fora; epicoPend._made (o que o épico já criou na nuvem) vai junto — retomar depois de fechar o app
function mesaData(m){ return JSON.parse(JSON.stringify(m, (k,v)=>k==='_q'?undefined:v)); }
function mesaSave(m){
  m.updatedAt=Date.now();
  const data=mesaData(m);
  m._q=(m._q||Promise.resolve()).then(()=>invoke('mesa_save',{ repo:m.repo, id:m.id, data })).catch(e=>console.error('mesa: salvar', e));
  return m._q;
}
async function mesaLoadList(){
  try{ MESA.list=await invoke('mesa_list',{ repo:MESA.repo })||[]; }catch(e){ MESA.list=[]; showErr(e,'Não consegui ler as mesas'); }
}
async function mesaLoadGen(){
  try{ const r=await invoke('mesa_read',{ repo:MESA.repo, id:'personas' }); MESA.gen=(r&&Array.isArray(r.personas))?r.personas:[]; }catch(_){ MESA.gen=[]; }
}

async function openMesa(){
  const ov=$id('mesaOverlay'); if(!ov) return;
  if(!state.repo){ toast('Abra um projeto primeiro — a mesa discute o projeto aberto.','warn'); return; }
  if(MESA.repo!==state.repo){
    MESA.repo=state.repo; MESA.view='lista'; MESA.pick=null; MESA.tema=''; MESA.draft=''; MESA.target='mesa';
    // mesa de outro projeto rodando continua (salva no projeto dela); só deixa de ser a mesa na tela
    if(MESA.cur && MESA.cur.repo!==state.repo) MESA.cur=null;
  }
  ovShow(ov);
  const body=$id('mesaBody'); if(body && MESA.view==='lista' && !MESA.list.length) body.innerHTML='<div class="dim" style="padding:24px">carregando as mesas…</div>';
  await Promise.all([mesaLoadList(), mesaLoadGen()]);
  if(!MESA.pick) MESA.pick=new Set(MESA_PERSONAS.map(p=>p.id));
  mesaRender();
}
window.openMesa=openMesa;
async function mesaOpenOne(id){
  // a mesa que está rodando fica em memória (é ela que recebe as respostas) — nunca relê por cima dela
  const live=Object.values(MESA.runs).map(r=>r.m).find(m=>m.id===id && m.repo===MESA.repo);
  let m=live;
  if(!m){ try{ m=await invoke('mesa_read',{ repo:MESA.repo, id }); }catch(e){ showErr(e,'Não consegui abrir a mesa'); return; } }
  if(!m){ toast('Essa mesa não existe mais.','warn'); await mesaLoadList(); mesaRender(); return; }
  m.repo=m.repo||MESA.repo; MESA.cur=m; MESA.view='mesa'; MESA.target='mesa'; MESA.draft='';
  mesaRender();
}

// ---- chamada de UMA persona ----
async function mesaAsk(m, sys, prompt, json){
  const r=await invoke('mesa_ask',{ repo:m.repo, id:m.id, personaSys:sys, prompt, model:m.model||MESA_MODEL, json:!!json });
  m.costUsd=(+m.costUsd||0)+(+(r&&r.costUsd)||0);
  return String((r&&r.text)||'');
}
function mesaErrMsg(e){ try{ const h=humanErr(e); return h.msg; }catch(_){ return String(e&&e.message||e); } }

// ---- orquestração: rodada por rodada, personas em paralelo, stop, teto entre rodadas ----
function mesaRoundMissing(m, r){ return (m.personas||[]).filter(p=>{ const x=r.resp&&r.resp[p.id]; return !x || x.st==='pendente' || x.st==='parada'; }); }
async function mesaRun(m){
  if(mesaRunning(m)) return;
  const run={ stop:false, m }; MESA.runs[m.id]=run;
  m.status='rodando'; await mesaSave(m); mesaPaint(m);
  try{
    for(;;){
      if(run.stop){ m.status='parada'; break; }
      const r=(m.rounds||[]).find(x=>mesaRoundMissing(m,x).length);
      if(!r){
        const vr=mesaVoteRounds(m);
        if(!vr.length && m.rounds.length){ // rodada 1 fechou: monta as features em votação e abre a rodada 2
          m.cands=mesaCandidates(m.personas, m.rounds[0].resp);
          if(!m.cands.length){ m.status='concluida'; m.aviso='Nenhuma persona trouxe proposta válida — não há o que votar. Rode de novo com outro tema ou outras personas.'; break; }
          m.rounds.push({ n:m.rounds.length+1, tipo:'voto', titulo:'Debate e voto', resp:{}, avisos:[] });
          MESA.open[m.id]=null;
          continue;
        }
        m.status='concluida'; break;
      }
      // teto próprio da mesa: só ENTRE rodadas (rodada que ainda não começou)
      const started=Object.values(r.resp||{}).some(x=>x && x.st!=='pendente' && x.st!=='parada');
      if(!started && mesaCapHit(m.costUsd, m.capBrl, usdBrlRate())){
        mesaPaint(m);
        const base=m.capBase||mesaCapBase();
        const go=await askYes(`A mesa "${m.tema}" chegou no teto de R$ ${fmtNumBR(m.capBrl,true)} (já gastou ${fmtCost(m.costUsd)}).\n\nContinuar com mais R$ ${fmtNumBR(base,true)} pra rodar "${r.titulo}"?`, 'Teto da mesa');
        if(!go){ m.status='pausada'; break; }
        m.capBrl=(+m.capBrl||0)+base;
      }
      await mesaRunRound(m, r, run);
    }
  }catch(e){ console.error('mesa:', e); m.status='parada'; showErr(e,'A mesa parou'); }
  finally{
    delete MESA.runs[m.id];
    await mesaSave(m);
    if(MESA.repo===m.repo) await mesaLoadList();
    mesaPaint(m);
    if(m.status==='concluida' && mesaVoteRounds(m).length && !(mesaVisible() && MESA.cur===m)) toast(`Mesa "${m.tema}" concluída — veja a votação e aprove as features.`,'ok',{ label:'abrir', fn:()=>{ if(window.openTab) openTab('mesa'); if(MESA.repo===m.repo){ MESA.cur=m; MESA.view='mesa'; mesaRender(); } } });
  }
}
async function mesaRunRound(m, r, run){
  const todo=mesaRoundMissing(m, r);
  r.resp=r.resp||{}; r.avisos=r.avisos||[];
  todo.forEach(p=>{ r.resp[p.id]={ st:'pendente' }; });
  mesaPaint(m);
  const idx=m.rounds.indexOf(r), prevVote=mesaVoteRounds(m).filter(x=>m.rounds.indexOf(x)<idx).pop();
  const candIds=(m.cands||[]).map(c=>c.id);
  const promptOf=()=>{
    if(r.tipo==='posicao') return mesaR1Prompt(m.tema);
    if(r.argumento && prevVote) return mesaArgPrompt(m.tema, m.personas, prevVote.resp, m.cands, mesaTally(m.cands, mesaVotesOf(prevVote), m.personas), r.argumento);
    return mesaR2Prompt(m.tema, m.personas, m.rounds[0].resp, m.cands);
  };
  const prompt=promptOf();
  await Promise.all(todo.map(async p=>{
    const sys=mesaPersonaSys(p);
    try{
      if(run.stop) throw new Error('MESA_STOPPED');
      const text=await mesaAsk(m, sys, prompt, true);
      if(r.tipo==='posicao'){
        const x=mesaParsePosition(text);
        r.resp[p.id]={ st:'ok', texto:x.texto, propostas:x.propostas, aviso:x.aviso||'', at:Date.now() };
        if(x.aviso) r.avisos.push(p.nome+': '+x.aviso);
      } else {
        let v=mesaParseVote(text, candIds), raw=text;
        if(!v.ok && !run.stop){ // voto malformado: UMA nova tentativa pedindo só o JSON
          r.resp[p.id]={ st:'pendente', aviso:'voto malformado — pedindo de novo só o JSON' }; mesaPaint(m);
          raw=await mesaAsk(m, sys, prompt+MESA_RETRY, true); v=mesaParseVote(raw, candIds);
        }
        if(v.ok){
          r.resp[p.id]={ st:'ok', texto:v.vote.fala, voto:v.vote, aviso:v.warns.join(' · '), at:Date.now() };
          if(v.warns.length) r.avisos.push(p.nome+': '+v.warns.join(' · '));
        } else {
          const txt=(mesaParseJson(raw)||{}).fala||raw;
          r.resp[p.id]={ st:'ok', texto:String(txt||'').trim(), voto:null, aviso:'voto descartado ('+v.erro+')', at:Date.now() };
          r.avisos.push(p.nome+': voto descartado ('+v.erro+')');
        }
      }
    }catch(e){
      const msg=String(e&&e.message||e);
      r.resp[p.id]=(run.stop||/MESA_STOPPED/.test(msg))?{ st:'parada' }:{ st:'falhou', erro:mesaErrMsg(e), at:Date.now() };
    }
    await mesaSave(m); mesaPaint(m);
  }));
}
async function mesaStop(m){
  const run=MESA.runs[m.id]; if(!run) return;
  run.stop=true; mesaPaint(m);
  try{ await invoke('mesa_stop',{ id:m.id }); }catch(_){ }
}

// ---- criar e rodar ----
async function mesaStart(){
  const tema=String(($id('mesaTema')||{}).value||MESA.tema||'').trim();
  if(!tema){ toast('Escreva o tema da mesa.','warn'); const t=$id('mesaTema'); if(t) t.focus(); return; }
  const personas=mesaPersonas().filter(p=>MESA.pick.has(p.id));
  if(personas.length<2){ toast('Escolha pelo menos 2 personas pra mesa.','warn'); return; }
  const capIn=$id('mesaCap'); let cap=capIn?parseFloat(String(capIn.value).replace(',','.')):mesaCapBase(); if(!(cap>=0)) cap=mesaCapBase();
  lsSet('mesaCapBrl', String(cap));
  const m={ id:mesaNewId(), v:1, repo:MESA.repo, tema, model:MESA_MODEL, capBrl:cap, capBase:cap||mesaCapBase(), createdAt:Date.now(), updatedAt:Date.now(), status:'rodando',
    personas:personas.map(p=>({ id:p.id, nome:p.nome, papel:p.papel, desc:p.desc, gerada:!!p.gerada })),
    rounds:[{ n:1, tipo:'posicao', titulo:'Posições', resp:{}, avisos:[] }], cands:[], chats:{}, escolhas:{}, criadas:null, costUsd:0 };
  { const t=$id('mesaTema'); if(t) t.value=''; }
  MESA.tema=''; MESA.cur=m; MESA.view='mesa'; MESA.target='mesa'; MESA.draft='';
  mesaRender();
  mesaRun(m);
}
async function mesaGenerate(){
  if(MESA.genBusy) return;
  const tema=String(($id('mesaTema')||{}).value||'').trim(); MESA.tema=tema;
  MESA.genBusy=true; mesaRender();
  const tmp={ id:'personas', repo:MESA.repo, model:MESA_MODEL, costUsd:0 };
  try{
    const text=await mesaAsk(tmp, MESA_GEN_SYS, mesaGenPrompt(tema), true);
    const ps=mesaParsePersonas(text, MESA_PERSONAS.map(p=>p.id));
    if(!ps.length){ toast('A IA não devolveu personas válidas — tente de novo.','warn'); return; }
    MESA.gen=ps; ps.forEach(p=>MESA.pick.add(p.id));
    await invoke('mesa_save',{ repo:MESA.repo, id:'personas', data:{ personas:ps, tema, at:Date.now() } });
    toast(`${ps.length} personas geradas pra este projeto (${fmtCost(tmp.costUsd)}).`,'ok');
  }catch(e){ if(!/MESA_STOPPED/.test(String(e&&e.message||e))) showErr(e,'Não consegui gerar as personas'); }
  finally{ MESA.genBusy=false; mesaRender(); }
}

// ---- argumentar: com a mesa (revoto) ou com uma persona ----
async function mesaArgue(){
  const m=MESA.cur; if(!m) return;
  const inp=$id('mesaArgIn'); const text=String(inp&&inp.value||'').trim(); if(!text) return;
  if(mesaRunning(m)){ toast('Espere a rodada terminar (ou pare a mesa) pra argumentar.','warn'); return; }
  if(!mesaVoteRounds(m).length){ toast('A mesa ainda não votou — argumente depois da rodada de voto.','warn'); return; }
  if(MESA.target==='mesa'){
    MESA.draft=''; if(inp) inp.value='';
    m.rounds.push({ n:m.rounds.length+1, tipo:'voto', titulo:'Revoto', argumento:text, resp:{}, avisos:[] });
    MESA.open[m.id]=null; // abre a rodada nova
    await mesaSave(m);
    mesaRun(m); // o teto é conferido antes da rodada começar (pergunta se já bateu)
    return;
  }
  const p=(m.personas||[]).find(x=>x.id===MESA.target); if(!p) return;
  if(MESA.chatBusy) return;
  if(mesaCapHit(m.costUsd, m.capBrl, usdBrlRate()) && !await askYes(`A mesa já passou do teto de R$ ${fmtNumBR(m.capBrl,true)} (gastou ${fmtCost(m.costUsd)}). Perguntar pra ${p.nome} mesmo assim?`,'Teto da mesa')) return;
  MESA.draft=''; if(inp) inp.value='';
  const chat=(m.chats[p.id]=m.chats[p.id]||[]);
  const vr=mesaVoteRounds(m), last=vr[vr.length-1], r1=(m.rounds[0].resp||{})[p.id]||{}, lr=(last&&last.resp[p.id])||{};
  const hist={ posicao:r1.texto||'', voto:lr.voto||null, fala:lr.texto||'', cands:m.cands, chat:chat.slice() };
  chat.push({ who:'you', text });
  MESA.chatBusy=true; chatPinBottom('mesaChat'); mesaRender();
  try{
    const ans=await mesaAsk(m, mesaPersonaSys(p), mesaAskPrompt(m.tema, p, hist, text), false);
    chat.push({ who:'bot', text:ans||'(sem resposta)' });
  }catch(e){
    const msg=String(e&&e.message||e);
    chat.push({ who:'sys', text:/MESA_STOPPED/.test(msg)?'Parado.':(p.nome+' não respondeu: '+mesaErrMsg(e)) });
  }finally{ MESA.chatBusy=false; await mesaSave(m); chatPinBottom('mesaChat'); mesaPaint(m); }
}

// ---- aprovar/rejeitar e criar demandas ----
function mesaDecisionOf(m){
  const vr=mesaVoteRounds(m); if(!vr.length) return null;
  const last=vr[vr.length-1], prev=vr.length>1?vr[vr.length-2]:null;
  const tally=mesaTally(m.cands, mesaVotesOf(last), m.personas);
  return { tally, prev:prev?mesaTally(m.cands, mesaVotesOf(prev), m.personas):null, dec:mesaDecision(tally, m.escolhas), last };
}
async function mesaChoose(m, id, what){
  m.escolhas=m.escolhas||{};
  if(m.escolhas[id]===what) delete m.escolhas[id]; else m.escolhas[id]=what;
  await mesaSave(m); mesaPaint(m);
}
async function mesaCreate(){
  const m=MESA.cur; if(!m||MESA.creating) return;
  const D=mesaDecisionOf(m); if(!D) return;
  const done=new Set(((m.criadas&&m.criadas.itens)||[]).map(x=>x.fid));
  // épico que caiu no meio: "Criar demandas" de novo RETOMA o mesmo épico (idempotente), não vira tarefa solta
  const resume=m.epicoPend||null;
  const ap=resume?D.dec.rows.filter(r=>resume.tasks.some(t=>t.fid===r.id) && !done.has(r.id)):D.dec.aprovadas.filter(r=>!done.has(r.id));
  if(!ap.length){ toast(D.dec.aprovadas.length?'As aprovadas já viraram demanda.':'Aprove pelo menos uma feature (✓ na tabela) antes de criar demandas.','warn'); return; }
  if(m.repo!==state.repo){
    toast(`Esta mesa é do projeto ${pathBase(m.repo)} — abra ele pra criar as demandas lá.`,'warn', window.switchProject?{ label:'abrir o projeto', fn:()=>window.switchProject(m.repo) }:null);
    return; }
  if(typeof repoHasGit==='function' && !repoHasGit()){ if(!(typeof gitGate==='function' && await gitGate())) return; }
  const cloud=!!(typeof SB!=='undefined' && SB.sess() && cloudTeamId());
  const asEpic=!!resume || (ap.length>1 && cloud);
  if(resume && !cloud){ toast('Retomar o épico precisa da conta e do time — entre na Conta e escolha o time.','warn'); return; }
  const q=resume?`Retomar o épico "${resume.epic}"? Falta criar:\n\n${ap.map(r=>'• '+r.titulo).join('\n')}\n\n(o que já foi criado não se repete)`:asEpic?`Criar um ÉPICO no backlog do time com ${ap.length} tarefas?\n\n${ap.map(r=>'• '+r.titulo).join('\n')}`
               :`Criar ${ap.length===1?'1 tarefa':ap.length+' tarefas'} neste projeto (sem iniciar)?\n\n${ap.map(r=>'• '+r.titulo).join('\n')}`+(ap.length>1&&!cloud?'\n\n(Sem nuvem/time: viram tarefas soltas, não épico.)':'');
  if(!await askYes(q,'Criar demandas')) return;
  MESA.creating=true; mesaPaint(m);
  const itens=[], faltou=[];
  const obj=r=>{ const c=(m.cands||[]).find(x=>x.id===r.id)||{}; return ((c.descricao||r.titulo)+'\n\n'+mesaJustify(m, r)).trim(); };
  try{
    if(asEpic){
      if(plPlanCtx && plPlanCtx.origin && !(m.epicoPend && plPlanCtx.origin.mesa===m.id)){ toast('Feche o "Desdobrar" aberto antes — ele usa o mesmo cartão de épico.','warn'); return; }
      // hospeda o plCreateEpic (o mesmo do planner/desdobrar): idempotente — tentar de novo não repete o que já foi criado
      const plan=m.epicoPend||{ epic:('Mesa: '+m.tema).slice(0,80), outcome:'', requirements:[],
        doneWhen:ap.map(r=>r.titulo+' entregue').slice(0,6), boundaries:[],
        tasks:ap.map((r,i)=>({ idx:i, fid:r.id, title:r.titulo.slice(0,90), objective:obj(r), requirements:[], owns:'', verify:'', covers:[], after:[], risk:'', hitl:false, boundaries:[], wave:1, on:true })) };
      const livres=(D.tally.vetosLivres||[]).map(v=>v.texto+(v.motivo?' — '+v.motivo:'')).slice(0,6); if(livres.length) plan.boundaries=livres;
      m.epicoPend=plan; let made=null;
      bdPlan=plan; plPlanRender=()=>{};
      plPlanCtx={ origin:{ title:'mesa '+m.tema, mesa:m.id }, originNote:'', description:`Decidido na mesa de personas "${m.tema}" (${(m.personas||[]).map(p=>p.nome).join(', ')}).`, onDone:ep=>{ made=ep; }, onDiscard:()=>{} };
      try{ await plCreateEpic(); }
      finally{ if(plPlanCtx && plPlanCtx.origin && plPlanCtx.origin.mesa===m.id){ plPlanCtx={}; plPlanRender=null; bdPlan=null; } }
      const rows=(plan._made&&plan._made.rows)||{};
      plan.tasks.forEach(t=>{ const row=rows['i'+t.idx]; if(row){ if(!done.has(t.fid)) itens.push({ fid:t.fid, titulo:t.title, cloudId:row.id }); } else faltou.push(t.title); });
      if(made){ m.epicoPend=null; m.criadas=Object.assign({}, m.criadas||{}, { epico:{ id:made.id, name:made.name } }); }
    } else {
      for(const r of ap){
        const payload={ start:false, title:r.titulo.slice(0,90), workflow:null, agents:null, engine:'claude', model:null, approval:'auto', owns:null, off:null,
          objective:obj(r), deliverables:[], requirements:[((m.cands||[]).find(x=>x.id===r.id)||{}).descricao||r.titulo],
          doc:null, proof:!!(typeof ntPolicy!=='undefined'&&ntPolicy.proofRequired), tests:!!(typeof ntPolicy!=='undefined'&&ntPolicy.testsRequired),
          autoPr:'ask', prBase:null, planApproval:'auto', refs:[], branchType:'feat', issue:null };
        try{ const nid=await invoke('new_task', typeof trkBeforeNewTask==='function'?await trkBeforeNewTask(payload):payload); itens.push({ fid:r.id, titulo:r.titulo, taskId:nid }); }
        catch(e){ faltou.push(r.titulo); console.error('mesa: criar tarefa', e); if(faltou.length===1) showErr(e,'Não consegui criar "'+r.titulo+'"'); }
      }
    }
    if(itens.length){
      m.criadas=Object.assign({}, m.criadas||{}); m.criadas.itens=((m.criadas.itens)||[]).concat(itens); m.criadas.at=Date.now();
      await mesaSave(m);
      await mesaWriteDecisionNote(m, D.dec, itens);
      lastSig=''; try{ await refresh(); }catch(_){ }
    }
    m.criadas=m.criadas||{}; m.criadas.faltou=faltou; await mesaSave(m);
    if(faltou.length) toast(`Criadas ${itens.length} de ${itens.length+faltou.length}. Faltou: ${faltou.join(', ')} — clique em "Criar demandas" de novo pra tentar o que faltou.`,'warn');
    else if(itens.length) toast(asEpic?`Épico criado com ${itens.length} tarefa(s) no backlog do time.`:`${itens.length} tarefa(s) criada(s) na Central, com a justificativa da mesa.`,'ok');
  }catch(e){ showErr(e,'Falha ao criar as demandas'); }
  finally{ MESA.creating=false; mesaPaint(m); }
}
// decisão aprovada → nota "decisão" no cérebro (vai pro time se o cérebro está no modo time — D3)
async function mesaWriteDecisionNote(m, dec, itens){
  try{
    const info=await invoke('memory_list',{ repo:m.repo });
    const team=info && info.mode==='time' && typeof memTeamAvailable==='function' && await memTeamAvailable();
    const scope=team?'time':'local';
    const prev=m.criadas&&m.criadas.nota; // uma nota por mesa: criar mais demandas depois reescreve a mesma
    const all=((m.criadas&&m.criadas.itens)||[]).concat(itens.filter(x=>!((m.criadas&&m.criadas.itens)||[]).includes(x)));
    const criadas=all.map(x=>`- ${x.titulo}${x.taskId?' (tarefa '+x.taskId+')':' (no épico'+(m.criadas&&m.criadas.epico?' '+m.criadas.epico.name:'')+')'}`).join('\n');
    const note={ title:('Decisão da mesa: '+m.tema).slice(0,110), type:'decisão', tags:['mesa'], updated:memToday(), by:memWho(), origem:'pessoa', body:mesaNoteBody(m, dec, criadas), extra:{} };
    const sc=prev?prev.scope:scope;
    const r=await invoke('memory_write',{ repo:m.repo, scope:sc, slug:prev?prev.slug:null, content:memSerialize(note), expectMtime:null, create:!prev });
    m.criadas=m.criadas||{}; m.criadas.nota={ scope:r.scope||sc, slug:r.slug||(prev&&prev.slug) };
    await mesaSave(m);
    if(m.criadas.nota.scope==='time' && typeof memTeamSync==='function') memTeamSync().catch(()=>{});
  }catch(e){ showErr(e,'As demandas foram criadas, mas não consegui gravar a nota de decisão no cérebro'); }
}

// ---------------- tela ----------------
function mesaPaint(m){ if(mesaVisible() && ((MESA.view==='mesa' && MESA.cur===m) || MESA.view==='lista')) mesaRender(); }
function mesaCapture(){
  const a=$id('mesaArgIn'); if(a) MESA.draft=a.value;
  const t=$id('mesaTema'); if(t) MESA.tema=t.value;
}
function mesaRender(){
  const body=$id('mesaBody'); if(!body) return;
  mesaCapture();
  const scr=body.querySelector('.mesascroll'), top=scr?scr.scrollTop:0;
  const keep=stickBottom($id('mesaChat'));
  body.innerHTML='<div class="mesawrap">'+(MESA.view==='nova'?mesaNovaHtml():MESA.view==='mesa'&&MESA.cur?mesaMesaHtml(MESA.cur):mesaListaHtml())+'</div>';
  const scr2=body.querySelector('.mesascroll'); if(scr2) scr2.scrollTop=top;
  keep($id('mesaChat'));
  mesaWire(body);
}
function mesaHead(title, sub, acts){
  return `<div class="mesatop"><div class="mesatitle">${IC.mesa}<div><h1>${title}</h1><div class="dim mesasub">${sub}</div></div></div><div class="mesactl">${acts||''}</div></div>`;
}
function mesaListaHtml(){
  const rows=(MESA.list||[]).map(x=>{
    const live=Object.values(MESA.runs).some(r=>r.m.id===x.id && r.m.repo===MESA.repo);
    const st=(x.status==='rodando'&&!live)?'interrompida':(x.status||'concluida');
    const d=x.updatedAt?new Date(x.updatedAt).toLocaleString('pt-BR',{ day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }):'';
    return `<button class="mesarow" data-mopen="${mesaEsc(x.id)}"><span class="mesart"><b>${mesaEsc(x.tema||'(sem tema)')}</b>${mesaStBadge(st)}</span><span class="mesarm">${x.personas} personas · ${x.rounds} rodada${x.rounds===1?'':'s'} · ${mesaEsc(fmtCost(+x.costUsd||0))}${d?' · '+d:''}</span></button>`;
  }).join('');
  return mesaHead('Mesa de personas', mesaEsc(pathBase(MESA.repo))+' · '+(MESA.list.length||0)+' mesa'+(MESA.list.length===1?'':'s'),
      `<button class="btn primary" id="mesaNew">${IC.ai}Nova mesa</button>`)+
    `<div class="mesascroll">`+
    (rows?`<div class="mesalist">${rows}</div>`:
      `<div class="mesaempty">${IC.mesa}<p><b>Decida o que construir com uma mesa de vozes.</b></p><p class="dim">Você escreve o tema (ex.: "próximas features do app de agendamento"). Cada persona — a vibe coder, o tech lead, quem não programa, a estratégia de produto, a cética — responde separada, com a memória do projeto. Na rodada 1 cada uma dá a sua posição; na rodada 2 elas debatem e votam (top 5 com peso e vetos). Você vê a tabela de votos, aprova ou rejeita cada feature, argumenta com a mesa e transforma as aprovadas em demandas.</p></div>`)+
    `</div>`;
}
function mesaNovaHtml(){
  const ps=mesaPersonas(), n=ps.filter(p=>MESA.pick.has(p.id)).length;
  const [lo,hi]=mesaCost(n, 2, MESA_MODEL, typeof roughEstimate==='function'?roughEstimate:null);
  const card=p=>`<label class="mesap${MESA.pick.has(p.id)?' on':''}"><input type="checkbox" data-mpick="${mesaEsc(p.id)}"${MESA.pick.has(p.id)?' checked':''}><span><b>${mesaEsc(p.nome)}</b> <span class="dim">· ${mesaEsc(p.papel)}${p.gerada?' · gerada':''}</span><span class="mesapd">${mesaEsc(p.desc)}</span></span></label>`;
  return mesaHead('Nova mesa', mesaEsc(pathBase(MESA.repo)), `<button class="btn" id="mesaBack">${IC.back}voltar</button>`)+
    `<div class="mesascroll"><div class="mesaform">`+
      `<label class="mesaf"><span>Tema da mesa</span><textarea class="in ta" id="mesaTema" rows="2" placeholder="ex.: próximas features do app de agendamento · como lançar a campanha de inverno · o que cortar do escopo">${mesaEsc(MESA.tema)}</textarea></label>`+
      `<div class="mesaf"><span>Quem senta à mesa <span class="dim">(${n} escolhida${n===1?'':'s'})</span></span>`+
        `<div class="mesaps">${ps.map(card).join('')}</div>`+
        `<div class="mesagen"><button class="btn" id="mesaGen"${MESA.genBusy?' disabled':''}>${IC.ai}${MESA.genBusy?'gerando personas…':'Gerar personas pra este projeto'}</button><span class="dim">a IA lê o cérebro e o tema e propõe de 3 a 5 personas (ex.: o dono do negócio, o cliente final) — ficam salvas neste projeto</span></div>`+
      `</div>`+
      `<div class="mesacost"><div>deve custar <b>${mesaEsc(fmtCostRange(lo,hi))}</b> <span class="dim">· ${n} personas × 2 rodadas · Sonnet</span></div>`+
        `<label class="mesacap">teto da mesa R$ <input class="in" id="mesaCap" type="number" min="0" step="1" value="${mesaEsc(String(mesaCapBase()))}"> <span class="dim">ao chegar nele, a mesa pausa entre rodadas e pergunta se continua (0 = sem teto)</span></label></div>`+
      `<div class="mesafoot"><span style="flex:1"></span><button class="btn primary" id="mesaGo"${n<2?' disabled':''}>${IC.play}Rodar a mesa</button></div>`+
    `</div></div>`;
}
function mesaPersonaCard(m, r, p){
  const x=(r.resp||{})[p.id];
  const run=MESA.runs[m.id];
  let st, body='';
  if(!x) st=`<span class="mesachip">na fila</span>`;
  else if(x.st==='pendente' && !run) st=`<span class="mesachip">interrompida — continue a mesa</span>`;
  else if(x.st==='pendente') st=(run&&run.stop)?`<span class="mesachip">parando…</span>`:`<span class="mesachip live"><span class="pltyping"><i></i><i></i><i></i></span>${x.aviso?mesaEsc(x.aviso):'pensando…'}</span>`;
  else if(x.st==='parada') st=`<span class="mesachip">parada</span>`;
  else if(x.st==='falhou'){ st=`<span class="mesachip bad">não respondeu</span>`; body=`<div class="mesaerr">${mesaEsc(x.erro||'')}</div>`; }
  else {
    st=`<span class="mesachip ok">${IC.ok}respondeu</span>`;
    body=(x.aviso?`<div class="mesawarn">${mesaEsc(x.aviso)}</div>`:'')+`<div class="mdview mesamd">${mdToHtml(x.texto||'*(sem texto)*')}</div>`;
    if(r.tipo==='posicao' && (x.propostas||[]).length) body+=`<div class="mesaprops">${x.propostas.map(q=>`<div><b>${mesaEsc(q.titulo)}</b>${q.descricao?' — '+mesaEsc(q.descricao):''}${q.porque?`<span class="dim"> · ${mesaEsc(q.porque)}</span>`:''}</div>`).join('')}</div>`;
    if(r.tipo==='voto' && x.voto){
      const t=id=>((m.cands||[]).find(c=>c.id===id)||{}).titulo||id;
      body+=`<div class="mesavotes">${x.voto.top.map(v=>`<span class="mesav" title="${mesaEsc(v.porque||'')}"><i>${v.peso}</i>${mesaEsc(t(v.id))}</span>`).join('')}${(x.voto.vetos||[]).map(v=>`<span class="mesav veto" title="${mesaEsc(v.motivo||'')}"><i>veto</i>${mesaEsc(v.id?t(v.id):v.texto)}</span>`).join('')}</div>`;
    }
  }
  return `<div class="mesacard"><div class="mesach"><b>${mesaEsc(p.nome)}</b><span class="dim">${mesaEsc(p.papel)}</span><span style="flex:1"></span>${st}</div>${body}</div>`;
}
function mesaRoundHtml(m, r, isLast){
  const ps=m.personas||[], ok=ps.filter(p=>{ const x=(r.resp||{})[p.id]; return x&&x.st==='ok'; }).length;
  const openSet=MESA.open[m.id]; const open=openSet?openSet.has(r.n):isLast;
  const lbl=r.tipo==='posicao'?'posições':(r.argumento?'revoto':'debate e voto');
  return `<details class="mesaround" data-mround="${r.n}"${open?' open':''}><summary><b>Rodada ${r.n}</b> — ${lbl}<span class="dim"> · ${ok}/${ps.length} responderam</span>${(r.avisos||[]).length?`<span class="mesawarnc">${r.avisos.length} aviso${r.avisos.length===1?'':'s'}</span>`:''}</summary>`+
    (r.argumento?`<div class="mesaarg"><span class="dim">seu argumento:</span> ${mesaEsc(r.argumento)}</div>`:'')+
    ((r.avisos||[]).length?`<div class="mesawarn">${r.avisos.map(mesaEsc).join('<br>')}</div>`:'')+
    `<div class="mesacards">${ps.map(p=>mesaPersonaCard(m, r, p)).join('')}</div></details>`;
}
function mesaTableHtml(m, D){
  const ps=m.personas||[], diff=D.prev?mesaDiff(D.prev, D.tally):null, nome=pid=>(ps.find(p=>p.id===pid)||{}).nome||pid;
  const head=`<tr><th>Feature</th>${ps.map(p=>`<th class="c" title="${mesaEsc(p.papel)}">${mesaEsc(p.nome)}</th>`).join('')}<th class="c">Total</th>${diff?'<th class="c">antes → depois</th>':''}<th>Decisão</th></tr>`;
  const rows=D.dec.rows.map(r=>{
    const d=diff&&diff[r.id];
    const tags=(r.todos?'<span class="mesatag all">voto de todos</span>':'')+(r.empate?'<span class="mesatag">empate</span>':'')+(r.vetadoPor.length?`<span class="mesatag veto" title="vetada por ${mesaEsc(r.vetadoPor.map(nome).join(', '))}">vetada por ${mesaEsc(r.vetadoPor.map(nome).join(', '))}</span>`:'');
    const stl={ sugerida:'sugerida', aprovada:'aprovada', rejeitada:'rejeitada', vetada:'vetada', fora:'fora' }[r.status];
    return `<tr class="st-${r.status}"><td><span class="mesafid">${mesaEsc(r.id)}</span> ${mesaEsc(r.titulo)} ${tags}</td>`+
      ps.map(p=>{ const w=r.pesos[p.id]; return `<td class="c">${w?w:(r.vetadoPor.includes(p.id)?'<span class="mesax" title="vetou">'+IC.x+'</span>':'<span class="dim">–</span>')}</td>`; }).join('')+
      `<td class="c"><b>${r.total}</b></td>`+
      (diff?`<td class="c">${d.antes} → ${d.depois}${d.delta?` <span class="${d.delta>0?'up':'down'}">${d.delta>0?'+':''}${d.delta}</span>`:''}</td>`:'')+
      `<td><div class="mesadec"><span class="mesadecl ${r.status}">${stl}</span>`+
        `<button class="btn sm${r.escolha==='aprovada'?' on':''}" data-mchoose="${mesaEsc(r.id)}:aprovada" title="aprovar" aria-label="aprovar ${mesaEsc(r.titulo)}">${IC.ok}</button>`+
        `<button class="btn sm${r.escolha==='rejeitada'?' on bad':''}" data-mchoose="${mesaEsc(r.id)}:rejeitada" title="rejeitar" aria-label="rejeitar ${mesaEsc(r.titulo)}">${IC.x}</button></div></td></tr>`;
  }).join('');
  return `<div class="mesatablew"><table class="mesatable"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}
function mesaMesaHtml(m){
  const st=mesaStatusOf(m), running=mesaRunning(m), run=MESA.runs[m.id];
  const acts=(running?`<button class="btn" id="mesaStop"${run&&run.stop?' disabled':''}>${IC.stopsq}${run&&run.stop?'parando…':'Parar'}</button>`:'')+
    (!running && ['pausada','parada','interrompida'].includes(st)?`<button class="btn primary" id="mesaCont">${IC.play}Continuar</button>`:'')+
    `<button class="btn" id="mesaBack">${IC.back}mesas</button>`;
  const cap=+m.capBrl>0?` · teto R$ ${fmtNumBR(m.capBrl,true)}`:'';
  const sub=`${mesaStBadge(st)} · ${(m.personas||[]).map(p=>mesaEsc(p.nome)).join(', ')} · gastou ${mesaEsc(fmtCost(+m.costUsd||0))}${cap}`+(m.repo!==state.repo?` · projeto ${mesaEsc(pathBase(m.repo))}`:'');
  const D=mesaDecisionOf(m);
  let dec='';
  if(D){
    const nome=pid=>((m.personas||[]).find(p=>p.id===pid)||{}).nome||pid;
    const sug=D.dec.sugeridas, apN=D.dec.aprovadas.length;
    const doneIds=new Set(((m.criadas&&m.criadas.itens)||[]).map(x=>x.fid)), pend=D.dec.aprovadas.filter(r=>!doneIds.has(r.id)).length;
    dec=`<section class="mesasec"><h2>Votação${D.prev?' <span class="dim">— antes e depois do seu argumento</span>':''}</h2>`+
      (D.tally.ausentes.length?`<div class="mesawarn">Sem voto válido: ${mesaEsc(D.tally.ausentes.map(nome).join(', '))} — a apuração conta só quem votou.</div>`:'')+
      mesaTableHtml(m, D)+
      (D.tally.vetosLivres.length?`<div class="mesavetos"><div class="mesalbl">vetos (princípios)</div>${D.tally.vetosLivres.map(v=>`<div><b>${mesaEsc(nome(v.pid))}:</b> ${mesaEsc(v.texto)}${v.motivo?` <span class="dim">— ${mesaEsc(v.motivo)}</span>`:''}</div>`).join('')}</div>`:'')+
      `</section><section class="mesasec"><h2>Decisão sugerida</h2>`+
      (sug.length?`<ol class="mesasug">${sug.map(r=>`<li><b>${mesaEsc(r.titulo)}</b> <span class="dim">· ${r.total} pts${r.todos?' · voto de todos':''}</span>${r.escolha?` <span class="mesadecl ${r.escolha}">${r.escolha}</span>`:''}</li>`).join('')}</ol>`:'<div class="dim">Nenhuma feature sem veto recebeu voto.</div>')+
      `<div class="dim mesahint">A sugestão sai só da tabela: as 5 mais votadas sem veto (empate no corte entra junto) e a que teve voto de todos. Quem decide é você: ${IC.ok} aprova, ${IC.x} rejeita.</div>`+
      `<div class="mesacreate">`+(sug.length&&!apN?`<button class="btn" id="mesaApSug">${IC.ok}aprovar as sugeridas</button>`:'')+
        `<span style="flex:1"></span><button class="btn primary" id="mesaCreate"${!pend||MESA.creating||running?' disabled':''}>${MESA.creating?'criando…':'Criar demandas'+(pend?' ('+pend+')':'')}</button></div>`+
      mesaCriadasHtml(m)+
      `</section>`;
  }
  const argue=D?mesaArgueHtml(m):'';
  return mesaHead(mesaEsc(m.tema), sub, acts)+
    `<div class="mesascroll">`+(m.aviso?`<div class="mesawarn">${mesaEsc(m.aviso)}</div>`:'')+
    `<section class="mesasec"><h2>Discussão</h2>${(m.rounds||[]).map((r,i,a)=>mesaRoundHtml(m, r, i===a.length-1)).join('')}</section>`+
    dec+argue+`</div>`;
}
function mesaCriadasHtml(m){
  const c=m.criadas; if(!c||!((c.itens||[]).length||(c.faltou||[]).length)) return '';
  return `<div class="mesacriadas"><div class="mesalbl">demandas criadas</div>`+
    (c.epico?`<div><a href="#" data-mepic="${mesaEsc(c.epico.id)}">${IC.stack}épico ${mesaEsc(c.epico.name||'')}</a></div>`:'')+
    (c.itens||[]).map(x=>`<div>${x.taskId?`<a href="#" data-mtask="${mesaEsc(x.taskId)}">${mesaEsc(x.titulo)}</a>`:mesaEsc(x.titulo)+' <span class="dim">(no épico)</span>'}</div>`).join('')+
    ((c.faltou||[]).length?`<div class="mesawarn">faltou criar: ${mesaEsc(c.faltou.join(', '))}</div>`:'')+
    (c.nota?`<div class="dim">nota de decisão no cérebro ${mesaEsc(c.nota.scope)}: <a href="#" id="mesaNote">${mesaEsc(c.nota.slug)}</a></div>`:'')+`</div>`;
}
function mesaArgueHtml(m){
  const running=mesaRunning(m), ps=m.personas||[], tgt=MESA.target;
  const p=ps.find(x=>x.id===tgt);
  const chat=p?(m.chats[p.id]||[]):[];
  const opts=`<select class="in mesatgt" id="mesaTgt" aria-label="Com quem argumentar"><option value="mesa"${tgt==='mesa'?' selected':''}>com a mesa (nova rodada e revoto)</option>${ps.map(x=>`<option value="${mesaEsc(x.id)}"${tgt===x.id?' selected':''}>só com ${mesaEsc(x.nome)}</option>`).join('')}</select>`;
  const thread=p?`<div class="mesachat plthread" id="mesaChat">${chat.length?chat.map(x=>chatMsgHtml(x.who==='bot'?{ who:'bot', text:'**'+p.nome+':** '+x.text }:x)).join(''):`<div class="dim" style="padding:6px 2px">Pergunte algo só pra ${mesaEsc(p.nome)} — só essa persona responde, com o histórico dela nesta mesa (a mesa não revota).</div>`}${MESA.chatBusy?chatThinkHtml():''}</div>`:'';
  return `<section class="mesasec"><h2>Argumentar</h2>${thread}`+
    chatComposerHtml({ input:'mesaArgIn', send:'mesaArgSend', rows:2, value:MESA.draft, extras:opts, disabled:running,
      placeholder:p?`ex.: ${p.nome}, por que você vetou isso?`:'ex.: considerem que não temos backend — isso muda o voto?', sendHtml:p?'perguntar':'argumentar' })+
    `</section>`;
}
function mesaWire(body){
  bindClick('mesaNew', ()=>{ MESA.view='nova'; if(!MESA.pick) MESA.pick=new Set(MESA_PERSONAS.map(p=>p.id)); mesaRender(); const t=$id('mesaTema'); if(t) t.focus(); });
  bindClick('mesaBack', async()=>{ MESA.view='lista'; MESA.cur=null; await mesaLoadList(); mesaRender(); });
  bindClick('mesaGen', mesaGenerate);
  bindClick('mesaGo', mesaStart);
  bindClick('mesaStop', ()=>MESA.cur&&mesaStop(MESA.cur));
  bindClick('mesaCont', ()=>MESA.cur&&mesaRun(MESA.cur));
  bindClick('mesaCreate', mesaCreate);
  bindClick('mesaApSug', async()=>{ const m=MESA.cur, D=m&&mesaDecisionOf(m); if(!D) return; D.dec.sugeridas.forEach(r=>{ if(!m.escolhas[r.id]) m.escolhas[r.id]='aprovada'; }); await mesaSave(m); mesaRender(); });
  bindClick('mesaNote', ev=>{ ev.preventDefault(); const c=MESA.cur&&MESA.cur.criadas; if(!c||!c.nota) return; MEM.sel={ scope:c.nota.scope, slug:c.nota.slug }; if(window.openTab) openTab('memoria'); });
  body.querySelectorAll('[data-mopen]').forEach(b=>b.onclick=()=>mesaOpenOne(b.dataset.mopen));
  body.querySelectorAll('[data-mpick]').forEach(c=>c.onchange=()=>{ if(c.checked) MESA.pick.add(c.dataset.mpick); else MESA.pick.delete(c.dataset.mpick); mesaRender(); });
  body.querySelectorAll('[data-mchoose]').forEach(b=>b.onclick=()=>{ const [id,w]=b.dataset.mchoose.split(':'); if(MESA.cur) mesaChoose(MESA.cur, id, w); });
  body.querySelectorAll('[data-mtask]').forEach(a=>a.onclick=ev=>{ ev.preventDefault(); if(typeof openTaskById==='function'){ openTab('flow'); openTaskById(a.dataset.mtask); } });
  body.querySelectorAll('[data-mepic]').forEach(a=>a.onclick=ev=>{ ev.preventDefault(); const c=MESA.cur&&MESA.cur.criadas; if(c&&c.epico&&window.openEpicPage) openEpicPage(c.epico); });
  // abrir/fechar rodada: só o CLIQUE conta (o evento toggle também dispara ao desenhar um <details open>)
  body.querySelectorAll('details.mesaround>summary').forEach(sm=>sm.onclick=()=>setTimeout(()=>{ const d=sm.parentElement, m=MESA.cur; if(!m) return;
    const s=MESA.open[m.id]||(MESA.open[m.id]=new Set((m.rounds||[]).length?[m.rounds[m.rounds.length-1].n]:[])); if(d.open) s.add(+d.dataset.mround); else s.delete(+d.dataset.mround); },0));
  const tg=$id('mesaTgt'); if(tg) tg.onchange=()=>{ MESA.target=tg.value; mesaRender(); const i=$id('mesaArgIn'); if(i) i.focus(); };
  if($id('mesaArgIn')){
    chatComposer({ input:'mesaArgIn', attach:null, pend:()=>[], taskId:()=>null, rerender:()=>{}, send:'mesaArgSend',
      stop:{ btn:'', busy:()=>MESA.chatBusy||mesaRunning(MESA.cur), fn:()=>{} }, onSend:mesaArgue,
      hint:'Enter envia · ⇧Enter quebra linha', busyHint:mesaRunning(MESA.cur)?'a mesa está rodando — argumente quando a rodada terminar':(MESA.chatBusy?'esperando a resposta…':'') });
    bindClick('mesaArgSend', mesaArgue);
  }
}

bindClick('mesaBtn', ()=>{ const mm=$id('moreMenu'); if(mm) mm.style.display='none'; if(window.openTab) window.openTab('mesa'); else openMesa(); });
{ const ov=$id('mesaOverlay'); if(ov) ov.addEventListener('click',e=>{ if(e.target.id==='mesaOverlay') ovHide('mesaOverlay'); }); }
bindClick('mesaClose', ()=>ovHide('mesaOverlay'));
