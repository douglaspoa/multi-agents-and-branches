// COMANDO · MEMÓRIA, SKILLS E ÉPICO NO CHAT (25/11): o que ainda exigia abrir a Memória, as Skills ou o planejador.
// Mesmas chamadas das telas (memory_*, learn_*, list_skills/set_active_skills/create_skill, pedidos de épico do 49).
const CMD_MAIS=new Set(['memoria','anotar_memoria','apagar_memoria','aprendizados','aceitar_aprendizado','descartar_aprendizado','skills','ligar_skill','desligar_skill','criar_skill','criar_epico','vincular_epico','desvincular_epico']);
const cmdMaisN=x=>String(x||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
/** Tipo da nota a partir do que foi dito. Puro. */
function cmdMemTipo(tx){ const s=cmdMaisN(tx); return /decis/.test(s)?'decisão':/regra|sempre|nunca|convenc/.test(s)?'regra':/gotcha|armadilha|pegadinha|cuidado/.test(s)?'gotcha':/gloss/.test(s)?'glossário':/pessoa/.test(s)?'pessoa':'contexto'; }
/** Acha UM item por nome/título entre vários. Puro. → item | null | { varios } */
function cmdMaisAcha(lista, nomeDe, q){ const n=cmdMaisN(q); if(!n) return null; const L=lista||[];
  const ex=L.filter(x=>cmdMaisN(nomeDe(x))===n); if(ex.length===1) return ex[0];
  const pa=L.filter(x=>cmdMaisN(nomeDe(x)).includes(n) || (n.length>=5 && n.includes(cmdMaisN(nomeDe(x))) && cmdMaisN(nomeDe(x)).length>=4)); if(pa.length===1) return pa[0];
  if(pa.length>1) return { varios:pa.slice(0,5) };
  const toks=n.split(' ').filter(w=>w.length>=4), sc=L.map(x=>({ x, s:toks.filter(w=>cmdMaisN(nomeDe(x)).includes(w)).length })).filter(o=>o.s>0).sort((a,b)=>b.s-a.s);
  return !sc.length?null:(sc.length===1 || sc[0].s>sc[1].s)?sc[0].x:{ varios:sc.slice(0,5).map(o=>o.x) }; }

async function cmdMaisDo(p, say){
  const repo=cmdRepo(), erro=e=>String((e&&e.message)||e).slice(0,240);
  try{
    // ---------- memória do projeto ----------
    if(p.acao==='memoria' || p.acao==='anotar_memoria' || p.acao==='apagar_memoria'){
      const r=await invoke('memory_list',{ repo, withBody:true })||{}, notas=r.notes||[];
      if(p.acao==='memoria'){ const q=String(p.alvo||p.texto||'').trim(); if(!notas.length) return say('A memória deste projeto ainda não tem notas.');
        if(!q) return say('Memória do projeto — '+notas.length+' notas:\n'+notas.slice(0,60).map(n=>`- ${n.title} (${n.type||'contexto'}${n.scope==='time'?' · time':''})`).join('\n'));
        const docs=notas.map(n=>({ tipo:'nota', code:'', id:n.scope+'/'+n.slug, title:n.title||n.slug, text:String(n.body||'').slice(0,3000) })), A=cmdBusca(q, docs, 4);
        if(!A.length) return say('Nenhuma nota da memória fala de “'+q+'”. São '+notas.length+' notas.');
        return say(A.map(a=>{ const n=notas.find(x=>x.scope+'/'+x.slug===a.id)||{}; return `### ${n.title} (${n.type||'contexto'}${n.scope==='time'?' · time':''})\n${String(n.body||'').trim().slice(0,1500)}`; }).join('\n\n')); }
      if(p.acao==='anotar_memoria'){ const titulo=String(p.titulo||'').trim()||cmdUma(String(p.texto||'').split(/[.\n]/)[0]).slice(0,80), corpo=String(p.texto||'').trim(); if(titulo.length<3 || corpo.length<5) return say('Pra anotar preciso do que guardar (uma frase já serve).');
        const time=/time|equipe|todos/.test(cmdMaisN(p.alvo)), who=typeof memWho==='function'?memWho():'', nota={ title:titulo, type:cmdMemTipo((p.alvo||'')+' '+titulo), tags:[], updated:memToday(), body:corpo, extra:{}, by:who, origem:'pessoa', atualizadaPor:'' };
        const w=await invoke('memory_write',{ repo, scope:time?'time':'local', slug:null, content:memSerialize(nota), expectMtime:null, create:true }); if(w && w.scope==='time' && typeof memTeamSync==='function') memTeamSync().catch(()=>{});
        return say(`Anotei na memória ${w&&w.scope==='time'?'do time':'do projeto'}: “${titulo}” (${nota.type}). Os agentes leem na próxima tarefa.`); }
      const n=cmdMaisAcha(notas, x=>x.title||x.slug, p.alvo||p.texto); if(!n) return say('Não achei essa nota na memória.'); if(n.varios) return say('Qual nota? '+n.varios.map(x=>'“'+x.title+'”').join(', '));
      await invoke('memory_delete',{ repo, scope:n.scope, slug:n.slug }); if(n.scope==='time' && typeof memCloudTombstone==='function') await memCloudTombstone(repo, n.slug).catch(()=>{}); return say(`Apaguei a nota “${n.title}” da memória${n.scope==='time'?' do time':''}.`); }
    if(p.acao==='aprendizados' || p.acao==='aceitar_aprendizado' || p.acao==='descartar_aprendizado'){
      const L=(await invoke('learn_pending',{ repo }))||[], nome=it=>it.kind==='skill'?((it.skill||{}).nome||'skill'):it.kind==='persona'?'jeito de trabalhar':((it.nota||{}).title||'nota');
      if(p.acao==='aprendizados') return say(L.length?'Aprendizados esperando a sua decisão:\n'+L.map(it=>`- ${nome(it)} (${it.kind==='skill'?'skill':it.kind==='persona'?'persona':'nota'})${(it.nota&&it.nota.body)?': '+cmdUma(it.nota.body).slice(0,160):''}`).join('\n'):'Nenhum aprendizado esperando decisão.');
      const it=cmdMaisAcha(L, nome, p.alvo||p.texto)||(L.length===1?L[0]:null); if(!it) return say(L.length?'Qual aprendizado? '+L.map(x=>'“'+nome(x)+'”').join(', '):'Não há aprendizado pendente.'); if(it.varios) return say('Qual deles? '+it.varios.map(x=>'“'+nome(x)+'”').join(', '));
      if(p.acao==='descartar_aprendizado'){ await invoke('learn_discard',{ repo, id:it.id }); return say(`Descartei o aprendizado “${nome(it)}”.`); }
      await invoke('learn_accept',{ repo, id:it.id, edited:null, como:/time/.test(cmdMaisN(p.texto))?'time':'aceitar' }); return say(`Aceitei o aprendizado “${nome(it)}” — passa a valer pros agentes.`); }
    // ---------- skills ----------
    if(['skills','ligar_skill','desligar_skill','criar_skill'].includes(p.acao)){
      if(p.acao==='criar_skill'){ const nome=String(p.titulo||p.alvo||'').trim(), quando=String(p.alvo&&p.titulo?p.alvo:'').trim()||cmdUma(String(p.texto||'').split(/[.\n]/)[0]).slice(0,200); if(!nome || !String(p.texto||'').trim()) return say('Pra criar a skill preciso do nome e do que ela ensina a fazer.');
        await invoke('create_skill',{ name:nome, description:quando, body:String(p.texto||'') }); return say(`Skill “${nome}” criada na biblioteca. Diga "liga a skill ${nome}" pra valer neste projeto.`); }
      const L=(await invoke('list_skills'))||[];
      if(p.acao==='skills') return say(L.length?'Skills ('+L.filter(x=>x.active).length+' ligadas de '+L.length+'):\n'+L.slice(0,60).map(x=>`- ${x.active?'[ligada]':'[desligada]'} ${x.name}${x.description?': '+cmdUma(x.description).slice(0,120):''}`).join('\n'):'Nenhuma skill na biblioteca.');
      const s=cmdMaisAcha(L, x=>x.name, p.alvo||p.texto); if(!s) return say('Não achei essa skill. Existem: '+L.slice(0,20).map(x=>x.name).join(', ')+'.'); if(s.varios) return say('Qual skill? '+s.varios.map(x=>x.name).join(', '));
      const on=p.acao==='ligar_skill'; if(!!s.active===on) return say(`A skill ${s.name} já está ${on?'ligada':'desligada'}.`); s.active=on;
      await invoke('set_active_skills',{ skills:L.filter(x=>x.active).map(x=>({ name:x.name, description:x.description||'' })) }); try{ if(typeof skList!=='undefined') skList=L; }catch(_){ } return say(`Skill ${s.name} ${on?'ligada':'desligada'} neste projeto.`); }
    // ---------- épico (time) ----------
    if(['criar_epico','vincular_epico','desvincular_epico'].includes(p.acao)){ if(typeof erApplyOne!=='function') return say('Épico pelo chat não está disponível nesta versão.');
      const refs=cmdRefs(), ts=(p.tarefas||[]).map(q=>cmdRefTask(q, refs)).filter(Boolean), falt=(p.tarefas||[]).filter(q=>!cmdRefTask(q, refs)); if(falt.length) return say('Não achei estas tarefas: '+falt.join(', ')+'.');
      const tasks=ts.map(t=>({ localId:t.id })), base={ id:'cmd-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6), at:new Date().toISOString(), by:{ agent:'Comando', role:'planner' }, tasks };
      const r=p.acao==='criar_epico'?Object.assign(base, { kind:'create', epic:{ title:String(p.titulo||p.alvo||'').trim(), description:String(p.texto||'').trim().slice(0,2000)||undefined, doneWhen:(p.requisitos||[]).length?p.requisitos.map(x=>String(x).slice(0,300)):undefined } })
        :Object.assign(base, { kind:p.acao==='vincular_epico'?'link':'unlink', epicTitle:String(p.alvo||'').trim()||undefined });
      const res=await erApplyOne(r); try{ lastSig=''; }catch(_){ } if(typeof refresh==='function') refresh().catch(()=>{});
      return say((res&&res.message)?res.message.charAt(0).toUpperCase()+res.message.slice(1)+((res.failed||[]).length?' Falharam: '+res.failed.map(f=>(f.title||f.ref)+' ('+f.why+')').join('; '):''):'O pedido de épico não devolveu resultado.'); }
  }catch(e){ say('Não deu certo: '+erro(e)); }
}
