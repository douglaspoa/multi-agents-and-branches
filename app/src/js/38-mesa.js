/* ===== MESA DE PERSONAS (party mode) — decidir "o que construir a seguir" com uma mesa de vozes =====
   Aba "mesa": o usuário escreve o tema; personas independentes (uma chamada ao claude cada, com o cérebro
   do projeto) passam por RODADA 1 (posição + propostas, sem ver as outras) e RODADA 2 (debate + voto:
   top 5 com peso 5→1 e vetos). A apuração é uma função pura (mesaTally) e a decisão sai da tabela +
   as escolhas do usuário (mesaDecision) — nunca de uma persona sozinha. Argumentar com a mesa abre uma
   rodada de revoto; com uma persona, só ela responde. Aprovadas viram demandas (épico ou tarefas) e uma
   nota "decisão" no cérebro. A discussão inteira mora só local: .cardume/mesas/<id>.json (mesa.rs). */

// @puro-inicio — funções sem DOM (testadas em app/tests/mesa.test.mjs)
const MESA_MODEL='claude-sonnet-5'; // só a RÉGUA da estimativa de custo — a mesa usa a IA escolhida no seletor único (F4 · D12), não um modelo fixo
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
const MESA_JSON_VOTO='{"fala":"sua reação ao debate em 1-2 parágrafos curtos","top5":[{"id":"F1","peso":5,"porque":"..."}],"vetos":[{"id":"F2","motivo":"..."},{"texto":"princípio que não pode entrar","motivo":"..."}],"observacoes":"(opcional) ideia nova que não está na lista"}';
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
  return `Tema da mesa: "${tema}"\n\nREVOTO — a pessoa dona do projeto trouxe um argumento novo pra mesa:\n> ${String(argumento||'').replace(/\n/g,'\n> ')}\n\nComo a mesa estava na última rodada:\n\n${falas}\n\nApuração até aqui:\n${ap||'(nenhum voto válido)'}\n\nFeatures em votação:\n${mesaCandsText(cands)}\n\nLeve o argumento a sério — ele pode mudar ou não o seu voto; diga por quê na fala. Só dá pra votar e vetar as features da lista (${(cands||[]).map(c=>c.id).join(', ')}) — o revoto NÃO cria feature nova; se o argumento te deu uma ideia nova, escreva no campo "observacoes". Depois ${mesaVoteAsk(cands)}`;
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
  const ids=new Set((candIds||[]).map(String)), warns=[], maxPeso=Math.min(5, ids.size);
  const normId=v=>String(v==null?'':v).trim().toUpperCase().replace(/^F?\s*(\d+)$/,'F$1');
  const src=Array.isArray(o.top5)?o.top5:Array.isArray(o.top)?o.top:Array.isArray(o.votos)?o.votos:null;
  if(!src) return { ok:false, erro:'o JSON não tem a lista top5', warns };
  const top=[], usedId=new Set(), usedPeso=new Set();
  for(const x of src){
    if(!x||typeof x!=='object'){ warns.push('item de voto inválido ignorado'); continue; }
    const id=normId(x.id!=null?x.id:x.feature), peso=Number(x.peso!=null?x.peso:x.weight);
    if(!ids.has(id)){ warns.push('voto em feature desconhecida ('+(id||'sem id')+') ignorado'); continue; }
    if(!Number.isInteger(peso)||peso<1||peso>maxPeso){ warns.push('peso inválido em '+id+' ('+(x.peso)+', vai de 1 a '+maxPeso+') ignorado'); continue; }
    if(usedId.has(id)){ warns.push(id+' votada duas vezes — valeu a primeira'); continue; }
    if(usedPeso.has(peso)){ warns.push('peso '+peso+' repetido ('+id+') ignorado'); continue; }
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
  const obs=String(o.observacoes||o.observações||'').trim().slice(0,600);
  return { ok:true, vote:Object.assign({ fala:String(o.fala||o.debate||o.posicao||'').trim(), top, vetos }, obs?{ obs }:{}), warns };
}
// resposta de voto de UMA persona: 1ª tentativa ok → vale; malformada → pede de novo UMA vez; 2ª ruim → voto
// descartado com aviso (a persona respondeu — não é "falhou")
function mesaVoteOutcome(first, retry, rawText){
  if(first && first.ok) return { kind:'ok', vote:first.vote, warns:first.warns||[] };
  if(!retry) return { kind:'retry' };
  if(retry.ok) return { kind:'ok', vote:retry.vote, warns:retry.warns||[] };
  const txt=(mesaParseJson(rawText)||{}).fala||rawText||'';
  return { kind:'discard', erro:retry.erro||(first&&first.erro)||'voto inválido', texto:String(txt).trim() };
}
// quem ainda falta responder numa rodada; withFailed (Continuar / tentar de novo) inclui quem falhou
function mesaRoundMissing(m, r, withFailed){ return (m.personas||[]).filter(p=>{ const x=r.resp&&r.resp[p.id]; return !x || x.st==='pendente' || x.st==='parada' || (withFailed && x.st==='falhou'); }); }
// quem falhou (erro da IA, limite) na ÚLTIMA rodada — numa mesa concluída ficava de fora sem jeito de refazer.
// "Tentar de novo" refaz a 1ª rodada com falha (mesaNextStep com withFailed): se uma rodada anterior também
// tem falha, refazer lá não mudaria a apuração de agora — então aí não oferece (lista vazia).
function mesaFailed(m){
  const rs=(m&&m.rounds)||[], ps=(m&&m.personas)||[]; if(!rs.length) return [];
  const f=r=>ps.filter(p=>{ const x=r.resp&&r.resp[p.id]; return x && x.st==='falhou'; });
  if(rs.slice(0,-1).some(r=>f(r).length)) return [];
  return f(rs[rs.length-1]);
}
function mesaRoundValid(r){ return Object.values((r&&r.resp)||{}).filter(x=>x && x.st==='ok' && (r.tipo!=='voto' || x.voto)).length; }
// próximo passo da mesa: rodar uma rodada / abrir a votação / concluída / interrompida (rodada sem nenhuma resposta válida)
function mesaNextStep(m, withFailed){
  for(const r of (m.rounds||[])){
    if(mesaRoundMissing(m, r, withFailed).length) return { kind:'run', round:r };
    if(!mesaRoundValid(r)) return { kind:'interrupted', round:r };
  }
  if(!mesaVoteRounds(m).length && (m.rounds||[]).length){
    const cands=mesaCandidates(m.personas, m.rounds[0].resp);
    return cands.length ? { kind:'open-vote', cands } : { kind:'concluded', aviso:'Nenhuma persona trouxe proposta válida — não há o que votar. Rode de novo com outro tema ou outras personas.' };
  }
  return { kind:'concluded' };
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
const MESA_RETRY_MARGIN=1.15; // rodada de voto: margem pro voto malformado que é pedido de novo
function mesaCost(nPersonas, nRounds, model, est){
  const calls=Math.max(1,+nPersonas||1)*(1+(Math.max(1,+nRounds||1)-1)*MESA_RETRY_MARGIN);
  const m=String(model||'').toLowerCase().replace(/.*(opus|sonnet|haiku).*/,'$1');
  const base=typeof est==='function'?est(calls, m):null;
  if(Array.isArray(base)) return [base[0]*MESA_TURN, base[1]*MESA_TURN];
  const per=({ opus:[0.16,0.64], sonnet:[0.05,0.20], haiku:[0.012,0.05] })[m]||[0.06,0.26];
  return [per[0]*calls, per[1]*calls];
}
// TETO EM US$ (F4 · D13): era R$ na Mesa e US$ na Ideia. Mesa antiga (capBrl) migra pelo câmbio da época da leitura.
function mesaCapUsdOf(m, rate){ if(!m) return 0; if(m.capUsd!=null && isFinite(+m.capUsd)) return Math.max(0, +m.capUsd); return +m.capBrl>0 ? Math.round(+m.capBrl/(+rate>0?+rate:5.5)*100)/100 : 0; }
function mesaCapHit(usd, capUsd){ return +capUsd>0 && (+usd||0) >= +capUsd; }
// personas: as padrão + ajustes deste computador (over) + as criadas aqui (custom) + as geradas pro projeto (gen).
// Campos editáveis: nome, papel, desc (a voz), ativa (senta por padrão). Ids nunca mudam (as rodadas guardam por id).
function mesaPersonaMerge(base, over, custom, gen){
  over=over||{}; const pick=p=>{ const o=over[p.id]||{}; return Object.assign({}, p, { nome:String(o.nome||p.nome).slice(0,30), papel:String(o.papel||p.papel||'').slice(0,60), desc:String(o.desc||p.desc||'').slice(0,600), ativa:o.ativa!=null?!!o.ativa:(p.ativa!==false) }); };
  const seen=new Set(), out=[];
  for(const [list, tag] of [[base,'padrao'],[custom,'custom'],[gen,'gerada']]) for(const p of (list||[])){ if(!p||!p.id||seen.has(p.id)) continue; seen.add(p.id); out.push(Object.assign(pick(p), { origem:tag, gerada:tag==='gerada' })); }
  return out;
}
// TETO POR TOKENS fora do Claude: Codex/DeepSeek/gateway devolvem US$ 0 (como nas tarefas) mas informam tokens. Pra o
// teto da mesa continuar valendo, cada token vira um gasto ESTIMADO pela MESMA tabela do livro de uso (US$ por milhão:
// entrada nova, entrada em cache, saída). Espelho de src/usage-prices.json (`engines` e `fallback`) — app/tests/uso.test.mjs
// confere que é igual. Motor sem taxa → o fallback (o mais caro).
const MESA_TOK_USD={ codex:{ in:1.25, cached_in:0.125, out:10 }, deepseek:{ in:0.28, cached_in:0.028, out:0.42 }, gateway:{ in:1.25, cached_in:0.125, out:10 } };
const MESA_TOK_FALLBACK={ in:3, cached_in:0.3, out:15 };
function mesaTokUsd(engine, inTok, outTok, cachedTok){
  const r=MESA_TOK_USD[String(engine||'')]||MESA_TOK_FALLBACK;
  const i=Math.max(0,+inTok||0), c=Math.min(i, Math.max(0,+cachedTok||0));
  return ((i-c)*r.in + c*r.cached_in + Math.max(0,+outTok||0)*r.out)/1e6;
}
// o que conta pro teto: o custo real (Claude) + a estimativa por tokens (outros motores)
function mesaSpentUsd(m){ return (+m.costUsd||0)+(+m.tokUsd||0); }
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
// TETO DA SESSÃO POR CHAMADA (B1/B2 da mesa de bugs 2): várias personas rodam em paralelo e o custo só chega no fim de
// cada chamada — conferir o gasto antes de lançar deixava a mesa passar 3× do teto. Agora cada chamada RESERVA a sua
// parte do que sobra (teto − gasto − o já reservado pelas chamadas em voo) e vai pro motor com esse teto
// (`--max-budget-usd` no Claude). Sobra menor que uma chamada mínima = não lança (parou no teto).
const MESA_MIN_CALL=0.03; // = fabrica.rs MIN_CHAMADA
// quanto a PRÓXIMA chamada pode gastar: a sobra dividida pelas vagas que ainda vão abrir agora (slots), nunca além da
// sobra nem de `max`; arredonda pra BAIXO no centavo (a soma das reservas nunca passa do teto). null = não cabe.
// `want` = quanto uma fala costuma custar: com sobra curta, menos falas em paralelo (cada uma com o bastante pra
// terminar) em vez de várias que batem no teto da chamada e não entregam nada. `floor` = o custo de uma fala JÁ
// MEDIDO nesta sessão: sobra menor que isso não lança (pararia no teto da chamada sem entregar — gasto jogado fora).
function mesaCallBudget(spent, reserved, cap, slots, max, want, floor){
  const sobra=(+cap||0)-(+spent||0)-(+reserved||0);
  if(!(+cap>0) || !(sobra>=Math.max(MESA_MIN_CALL, +floor||0))) return null;
  let n=Math.max(1, Math.floor(+slots)||1);
  if(+want>0) n=Math.max(1, Math.min(n, Math.floor(sobra/+want)));
  let b=Math.max(MESA_MIN_CALL, sobra/n);
  if(+max>0) b=Math.min(b, +max);
  b=Math.floor(Math.min(b, sobra)*100+1e-9)/100;
  return b>=MESA_MIN_CALL?b:null;
}
// a "carteira" de uma sessão: reserva antes de lançar, devolve quando a chamada termina (o custo real já entrou no gasto)
function mesaPurse(spentFn, capFn, wantFn, floorFn){
  const P={ reserved:0, inflight:0,
    take(slots, max){ const b=mesaCallBudget(spentFn(), P.reserved, capFn(), slots, max, wantFn?wantFn():0, floorFn?floorFn():0); if(b!=null){ P.reserved+=b; P.inflight++; } return b; },
    give(b){ P.reserved=Math.max(0, Math.round((P.reserved-(+b||0))*1e6)/1e6); P.inflight=Math.max(0, P.inflight-1); } };
  return P;
}
// aprende quanto uma fala custa nesta sessão: a mais cara que terminou; bateu no teto da chamada = custava mais (dobra)
function mesaLearnWant(prev, r, budget){ const p=+prev||0; if(r&&r.budgetHit) return Math.max(p, 2*(+budget||0)); const c=+(r&&r.costUsd)||0; return Math.max(p, c); }
// @puro-fim

Object.assign(IC, {
  mesa:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="7.4" width="11" height="2.6" rx=".8"/><circle cx="4.6" cy="4.4" r="1.3"/><circle cx="8" cy="3.8" r="1.3"/><circle cx="11.4" cy="4.4" r="1.3"/><path d="M4.4 10v3.2M11.6 10v3.2" stroke-linecap="round"/></svg>',
  stopsq:'<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2"/></svg>',
  play:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 3.6v8.8L12 8z" stroke-linejoin="round"/></svg>',
  back:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9.8 3.5L5.3 8l4.5 4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
});
function mesaEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const MESA={ forceRepo:'', forceId:'', tab:'dec', repo:'', list:[], cur:null, view:'lista', gen:[], pick:null, tema:'', genBusy:false, runs:{}, open:{}, target:'mesa', draft:'', chatBusy:false, creating:false };
function mesaVisible(){ const o=$id('mesaOverlay'); return !!(o && o.style.display!=='none'); }
// teto padrão da mesa em US$ (o antigo "mesaCapBrl" migra uma vez pelo câmbio de Ajustes)
// migra UMA vez e grava em US$: R$ 15 (o padrão antigo) ≈ US$ 2,73 no câmbio de Ajustes. "0" antigo era "sem teto": vira 0
// aqui (o campo vem vazio e pede um valor — toda mesa nova tem teto); nada guardado → US$ 2
function mesaCapBase(){
  const u=lsGet('mesaCapUsd'); if(u!=null && u!==''){ const v=parseUsd(u); return v>=0?v:2; }
  const b=lsGet('mesaCapBrl'); let v=2;
  if(b!=null && b!==''){ const n=parseUsd(b); v=n>0?Math.round(n/usdBrlRate()*100)/100:0; }
  try{ lsSet('mesaCapUsd', String(v)); }catch(_){ }
  return v; }
function mesaCapOf(m){ return mesaCapUsdOf(m, usdBrlRate()); }
// personas (editor único em Fábrica › Personas): padrão + ajustes deste computador + criadas aqui + geradas pro projeto
function mesaPersonaStore(){ try{ const o=JSON.parse(lsGet('fab:personas')||'{}'); return { over:o.over||{}, custom:Array.isArray(o.custom)?o.custom:[] }; }catch(_){ return { over:{}, custom:[] }; } }
function mesaPersonaList(gen){ const st=mesaPersonaStore(); return mesaPersonaMerge(MESA_PERSONAS, st.over, st.custom, gen==null?MESA.gen:gen); }
window.mesaPersonaList=mesaPersonaList;
// grava UMA persona onde ela mora: padrão → ajuste deste computador; criada aqui → lista deste computador; gerada → arquivo do projeto
async function mesaPersonaSave(p, repo){
  const st=mesaPersonaStore(), clean={ nome:String(p.nome||'').trim().slice(0,30)||'Persona', papel:String(p.papel||'').trim().slice(0,60), desc:String(p.desc||'').trim().slice(0,600), ativa:p.ativa!==false };
  if(p.origem==='gerada'){
    const r=repo||MESA.repo||(typeof state!=='undefined'&&state.repo); if(!r) throw new Error('abra o projeto da persona pra editar');
    const cur=await mesaPersonasRead(r); // falhou a leitura → ABORTA (nunca regrava o arquivo com uma lista vazia)
    const list=cur.personas.map(x=>x.id===p.id?Object.assign({}, x, clean):x);
    await invoke('mesa_save',{ repo:r, id:'personas', data:Object.assign({}, cur, { personas:list, at:Date.now() }) });
    if(MESA.repo===r) MESA.gen=list; return;
  }
  if(p.origem==='custom'){ st.custom=st.custom.map(x=>x.id===p.id?Object.assign({}, x, clean):x); }
  else st.over[p.id]=clean;
  lsSet('fab:personas', JSON.stringify(st));
}
// nova persona entra FORA da mesa (ativa:false) até ter nome e voz — senão sentaria em toda sessão sem jeito de falar
function mesaPersonaNew(){ const st=mesaPersonaStore(); const id='c-'+Date.now().toString(36); st.custom.push({ id, nome:'Nova persona', papel:'', desc:'', ativa:false }); lsSet('fab:personas', JSON.stringify(st)); return id; }
// lê o personas.json do projeto; QUALQUER falha (sem projeto, erro do Rust, formato estranho) lança — quem grava não grava
async function mesaPersonasRead(repo){
  if(!repo) throw new Error('abra o projeto da persona pra editar');
  const cur=await invoke('mesa_read',{ repo, id:'personas' });
  if(cur==null) return { personas:[] }; // arquivo ainda não existe: lista vazia é a verdade
  if(typeof cur!=='object' || !Array.isArray(cur.personas)) throw new Error('não consegui ler as personas do projeto — nada foi gravado');
  return cur;
}
async function mesaPersonaRemove(p, repo){
  if(p.origem==='padrao') return;
  if(p.origem==='custom'){ const st=mesaPersonaStore(); st.custom=st.custom.filter(x=>x.id!==p.id); lsSet('fab:personas', JSON.stringify(st)); return; }
  const r=repo||MESA.repo; const cur=await mesaPersonasRead(r);
  const list=cur.personas.filter(x=>x.id!==p.id); await invoke('mesa_save',{ repo:r, id:'personas', data:Object.assign({}, cur, { personas:list, at:Date.now() }) }); if(MESA.repo===r) MESA.gen=list;
}
window.mesaPersonaSave=mesaPersonaSave; window.mesaPersonaNew=mesaPersonaNew; window.mesaPersonaRemove=mesaPersonaRemove;
function mesaRunning(m){ return !!(m && MESA.runs[m.id]); }
function mesaStatusOf(m){ if(!m) return ''; if(m.status==='rodando' && !mesaRunning(m)) return 'interrompida'; return m.status||'concluida'; }
const MESA_ST={ rodando:['rodando','var(--info)'], pausada:['pausada no teto','var(--warn)'], parada:['parada','var(--muted)'], interrompida:['interrompida','var(--warn)'], concluida:['concluída','var(--accent)'], corrompida:['arquivo ilegível','var(--crit)'] };
function mesaPersonas(){ return mesaPersonaList(); }
function mesaNewId(){ return 'm-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,6); }

// ---- disco: grava a mesa a cada resposta (fila por mesa: nunca duas escritas cruzadas) ----
// _q (fila de gravação) fica fora; epicoPend._made (o que o épico já criou na nuvem) vai junto — retomar depois de fechar o app
function mesaData(m){ return JSON.parse(JSON.stringify(m, (k,v)=>(k==='_q'||k==='_saveErr')?undefined:v)); }
function mesaSave(m){
  m.updatedAt=Date.now();
  const data=mesaData(m);
  m._q=(m._q||Promise.resolve()).then(()=>invoke('mesa_save',{ repo:m.repo, id:m.id, data })).then(()=>{ m._saveErr=false; })
    .catch(e=>{ console.error('mesa: salvar', e); if(!m._saveErr){ m._saveErr=true; showErr(e,'Não consegui salvar a mesa "'+m.tema+'" no disco'); } });
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
  const want=MESA.forceRepo||state.repo, fid=MESA.forceId; MESA.forceRepo=''; MESA.forceId='';
  if(!want){ ovShow(ov); MESA.view='vazia'; mesaRender(); return; }
  if(MESA.repo!==want){
    MESA.repo=want; MESA.view='lista'; MESA.pick=null; MESA.tema=''; MESA.draft=''; MESA.target='mesa';
    // mesa de outro projeto rodando continua (salva no projeto dela); só deixa de ser a mesa na tela
    if(MESA.cur && MESA.cur.repo!==want) MESA.cur=null;
  }
  ovShow(ov);
  // lista de mesas em esqueleto na hora (mesa aberta/lista já pintada fica até a leitura chegar)
  await loadInto($id('mesaBody'), 'lista', ()=>Promise.all([mesaLoadList(), mesaLoadGen()]), ()=>{
    if(!MESA.pick) MESA.pick=new Set(mesaPersonas().filter(p=>p.ativa!==false).map(p=>p.id));
    if(fid) mesaOpenOne(fid); else { if(!MESA.cur) MESA.view='vazia'; mesaRender(); }
  }, { label:'abrindo a mesa', keep:!!MESA.cur, shape:{ wrap:'mesawrap', head:true, n:5 } });
}
window.openMesa=openMesa;
// abre UMA mesa (de Fábrica › Sessões), mesmo de outro projeto: a mesa é do projeto dela
function mesaOpenAt(repo, id){ MESA.forceRepo=repo||''; MESA.forceId=id||''; if(window.openTab) window.openTab('mesa', { mesaId:id }); else openMesa(); }
window.mesaOpenAt=mesaOpenAt;
async function mesaOpenOne(id){
  // a mesa que está rodando fica em memória (é ela que recebe as respostas) — nunca relê por cima dela
  const live=Object.values(MESA.runs).map(r=>r.m).find(m=>m.id===id && m.repo===MESA.repo);
  let m=live;
  // arquivo ilegível (a lista já sabe: status "corrompida") — o mesa_read só devolveria o erro do serde em inglês
  if(!m && ((MESA.list||[]).find(x=>x.id===id)||{}).status==='corrompida'){ mesaCorrupt(id); return; }
  if(!m){ try{ m=await invoke('mesa_read',{ repo:MESA.repo, id }); }catch(e){ showErr(e,'Não consegui abrir a mesa'); return; } }
  if(!m){ toast('Essa mesa não existe mais.','warn'); await mesaLoadList(); mesaRender(); return; }
  if(!live) m.repo=MESA.repo; // o caminho gravado no JSON pode estar velho (pasta movida): vale a pasta de onde foi lida
  if(m.capUsd==null){ m.capUsd=mesaCapUsdOf(m, usdBrlRate()); if(m.capBase!=null && +m.capBrl>0) m.capBase=Math.round(+m.capBase/usdBrlRate()*100)/100; mesaSave(m); } // mesa antiga em R$: migra UMA vez (capBrl 0 = "sem teto" segue sem teto)
  MESA.cur=m; MESA.view='mesa'; MESA.target='mesa'; MESA.draft='';
  mesaRender();
}

function mesaCorrupt(id){
  const repo=MESA.repo, dir=repo.replace(/[\\/]+$/,'')+'/.cardume/mesas';
  toast(`O arquivo desta mesa (.cardume/mesas/${id}.json) está ilegível — foi editado ou cortado fora do app. Restaure pelo git ou apague a mesa.`,'warn',
    { label:'abrir pasta', fn:()=>invoke('open_folder',{ path:dir }).catch(e=>showErr(e,'Não consegui abrir a pasta')) },
    { label:'apagar', fn:async()=>{
      if(!await askYes(`Apagar o arquivo .cardume/mesas/${id}.json? Não dá pra desfazer (a não ser pelo git).`,'Apagar mesa')) return;
      try{ await invoke('mesa_delete',{ repo, id }); toast('Mesa apagada.','ok'); }catch(e){ showErr(e,'Não consegui apagar a mesa'); }
      if(MESA.repo===repo){ await mesaLoadList(); mesaRender(); } } });
}

// ---- chamada de UMA persona ----
// budget: o teto DESTA chamada (US$) reservado na carteira da sessão; acc.usd soma o que esta chamada custou
async function mesaAsk(m, sys, prompt, json, budget, acc){
  const r=await invoke('mesa_ask',{ repo:m.repo, id:m.id, personaSys:sys, prompt, model:m.model||null, json:!!json, budgetUsd:budget>0?budget:null });
  const c0=mesaSpentUsd(m); m.callWant=mesaLearnWant(m.callWant, r, budget);
  m.costUsd=(+m.costUsd||0)+(+(r&&r.costUsd)||0); // erro do claude também cobra — entra no gasto
  { const tok=(+(r&&r.inTok)||0)+(+(r&&r.outTok)||0); // fora do Claude: US$ 0 + tokens → teto por tokens
    if(!(+(r&&r.costUsd)>0) && tok>0){ m.tokens=(+m.tokens||0)+tok; m.tokUsd=(+m.tokUsd||0)+mesaTokUsd(r.engine, r.inTok, r.outTok, r.cachedTok); } }
  if(acc) acc.usd=(+acc.usd||0)+(mesaSpentUsd(m)-c0);
  if(r && r.error) throw new Error(r.error);
  return String((r&&r.text)||'');
}
function mesaErrMsg(e){ try{ const h=humanErr(e); return h.msg; }catch(_){ return String(e&&e.message||e); } }

// ---- orquestração: rodada por rodada, personas em paralelo, stop, teto entre rodadas ----
const MESA_POOL=3; // personas ao mesmo tempo (várias chamadas ao claude em paralelo pesam na máquina e na cota)
// teto batido: a mesa PAUSA e mostra o "Aviso do Starfork" inline (sem janela por cima) com "continuar com +US$ X"
function mesaCapAsk(m, what){
  m.capAviso={ what, base:m.capBase||mesaCapBase(), at:Date.now() };
  return Promise.resolve(false);
}
// opts.retryFailed: Continuar / tentar de novo — quem falhou entra de novo (só na 1ª passada, senão repetiria pra sempre)
async function mesaRun(m, opts){
  if(mesaRunning(m)) return;
  const run={ stop:false, m }; MESA.runs[m.id]=run;
  let withFailed=!!(opts&&opts.retryFailed);
  try{ await invoke('mesa_resume',{ id:m.id }); }catch(_){ }
  m.status='rodando'; m.aviso=''; m.capAviso=null; await mesaSave(m); mesaPaint(m);
  try{
    for(;;){
      if(run.stop){ m.status='parada'; break; }
      const wf=withFailed, step=mesaNextStep(m, wf); withFailed=false;
      if(step.kind==='open-vote'){ // rodada 1 fechou: features em votação + rodada 2
        m.cands=step.cands;
        m.rounds.push({ n:m.rounds.length+1, tipo:'voto', titulo:'Debate e voto', resp:{}, avisos:[] });
        MESA.open[m.id]=null; continue; }
      if(step.kind==='concluded'){ m.status='concluida'; if(step.aviso) m.aviso=step.aviso; break; }
      if(step.kind==='interrupted'){ m.status='interrompida'; m.aviso=`Rodada ${step.round.n}: nenhuma persona deu uma resposta válida — veja o erro de cada uma e tente de novo.`; break; }
      const r=step.round;
      // o teto é conferido antes de CADA persona começar (mesaRunRound) — aqui é o aviso de início de rodada
      if(mesaCapHit(mesaSpentUsd(m), mesaCapOf(m))){ mesaPaint(m); if(!await mesaCapAsk(m, `rodar "${r.titulo}"`)){ m.status='pausada'; break; } }
      const capped=await mesaRunRound(m, r, run, wf);
      if(capped && !run.stop){ mesaPaint(m); if(!await mesaCapAsk(m, `terminar "${r.titulo}"`)){ m.status='pausada'; break; } }
    }
  }catch(e){ console.error('mesa:', e); m.status='parada'; showErr(e,'A mesa parou'); }
  finally{
    delete MESA.runs[m.id];
    await mesaSave(m);
    if(MESA.repo===m.repo){ await mesaLoadList(); if(MESA.view==='lista') mesaPaint(m); }
    mesaPaint(m);
    if(m.status==='concluida' && mesaVoteRounds(m).length && !(mesaVisible() && MESA.cur===m)) toast(`Mesa "${m.tema}" concluída — veja a votação e aprove as features.`,'ok',{ label:'abrir', fn:()=>mesaOpenAt(m.repo, m.id) });
  }
}
// roda quem falta, no máximo MESA_POOL por vez; devolve true se parou de lançar porque bateu no teto
async function mesaRunRound(m, r, run, withFailed){
  const todo=mesaRoundMissing(m, r, withFailed);
  r.resp=r.resp||{}; r.avisos=r.avisos||[];
  todo.forEach(p=>{ r.resp[p.id]={ st:'pendente' }; });
  mesaPaint(m);
  const idx=m.rounds.indexOf(r), prevVote=mesaVoteRounds(m).filter(x=>m.rounds.indexOf(x)<idx).pop();
  const candIds=(m.cands||[]).map(c=>c.id);
  const prompt=r.tipo==='posicao'?mesaR1Prompt(m.tema)
    :(r.argumento && prevVote)?mesaArgPrompt(m.tema, m.personas, prevVote.resp, m.cands, mesaTally(m.cands, mesaVotesOf(prevVote), m.personas), r.argumento)
    :mesaR2Prompt(m.tema, m.personas, m.rounds[0].resp, m.cands);
  const STOP=new Error('MESA_STOPPED');
  const one=async(p, budget)=>{
    const sys=mesaPersonaSys(p), acc={ usd:0 };
    const chk=()=>{ if(run.stop) throw STOP; };
    try{
      chk();
      const text=await mesaAsk(m, sys, prompt, true, budget, acc); chk();
      if(r.tipo==='posicao'){
        const x=mesaParsePosition(text);
        r.resp[p.id]={ st:'ok', texto:x.texto, propostas:x.propostas, aviso:x.aviso||'', at:Date.now() };
        if(x.aviso) r.avisos.push(p.nome+': '+x.aviso);
      } else {
        const first=mesaParseVote(text, candIds);
        let out=mesaVoteOutcome(first, null, text), raw=text;
        const left=Math.floor((budget-acc.usd)*100)/100; // a nova tentativa usa o que sobrou da reserva desta persona
        if(out.kind==='retry' && left>=MESA_MIN_CALL){ // voto malformado: UMA nova tentativa pedindo só o JSON
          r.resp[p.id]={ st:'pendente', aviso:'voto malformado — pedindo de novo só o JSON' }; mesaPaint(m);
          raw=await mesaAsk(m, sys, prompt+MESA_RETRY, true, left, acc); chk();
          out=mesaVoteOutcome(first, mesaParseVote(raw, candIds), raw);
        }
        if(out.kind==='retry') out=mesaVoteOutcome(first, mesaParseVote('', candIds), raw); // sem reserva pra tentar de novo: descarta
        if(out.kind==='ok'){
          r.resp[p.id]={ st:'ok', texto:out.vote.fala, voto:out.vote, aviso:out.warns.join(' · '), at:Date.now() };
          if(out.warns.length) r.avisos.push(p.nome+': '+out.warns.join(' · '));
        } else {
          r.resp[p.id]={ st:'ok', texto:out.texto, voto:null, aviso:'voto descartado ('+out.erro+')', at:Date.now() };
          r.avisos.push(p.nome+': voto descartado ('+out.erro+')');
        }
      }
    }catch(e){
      const msg=String(e&&e.message||e);
      if(/MESA_BUDGET/.test(msg)){ r.resp[p.id]={ st:'parada', aviso:'parou no teto desta fala' }; budgetHit=true; } // volta pra fila: roda de novo depois de aumentar o teto
      else r.resp[p.id]=(run.stop||/MESA_STOPPED/.test(msg))?{ st:'parada' }:{ st:'falhou', erro:mesaErrMsg(e), at:Date.now() };
    }
    await mesaSave(m); mesaPaint(m);
  };
  const queue=todo.slice(); let capped=false, budgetHit=false;
  // cada persona reserva a sua parte do que sobra do teto ANTES de lançar (as em voo já reservaram a delas)
  const est=mesaCost(1, 1, m.model||'sonnet', typeof roughEstimate==='function'?roughEstimate:null)[1]; // pior caso de 1 fala antes de ter custo real
  const purse=mesaPurse(()=>mesaSpentUsd(m), ()=>mesaCapOf(m), ()=>+m.callWant>0?+m.callWant:est, ()=>+m.callWant||0);
  const worker=async()=>{
    while(queue.length && !run.stop && !capped){
      const b=purse.take(Math.min(MESA_POOL-purse.inflight, queue.length));
      if(b==null){ if(!purse.inflight) capped=true; break; } // sobra presa em falas em voo: a última que voltar confere de novo
      try{ await one(queue.shift(), b); }finally{ purse.give(b); }
    }
  };
  await Promise.all(Array.from({ length:Math.min(MESA_POOL, queue.length) }, worker));
  queue.forEach(p=>{ delete r.resp[p.id]; }); // não lançadas (parar/teto): voltam pra "na fila"
  if(queue.length) { await mesaSave(m); mesaPaint(m); }
  return (capped && queue.length>0) || budgetHit;
}
async function mesaStop(m){
  const run=MESA.runs[m.id]; if(!run) return;
  run.stop=true; mesaPaint(m);
  try{ await invoke('mesa_stop',{ id:m.id }); }catch(_){ }
}

// ---- criar e rodar ----
// "Discutir um tema" (Fábrica › Feature): tema + quem senta + IA (seletor único) + teto em US$ → abre a aba da mesa rodando
async function mesaStartWith(o){
  o=o||{}; const repo=o.repo||state.repo, tema=String(o.tema||'').trim();
  if(!repo){ toast('Abra o projeto do tema primeiro — a mesa lê o projeto.','warn'); return false; }
  if(!tema){ toast('Escreva o tema da mesa.','warn'); return false; }
  const all=mesaPersonaList(o.gen), personas=all.filter(p=>(o.ids||[]).includes(p.id));
  if(personas.length<2){ toast('Escolha pelo menos 2 personas pra mesa.','warn'); return false; }
  let cap=+o.capUsd; if(!(cap>0)){ toast('Defina o teto da mesa em US$ (maior que 0).','warn'); return false; }
  try{ lsSet('mesaCapUsd', String(cap)); }catch(_){ }
  const m={ id:mesaNewId(), v:1, repo, tema, model:o.model||null, capUsd:cap, // o MOTOR é a IA dos chats (mesa_ask); aqui só o modelo capBase:cap, createdAt:Date.now(), updatedAt:Date.now(), status:'rodando',
    personas:personas.map(p=>({ id:p.id, nome:p.nome, papel:p.papel, desc:p.desc, gerada:!!p.gerada })),
    rounds:[{ n:1, tipo:'posicao', titulo:'Posições', resp:{}, avisos:[] }], cands:[], chats:{}, escolhas:{}, criadas:null, costUsd:0 };
  MESA.repo=repo; MESA.cur=m; MESA.view='mesa'; MESA.target='mesa'; MESA.draft=''; MESA.tab='dec';
  if(window.openTab) window.openTab('mesa', { mesaId:m.id }); mesaRender();
  mesaRun(m);
  return true;
}
window.mesaStartWith=mesaStartWith;
async function mesaGenerate(temaArg){
  if(MESA.genBusy) return;
  const tema=String(temaArg!=null?temaArg:(MESA.tema||'')).trim(); MESA.tema=tema;
  const repo=MESA.repo; // trocar de projeto no meio não pode gravar as personas no projeto errado
  MESA.genBusy=true; mesaRender();
  const tmp={ id:'personas', repo, model:(typeof aiClaudeModel==='function'?aiClaudeModel():null), costUsd:0 };
  let ok=false;
  try{
    const text=await mesaAsk(tmp, MESA_GEN_SYS, mesaGenPrompt(tema), true);
    const ps=mesaParsePersonas(text, mesaPersonaList([]).map(p=>p.id));
    if(!ps.length){ toast(`A IA não devolveu personas válidas — tente de novo (custou ${fmtCost(tmp.costUsd)}).`,'warn'); return; }
    await invoke('mesa_save',{ repo, id:'personas', data:{ personas:ps, tema, at:Date.now() } });
    ok=true;
    if(MESA.repo===repo){ MESA.gen=ps; if(MESA.pick) ps.forEach(p=>MESA.pick.add(p.id)); }
    toast(`${ps.length} personas geradas pra ${MESA.repo===repo?'este projeto':'o projeto '+pathBase(repo)} (custou ${fmtCost(tmp.costUsd)}).`,'ok');
  }catch(e){ if(!/MESA_STOPPED/.test(String(e&&e.message||e))) showErr(e,'Não consegui gerar as personas'+(tmp.costUsd?' (custou '+fmtCost(tmp.costUsd)+')':'')); }
  finally{ MESA.genBusy=false; if(!ok || MESA.repo===repo) mesaRender(); if(typeof fabHubRender==='function') fabHubRender(); }
  return ok;
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
  const askBudget=mesaCallBudget(mesaSpentUsd(m), 0, mesaCapOf(m), 1); // uma pergunta só: leva toda a sobra
  if(askBudget==null){ m.capAviso={ what:'perguntar pra '+p.nome, kind:'ask', base:m.capBase||mesaCapBase()||2, at:Date.now() }; mesaRender(); return; }
  MESA.draft=''; if(inp) inp.value='';
  const chat=(m.chats[p.id]=m.chats[p.id]||[]);
  const vr=mesaVoteRounds(m), last=vr[vr.length-1], r1=(m.rounds[0].resp||{})[p.id]||{}, lr=(last&&last.resp[p.id])||{};
  const hist={ posicao:r1.texto||'', voto:lr.voto||null, fala:lr.texto||'', cands:m.cands, chat:chat.slice() };
  chat.push({ who:'you', text });
  MESA.chatBusy=true; MESA.chatMesaId=m.id; MESA.chatStop=false; chatPinBottom('mesaChat'); mesaRender();
  try{ await invoke('mesa_resume',{ id:m.id }); }catch(_){ } // um "parar" anterior não pode recusar a pergunta
  try{
    // "parar" clicado enquanto o resume corria: o resume apagaria a marca do Rust — a flag local segura
    if(MESA.chatStop) throw new Error('MESA_STOPPED');
    const ans=await mesaAsk(m, mesaPersonaSys(p), mesaAskPrompt(m.tema, p, hist, text), false, askBudget);
    chat.push({ who:'bot', text:ans||'(sem resposta)' });
  }catch(e){
    const msg=String(e&&e.message||e);
    chat.push({ who:'sys', text:/MESA_STOPPED/.test(msg)?'Parado.':/MESA_BUDGET/.test(msg)?(p.nome+' parou no teto da mesa — aumente o teto pra perguntar de novo.'):(p.nome+' não respondeu: '+mesaErrMsg(e)) });
  }finally{ MESA.chatBusy=false; MESA.chatMesaId=''; MESA.chatStop=false; await mesaSave(m); chatPinBottom('mesaChat'); mesaPaint(m); }
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
// confirmação ancorada no botão "Criar épico…" (folha, não janela — D23); sem a folha, a pergunta de sempre
function mesaConfirm(q, title, ap){
  const b=$id('mesaCreate');
  if(!b || typeof g2SheetConfirm!=='function') return askYes(q, title);
  return new Promise(res=>{ let done=false; const fin=v=>{ if(!done){ done=true; res(v); } };
    const sh=g2SheetConfirm(b, { title, sub:'em '+pathBase((MESA.cur&&MESA.cur.repo)||state.repo||''), ok:'Criar', onOk:()=>fin(true),
      body:(ap||[]).map(r=>`<span>· ${mesaEsc(r.titulo)}</span>`).join('')+`<span class="g2help">A decisão e os votos viram nota em Projeto › Memória. Nada roda até você iniciar.</span>` });
    if(!sh){ fin(false); return; }
    const mo=new MutationObserver(()=>{ if(!sh.el.isConnected){ mo.disconnect(); setTimeout(()=>fin(false),0); } }); mo.observe(document.body,{ childList:true }); });
}
async function mesaCreate(){
  const m=MESA.cur; if(!m||MESA.creating) return;
  const D=mesaDecisionOf(m); if(!D) return;
  const done=new Set(((m.criadas&&m.criadas.itens)||[]).map(x=>x.fid));
  // épico que caiu no meio: "Criar demandas" de novo RETOMA o mesmo épico (idempotente), não vira tarefa solta
  // A retomada segue a decisão ATUAL: o que você rejeitou depois sai do épico; o que já foi criado fica criado.
  const resume=m.epicoPend||null;
  const madeRows=(resume&&resume._made&&resume._made.rows)||{}, isMade=t=>!!madeRows['i'+t.idx];
  const apIds=new Set(D.dec.aprovadas.map(r=>r.id));
  const ap=resume?D.dec.aprovadas.filter(r=>resume.tasks.some(t=>t.fid===r.id && !isMade(t)) && !done.has(r.id)):D.dec.aprovadas.filter(r=>!done.has(r.id));
  if(resume && !ap.length && resume._made && resume._made.ep){ // nada mais a criar no épico: fecha a pendência
    m.criadas=Object.assign({}, m.criadas||{}, { epico:{ id:resume._made.ep.id, name:resume._made.ep.name } }); m.epicoPend=null; await mesaSave(m); mesaPaint(m);
    if(!D.dec.aprovadas.some(r=>!done.has(r.id) && !resume.tasks.some(t=>t.fid===r.id))) { toast('O épico da mesa está completo.','ok'); return; }
    return mesaCreate(); }
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
  if(!await mesaConfirm(q, asEpic?`Criar épico com ${ap.length} demanda${ap.length===1?'':'s'}`:'Criar demandas', ap)) return;
  MESA.creating=true; mesaPaint(m);
  const itens=[], faltou=[];
  const obj=r=>{ const c=(m.cands||[]).find(x=>x.id===r.id)||{}; return ((c.descricao||r.titulo)+'\n\n'+mesaJustify(m, r)).trim(); };
  try{
    if(asEpic){
      if(plPlanCtx && plPlanCtx.origin && !(m.epicoPend && plPlanCtx.origin.mesa===m.id)){ toast('Feche o "Desdobrar" aberto antes — ele usa o mesmo cartão de épico.','warn'); return; }
      // hospeda o plCreateEpic (o mesmo do planner/desdobrar): idempotente — tentar de novo não repete o que já foi criado
      const plan=resume||{ epic:('Mesa: '+m.tema).slice(0,80), outcome:'', requirements:[],
        doneWhen:ap.map(r=>r.titulo+' entregue').slice(0,6), boundaries:[],
        tasks:ap.map((r,i)=>({ idx:i, fid:r.id, title:r.titulo.slice(0,90), objective:obj(r), requirements:[], owns:'', verify:'', covers:[], after:[], risk:'', hitl:false, boundaries:[], wave:1, on:true })) };
      const livres=(D.tally.vetosLivres||[]).map(v=>v.texto+(v.motivo?' — '+v.motivo:'')).slice(0,6); if(livres.length) plan.boundaries=livres;
      if(resume) plan.tasks.forEach(t=>{ if(isMade(t)){ t.on=true; return; } t.on=apIds.has(t.fid); const row=D.dec.rows.find(r=>r.id===t.fid); if(t.on && row) t.objective=obj(row); });
      m.epicoPend=plan; let made=null;
      await mesaSave(m); // o plano (e o _made que o plCreateEpic vai preenchendo) está no disco ANTES do 1º insert
      bdPlan=plan; plPlanRender=()=>{};
      plPlanCtx={ origin:{ title:'mesa '+m.tema, mesa:m.id }, originNote:'', stay:true, noStartPrompt:true, onMade:()=>mesaSave(m),
        description:`Decidido na mesa de personas "${m.tema}" (${(m.personas||[]).map(p=>p.nome).join(', ')}).`, onDone:ep=>{ made=ep; }, onDiscard:()=>{} };
      try{ await plCreateEpic(); }
      finally{ if(plPlanCtx && plPlanCtx.origin && plPlanCtx.origin.mesa===m.id){ plPlanCtx={}; plPlanRender=null; bdPlan=null; } await mesaSave(m); }
      const rows=(plan._made&&plan._made.rows)||{};
      plan.tasks.forEach(t=>{ const row=rows['i'+t.idx]; if(row){ if(!done.has(t.fid)) itens.push({ fid:t.fid, titulo:t.title, cloudId:row.id }); } else if(t.on) faltou.push(t.title); });
      if(made){ m.epicoPend=null; m.criadas=Object.assign({}, m.criadas||{}, { epico:{ id:made.id, name:made.name } }); }
    } else {
      for(const r of ap){
        const payload={ start:false, title:r.titulo.slice(0,90), workflow:null, agents:null, engine:defaultAiEngine(), model:defaultAiModel(), approval:'auto', owns:null, off:null,
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
    let r;
    try{ r=await invoke('memory_write',{ repo:m.repo, scope:sc, slug:prev?prev.slug:null, content:memSerialize(note), expectMtime:null, create:!prev }); }
    catch(e){ if(!prev) throw e; // a nota anterior sumiu (apagada/movida na Memória): cria uma nova
      r=await invoke('memory_write',{ repo:m.repo, scope, slug:null, content:memSerialize(note), expectMtime:null, create:true }); }
    m.criadas=m.criadas||{}; m.criadas.nota={ scope:r.scope||sc, slug:r.slug||(prev&&prev.slug) };
    await mesaSave(m);
    if(m.criadas.nota.scope==='time' && typeof memTeamSync==='function') memTeamSync().catch(()=>{});
  }catch(e){ showErr(e,'As demandas foram criadas, mas não consegui gravar a nota de decisão no cérebro'); }
}

// ---------------- tela (F4 · G2: Fábrica › Feature › Discutir um tema) ----------------
// a lista e a "Nova mesa" foram pra Fábrica (Sessões e o cartão "Discutir um tema"); aqui fica a MESA ABERTA:
// votação + rodadas recolhíveis à esquerda, painel "Sua decisão | Argumentar" à direita, "Criar épico" com folha ancorada.
function mesaPaint(m){ if(mesaVisible() && MESA.view==='mesa' && MESA.cur===m) mesaRender(); }
function mesaCapture(){
  const a=$id('mesaArgIn'); if(a) MESA.draft=a.value;
  const t=$id('mesaTema'); if(t) MESA.tema=t.value;
}
function mesaRender(){
  const body=$id('mesaBody'); if(!body) return;
  mesaCapture();
  const html='<div class="g2page mesawrap">'+(MESA.view==='mesa'&&MESA.cur?mesaMesaHtml(MESA.cur):mesaVaziaHtml())+'</div>';
  if(body.__html===html) return; // nada mudou: não mexe no DOM (foco, seleção e rolagem ficam)
  const scr=body.querySelector('.mesascroll'), top=scr?scr.scrollTop:0;
  const keep=stickBottom($id('mesaChat'));
  const ae=document.activeElement, fid=ae&&body.contains(ae)&&ae.id?ae.id:null;
  const sel=fid&&typeof ae.selectionStart==='number'?[ae.selectionStart, ae.selectionEnd]:null;
  body.innerHTML=html; body.__html=html;
  const scr2=body.querySelector('.mesascroll'); if(scr2) scr2.scrollTop=top;
  keep($id('mesaChat'));
  const a=$id('mesaArgIn'); if(a && a.value!==MESA.draft) a.value=MESA.draft;
  if(fid){ const el=$id(fid); if(el){ el.focus(); if(sel && typeof el.setSelectionRange==='function') try{ el.setSelectionRange(sel[0], sel[1]); }catch(_){ } } }
  mesaWire(body);
  try{ const t=(typeof TABS!=='undefined'?TABS:[]).find(x=>x.kind==='mesa'); const nt=MESA.cur?('Mesa: '+MESA.cur.tema).slice(0,28):'Mesa'; if(t && t.title!==nt){ t.title=nt; if(typeof renderTabs==='function') renderTabs(); } }catch(_){ }
}
function mesaCrumb(){ return `<nav class="g2crumb" aria-label="Você está em"><button type="button" data-mgo="nova">Fábrica</button>›<button type="button" data-mgo="sessoes">Sessões</button>› mesa</nav>`; }
// sem mesa escolhida (aba restaurada, projeto sem mesas): orienta pra Fábrica — nunca uma aba vazia
function mesaVaziaHtml(){
  return mesaCrumb()+(typeof pageHead==='function'?pageHead({ title:'Mesa', sub:'Mesa: pontos de vista que debatem e votam features. Nada vira demanda sem você aprovar.' }):'')+
    `<div class="g2empty">${IC.mesa}<b>Nenhuma mesa aberta.</b><p>As mesas ficam em Fábrica › Sessões. Pra começar uma, use "Discutir um tema" em Fábrica › Nova sessão (Feature neste projeto).</p><div class="g2row"><button type="button" class="btn primary" data-mgo="nova-feat">Discutir um tema</button><button type="button" class="btn" data-mgo="sessoes">Ver as mesas</button></div></div>`;
}
function mesaStBadge(st){ const x={ rodando:'run', pausada:'blk', parada:'idle', interrompida:'rev', concluida:'ok', corrompida:'blk' }[st]||'idle'; return `<span class="g2status s-${x}">${mesaEsc((MESA_ST[st]||[st])[0])}</span>`; }
function mesaPersonaCard(m, r, p){
  const x=(r.resp||{})[p.id];
  const run=MESA.runs[m.id];
  let st, body='';
  if(!x) st=`<em>na fila</em>`;
  else if(x.st==='pendente' && !run) st=`<em>interrompida — continue a mesa</em>`;
  else if(x.st==='pendente') st=(run&&run.stop)?`<em>parando…</em>`:`<em class="live"><span class="pltyping"><i></i><i></i><i></i></span>${x.aviso?mesaEsc(x.aviso):'pensando…'}</em>`;
  else if(x.st==='parada') st=`<em>parada</em>`;
  else if(x.st==='falhou'){ st=`<em class="w">não respondeu</em>`; body=`<p class="g2help">${mesaEsc(x.erro||'')}</p>`; }
  else {
    st=`<em class="ok">respondeu</em>`;
    body=(x.aviso?`<div class="g2help">${mesaEsc(x.aviso)}</div>`:'')+`<div class="mdview mesamd">${mdToHtml(x.texto||'*(sem texto)*')}</div>`;
    if(r.tipo==='posicao' && (x.propostas||[]).length) body+=`<div class="mesaprops">${x.propostas.map(q=>`<div><b>Propõe:</b> ${mesaEsc(q.titulo)}${q.descricao?' — '+mesaEsc(q.descricao):''}${q.porque?`<span class="dim"> · porquê: ${mesaEsc(q.porque)}</span>`:''}</div>`).join('')}</div>`;
    if(r.tipo==='voto' && x.voto){
      const t=id=>((m.cands||[]).find(c=>c.id===id)||{}).titulo||id;
      if(x.voto.obs) body+=`<div class="mesaobs"><span class="dim">Observação:</span> ${mesaEsc(x.voto.obs)}</div>`;
      body+=`<div class="mesavotes">${x.voto.top.map(v=>`<span class="mesav" title="${mesaEsc(v.porque||'')}"><i>${v.peso}</i>${mesaEsc(t(v.id))}</span>`).join('')}${(x.voto.vetos||[]).map(v=>`<span class="mesav veto" title="${mesaEsc(v.motivo||'')}"><i>veto</i>${mesaEsc(v.id?t(v.id):v.texto)}</span>`).join('')}</div>`;
    }
  }
  return `<div class="g2pline${x&&x.st==='falhou'?' fail':''}"><span class="g2pav" aria-hidden="true">${mesaEsc(p.nome.charAt(0))}</span><div><div class="g2nm">${mesaEsc(p.nome)} <small>${mesaEsc(p.papel)}</small>${st}</div>${body}</div></div>`;
}
function mesaRoundHtml(m, r, isLast){
  const ps=m.personas||[], ok=ps.filter(p=>{ const x=(r.resp||{})[p.id]; return x&&x.st==='ok'; }).length;
  const openSet=MESA.open[m.id]; const open=openSet?openSet.has(r.n):isLast;
  const lbl=r.tipo==='posicao'?'posições':(r.argumento?'novo voto depois do seu argumento':'debate e voto');
  return `<details class="g2rd mesaround" data-mround="${r.n}"${open?' open':''}><summary>Rodada ${r.n} — ${lbl} <span>${ok} de ${ps.length} responderam${(r.avisos||[]).length?` · ${r.avisos.length} aviso${r.avisos.length===1?'':'s'}`:''}</span></summary><div class="rb">`+
    (r.argumento?`<span class="g2help">seu argumento: “${mesaEsc(r.argumento)}”</span>`:'')+
    ((r.avisos||[]).length?`<div class="g2help">${r.avisos.map(mesaEsc).join('<br>')}</div>`:'')+
    `${ps.map(p=>mesaPersonaCard(m, r, p)).join('')}</div></details>`;
}
function mesaTableHtml(m, D){
  const ps=m.personas||[], diff=D.prev?mesaDiff(D.prev, D.tally):null, nome=pid=>(ps.find(p=>p.id===pid)||{}).nome||pid;
  const head=`<tr><th>Feature</th>${ps.map(p=>`<th title="${mesaEsc(p.papel)}">${mesaEsc(p.nome)}</th>`).join('')}<th>Total</th>${diff?'<th>antes → depois</th>':''}<th>Decisão</th></tr>`;
  const todosDiz=D.dec.rows.some(r=>!r.todos);
  const rows=D.dec.rows.map(r=>{
    const d=diff&&diff[r.id];
    const tags=(r.sugerida&&!r.escolha?'<span class="g2tag">sugerida</span>':'')+(r.todos&&todosDiz?'<span class="g2tag">voto de todos</span>':'')+(r.empate?'<span class="g2tag">empate</span>':'')+(r.vetadoPor.length?`<span class="g2tag v">vetada por ${mesaEsc(r.vetadoPor.map(nome).join(', '))}</span>`:'');
    return `<tr class="st-${r.status}${r.escolha==='rejeitada'||(!r.escolha&&r.status==='vetada')?' rej':''}"><td>${mesaEsc(r.titulo)}${tags}</td>`+
      ps.map(p=>{ const w=r.pesos[p.id]; return `<td class="c${!w&&r.vetadoPor.includes(p.id)?' veto':''}">${w?w:(r.vetadoPor.includes(p.id)?'✕ vetou':'<span class="dim">–</span>')}</td>`; }).join('')+
      `<td class="c tot">${r.total}</td>`+(diff?`<td class="c">${d.antes} → ${d.depois}</td>`:'')+
      `<td><span class="g2yn"><button type="button" class="y${r.escolha==='aprovada'?' on':''}" data-mchoose="${mesaEsc(r.id)}:aprovada" aria-pressed="${r.escolha==='aprovada'}" aria-label="aprovar ${mesaEsc(r.titulo)}" title="aprovar">${IC.ok}</button><button type="button" class="n${r.escolha==='rejeitada'?' on':''}" data-mchoose="${mesaEsc(r.id)}:rejeitada" aria-pressed="${r.escolha==='rejeitada'}" aria-label="rejeitar ${mesaEsc(r.titulo)}" title="rejeitar">${IC.x}</button></span></td></tr>`;
  }).join('');
  return `<div class="g2tablew"><table class="g2vtable"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}
function mesaMesaHtml(m){
  const st=mesaStatusOf(m), running=mesaRunning(m), run=MESA.runs[m.id];
  const cap=mesaCapOf(m), spent=mesaSpentUsd(m);
  const acts=(running?`<button class="btn" id="mesaStop"${run&&run.stop?' disabled':''}>${IC.stopsq}${run&&run.stop?'parando…':'Parar'}</button>`:'')+
    (!running && ['pausada','parada','interrompida'].includes(st) && !m.capAviso?`<button class="btn primary" id="mesaCont">${IC.play}${m.status==='interrompida'?'Tentar de novo':'Continuar'}</button>`:'')+
    `<button type="button" class="btn icon quiet" id="mesaMore" title="Mais: tentar de novo com quem falhou · abrir pasta" aria-label="Mais ações" aria-haspopup="menu">${IC.dots||'⋯'}</button>`;
  const money=`${mesaStBadge(st)} gastou <b>${mesaEsc(fmtCost(spent,{ usdOnly:true }))}</b>${cap>0?' de <b>'+mesaEsc(fmtCost(cap,{ usdOnly:true }))+'</b>':''}`; // gasto e teto sempre visíveis (B3)
  const sum=`<span>${(m.personas||[]).length} personas · ${(m.rounds||[]).length} rodada${(m.rounds||[]).length===1?'':'s'} · ≈ R$ ${mesaEsc(fmtNumBR(spent*usdBrlRate(), true))}${+m.tokUsd>0?' · teto por tokens (parte estimada pelos tokens da IA)':''}</span>`;
  const head=mesaCrumb()+(typeof pageHead==='function'?pageHead({ title:'Mesa: '+m.tema, scope:'projeto', scopeLabel:pathBase(m.repo), money, sum, right:acts, sub:`Mesa: ${(m.personas||[]).length} pontos de vista que debatem e votam features. Nada vira demanda sem você aprovar.` }):`<h1>Mesa: ${mesaEsc(m.tema)}</h1>`);
  const D=mesaDecisionOf(m);
  const capAv=m.capAviso?`<div class="g2capbox" role="status"><span><b>Aviso do Starfork:</b> a mesa chegou no teto de ${mesaEsc(fmtCost(cap,{ usdOnly:true }))} (gastou ${mesaEsc(fmtCost(spent,{ usdOnly:true }))}) antes de ${mesaEsc(m.capAviso.what)}.</span><div class="g2row"><button type="button" class="btn sm primary" id="mesaCapUp">Continuar com mais ${mesaEsc(fmtCost(m.capAviso.base,{ usdOnly:true }))}</button><button type="button" class="btn sm quiet" id="mesaCapNo">Parar aqui</button></div></div>`:'';
  let left='';
  if(D){
    const nome=pid=>((m.personas||[]).find(p=>p.id===pid)||{}).nome||pid;
    left+=`<div class="g2k">Votação ${D.prev?'<span>— antes e depois do seu argumento</span>':''}</div>`+
      (D.tally.ausentes.length?`<div class="g2help">Sem voto válido: ${mesaEsc(D.tally.ausentes.map(nome).join(', '))} — a apuração conta só quem votou.</div>`:'')+
      mesaTableHtml(m, D)+
      `<span class="g2help">${D.tally.vetosLivres.length?D.tally.vetosLivres.map(v=>`Veto de ${mesaEsc(nome(v.pid))} (princípio): “${mesaEsc(v.texto)}”${v.motivo?' — '+mesaEsc(v.motivo):''}`).join(' · ')+' · ':''}Pesos por persona; a sugestão sai só da tabela.</span>`;
  }
  left+=(m.aviso?`<div class="g2help">${mesaEsc(m.aviso)}</div>`:'')+(m.rounds||[]).map((r,i,a)=>mesaRoundHtml(m, r, i===a.length-1)).join('');
  let right='';
  if(D){
    const sug=D.dec.sugeridas, apN=D.dec.aprovadas.length;
    const doneIds=new Set(((m.criadas&&m.criadas.itens)||[]).map(x=>x.fid)), pend=D.dec.aprovadas.filter(r=>!doneIds.has(r.id)).length;
    const dec=`<div class="g2rp-b"${MESA.tab==='dec'?'':' hidden'}><div class="g2k">Decisão sugerida</div>`+
      (sug.length?`<div class="g2mvp">${sug.map((r,i)=>`<div><b>${i+1}</b><span>${mesaEsc(r.titulo)}${r.escolha?` <small>${mesaEsc(r.escolha)}</small>`:''}</span><span></span></div>`).join('')}</div>`:'<div class="g2help">Nenhuma feature sem veto recebeu voto.</div>')+
      (sug.length&&!apN?`<button type="button" class="btn sm" id="mesaApSug">Aprovar as sugeridas</button>`:'')+
      `<span class="g2help">Aprovadas viram 1 épico neste projeto (ou tarefas, sem time). A decisão e os votos ficam salvos como nota em Projeto › Memória.</span>`+mesaCriadasHtml(m)+`</div>`;
    const arg=`<div class="g2rp-b"${MESA.tab==='arg'?'':' hidden'}>${mesaArgueHtml(m)}</div>`;
    right=`<div class="g2rpanel"><div class="g2htabs" role="tablist"><button type="button" role="tab" data-mtab="dec" class="${MESA.tab==='dec'?'on':''}" aria-selected="${MESA.tab==='dec'}">Sua decisão</button><button type="button" role="tab" data-mtab="arg" class="${MESA.tab==='arg'?'on':''}" aria-selected="${MESA.tab==='arg'}">Argumentar</button></div>${dec}${arg}`+
      `<div class="g2pfoot"><span class="g2msg"><b>${apN} aprovada${apN===1?'':'s'}</b>${apN>pend?` · ${apN-pend} já criada${apN-pend===1?'':'s'}`:''}</span><span class="g2sp"></span><button class="btn primary" id="mesaCreate"${!pend||MESA.creating||running?' disabled':''}>${MESA.creating?'criando…':`Criar épico com ${pend} demanda${pend===1?'':'s'}`}</button></div></div>`;
  } else right=`<div class="g2rpanel"><div class="g2rp-b"><div class="g2k">Sua decisão</div><p class="g2help">A tabela de votos aparece quando a rodada 2 (debate e voto) terminar. Até lá, acompanhe as posições à esquerda.</p></div></div>`;
  return head+capAv+`<div class="g2mesa"><div class="mesascroll g2scroll">${left}</div>${right}</div>`;
}
function mesaCriadasHtml(m){
  const c=m.criadas; if(!c||!((c.itens||[]).length||(c.faltou||[]).length)) return '';
  return `<div class="mesacriadas"><div class="g2k">Demandas criadas</div>`+
    (c.epico?`<div><a href="#" data-mepic="${mesaEsc(c.epico.id)}">${IC.stack||''}épico ${mesaEsc(c.epico.name||'')}</a></div>`:'')+
    (c.itens||[]).map(x=>`<div>${x.taskId?`<a href="#" data-mtask="${mesaEsc(x.taskId)}">${mesaEsc(x.titulo)}</a>`:mesaEsc(x.titulo)+' <span class="dim">(no épico)</span>'}</div>`).join('')+
    ((c.faltou||[]).length?`<div class="g2help">faltou criar: ${mesaEsc(c.faltou.join(', '))}</div>`:'')+
    (c.nota?`<div class="g2help">nota de decisão na Memória (${mesaEsc(c.nota.scope)}): <a href="#" id="mesaNote">${mesaEsc(c.nota.slug)}</a></div>`:'')+`</div>`;
}
function mesaArgueHtml(m){
  const running=mesaRunning(m), ps=m.personas||[], tgt=MESA.target;
  const p=ps.find(x=>x.id===tgt);
  const chat=p?(m.chats[p.id]||[]):[];
  const opts=`<select class="in mesatgt" id="mesaTgt" aria-label="Pra quem"><option value="mesa"${tgt==='mesa'?' selected':''}>com a mesa (nova rodada)</option>${ps.map(x=>`<option value="${mesaEsc(x.id)}"${tgt===x.id?' selected':''}>só com ${mesaEsc(x.nome)}</option>`).join('')}</select>`;
  const thread=p?`<div class="mesachat plthread" id="mesaChat">${chat.length?chat.map(x=>chatMsgHtml(x.who==='bot'?{ who:'bot', text:'**'+p.nome+':** '+x.text }:x)).join(''):`<div class="g2help">Pergunte algo só pra ${mesaEsc(p.nome)} — só essa persona responde, com o histórico dela nesta mesa (a mesa não vota de novo).</div>`}${MESA.chatBusy?chatThinkHtml():''}</div>`:'';
  return `<div class="g2explain">Pergunte só pra uma persona, ou leve um argumento pra mesa inteira (nova rodada e novo voto).</div>${thread}`+
    chatComposerHtml({ input:'mesaArgIn', send:'mesaArgSend', stop:'mesaArgStop', stopTitle:'para a resposta da persona', rows:3, value:MESA.draft, extras:opts, disabled:running,
      placeholder:p?`ex.: ${p.nome}, por que você vetou isso?`:'seu argumento… ex.: considerem que não temos backend — isso muda o voto?', sendHtml:p?'perguntar':'argumentar' });
}
function mesaWire(body){
  bindClick('mesaStop', ()=>MESA.cur&&mesaStop(MESA.cur));
  bindClick('mesaCont', ()=>MESA.cur&&mesaRun(MESA.cur, { retryFailed:true }));
  bindClick('mesaCreate', mesaCreate);
  bindClick('mesaCapUp', async()=>{ const m=MESA.cur; if(!m||!m.capAviso) return; const kind=m.capAviso.kind; m.capUsd=mesaCapOf(m)+(+m.capAviso.base||mesaCapBase()||2); m.capAviso=null; await mesaSave(m);
    if(kind==='ask') mesaArgue(); else mesaRun(m); }); // pergunta a UMA persona: refaz só a pergunta (o texto continua na caixa), não a mesa inteira
  bindClick('mesaCapNo', async()=>{ const m=MESA.cur; if(!m) return; m.capAviso=null; await mesaSave(m); mesaRender(); });
  bindClick('mesaMore', ev=>{ const m=MESA.cur; if(!m||typeof g2SheetMenu!=='function') return; const f=mesaFailed(m);
    g2SheetMenu(ev.currentTarget, [
      { label:'Continuar a mesa', hint:'roda o que ficou na fila', disabled:mesaRunning(m)||mesaStatusOf(m)==='concluida', fn:()=>mesaRun(m, { retryFailed:true }) },
      { label:f.length?'Tentar de novo com '+f.map(p=>p.nome).join(', '):'Tentar de novo com quem falhou', hint:'refaz só a fala de quem não respondeu', disabled:!f.length||mesaRunning(m)||((m.criadas&&m.criadas.itens)||[]).length>0, fn:()=>mesaRun(m, { retryFailed:true }) },
      { label:'Abrir pasta das mesas', hint:'.cardume/mesas', fn:()=>invoke('open_folder',{ path:m.repo.replace(/[\\/]+$/,'')+'/.cardume/mesas' }).catch(e=>showErr(e,'Não consegui abrir a pasta')) },
    ]); });
  bindClick('mesaApSug', async()=>{ const m=MESA.cur, D=m&&mesaDecisionOf(m); if(!D) return; D.dec.sugeridas.forEach(r=>{ if(!m.escolhas[r.id]) m.escolhas[r.id]='aprovada'; }); await mesaSave(m); mesaRender(); });
  bindClick('mesaNote', async ev=>{ ev.preventDefault(); const c=MESA.cur&&MESA.cur.criadas; if(!c||!c.nota) return;
    if(MESA.cur.repo!==state.repo){ toast(`A nota está na memória do projeto ${pathBase(MESA.cur.repo)} — abra ele pra ver.`,'warn', window.switchProject?{ label:'abrir o projeto', fn:()=>window.switchProject(MESA.cur.repo) }:null); return; }
    if(typeof memCaptureEdit==='function') memCaptureEdit();
    if(typeof MEM!=='undefined' && MEM.edit && (String(MEM.edit.title||'').trim()||String(MEM.edit.body||'').trim()) && !await askYes('Você está editando uma nota na Memória. Descartar o que não foi salvo e abrir a nota da decisão?','Descartar edição')) return;
    MEM.sel={ scope:c.nota.scope, slug:c.nota.slug }; MEM.view='lista'; MEM.edit=null; MEM.q=''; MEM.type=''; if(window.openTab) openTab('memoria'); });
  body.querySelectorAll('[data-mgo]').forEach(b=>b.onclick=()=>{ const g=b.dataset.mgo; if(window.fabOpen) window.fabOpen(g==='nova-feat'?'nova':g, g==='nova-feat'?{ mode:'feature' }:(g==='sessoes'?{ filter:'m' }:{})); });
  body.querySelectorAll('[data-mtab]').forEach(b=>b.onclick=()=>{ MESA.tab=b.dataset.mtab; mesaRender(); });
  body.querySelectorAll('[data-mchoose]').forEach(b=>b.onclick=()=>{ const [id,w]=b.dataset.mchoose.split(':'); if(MESA.cur) mesaChoose(MESA.cur, id, w); });
  body.querySelectorAll('[data-mtask]').forEach(a=>a.onclick=ev=>{ ev.preventDefault(); if(typeof openTaskById==='function'){ openTab('flow'); openTaskById(a.dataset.mtask); } });
  body.querySelectorAll('[data-mepic]').forEach(a=>a.onclick=ev=>{ ev.preventDefault(); const c=MESA.cur&&MESA.cur.criadas; if(c&&c.epico&&window.openEpicPage) openEpicPage(c.epico); });
  body.querySelectorAll('details.mesaround>summary').forEach(sm=>sm.onclick=()=>setTimeout(()=>{ const d=sm.parentElement, m=MESA.cur; if(!m) return;
    const s=MESA.open[m.id]||(MESA.open[m.id]=new Set((m.rounds||[]).length?[m.rounds[m.rounds.length-1].n]:[])); if(d.open) s.add(+d.dataset.mround); else s.delete(+d.dataset.mround); },0));
  const tg=$id('mesaTgt'); if(tg) tg.onchange=()=>{ MESA.target=tg.value; mesaRender(); const i=$id('mesaArgIn'); if(i) i.focus(); };
  if($id('mesaArgIn')){
    chatComposer({ input:'mesaArgIn', attach:null, pend:()=>[], taskId:()=>null, rerender:()=>{}, send:'mesaArgSend',
      stop:{ btn:MESA.chatBusy&&MESA.cur&&MESA.chatMesaId===MESA.cur.id?'mesaArgStop':'', busy:()=>MESA.chatBusy||mesaRunning(MESA.cur), fn:()=>{ const id=MESA.chatMesaId; if(id && MESA.chatBusy){ MESA.chatStop=true; invoke('mesa_stop',{ id }).catch(()=>{}); } } }, onSend:mesaArgue,
      hint:'Enter envia · ⇧Enter quebra linha', busyHint:mesaRunning(MESA.cur)?'a mesa está rodando — argumente quando a rodada terminar':(MESA.chatBusy?'esperando a resposta…':'') });
    bindClick('mesaArgSend', mesaArgue);
    { const i=$id('mesaArgIn'); if(i){ i.onpaste=null; i.ondrop=null; i.ondragover=null; i.ondragleave=null; } } // sem anexos aqui
  }
}
// entrada antiga (menu Mais › Mesa de personas) → Fábrica › Sessões › Mesas
bindClick('mesaBtn', ()=>{ const mm=$id('moreMenu'); if(mm) mm.style.display='none'; if(window.fabOpen) window.fabOpen('sessoes', { filter:'m' }); else if(window.openTab) window.openTab('mesa'); });
