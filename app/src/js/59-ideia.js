// Starfork — 59-ideia: COMEÇAR POR UMA IDEIA (spec-ideia-mesa-pesquisa)
// Aba "Ideia: <título>" (instância múltipla, funciona SEM projeto aberto): a pessoa descreve a ideia num chat e a
// MESA responde — a Pesquisadora (persona nova) e as 5 vozes da Mesa de personas (38-mesa.js), cada uma numa
// chamada isolada e curta. "Pesquisar" roda UMA rodada de pesquisa com as ferramentas de web NATIVAS da IA padrão
// (ideia.rs) e devolve um relatório com fontes, cada item marcado fato/inferência/suposição — fato sem URL ou
// número sem fonte é RECUSADO (pede a correção uma vez; depois rebaixa pra suposição com aviso). "Decidir com a
// mesa" = as 2 rodadas da mesa (posições → debate e voto com vetos), curtas: sai o MVP, os não-objetivos e a
// plataforma. "Criar projeto" monta o épico BMAD (formato do normalizePlan) e: (a) cria o projeto local
// (quick_create_project) com o épico e as tarefas em rascunho + docs/pesquisa-<slug>.md commitado; ou (b) entrega
// pro piloto automático com --plan. Tudo salvo em ~/.constellation/ideias/<id>.json. Sem polling: o progresso da
// pesquisa chega pelo evento `ideia-activity`; com a aba escondida nada novo começa (só a pesquisa em voo segue).

// @ideia-puro-inicio — funções sem DOM (testadas em app/tests/ideia.test.mjs, junto do trecho puro do 38-mesa)
const IDEIA_PESQ={ id:'pesq', nome:'Pesquisadora', papel:'pesquisa de mercado', desc:'Pesquisadora de produto. Só acredita no que tem fonte: busca sinais de demanda, concorrentes, reclamações de usuários e tendências recentes. Separa fato (com link) de inferência e de palpite, e nunca inventa número.' };
// a mesa da ideia: a Pesquisadora + as 5 vozes da Mesa (MESA_PERSONAS, 38-mesa.js)
function ideiaPanel(){ return [IDEIA_PESQ].concat(typeof MESA_PERSONAS!=='undefined'?MESA_PERSONAS:[]); }
const IDEIA_PLATS=[['web','Web'],['ios','iOS'],['android','Android'],['mobile','iOS + Android']];
const IDEIA_SECS=[['demanda','Sinais de demanda'],['tendencias','Tendências e por que agora'],['concorrentes','Concorrentes e alternativas'],['reclamacoes','Do que os usuários reclamam'],['publico','Público-alvo'],['riscos','Riscos']];
const IDEIA_ROT={ fato:'fato', inferencia:'inferência', suposicao:'suposição' };
const IDEIA_VERED={ sim:'Sim', talvez:'Talvez', nao:'Não' };
const IDEIA_CONF={ alta:'alta', media:'média', baixa:'baixa' };
const IDEIA_MAX_ITEMS=8;
const IDEIA_HIST_TURNS=6;
function ideiaFold(s){ return String(s==null?'':s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function ideiaCut(s, n){ s=String(s==null?'':s).replace(/\s+/g,' ').trim(); return s.length>n?s.slice(0,n-1).trimEnd()+'…':s; }
// título da aba: a 1ª frase do pedido, curta
function ideiaTitle(text){
  const first=String(text||'').trim().split('\n')[0].split(/(?<=[.!?])\s/)[0].replace(/^(eu\s+)?(quero|queria|gostaria de|pensei em)\s+(fazer|criar|construir|montar|lançar)\s+/i,'').trim();
  const t=ideiaCut(first, 60).replace(/[.!?]+$/,'');
  return t ? t.charAt(0).toUpperCase()+t.slice(1) : 'Ideia sem nome';
}
const IDEIA_STOP=new Set('a o as os um uma de da do das dos e ou em no na nos nas pra pro para por com sem que meu minha app aplicativo'.split(' '));
function ideiaSlug(text){
  const w=ideiaFold(text).split(' ').filter(Boolean), good=w.filter(x=>!IDEIA_STOP.has(x) && x.length>1);
  let s=(good.length?good:w).slice(0,5).join('-');
  if(s.length>40) s=s.slice(0,40).replace(/-[^-]*$/,'')||s.slice(0,40);
  return s.replace(/^-+|-+$/g,'')||'ideia';
}
function ideiaPlat(v){ const f=ideiaFold(v); if(/ios.*android|android.*ios|mobile|celular|react native|expo/.test(f)) return 'mobile'; if(/android/.test(f)) return 'android'; if(/ios|iphone/.test(f)) return 'ios'; if(/web|site|navegador|browser/.test(f)) return 'web'; return ''; }
function ideiaPlatName(k){ const p=IDEIA_PLATS.find(x=>x[0]===k); return p?p[1]:'Web'; }
// JSON dentro de ```json … ```, ou o primeiro {…} cercado de texto
function ideiaJson(text){
  const src=String(text==null?'':text), tries=[];
  const f=src.match(/```(?:json)?\s*([\s\S]*?)```/i); if(f) tries.push(f[1]);
  const i=src.indexOf('{'), j=src.lastIndexOf('}'); if(i>=0 && j>i) tries.push(src.slice(i,j+1));
  for(const t of tries){ try{ const o=JSON.parse(t.trim()); if(o && typeof o==='object' && !Array.isArray(o)) return o; }catch(_){ } }
  return null;
}
// ---- conversa ----
function ideiaPersonaSys(p){
  return `Você é ${p.nome}, ${p.papel}. ${p.desc}\n\nVocê está numa MESA avaliando uma IDEIA de produto que ainda NÃO existe (não há projeto nem código). Cada pessoa da mesa responde separada. Reaja com a SUA perspectiva, com franqueza — discordar é útil, concordar por educação não. Fale curto: no máximo 3 frases, na primeira pessoa, sem listas longas e sem cabeçalhos.`;
}
function ideiaReportBrief(r){
  if(!r || !r.veredito) return '';
  const v=r.veredito, top=IDEIA_SECS.map(([k,l])=>{ const it=(r[k]||[])[0]; return it?`- ${l}: ${ideiaCut(it.nome?it.nome+' — '+it.texto:it.texto,160)} [${IDEIA_ROT[it.rotulo]}]`:null; }).filter(Boolean);
  return `PESQUISA JÁ FEITA — veredito "vale a pena agora?": ${IDEIA_VERED[v.resposta]||v.resposta} (confiança ${IDEIA_CONF[v.confianca]||v.confianca}). ${ideiaCut(v.texto,300)}\n${top.join('\n')}`;
}
// a conversa até aqui (últimas rodadas), pro prompt
function ideiaHistory(idea, max){
  const turns=(idea&&idea.turns||[]).slice(-(max||IDEIA_HIST_TURNS));
  const nome=pid=>(ideiaPanel().find(p=>p.id===pid)||{}).nome||pid;
  return turns.map(t=>{
    const r=Object.keys(t.resp||{}).filter(k=>t.resp[k]&&t.resp[k].st==='ok').map(k=>`${nome(k)}: ${ideiaCut(t.resp[k].text,360)}`);
    return `Dono da ideia: ${ideiaCut(t.you,600)}${r.length?'\n'+r.join('\n'):''}`;
  }).join('\n\n');
}
// `turn` = a rodada que está sendo respondida: fica FORA do histórico (cada persona responde sem ver as outras)
function ideiaTurnPrompt(idea, p, turn){
  const msg=turn.you, brief=ideiaReportBrief(idea&&idea.report&&idea.report.data);
  const hist=ideiaHistory(Object.assign({}, idea, { turns:(idea&&idea.turns||[]).filter(t=>t!==turn) }));
  const papel=p.id==='pesq'
    ? 'Você é quem pesquisa: aponte o que precisa ser verificado na internet (demanda, concorrentes, reclamações) e, quando fizer sentido, sugira apertar "Pesquisar". Sem pesquisa feita, NÃO afirme números nem fatos de mercado.'
    : 'Se faltar dado de mercado pra opinar, diga o que a Pesquisadora deveria checar.';
  return `IDEIA: ${idea.titulo}\n\n${brief?brief+'\n\n':''}${hist?'A conversa até aqui:\n'+hist+'\n\n':''}O dono da ideia acabou de dizer:\n"${msg}"\n\nResponda só como ${p.nome}, em até 3 frases. ${papel}`;
}
// ---- pesquisa ----
const IDEIA_ITEM='{"texto":"…","rotulo":"fato|inferencia|suposicao","fontes":["https://endereço-que-você-leu"]}';
const IDEIA_RESEARCH_SYS='Você é a Pesquisadora do Starfork: faz pesquisa de mercado RÁPIDA e HONESTA sobre uma ideia de produto, usando as ferramentas de web desta sessão. Regras inegociáveis: (1) FATO só com a URL de onde veio (uma página que você achou ou leu AGORA) — sem URL não é fato; (2) INFERÊNCIA é a sua conclusão a partir de fatos (cite as URLs de base quando houver); (3) SUPOSIÇÃO é palpite sem base — diga que é palpite; (4) NUNCA invente número: porcentagem, usuários, downloads, volume de busca, preço ou receita só aparecem em FATO com URL; sem dado público, escreva "não encontrei dado público de …" sem número; (5) prefira fontes de 2025–2026 e diga a data quando importar; (6) seja econômica: no máximo 8 buscas e 8 páginas lidas; (7) responda em português do Brasil e SOMENTE com o JSON pedido.';
function ideiaResearchPrompt(idea){
  const hist=ideiaHistory(idea, 8);
  return `IDEIA: ${idea.titulo}\n\n${hist?'O que o dono da ideia e a mesa já disseram:\n'+hist+'\n\n':''}TAREFA: descubra se esta ideia teria procura AGORA. Pesquise na web: sinais de demanda (interesse de busca, volume de discussão em fóruns/comunidades, quando der pra obter), tendências recentes e "por que agora", concorrentes e alternativas (com links), do que os usuários desses concorrentes reclamam, quem é o público-alvo e os riscos. Termine com o veredito "vale a pena agora?" e a sua confiança.\n\nResponda SOMENTE com um bloco \`\`\`json no formato {"resumo":"2-3 frases","demanda":[ITEM],"tendencias":[ITEM],"concorrentes":[{"nome":"…","url":"https://…","texto":"o que é, preço/diferencial","rotulo":"fato","fontes":["https://…"]}],"reclamacoes":[ITEM],"publico":[ITEM],"riscos":[ITEM],"veredito":{"resposta":"sim|talvez|nao","confianca":"alta|media|baixa","texto":"2-4 frases: vale a pena agora? por quê","porque":[ITEM]}} onde ITEM = ${IDEIA_ITEM}. De 2 a ${IDEIA_MAX_ITEMS} itens por lista.`;
}
// `prev` = o JSON devolvido (vai junto: o gateway não tem sessão pra retomar)
function ideiaFixPrompt(errors, prev){
  const p=String(prev||'').trim();
  return `O relatório que você devolveu NÃO passou na checagem do Starfork:\n${(errors||[]).slice(0,12).map(e=>'- '+e).join('\n')}\n\nCorrija SEM pesquisar de novo: todo fato precisa da URL de onde veio (se não tiver, vire inferência ou suposição); número só em fato com URL (senão tire o número). Devolva SOMENTE o bloco \`\`\`json completo, no mesmo formato.${p?'\n\nO relatório que você devolveu:\n'+p.slice(0,16000):''}`;
}
function ideiaRot(v){ const f=ideiaFold(v); return f.startsWith('fat')?'fato':f.startsWith('inf')?'inferencia':'suposicao'; }
function ideiaUrls(v){
  const out=[]; const add=u=>{ u=String(u||'').trim().replace(/[).,;\]]+$/,''); if(/^https?:\/\/[^\s/]+\.[^\s]+/i.test(u) && !out.includes(u)) out.push(u); };
  (Array.isArray(v)?v:[v]).forEach(x=>{ const s=typeof x==='string'?x:(x&&typeof x==='object'?(x.url||x.href||''):''); (String(s).match(/https?:\/\/[^\s"'<>]+/gi)||[]).forEach(add); });
  return out;
}
// número que precisa de fonte: %, quantidades com unidade, dinheiro
const IDEIA_NUM=/(\d[\d.,]*\s*(%|por cento|mil\b|milh|bilh|k\b|usu[aá]rios|downloads|buscas|pesquisas|pessoas|membros|clientes|instala))|((us\$|r\$|\$|€)\s*\d)/i;
function ideiaItem(x){
  if(typeof x==='string') return { texto:ideiaCut(x,600), rotulo:'suposicao', fontes:ideiaUrls(x) };
  if(!x || typeof x!=='object') return null;
  const texto=ideiaCut(x.texto||x.text||x.descricao||'',600); if(!texto && !x.nome) return null;
  const fontes=ideiaUrls([].concat(x.fontes||x.sources||[], x.fonte||[], x.url||[]));
  const it={ texto, rotulo:ideiaRot(x.rotulo||x.label||x.tipo), fontes };
  if(x.nome) it.nome=ideiaCut(x.nome,80);
  if(x.url && ideiaUrls(x.url).length) it.url=ideiaUrls(x.url)[0];
  return it;
}
// PARSE + CHECAGEM do relatório: devolve o relatório normalizado e os ERROS (fato sem URL, número sem fonte,
// nenhuma fonte, sem veredito). ok só sem erro nenhum.
function ideiaCheckReport(text){
  const o=ideiaJson(text);
  if(!o) return { ok:false, report:null, errors:['a resposta não trouxe o JSON do relatório'] };
  const errors=[], r={ resumo:ideiaCut(o.resumo||o.summary||'',800) };
  const check=(sec, it)=>{
    if(it.rotulo==='fato' && !it.fontes.length) errors.push(`fato sem fonte (${sec}): "${ideiaCut(it.texto||it.nome,80)}"`);
    if(it.rotulo!=='fato' && IDEIA_NUM.test(it.texto)) errors.push(`número sem fonte (${sec}): "${ideiaCut(it.texto,80)}"`);
  };
  for(const [k,l] of IDEIA_SECS){
    r[k]=(Array.isArray(o[k])?o[k]:[]).map(ideiaItem).filter(Boolean).slice(0,IDEIA_MAX_ITEMS);
    r[k].forEach(it=>check(l.toLowerCase(), it));
  }
  const v=o.veredito||o.verdict;
  if(!v || typeof v!=='object'){ errors.push('faltou o veredito "vale a pena agora?"'); r.veredito=null; }
  else {
    const f=ideiaFold(v.resposta||v.answer);
    r.veredito={ resposta:f.startsWith('sim')||f==='yes'?'sim':f.startsWith('nao')||f==='no'?'nao':'talvez',
      confianca:/^alt|high/.test(ideiaFold(v.confianca||v.confidence))?'alta':/^baix|low/.test(ideiaFold(v.confianca||v.confidence))?'baixa':'media',
      texto:ideiaCut(v.texto||v.text||'',800), porque:(Array.isArray(v.porque)?v.porque:[]).map(ideiaItem).filter(Boolean).slice(0,6) };
    r.veredito.porque.forEach(it=>check('veredito', it));
    if(IDEIA_NUM.test(r.veredito.texto) && !r.veredito.porque.some(x=>x.rotulo==='fato')) errors.push(`número sem fonte (veredito): "${ideiaCut(r.veredito.texto,80)}"`);
  }
  r.fontes=ideiaUrls(IDEIA_SECS.flatMap(([k])=>r[k]).concat(r.veredito?r.veredito.porque:[]).flatMap(it=>(it.fontes||[]).concat(it.url?[it.url]:[])));
  if(!r.fontes.length) errors.push('nenhuma fonte (URL) citada — pesquisa sem fonte não vale');
  return { ok:!errors.length, report:r, errors };
}
// depois da 2ª tentativa: fato sem URL vira suposição (marcado) e número sem fonte ganha aviso. Sem NENHUMA fonte → null.
function ideiaSanitize(report){
  if(!report || !(report.fontes||[]).length || !report.veredito) return null; // sem fonte ou sem veredito não é relatório
  const r=JSON.parse(JSON.stringify(report)), avisos=[];
  const fix=(sec, it)=>{
    if(it.rotulo==='fato' && !it.fontes.length){ it.rotulo='suposicao'; it.semFonte=true; avisos.push(`fato sem fonte rebaixado pra suposição (${sec})`); }
    if(it.rotulo!=='fato' && IDEIA_NUM.test(it.texto)){ it.numSemFonte=true; avisos.push(`número sem fonte marcado (${sec})`); }
  };
  IDEIA_SECS.forEach(([k,l])=>(r[k]||[]).forEach(it=>fix(l.toLowerCase(), it)));
  if(r.veredito){ (r.veredito.porque||[]).forEach(it=>fix('veredito', it)); if(IDEIA_NUM.test(r.veredito.texto) && !r.veredito.porque.some(x=>x.rotulo==='fato')){ r.veredito.numSemFonte=true; avisos.push('número sem fonte marcado (veredito)'); } }
  r.avisos=avisos;
  return r;
}
// o relatório como documento (aba e docs/pesquisa-<slug>.md)
function ideiaReportMd(r, titulo, meta){
  meta=meta||{};
  const idx={}; (r.fontes||[]).forEach((u,i)=>{ idx[u]=i+1; });
  const refs=it=>{ const us=ideiaUrls((it.fontes||[]).concat(it.url?[it.url]:[])); return us.length?' '+us.map(u=>`[${idx[u]||'?'}](${u})`).join(' '):''; };
  const tag=it=>`**[${IDEIA_ROT[it.rotulo]||it.rotulo}]**${it.semFonte?' *(sem fonte)*':''}${it.numSemFonte?' *(número sem fonte — confira)*':''}`;
  const line=it=>`- ${tag(it)} ${it.nome?(it.url?`[${it.nome}](${it.url})`:`**${it.nome}**`)+(it.texto?' — ':''):''}${it.texto}${refs(it)}`;
  const L=[`# Pesquisa: ${titulo}`];
  if(r.veredito){ const v=r.veredito; L.push(`> **Vale a pena agora? ${IDEIA_VERED[v.resposta]}** (confiança ${IDEIA_CONF[v.confianca]||v.confianca}). ${v.texto}${v.numSemFonte?' *(número sem fonte — confira)*':''}`); }
  L.push(`*Pesquisa feita pelo Starfork${meta.engine?' com '+meta.engine:''}${meta.date?' em '+meta.date:''}. Cada item diz se é fato (com fonte), inferência (conclusão a partir de fatos) ou suposição (palpite). Nenhum número sem fonte.*`);
  if(r.resumo) L.push('## Resumo\n'+r.resumo);
  for(const [k,l] of IDEIA_SECS){ const xs=r[k]||[]; L.push(`## ${l}\n`+(xs.length?xs.map(line).join('\n'):'- *(nada encontrado com fonte)*')); }
  if(r.veredito && (r.veredito.porque||[]).length) L.push('## Por que esse veredito\n'+r.veredito.porque.map(line).join('\n'));
  if((r.avisos||[]).length) L.push('## Avisos da checagem\n'+r.avisos.map(a=>'- '+a).join('\n'));
  L.push('## Fontes\n'+(r.fontes||[]).map((u,i)=>`${i+1}. [${u}](${u})`).join('\n'));
  return L.join('\n\n')+'\n';
}
// custo previsto da pesquisa (US$ [lo,hi]) — Claude por modelo (medido: Sonnet ~US$ 0,30 com 6–10 páginas); outros por tokens
function ideiaResearchCost(engine, model){
  const e=String(engine||'claude'), m=String(model||'').toLowerCase();
  if(e==='claude'){ if(/opus/.test(m)) return [0.8,3.0]; if(/haiku/.test(m)) return [0.05,0.3]; return [0.2,1.0]; }
  return ({ codex:[0.05,0.5], deepseek:[0.01,0.1], gateway:[0.02,0.4] })[e]||[0.1,1.0];
}
// ---- decisão (as 2 rodadas da mesa, curtas) ----
function ideiaR1Prompt(idea){
  const brief=ideiaReportBrief(idea.report&&idea.report.data), hist=ideiaHistory(idea, 4);
  return `IDEIA: ${idea.titulo}\n\n${brief?brief+'\n\n':''}${hist?'Conversa:\n'+hist+'\n\n':''}RODADA 1 — o MVP. Sem ver as outras personas, diga o que o PRIMEIRO lançamento precisa ter (e o que fica de fora), do seu ponto de vista, e onde ele deve rodar primeiro.\n\nResponda SOMENTE com um bloco \`\`\`json no formato {"posicao":"1 parágrafo curto","propostas":[{"titulo":"feature do MVP (até 60 caracteres)","descricao":"1 frase","porque":"1 frase"}],"naoObjetivos":["o que NÃO entra no MVP"],"plataforma":"web|ios|android|mobile"} com 2 a 4 propostas.`;
}
function ideiaR2Prompt(idea, personas, r1, cands){
  return mesaR2Prompt('MVP de: '+idea.titulo, personas, r1, cands)+'\n\nNo MESMO JSON, inclua também "plataforma":"web|ios|android|mobile" — onde o MVP deve rodar primeiro. Fale curto (a fala em até 3 frases).';
}
// plataforma: maioria da rodada 2; empate → rodada 1; nada → web
function ideiaPickPlatform(r2, r1){
  const count=resp=>{ const c={}; Object.values(resp||{}).forEach(x=>{ const p=x&&x.st==='ok'&&ideiaPlat(x.plataforma); if(p) c[p]=(c[p]||0)+1; }); return c; };
  const best=c=>{ const e=Object.entries(c).sort((a,b)=>b[1]-a[1]); return e.length&&(e.length===1||e[0][1]>e[1][1])?e[0][0]:''; };
  return best(count(r2))||best(count(r1))||Object.keys(count(r2)).concat(Object.keys(count(r1)))[0]||'web';
}
// o que a mesa decidiu: MVP (aprovadas pela pessoa ou, sem escolha, as sugeridas), não-objetivos e plataforma
function ideiaDecisionView(dc, personas){
  const rs=(dc&&dc.rounds)||[], r1=rs[0]||{ resp:{} }, r2=rs[1];
  if(!r2 || !(dc.cands||[]).length) return null;
  const tally=mesaTally(dc.cands, mesaVotesOf(r2), personas), dec=mesaDecision(tally, dc.escolhas||{}, 5);
  const desc=id=>((dc.cands||[]).find(c=>c.id===id)||{}).descricao||'';
  const mvp=(dec.aprovadas.length?dec.aprovadas:dec.sugeridas.filter(r=>r.escolha!=='rejeitada')).map(r=>({ id:r.id, titulo:r.titulo, descricao:desc(r.id), total:r.total }));
  const seen=new Set(), non=[]; const add=t=>{ t=ideiaCut(t,140); const k=ideiaFold(t); if(k && !seen.has(k)){ seen.add(k); non.push(t); } };
  dec.rows.filter(r=>r.status==='vetada'||r.status==='rejeitada').forEach(r=>add(r.titulo));
  (tally.vetosLivres||[]).forEach(v=>add(v.texto));
  Object.values(r1.resp||{}).forEach(x=>(x&&x.naoObjetivos||[]).forEach(add));
  const voted=ideiaPickPlatform(r2.resp, r1.resp);
  return { tally, dec, mvp, naoObjetivos:non.slice(0,6), plataforma:ideiaPlat(dc.plataforma)||voted, plataformaVotada:voted };
}
// ---- épico BMAD (o MESMO formato que o normalizePlan do piloto aceita) ----
function ideiaBuildPlan(idea, view, reportMd){
  const titulo=idea.titulo, plat=view.plataforma||'web', feats=(view.mvp||[]).slice(0,6), non=view.naoObjetivos||[];
  const lc=s=>{ s=String(s||''); return s.charAt(0).toLowerCase()+s.slice(1); };
  const v=idea.report&&idea.report.data&&idea.report.data.veredito;
  const tasks=[{ title:`Esqueleto do app (${ideiaPlatName(plat)})`, after:[], covers:[], owns:'',
    objective:`Criar o projeto (${ideiaPlatName(plat)}) de "${titulo}" com a tela inicial e a navegação prontas pras features do MVP: ${feats.map(f=>f.titulo).join('; ')||'—'}. É o tracer bullet: roda de ponta a ponta antes das features.`,
    requirements:['O app abre e mostra a tela inicial com o nome do produto', 'README.md na raiz explica como instalar e rodar, com os comandos exatos'],
    verify:'abrir o app e ver a tela inicial' }];
  feats.forEach((f,i)=>tasks.push({ title:ideiaCut(f.titulo,80), after:[0], covers:['R'+(i+1)], owns:'',
    objective:`${f.descricao||f.titulo}. Parte do MVP de "${titulo}", decidido com a mesa de personas.`,
    requirements:[`Dá pra ${lc(f.titulo)} no app, de ponta a ponta`, 'Os estados vazio, carregando e erro aparecem com texto claro em português'].concat(non.length?[`Não entra nesta tarefa: ${non.slice(0,2).join('; ')}`]:[]),
    verify:`usar "${ideiaCut(f.titulo,60)}" no app e ver o resultado` }));
  const plan={ epic:ideiaCut('MVP: '+titulo,90),
    outcome:v?`Primeira versão de "${titulo}" (${ideiaPlatName(plat)}). Pesquisa: vale a pena agora? ${IDEIA_VERED[v.resposta]} (confiança ${IDEIA_CONF[v.confianca]||v.confianca}).`:`Primeira versão de "${titulo}" (${ideiaPlatName(plat)}) com o MVP decidido com a mesa.`,
    requirements:feats.map((f,i)=>({ id:'R'+(i+1), text:f.titulo+(f.descricao?' — '+f.descricao:'') })),
    doneWhen:[`Abrir o app mostra a tela inicial de "${ideiaCut(titulo,60)}"`].concat(feats.slice(0,5).map(f=>`Dá pra usar "${ideiaCut(f.titulo,60)}" de ponta a ponta`)),
    boundaries:non.slice(0,6), platform:plat, tasks };
  if(reportMd) plan.docs=[{ path:`docs/pesquisa-${ideiaSlug(titulo)}.md`, content:reportMd }];
  return plan;
}
// o épico como documento (vai pro projeto em docs/epico-<slug>.md na opção "seguir eu mesmo")
function ideiaEpicMd(plan, titulo){
  const L=[`# ${plan.epic}`, plan.outcome, `**Plataforma:** ${ideiaPlatName(plan.platform)}`];
  L.push('## Pronto quando\n'+plan.doneWhen.map((d,i)=>`- D${i+1}. ${d}`).join('\n'));
  if(plan.requirements.length) L.push('## Requisitos\n'+plan.requirements.map(r=>`- ${r.id}. ${r.text}`).join('\n'));
  if(plan.boundaries.length) L.push('## Fora do MVP (não-objetivos)\n'+plan.boundaries.map(b=>'- '+b).join('\n'));
  L.push('## Tarefas\n'+plan.tasks.map((t,i)=>`${i+1}. **${t.title}** (onda ${t.after.length?2:1}${t.after.length?', depois de '+t.after.map(a=>plan.tasks[a].title).join(', '):''})\n   ${t.objective}\n${t.requirements.map(r=>'   - '+r).join('\n')}`).join('\n'));
  L.push(`*Decidido na aba Ideia do Starfork ("${titulo}"): conversa com a mesa, pesquisa com fontes e votação.*`);
  return L.join('\n\n')+'\n';
}
// payloads do new_task pra opção "seguir eu mesmo" (rascunhos sob o épico local; `after` vira id depois de criar)
function ideiaTaskPayloads(plan, epicId, defaults){
  const d=defaults||{};
  return plan.tasks.map((t,i)=>({ afterIdx:t.after.slice(), payload:{ start:false, title:t.title, workflow:null, agents:null, engine:d.engine||'claude', model:d.model||null, approval:'auto', owns:null, off:null,
    objective:t.objective, deliverables:[], requirements:t.requirements, doc:null, proof:!!d.proof, tests:!!d.tests, autoPr:'ask', prBase:null, planApproval:'auto', refs:[], branchType:'feat', issue:null,
    epicId, verify:t.verify, covers:t.covers, after:[], wave:t.after.length?2:1, boundaries:plan.boundaries, epicDoneWhen:plan.doneWhen } }));
}
// em que passo a ideia está (o fluxo da aba)
function ideiaStage(idea){
  if(!idea) return 'conversar';
  if(idea.project && idea.project.dir) return 'criado';
  if(idea.decision && idea.decision.status==='ok') return 'criar';
  if(idea.report && idea.report.status==='ok') return 'decidir';
  if((idea.turns||[]).length) return 'pesquisar';
  return 'conversar';
}
// carregada do disco: o que estava "pensando" quando o app fechou vira "interrompida" (nada roda sozinho)
function ideiaRevive(idea){
  if(!idea) return idea;
  (idea.turns||[]).forEach(t=>Object.values(t.resp||{}).forEach(x=>{ if(x && x.st==='pendente') x.st='interrompida'; }));
  if(idea.report && idea.report.status==='rodando'){
    // pesquisa de novo interrompida: o relatório anterior (bom) continua valendo
    if(idea.report.data){ idea.report.status='ok'; idea.report.erro='o app fechou no meio da nova pesquisa — ficou o relatório anterior'; }
    else { idea.report.status='interrompida'; idea.report.erro='o app fechou no meio da pesquisa — pesquise de novo'; }
  }
  if(idea.decision && idea.decision.status==='rodando') idea.decision.status='interrompida';
  (idea.decision&&idea.decision.rounds||[]).forEach(r=>Object.values(r.resp||{}).forEach(x=>{ if(x && x.st==='pendente') x.st='interrompida'; }));
  return idea;
}
// @ideia-puro-fim

Object.assign(IC, {
  ideia:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"><path d="M8 1.9a4.3 4.3 0 0 0-2.6 7.7c.5.4.8.9.8 1.5v.4h3.6v-.4c0-.6.3-1.1.8-1.5A4.3 4.3 0 0 0 8 1.9z" stroke-linejoin="round"/><path d="M6.3 13.2h3.4M6.9 14.6h2.2" stroke-linecap="round"/></svg>',
});
function iEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const IDEIA={ list:null, cur:null, mem:{}, next:null, pendingId:'', draft:'', newDraft:'', live:{}, mode:null, capUsd:null, gh:false, apCap:'' };
const IDEIA_POOL=3; // personas ao mesmo tempo (como a mesa)
function ideiaLive(id){ return IDEIA.live[id]||(IDEIA.live[id]={ turn:false, research:null, decide:false, creating:false, paused:false }); }
function ideiaVisible(id){ const o=$id('ideiaOverlay'); return !!(o && o.style.display!=='none' && IDEIA.cur && (!id || IDEIA.cur.id===id)); }
function ideiaNewId(){ return 'i-'+Date.now().toString(36)+'-'+(Math.random().toString(36).slice(2)+'0000').slice(0,4)+'x'; } // sufixo fixo: nunca termina em "-r"/"-d" (chaves de parar)
function ideiaCall(){ return typeof invokeQuiet==='function'?invokeQuiet:invoke; }
function ideiaErr(e, what){ try{ return humanErr(e, what).msg; }catch(_){ return String(e&&e.message||e); } }
function ideiaClaudeModel(){ return typeof aiClaudeModel==='function'?aiClaudeModel():null; }
function ideiaEngine(){ return (IDEIA.mode&&IDEIA.mode.engine)||(typeof defaultAiEngine==='function'?defaultAiEngine():'claude'); }

// ---- disco: grava a cada passo (fila por ideia: nunca duas escritas cruzadas) ----
function ideiaSave(m){
  m.updatedAt=Date.now();
  const data=JSON.parse(JSON.stringify(m, (k,v)=>(k==='_q'||k==='_saveErr')?undefined:v));
  m._q=(m._q||Promise.resolve()).then(()=>ideiaCall()('ideia_save',{ id:m.id, data })).then(()=>{ m._saveErr=false; })
    .catch(e=>{ console.error('ideia: salvar', e); if(!m._saveErr){ m._saveErr=true; showErr(e,'Não consegui salvar a ideia "'+m.titulo+'"'); } });
  return m._q;
}
async function ideiaLoadList(){ try{ IDEIA.list=await ideiaCall()('ideia_list')||[]; }catch(e){ IDEIA.list=[]; } return IDEIA.list; }
window.ideiaLoadList=ideiaLoadList;
async function ideiaGet(id){
  if(IDEIA.mem[id]) return IDEIA.mem[id];
  const m=await ideiaCall()('ideia_read',{ id });
  if(!m) return null;
  IDEIA.mem[id]=ideiaRevive(m);
  return IDEIA.mem[id];
}
async function ideiaLoadMode(){ try{ IDEIA.mode=await ideiaCall()('ideia_research_mode'); }catch(e){ IDEIA.mode={ engine:ideiaEngine(), mode:'none', msg:ideiaErr(e,'Nenhuma IA disponível') }; } return IDEIA.mode; }

// ---- abrir a aba ----
// estado da aba (instância múltipla): qual ideia ela mostra + o rascunho; título "Ideia: <título>"
window.TAB_STATE_ideia={
  get:()=>{ ideiaCapture(); return { id:IDEIA.cur?IDEIA.cur.id:'', draft:IDEIA.draft, newDraft:IDEIA.newDraft, _title:IDEIA.cur?('Ideia: '+IDEIA.cur.titulo):'' }; },
  set:(st)=>{ IDEIA.pendingId=(st&&st.id)||''; IDEIA.draft=(st&&st.draft)||''; IDEIA.newDraft=(st&&st.newDraft)||''; IDEIA.cur=IDEIA.pendingId?(IDEIA.mem[IDEIA.pendingId]||null):null; },
};
async function openIdeia(fresh){
  const ov=$id('ideiaOverlay'); if(!ov) return;
  if(fresh){ const id=IDEIA.next; IDEIA.next=null; IDEIA.cur=id?(await ideiaGet(id).catch(()=>null)):null; IDEIA.draft=''; if(!id) IDEIA.newDraft=IDEIA.carry||(window.ndTakeCarry?window.ndTakeCarry():'')||''; IDEIA.carry=''; } // texto levado da Nova demanda vira o rascunho
  else if(IDEIA.pendingId && (!IDEIA.cur || IDEIA.cur.id!==IDEIA.pendingId)) IDEIA.cur=await ideiaGet(IDEIA.pendingId).catch(()=>null);
  if(typeof ovShow==='function') ovShow(ov); else ov.style.display='flex';
  ideiaRender();
  if(typeof renderTabs==='function') renderTabs();
  await Promise.all([ideiaLoadMode(), IDEIA.cur?null:ideiaLoadList()]);
  ideiaRender();
  if(IDEIA.cur) ideiaResumePaused(IDEIA.cur); // trabalho que esperava a aba aparecer
  setTimeout(()=>{ const i=$id(IDEIA.cur?'ideiaIn':'ideiaNewIn'); if(i && !i.value) i.focus(); }, 40);
}
window.openIdeia=openIdeia;
// abre uma aba de ideia: nova (texto opcional) ou uma salva (reaproveita a aba que já mostra ela)
function ideiaNew(text){ IDEIA.next=null; IDEIA.carry=String(text||'').trim(); if(window.openTab) window.openTab('ideia'); }
function ideiaOpenTab(id){
  const t=(typeof TABS!=='undefined'?TABS:[]).find(x=>x.kind==='ideia' && ((x.state&&x.state.id===id) || (x.id===activeTab && IDEIA.cur && IDEIA.cur.id===id)));
  if(t){ activateTab(t.id); return; }
  IDEIA.next=id; if(window.openTab) window.openTab('ideia');
}
window.ideiaNew=ideiaNew; window.ideiaOpenTab=ideiaOpenTab;

// ---- criar a ideia (1ª mensagem) e conversar ----
async function ideiaStart(){
  const inp=$id('ideiaNewIn'); const text=String(inp&&inp.value||IDEIA.newDraft||'').trim();
  if(text.length<6){ toast('Conte a ideia numa frase (ex.: "um app de rotina de skincare com lembretes").','warn'); if(inp) inp.focus(); return; }
  const m={ id:ideiaNewId(), v:1, titulo:ideiaTitle(text), createdAt:Date.now(), updatedAt:Date.now(), turns:[], report:null, decision:null, project:null, costUsd:0, tokUsd:0, tokens:0 };
  IDEIA.mem[m.id]=m; IDEIA.cur=m; IDEIA.newDraft=''; IDEIA.draft='';
  if(inp) inp.value='';
  await ideiaSave(m);
  if(typeof renderTabs==='function') renderTabs();
  ideiaSend(m, text);
}
async function ideiaSendFromInput(){
  const m=IDEIA.cur; if(!m) return;
  const inp=$id('ideiaIn'); const text=String(inp&&inp.value||'').trim(); if(!text) return;
  if(ideiaLive(m.id).turn){ toast('Espere a mesa responder (ou pare).','warn'); return; }
  if(ideiaLive(m.id).decide){ toast('A mesa está decidindo o MVP — converse quando a votação terminar (ou pare).','warn'); return; }
  if(inp) inp.value=''; IDEIA.draft='';
  ideiaSend(m, text);
}
// uma mensagem → a mesa inteira responde (Pesquisadora + personas), no máximo IDEIA_POOL por vez
async function ideiaSend(m, text){
  const turn={ you:text, at:Date.now(), resp:{} };
  ideiaPanel().forEach(p=>{ turn.resp[p.id]={ st:'na fila' }; });
  m.turns.push(turn);
  if(typeof chatPinBottom==='function') chatPinBottom('ideiaThread');
  await ideiaSave(m); ideiaPaint(m);
  ideiaRunTurn(m, turn);
}
async function ideiaAsk(m, sys, prompt, json, key){
  const r=await ideiaCall()('ideia_ask',{ id:key||m.id, personaSys:sys, prompt, model:ideiaClaudeModel(), json:!!json });
  m.costUsd=(+m.costUsd||0)+(+(r&&r.costUsd)||0);
  { const tok=(+(r&&r.inTok)||0)+(+(r&&r.outTok)||0); if(!(+(r&&r.costUsd)>0) && tok>0 && typeof mesaTokUsd==='function'){ m.tokens=(+m.tokens||0)+tok; m.tokUsd=(+m.tokUsd||0)+mesaTokUsd(r.engine, r.inTok, r.outTok, r.cachedTok); } }
  if(r && r.error) throw new Error(r.error);
  return String((r&&r.text)||'');
}
// roda quem falta numa rodada de conversa. Aba escondida: não lança ninguém novo (fica "na fila" até voltar)
async function ideiaRunTurn(m, turn){
  const L=ideiaLive(m.id); if(L.turn) return;
  L.turn=true; L.stop=false; L.paused=false;
  try{ await ideiaCall()('mesa_resume',{ id:m.id }); }catch(_){ }
  const todo=ideiaPanel().filter(p=>{ const x=turn.resp[p.id]; return !x || ['na fila','interrompida','parada','falhou'].includes(x.st); });
  todo.forEach(p=>{ turn.resp[p.id]={ st:'na fila' }; });
  ideiaPaint(m);
  const one=async p=>{
    turn.resp[p.id]={ st:'pendente' }; ideiaPaint(m);
    try{ const t=await ideiaAsk(m, ideiaPersonaSys(p), ideiaTurnPrompt(m, p, turn), false); turn.resp[p.id]={ st:'ok', text:t.trim()||'(sem resposta)', at:Date.now() }; }
    catch(e){ const msg=String(e&&e.message||e); turn.resp[p.id]=(L.stop||/MESA_STOPPED/.test(msg))?{ st:'parada' }:{ st:'falhou', erro:ideiaErr(e,'não respondeu') }; }
    await ideiaSave(m); ideiaPaint(m);
  };
  const queue=todo.slice();
  const worker=async()=>{ while(queue.length && !L.stop){ if(!ideiaVisible(m.id)){ L.paused=true; break; } await one(queue.shift()); } };
  try{ await Promise.all(Array.from({ length:Math.min(IDEIA_POOL, queue.length) }, worker)); }
  finally{ L.turn=false; if(L.stop) queue.forEach(p=>{ turn.resp[p.id]={ st:'parada' }; }); await ideiaSave(m); ideiaPaint(m); }
}
async function ideiaStopTurn(m){ const L=ideiaLive(m.id); L.stop=true; ideiaPaint(m); try{ await ideiaCall()('mesa_stop',{ id:m.id }); }catch(_){ } }
// a aba voltou: o que ficou esperando (rodada da conversa ou da decisão) continua
function ideiaResumePaused(m){
  const L=ideiaLive(m.id);
  if(L.dpaused && m.decision && m.decision.status==='rodando' && !L.decide && !L.turn){ L.dpaused=false; ideiaDecide(m, true); return; }
  if(!L.paused) return;
  L.paused=false;
  const t=(m.turns||[]).slice(-1)[0];
  if(t && !L.turn && Object.values(t.resp||{}).some(x=>x.st==='na fila')) ideiaRunTurn(m, t);
}

// ---- pesquisa ----
const IDEIA_ACTS_MAX=40;
try{ window.__TAURI__.event.listen('ideia-activity', ev=>{
  const p=ev&&ev.payload; if(!p || !p.id) return;
  const L=IDEIA.live[p.id]; if(!L || !L.research) return;
  const line=String(p.line||'').trim(); if(!line) return;
  L.research.acts.push({ line, url:p.url||null, at:Date.now() }); if(L.research.acts.length>IDEIA_ACTS_MAX) L.research.acts.shift();
  if(p.url && !L.research.sites.includes(p.url)) L.research.sites.push(p.url);
  if(ideiaVisible(p.id)) ideiaPaintActs(IDEIA.cur);
}); }catch(_){ }
function ideiaCap(){ if(IDEIA.capUsd!=null) return IDEIA.capUsd; const v=parseFloat(String((typeof lsGet==='function'&&lsGet('ideiaCapUsd'))||'').replace(',','.')); return v>0?v:1; }
async function ideiaResearch(m){
  const L=ideiaLive(m.id); if(L.research && L.research.running) return;
  const R={ running:true, acts:[], sites:[], t0:Date.now(), stop:false }; L.research=R; // antes de qualquer await: 2 cliques = 1 pesquisa
  const mode=await ideiaLoadMode(); // sempre atual (a IA padrão pode ter mudado com a aba aberta)
  if(mode.mode==='none'){ R.running=false; toast(mode.msg||'A IA padrão não navega na web.','warn'); ideiaPaint(m); return; }
  const capIn=$id('ideiaCap'); if(capIn){ const v=parseFloat(String(capIn.value).replace(',','.')); if(v>0){ IDEIA.capUsd=v; try{ lsSet('ideiaCapUsd', String(v)); }catch(_){ } } }
  const engine=mode.engine||ideiaEngine(), model=ideiaClaudeModel();
  const prev=m.report&&m.report.status==='ok'?m.report:null;
  m.report=Object.assign({}, prev||{}, { status:'rodando', erro:'', startedAt:Date.now(), engine });
  await ideiaSave(m); ideiaPaint(m);
  try{ await ideiaCall()('mesa_resume',{ id:m.id+'-r' }); }catch(_){ }
  const budget=engine==='claude'?ideiaCap():null;
  let spent=0;
  const call=async(prompt, sid, fix)=>{
    const r=await ideiaCall()('ideia_research',{ id:m.id, sys:IDEIA_RESEARCH_SYS, prompt, model, budgetUsd:fix?null:budget, sessionId:sid||null, fix:!!fix });
    spent+=(+(r&&r.costUsd)||0); m.costUsd=(+m.costUsd||0)+(+(r&&r.costUsd)||0);
    { const tok=(+(r&&r.inTok)||0)+(+(r&&r.outTok)||0); if(tok>0 && typeof mesaTokUsd==='function'){ const u=mesaTokUsd(r.engine, r.inTok, r.outTok, r.cachedTok); m.tokens=(+m.tokens||0)+tok; m.tokUsd=(+m.tokUsd||0)+u; spent+=u; } }
    if(r && r.error) throw new Error(r.error);
    return r||{};
  };
  try{
    let r=await call(ideiaResearchPrompt(m), null, false);
    let chk=ideiaCheckReport(r.text);
    let data=chk.ok?chk.report:null, avisos=[];
    if(!chk.ok && !R.stop){ // a checagem recusou: UMA correção na mesma sessão, sem pesquisar de novo
      R.acts.push({ line:'checagem: '+chk.errors.length+' problema(s) — pedindo a correção ('+ideiaCut(chk.errors[0],80)+')', at:Date.now() }); ideiaPaint(m);
      try{ const r2=await call(ideiaFixPrompt(chk.errors, r.text), r.sessionId, true); const c2=ideiaCheckReport(r2.text); if(c2.ok) data=c2.report; else if(c2.report && (c2.report.fontes||[]).length){ chk=c2; } }
      catch(e){ if(/MESA_STOPPED/.test(String(e&&e.message||e))) throw e; }
      if(!data){ data=ideiaSanitize(chk.report); if(data) avisos=data.avisos||[]; }
    }
    if(!data) throw new Error('a pesquisa voltou sem nenhuma fonte (URL) — relatório recusado. Tente de novo'+(engine==='claude'?' (ou aumente o teto)':''));
    const date=new Date().toLocaleDateString('pt-BR');
    m.report={ status:'ok', data, md:ideiaReportMd(data, m.titulo, { engine:(typeof aiChatRunLabel==='function'?aiChatRunLabel():engine), date }), engine, costUsd:spent, at:Date.now(), sites:R.sites.length, avisos };
    toast(`Pesquisa pronta: ${data.fontes.length} fonte${data.fontes.length===1?'':'s'} — veredito "${IDEIA_VERED[data.veredito?data.veredito.resposta:'talvez']}".`,'ok');
  }catch(e){
    const msg=String(e&&e.message||e), stopped=R.stop||/MESA_STOPPED/.test(msg);
    m.report=Object.assign({}, prev||{}, { status:prev?'ok':(stopped?'parada':'falhou'), erro:stopped?'pesquisa parada':ideiaErr(e,'A pesquisa falhou'), lastErr:Date.now() });
    if(!stopped) showErr(e,'A pesquisa falhou');
  }finally{
    R.running=false; await ideiaSave(m); ideiaPaint(m);
  }
}
async function ideiaStopResearch(m){ const L=ideiaLive(m.id); if(L.research) L.research.stop=true; ideiaPaint(m); try{ await ideiaCall()('mesa_stop',{ id:m.id+'-r' }); }catch(_){ } }

// ---- decidir com a mesa (2 rodadas curtas) ----
async function ideiaDecide(m, resuming){
  const L=ideiaLive(m.id); if(L.decide) return;
  if(L.turn){ toast('Espere a mesa responder a conversa antes de decidir.','warn'); return; }
  if(!resuming && !(m.turns||[]).length){ toast('Converse um pouco com a mesa antes de decidir.','warn'); return; }
  const key=m.id+'-d'; // chave de parar própria: parar a conversa não derruba a votação (e vice-versa)
  const ps=ideiaPanel();
  if(!resuming || !m.decision || !m.decision.rounds){ m.decision={ status:'rodando', rounds:[{ n:1, tipo:'posicao', resp:{} }], cands:[], escolhas:{}, plataforma:'', at:Date.now() }; }
  m.decision.status='rodando';
  L.decide=true; L.dstop=false; L.dpaused=false;
  try{ await ideiaCall()('mesa_resume',{ id:key }); }catch(_){ }
  await ideiaSave(m); ideiaPaint(m);
  const runRound=async(r, prompt, parse)=>{
    const todo=ps.filter(p=>{ const x=r.resp[p.id]; return !x || x.st!=='ok'; });
    const queue=todo.slice();
    const one=async p=>{
      r.resp[p.id]={ st:'pendente' }; ideiaPaint(m);
      try{ const t=await ideiaAsk(m, ideiaPersonaSys(p), prompt, true, key); r.resp[p.id]=Object.assign({ st:'ok', at:Date.now() }, parse(t)); }
      catch(e){ const msg=String(e&&e.message||e); r.resp[p.id]=(L.dstop||/MESA_STOPPED/.test(msg))?{ st:'parada' }:{ st:'falhou', erro:ideiaErr(e,'não respondeu') }; }
      await ideiaSave(m); ideiaPaint(m);
    };
    const worker=async()=>{ while(queue.length && !L.dstop){ if(!ideiaVisible(m.id)){ L.dpaused=true; break; } await one(queue.shift()); } };
    await Promise.all(Array.from({ length:Math.min(IDEIA_POOL, queue.length) }, worker));
    // rodada completa = ninguém na fila e ninguém parado (quem FALHOU conta: a apuração usa quem respondeu)
    return !queue.length && !L.dstop && !ps.some(p=>{ const x=r.resp[p.id]; return x && x.st==='parada'; });
  };
  try{
    const r1=m.decision.rounds[0];
    const p1=t=>{ const x=mesaParsePosition(t), o=ideiaJson(t)||{}; return { texto:x.texto, propostas:x.propostas, naoObjetivos:(Array.isArray(o.naoObjetivos)?o.naoObjetivos:[]).map(s=>ideiaCut(s,140)).filter(Boolean).slice(0,4), plataforma:ideiaPlat(o.plataforma) }; };
    if(!await runRound(r1, ideiaR1Prompt(m), p1)){ m.decision.status=L.dpaused?'rodando':'parada'; return; }
    if(!m.decision.rounds[1]){
      m.decision.cands=mesaCandidates(ps, r1.resp);
      if(!m.decision.cands.length){ m.decision.status='falhou'; m.decision.erro='Nenhuma persona trouxe proposta de MVP válida — tente de novo.'; return; }
      m.decision.rounds.push({ n:2, tipo:'voto', resp:{} });
    }
    const r2=m.decision.rounds[1], ids=m.decision.cands.map(c=>c.id);
    const p2=t=>{ const v=mesaParseVote(t, ids), o=ideiaJson(t)||{}; return v.ok?{ texto:v.vote.fala, voto:v.vote, plataforma:ideiaPlat(o.plataforma) }:{ texto:String((o.fala||t)||'').trim(), voto:null, aviso:'voto descartado ('+v.erro+')', plataforma:ideiaPlat(o.plataforma) }; };
    if(!await runRound(r2, ideiaR2Prompt(m, ps, r1.resp, m.decision.cands), p2)){ m.decision.status=L.dpaused?'rodando':'parada'; return; }
    const view=ideiaDecisionView(m.decision, ps);
    if(!view || !view.mvp.length){ m.decision.status='falhou'; m.decision.erro='A votação não deixou nenhuma feature sem veto — argumente na conversa e decida de novo.'; return; }
    m.decision.status='ok'; m.decision.erro='';
    toast(`A mesa decidiu o MVP: ${view.mvp.length} feature${view.mvp.length===1?'':'s'} · ${ideiaPlatName(view.plataforma)}.`,'ok');
  }catch(e){ m.decision.status='falhou'; m.decision.erro=ideiaErr(e,'A decisão parou'); }
  finally{ L.decide=false; await ideiaSave(m); ideiaPaint(m); }
}
async function ideiaStopDecide(m){ const L=ideiaLive(m.id); L.dstop=true; ideiaPaint(m); try{ await ideiaCall()('mesa_stop',{ id:m.id+'-d' }); }catch(_){ } }

// ---- criar o projeto ----
async function ideiaCreate(m, mode){
  const L=ideiaLive(m.id); if(L.creating) return;
  const view=m.decision&&ideiaDecisionView(m.decision, ideiaPanel()); if(!view || !view.mvp.length){ toast('Decida o MVP com a mesa antes de criar o projeto.','warn'); return; }
  const md=m.report&&m.report.status==='ok'?m.report.md:'';
  const plan=ideiaBuildPlan(m, view, md), slug=ideiaSlug(m.titulo);
  const q=mode==='piloto'
    ? `Criar o projeto "${slug}" e entregar pro PILOTO AUTOMÁTICO?\n\nO piloto constrói sozinho o épico "${plan.epic}" (${plan.tasks.length} tarefas, ${ideiaPlatName(plan.platform)}) numa pasta nova em Documentos › Starfork, só no seu computador.${md?'\n\nA pesquisa vai junto em docs/pesquisa-'+slug+'.md.':''}`
    : `Criar o projeto "${slug}" com o épico "${plan.epic}" e ${plan.tasks.length} tarefas em rascunho (nenhuma começa sozinha)?${IDEIA.gh?'\n\nTambém cria o repositório PRIVADO no GitHub.':''}${md?'\n\nA pesquisa vai em docs/pesquisa-'+slug+'.md.':''}`;
  if(!await askYes(q, mode==='piloto'?'Entregar pro piloto':'Criar projeto')) return;
  L.creating=true; ideiaPaint(m);
  try{
    if(mode==='piloto'){
      const capIn=$id('ideiaApCap'); const cap=capIn?parseFloat(String(capIn.value).replace(',','.')):NaN;
      const op=typeof window.orgPolForPilot==='function'?await window.orgPolForPilot():null; // F5 · P14
      const res=await invoke('autopilot_start',{ orgPolicy:op, idea:`${m.titulo}${view.mvp.length?' — MVP: '+view.mvp.map(f=>f.titulo).join('; '):''}`.slice(0,600), platform:plan.platform, name:slug, engine:defaultAiEngine(), model:defaultAiModel(), parallel:2, attempts:2, budgetUsd:cap>0?cap:null, plan }); // vazio ou 0 = sem teto
      const dir=typeof res==='string'?res:(res&&res.dir)||'';
      m.project={ dir, mode:'piloto', at:Date.now(), epic:plan.epic };
      await ideiaSave(m);
      if(typeof pilSetDir==='function'){ pilSetDir(dir); if(typeof pilWaitStart==='function') pilWaitStart(); }
      if(res&&res.warning) toast(res.warning,'warn'); else toast('O piloto automático começou — acompanhe na aba de progresso.','ok');
      if(window.switchProject){ try{ await window.switchProject(dir); }catch(_){ } }
      if(window.openTab) window.openTab('pilotorun');
      return;
    }
    // criação que parou no meio (pasta criada, doc/tarefa falhou): CONTINUA na mesma pasta, sem repetir o que já foi
    const part=m.partial&&m.partial.mode==='manual'&&m.partial.dir?m.partial:null;
    let path=part?part.dir:'';
    if(part){ if(window.switchProject && (typeof state==='undefined' || state.repo!==path)) await window.switchProject(path); }
    else {
      if(IDEIA.gh){
        const target=String(await invoke('quick_project_target',{ name:slug })||'');
        const parent=target.replace(/[\\/][^\\/]+$/,''), name=target.split(/[\\/]/).pop();
        path=await invoke('create_project',{ parent, name, github:true, private:true, owner:'' });
      } else path=await invoke('quick_create_project',{ name:slug });
      path=String(path||'');
      m.partial={ mode:'manual', dir:path, tasks:[], at:Date.now() };
      await ideiaSave(m);
      selected=null; lastSig=''; if(typeof clearProjectCaches==='function') clearProjectCaches();
      try{ await refresh(); }catch(_){ } if(typeof loadProjects==='function') try{ await loadProjects(); }catch(_){ }
    }
    if(md) await invoke('ideia_commit_doc',{ repo:path, rel:`docs/pesquisa-${slug}.md`, content:md, message:`docs: pesquisa de mercado da ideia "${ideiaCut(m.titulo,60)}"` });
    await invoke('ideia_commit_doc',{ repo:path, rel:`docs/epico-${slug}.md`, content:ideiaEpicMd(plan, m.titulo), message:`docs: épico do MVP "${ideiaCut(m.titulo,60)}"` });
    const epicId='ideia-'+slug, made=m.partial.tasks.map(t=>t.id);
    const pol=typeof ntPolicy!=='undefined'?ntPolicy:{};
    const all=ideiaTaskPayloads(plan, epicId, { engine:defaultAiEngine(), model:defaultAiModel(), proof:pol.proofRequired, tests:pol.testsRequired });
    for(let i=made.length;i<all.length;i++){
      const { afterIdx, payload }=all[i];
      // a tarefa nasce no projeto ABERTO: se a pessoa trocou de projeto no meio, para (sem criar no projeto errado)
      if(typeof state!=='undefined' && state && state.repo && state.repo!==path) throw new Error(`o projeto aberto mudou — abra "${slug}" e clique em "continuar a criação"`);
      payload.after=afterIdx.map(j=>made[j]).filter(Boolean);
      payload.termMode='auto'; // o MVP da ideia é construído sozinho (ondas) — sem terminal
      const id=await invoke('new_task', typeof trkBeforeNewTask==='function'?await trkBeforeNewTask(payload):payload);
      made.push(id); m.partial.tasks.push({ id, titulo:payload.title });
      await ideiaSave(m);
    }
    m.project={ dir:path, mode:'manual', at:Date.now(), epic:plan.epic, tasks:m.partial.tasks };
    delete m.partial;
    await ideiaSave(m);
    lastSig=''; try{ await refresh(); }catch(_){ }
    toast(`Projeto criado com o épico "${plan.epic}" e ${made.length} tarefas em rascunho no quadro.`,'ok');
    if(window.openTab) window.openTab('flow');
  }catch(e){ showErr(e,'Não consegui criar o projeto'); }
  finally{ L.creating=false; await ideiaSave(m); ideiaPaint(m); }
}

// ---------------- tela ----------------
function ideiaPaint(m){ if(ideiaVisible(m&&m.id)) ideiaRender(); else if(typeof renderTabs==='function' && m && IDEIA.cur===m) renderTabs(); }
function ideiaCapture(){
  const a=$id('ideiaIn'); if(a) IDEIA.draft=a.value;
  const n=$id('ideiaNewIn'); if(n) IDEIA.newDraft=n.value;
  const c=$id('ideiaCap'); if(c){ const v=parseFloat(String(c.value).replace(',','.')); if(v>0) IDEIA.capUsd=v; }
  const g=$id('ideiaGh'); if(g) IDEIA.gh=!!g.checked;
  const ap=$id('ideiaApCap'); if(ap) IDEIA.apCap=ap.value;
}
function ideiaRender(){
  const body=$id('ideiaBody'); if(!body) return;
  ideiaCapture();
  const html='<div class="ideiawrap">'+(IDEIA.cur?ideiaIdeaHtml(IDEIA.cur):ideiaStartHtml())+'</div>';
  if(body.__html===html) return;
  const ae=document.activeElement, fid=ae&&body.contains(ae)&&ae.id?ae.id:null;
  const sel=fid&&typeof ae.selectionStart==='number'?[ae.selectionStart, ae.selectionEnd]:null;
  const docEl=body.querySelector('.ideiaside'), top=docEl?docEl.scrollTop:0;
  const keep=typeof stickBottom==='function'?stickBottom($id('ideiaThread')):()=>{};
  body.innerHTML=html; body.__html=html;
  { const d=body.querySelector('.ideiaside'); if(d) d.scrollTop=top; }
  keep($id('ideiaThread'));
  { const a=$id('ideiaIn'); if(a && a.value!==IDEIA.draft) a.value=IDEIA.draft; const n=$id('ideiaNewIn'); if(n && n.value!==IDEIA.newDraft) n.value=IDEIA.newDraft; }
  if(fid){ const el=$id(fid); if(el){ el.focus(); if(sel && typeof el.setSelectionRange==='function') try{ el.setSelectionRange(sel[0], sel[1]); }catch(_){ } } }
  ideiaWire(body);
}
function ideiaPillLabel(){ return typeof aiChatRunLabel==='function'?aiChatRunLabel():'IA padrão'; }
function ideiaRecentHtml(n, compact){
  const l=(IDEIA.list||[]).slice(0,n||8); if(!l.length) return '';
  const st=x=>x.corrompida?'arquivo ilegível':x.projeto?'projeto criado':x.decisao==='ok'?'MVP decidido':x.pesquisa==='ok'?'pesquisada':(x.turnos?x.turnos+' mensagem'+(x.turnos===1?'':'s'):'nova');
  const d=x=>x.updatedAt?new Date(x.updatedAt).toLocaleString('pt-BR',{ day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }):'';
  return `<div class="ideiarecent${compact?' compact':''}"><h2>Ideias recentes</h2><div class="ideialist">${l.map(x=>`<button type="button" class="ideiarow" data-iopen="${iEsc(x.id)}"${x.corrompida?' disabled':''}><span class="ideiart"><b>${iEsc(x.titulo||'(sem título)')}</b><span class="ideiast">${iEsc(st(x))}</span></span><span class="ideiarm">${iEsc(d(x))}${+x.costUsd>0?' · '+iEsc(fmtCost(+x.costUsd,{ usdOnly:true })):''}</span></button>`).join('')}</div></div>`;
}
window.ideiaRecentHtml=ideiaRecentHtml;
function ideiaStartHtml(){
  const names=ideiaPanel().map(p=>p.nome).join(', ');
  return `<div class="ideiastart"><div class="ideiahero">${IC.ideia}<h1>Começar por uma ideia</h1>`+
    `<p>Conte a ideia como contaria pra um amigo. A mesa responde — ${iEsc(names)} — cada uma do seu jeito. Depois a Pesquisadora busca na web se a ideia teria procura agora (com fontes), a mesa decide o MVP e o Starfork cria o projeto: pra você seguir ou pro piloto automático construir.</p></div>`+
    chatComposerHtml({ input:'ideiaNewIn', send:'ideiaNewGo', rows:3, value:IDEIA.newDraft, sendHtml:'começar', modelPill:aiChatModelPill('ideiaNewModel'), placeholder:'ex.: um app de rotina de skincare com lembretes — quero saber se faria sucesso agora' })+
    (IDEIA.list===null?`<div class="dim ideiahint">lendo as ideias…</div>`:ideiaRecentHtml(8))+`</div>`;
}
function ideiaSteps(m){
  const st=ideiaStage(m), order=['conversar','pesquisar','decidir','criar'], at=st==='criado'?4:order.indexOf(st);
  const lbl={ conversar:'Conversar', pesquisar:'Pesquisar', decidir:'Decidir o MVP', criar:'Criar o projeto' };
  return `<ol class="ideiaflow" aria-label="passos da ideia">${order.map((k,i)=>`<li class="${i<at?'ok':i===at?'cur':''}"${i===at?' aria-current="step"':''}>${lbl[k]}</li>`).join('')}</ol>`;
}
function ideiaAvatar(p){ const hue={ pesq:170, bia:330, rafa:210, carla:30, marcos:270, julia:0 }[p.id]; return `<span class="ideiaav" style="--h:${hue==null?190:hue}" aria-hidden="true">${iEsc(p.nome.charAt(0))}</span>`; }
function ideiaTurnHtml(m, t, last){
  const L=ideiaLive(m.id), ps=ideiaPanel();
  const you=`<div class="plmsg you chatmsg"><div class="plbub">${iEsc(t.you)}</div></div>`;
  const rs=ps.map(p=>{
    const x=t.resp[p.id]||{ st:'na fila' };
    let inner;
    if(x.st==='ok') inner=`<div class="mdview ideiamd">${mdToHtml(x.text||'')}</div>`;
    else if(x.st==='pendente') inner=`<span class="ideiachip live"><span class="pltyping"><i></i><i></i><i></i></span>pensando…</span>`;
    else if(x.st==='falhou') inner=`<span class="ideiachip bad">não respondeu</span> <span class="dim ideiaerr">${iEsc(x.erro||'')}</span>`;
    else if(x.st==='na fila') inner=`<span class="ideiachip">${L.paused&&last?'esperando a aba aparecer':'na fila'}</span>`;
    else inner=`<span class="ideiachip">${x.st==='interrompida'?'interrompida':'parada'}</span>`;
    return `<div class="ideiamsg st-${iEsc(x.st.replace(/\s/g,'-'))}">${ideiaAvatar(p)}<div class="ideiamb"><div class="ideiamn"><b>${iEsc(p.nome)}</b><span class="dim">${iEsc(p.papel)}</span></div>${inner}</div></div>`;
  }).join('');
  const failed=last && !L.turn && Object.values(t.resp).some(x=>['falhou','parada','interrompida','na fila'].includes(x.st));
  return you+`<div class="ideiapanel">${rs}${failed?`<button type="button" class="btn sm" id="ideiaRetryTurn">${IC.play||''}responder quem faltou</button>`:''}</div>`;
}
function ideiaResearchHtml(m){
  const L=ideiaLive(m.id), mode=IDEIA.mode, rep=m.report, running=!!(L.research&&L.research.running);
  const eng=(mode&&mode.engine)||ideiaEngine(), [lo,hi]=ideiaResearchCost(eng, ideiaClaudeModel());
  let body='';
  if(running){
    const acts=(L.research.acts||[]).slice(-12).reverse();
    body=`<div class="ideiaprog" role="status"><div class="ideiaprogh"><span class="pltyping"><i></i><i></i><i></i></span><b>pesquisando</b><span class="dim" id="ideiaSites">${L.research.sites.length} página${L.research.sites.length===1?'':'s'} lida${L.research.sites.length===1?'':'s'} · ${(L.research.acts||[]).length} passo${(L.research.acts||[]).length===1?'':'s'}</span><span class="ideiasp"></span><button type="button" class="btn sm" id="ideiaResStop"${L.research.stop?' disabled':''}>${IC.stopsq||''}${L.research.stop?'parando…':'Parar'}</button></div>`+
      `<ul class="ideiaacts" id="ideiaActs">${ideiaActsHtml(acts)}</ul><div class="dim ideiahint">segue rodando se você trocar de aba — o relatório chega aqui.</div></div>`;
  } else if(mode && mode.mode==='none'){
    body=`<div class="ideianote warn">${iEsc(mode.msg)}</div><div class="ideiaacts2"><button type="button" class="btn sm" id="ideiaGoCfg">trocar a IA</button><button type="button" class="btn sm" id="ideiaGoEnv">pesquisa ampliada no Ambiente</button></div>`;
  } else {
    const capRow=eng==='claude'?`<label class="ideiacap">teto US$ <input class="in" id="ideiaCap" type="number" min="0.1" step="0.1" value="${iEsc(String(ideiaCap()))}" aria-label="teto da pesquisa em dólares"></label>`:`<span class="dim">estimativa pelos tokens — ${iEsc(eng)} não tem teto por pesquisa</span>`;
    body=`<div class="ideiaest"><div>deve custar <b>${iEsc(fmtCostRange(lo,hi))}</b> <span class="dim">· usa ${iEsc((mode&&mode.tools)||'a web da sua IA')}</span></div><div class="ideiaestrow">${capRow}<span class="ideiasp"></span><button type="button" class="btn ${rep&&rep.status==='ok'?'':'primary'}" id="ideiaResGo">${rep&&rep.status==='ok'?'Pesquisar de novo':'Pesquisar'}</button></div></div>`+
      (rep && rep.erro && rep.status!=='rodando'?`<div class="ideianote warn" role="alert">${iEsc(rep.erro)}</div>`:'');
  }
  let doc='';
  if(rep && rep.status==='ok' && rep.data){
    const v=rep.data.veredito||{ resposta:'talvez', confianca:'baixa', texto:'' };
    doc=`<div class="ideiaverd v-${iEsc(v.resposta)}"><div class="ideiaverdq">Vale a pena agora?</div><div class="ideiaverda">${iEsc(IDEIA_VERED[v.resposta])}<span>confiança ${iEsc(IDEIA_CONF[v.confianca]||v.confianca)}</span></div><p>${iEsc(v.texto)}</p></div>`+
      `<div class="dim ideiameta">${rep.data.fontes.length} fonte${rep.data.fontes.length===1?'':'s'} · ${+rep.sites||0} página${+rep.sites===1?'':'s'} lida${+rep.sites===1?'':'s'} · ${iEsc(fmtCost(+rep.costUsd||0,{ usdOnly:true }))}${(rep.avisos||[]).length?` · <span class="ideiawarnt">${rep.avisos.length} aviso${rep.avisos.length===1?'':'s'} da checagem</span>`:''}</div>`+
      `<article class="mdview ideiadoc">${mdToHtml(rep.md.replace(/^# .*\n+(> .*\n+)?/,''))}</article>`;
  }
  return `<section class="ideiasec" aria-labelledby="ideiaResH"><h2 id="ideiaResH">Pesquisa</h2>${body}${doc}</section>`;
}
function ideiaActsHtml(acts){ return (acts||[]).map(a=>`<li>${a.url?`<a href="#" data-iurl="${iEsc(a.url)}">${iEsc(ideiaCut(a.line,110))}</a>`:iEsc(ideiaCut(a.line,110))}</li>`).join('')||'<li class="dim">preparando a busca…</li>'; }
// progresso da pesquisa sem redesenhar a aba inteira (o evento chega a cada ferramenta usada)
function ideiaPaintActs(m){
  const L=m&&IDEIA.live[m.id]; const ul=$id('ideiaActs'), s=$id('ideiaSites'); if(!L || !L.research || !ul){ if(m) ideiaRender(); return; }
  ul.innerHTML=ideiaActsHtml(L.research.acts.slice(-12).reverse());
  if(s){ const n=L.research.sites.length, k=L.research.acts.length; s.textContent=`${n} página${n===1?'':'s'} lida${n===1?'':'s'} · ${k} passo${k===1?'':'s'}`; }
}
function ideiaDecisionHtml(m){
  const L=ideiaLive(m.id), dc=m.decision, ps=ideiaPanel();
  const n=ps.length, [lo,hi]=typeof mesaCost==='function'?mesaCost(n, 2, ideiaClaudeModel()||'sonnet', typeof roughEstimate==='function'?roughEstimate:null):[0,0];
  const go=`<div class="ideiaest"><div>a mesa (${n} vozes) dá a posição e depois debate e vota: sai o MVP, o que fica de fora e a plataforma. Deve custar <b>${iEsc(fmtCostRange(lo*0.6,hi*0.6))}</b>.</div><div class="ideiaestrow"><span class="ideiasp"></span><button type="button" class="btn${!dc||dc.status!=='ok'?' primary':''}" id="ideiaDecGo"${!(m.turns||[]).length||L.decide||L.turn?' disabled':''}>${dc&&dc.status==='ok'?'Decidir de novo':'Decidir com a mesa'}</button></div></div>`;
  if(!dc) return `<section class="ideiasec"><h2>Decisão</h2>${go}</section>`;
  if(dc.status==='rodando' || L.decide){
    const chips=(dc.rounds||[]).map(r=>`<div class="ideiaround"><b>${r.n===1?'Rodada 1 — posições':'Rodada 2 — debate e voto'}</b><div class="ideiarchips">${ps.map(p=>{ const x=r.resp[p.id]; const s=x?x.st:'na fila'; return `<span class="ideiachip ${s==='ok'?'ok':s==='pendente'?'live':s==='falhou'?'bad':''}">${iEsc(p.nome)}${s==='ok'?'':' · '+(s==='pendente'?'pensando':s)}</span>`; }).join('')}</div></div>`).join('');
    return `<section class="ideiasec"><h2>Decisão</h2><div class="ideiaprog"><div class="ideiaprogh"><span class="pltyping"><i></i><i></i><i></i></span><b>${L.dpaused?'esperando a aba aparecer':'a mesa está decidindo'}</b><span class="ideiasp"></span>${L.decide?`<button type="button" class="btn sm" id="ideiaDecStop"${L.dstop?' disabled':''}>${IC.stopsq||''}${L.dstop?'parando…':'Parar'}</button>`:`<button type="button" class="btn sm primary" id="ideiaDecCont">continuar</button>`}</div>${chips}</div></section>`;
  }
  if(dc.status!=='ok') return `<section class="ideiasec"><h2>Decisão</h2><div class="ideianote warn">${iEsc(dc.erro||'A decisão parou no meio.')}</div><div class="ideiaacts2"><button type="button" class="btn sm primary" id="ideiaDecCont">continuar de onde parou</button></div>${go}</section>`;
  const v=ideiaDecisionView(dc, ps); if(!v) return `<section class="ideiasec"><h2>Decisão</h2>${go}</section>`;
  const nome=pid=>(ps.find(p=>p.id===pid)||{}).nome||pid;
  const todosDiz=v.dec.rows.some(r=>!r.todos); // "voto de todos" em TODA linha não diz nada (mesma regra da Mesa)
  const rows=v.dec.rows.filter(r=>r.total>0||r.vetadoPor.length).map(r=>{
    const inMvp=v.mvp.some(f=>f.id===r.id);
    return `<li class="ideiafeat${inMvp?' on':''}${r.vetadoPor.length?' veto':''}"><span class="ideiafp">${r.total}</span><span class="ideiaft"><b>${iEsc(r.titulo)}</b>${r.vetadoPor.length?`<span class="ideiatag veto">vetada por ${iEsc(r.vetadoPor.map(nome).join(', '))}</span>`:''}${r.todos&&todosDiz?'<span class="ideiatag">voto de todos</span>':''}</span>`+
      `<span class="ideiafb"><button type="button" class="btn sm${r.escolha==='aprovada'?' on':''}" data-ichoose="${iEsc(r.id)}:aprovada" aria-pressed="${r.escolha==='aprovada'}" title="entra no MVP" aria-label="pôr ${iEsc(r.titulo)} no MVP">${IC.ok}</button><button type="button" class="btn sm${r.escolha==='rejeitada'?' on bad':''}" data-ichoose="${iEsc(r.id)}:rejeitada" aria-pressed="${r.escolha==='rejeitada'}" title="fica de fora" aria-label="tirar ${iEsc(r.titulo)} do MVP">${IC.x}</button></span></li>`;
  }).join('');
  const plats=IDEIA_PLATS.map(([k,l])=>`<option value="${k}"${k===v.plataforma?' selected':''}>${l}${k===v.plataformaVotada?' (votada)':''}</option>`).join('');
  return `<section class="ideiasec"><h2>Decisão</h2>`+
    `<div class="ideiadec"><div class="ideialbl">MVP <span class="dim">— ${v.mvp.length} feature${v.mvp.length===1?'':'s'}; pontos da votação; ${IC.ok} põe, ${IC.x} tira</span></div><ol class="ideiafeats">${rows}</ol>`+
    `<label class="ideiaplat">Plataforma <select class="in" id="ideiaPlat">${plats}</select></label>`+
    (v.naoObjetivos.length?`<div class="ideialbl">Fora do MVP</div><ul class="ideianon">${v.naoObjetivos.map(x=>`<li>${iEsc(x)}</li>`).join('')}</ul>`:'')+`</div>${go}</section>`;
}
function ideiaCreateHtml(m){
  const L=ideiaLive(m.id), stage=ideiaStage(m);
  if(m.project && m.project.dir){
    const p=m.project;
    return `<section class="ideiasec"><h2>Projeto</h2><div class="ideiadone">${IC.ok}<div><b>${p.mode==='piloto'?'Entregue pro piloto automático':'Projeto criado'}</b><div class="dim mono">${iEsc(String(p.dir).replace(/^\/Users\/[^/]+/,'~'))}</div></div></div>`+
      `<div class="ideiaacts2"><button type="button" class="btn primary" id="ideiaOpenProj">${p.mode==='piloto'?'ver o progresso do piloto':'abrir o quadro do projeto'}</button>${m.report&&m.report.status==='ok'&&p.mode==='manual'&&m.report.at>p.at?'<button type="button" class="btn" id="ideiaSaveDoc">atualizar a pesquisa no projeto</button>':''}</div></section>`;
  }
  if(stage!=='criar') return `<section class="ideiasec"><h2>Projeto</h2><div class="dim ideiahint">Depois que a mesa decidir o MVP, o Starfork monta o épico (pronto quando, requisitos por tarefa, ondas) e cria o projeto.</div></section>`;
  const v=ideiaDecisionView(m.decision, ideiaPanel()), plan=ideiaBuildPlan(m, v, '');
  const busy=L.creating, part=m.partial&&m.partial.dir;
  return `<section class="ideiasec"><h2>Projeto</h2>${part?`<div class="ideianote warn">A criação parou no meio — a pasta ${iEsc(String(m.partial.dir).replace(/^\/Users\/[^/]+/,'~'))} já existe com ${m.partial.tasks.length} tarefa${m.partial.tasks.length===1?'':'s'}. "Continuar a criação" segue dali, sem repetir.</div>`:''}<div class="ideiaplan"><b>${iEsc(plan.epic)}</b> <span class="dim">· ${plan.tasks.length} tarefas em 2 ondas · ${iEsc(ideiaPlatName(plan.platform))}${m.report&&m.report.status==='ok'?' · com a pesquisa em docs/':''}</span></div>`+
    `<div class="ideiacreate"><div class="ideiaopt"><b>Criar e seguir eu mesmo</b><p class="dim">Pasta nova em Documentos › Starfork com o épico e as tarefas em rascunho no quadro — você revisa e solta quando quiser.</p><label class="ideiachk"><input type="checkbox" id="ideiaGh"${IDEIA.gh?' checked':''}> guardar também no GitHub (privado)</label><button type="button" class="btn primary" id="ideiaMkManual"${busy?' disabled':''}>${busy?'criando…':part?'continuar a criação':'criar e seguir eu mesmo'}</button></div>`+
    `<div class="ideiaopt"><b>Criar e entregar pro piloto automático</b><p class="dim">O piloto constrói tudo sozinho, sem perguntar, e prova cada tarefa. Só no seu computador (sem GitHub).</p><label class="ideiacap">teto US$ <input class="in" id="ideiaApCap" type="text" inputmode="decimal" placeholder="sem teto" value="${iEsc(IDEIA.apCap)}" aria-label="teto do piloto em dólares"></label><button type="button" class="btn" id="ideiaMkPiloto"${busy||part?' disabled':''}>criar e entregar pro piloto</button></div></div></section>`;
}
function ideiaIdeaHtml(m){
  const L=ideiaLive(m.id), turns=m.turns||[];
  const spent=(+m.costUsd||0)+(+m.tokUsd||0);
  const head=`<div class="ideiatop"><div class="ideiatitle">${IC.ideia}<div><h1>Ideia: ${iEsc(m.titulo)}</h1><div class="dim ideiasub">gastou ${iEsc(fmtCost(spent,{ usdOnly:true }))}${+m.tokUsd>0?' (parte estimada pelos tokens)':''} · salva neste computador</div></div></div><div class="ideiactl"><button type="button" class="btn" id="ideiaBack">${IC.back||''}ideias</button></div></div>`;
  const thread=`<div class="ideiathread plthread" id="ideiaThread">${turns.map((t,i)=>ideiaTurnHtml(m, t, i===turns.length-1)).join('')||'<div class="dim ideiahint">Escreva a ideia abaixo — a mesa responde.</div>'}</div>`;
  const comp=chatComposerHtml({ input:'ideiaIn', send:'ideiaSend', stop:'ideiaStop', stopTitle:'para a mesa', rows:2, value:IDEIA.draft, modelPill:aiChatModelPill('ideiaModel'),
    placeholder:'converse com a mesa — ex.: "e se for só pra quem tem pele oleosa?"', sendHtml:'enviar' });
  return head+ideiaSteps(m)+`<div class="ideiagrid"><div class="ideiachat">${thread}${comp}</div><div class="ideiaside">${ideiaResearchHtml(m)}${ideiaDecisionHtml(m)}${ideiaCreateHtml(m)}</div></div>`;
}
function ideiaWire(body){
  const m=IDEIA.cur;
  if(!m){
    if($id('ideiaNewIn')) chatComposer({ input:'ideiaNewIn', attach:null, pend:()=>[], taskId:()=>null, rerender:()=>{}, send:'ideiaNewGo', onSend:ideiaStart, modelPill:aiChatModelPill('ideiaNewModel'), hint:'Enter começa · ⇧Enter quebra linha' });
    bindClick('ideiaNewGo', ideiaStart);
  } else {
    const L=ideiaLive(m.id);
    if($id('ideiaIn')) chatComposer({ input:'ideiaIn', attach:null, pend:()=>[], taskId:()=>null, rerender:()=>{}, send:'ideiaSend', onSend:ideiaSendFromInput, modelPill:aiChatModelPill('ideiaModel'),
      stop:{ btn:'ideiaStop', busy:()=>L.turn, fn:()=>ideiaStopTurn(m) }, hint:'Enter envia · ⇧Enter quebra linha', busyHint:'a mesa está respondendo…' });
    bindClick('ideiaSend', ideiaSendFromInput);
    bindClick('ideiaBack', async()=>{ IDEIA.cur=null; IDEIA.pendingId=''; if(typeof renderTabs==='function') renderTabs(); await ideiaLoadList(); ideiaRender(); });
    bindClick('ideiaRetryTurn', ()=>{ const t=m.turns[m.turns.length-1]; if(t) ideiaRunTurn(m, t); });
    bindClick('ideiaResGo', ()=>ideiaResearch(m));
    bindClick('ideiaResStop', ()=>ideiaStopResearch(m));
    bindClick('ideiaDecGo', ()=>ideiaDecide(m, false));
    bindClick('ideiaDecCont', ()=>ideiaDecide(m, true));
    bindClick('ideiaDecStop', ()=>ideiaStopDecide(m));
    bindClick('ideiaMkManual', ()=>ideiaCreate(m, 'manual'));
    bindClick('ideiaMkPiloto', ()=>ideiaCreate(m, 'piloto'));
    bindClick('ideiaGoCfg', ()=>{ if(typeof suaIaOpenCfg==='function') suaIaOpenCfg(); else if(window.openTab) window.openTab('cfg'); });
    bindClick('ideiaGoEnv', ()=>{ if(window.openTab) window.openTab('env'); });
    bindClick('ideiaOpenProj', async()=>{ const p=m.project; if(!p) return; if(window.switchProject && (typeof state==='undefined'||state.repo!==p.dir)) try{ await window.switchProject(p.dir); }catch(_){ } if(p.mode==='piloto'){ if(typeof pilSetDir==='function') pilSetDir(p.dir); window.openTab('pilotorun'); } else window.openTab('flow'); });
    bindClick('ideiaSaveDoc', async()=>{ try{ await invoke('ideia_commit_doc',{ repo:m.project.dir, rel:`docs/pesquisa-${ideiaSlug(m.titulo)}.md`, content:m.report.md, message:'docs: pesquisa de mercado atualizada' }); m.project.at=Date.now(); await ideiaSave(m); ideiaRender(); toast('Pesquisa atualizada no projeto.','ok'); }catch(e){ showErr(e,'Não consegui gravar a pesquisa no projeto'); } });
    const pl=$id('ideiaPlat'); if(pl) pl.onchange=async()=>{ m.decision.plataforma=pl.value; await ideiaSave(m); ideiaRender(); };
    const gh=$id('ideiaGh'); if(gh) gh.onchange=()=>{ IDEIA.gh=gh.checked; };
    body.querySelectorAll('[data-ichoose]').forEach(b=>b.onclick=async()=>{ const [id,w]=b.dataset.ichoose.split(':'); const e=m.decision.escolhas=m.decision.escolhas||{}; if(e[id]===w) delete e[id]; else e[id]=w; await ideiaSave(m); ideiaRender(); });
  }
}
// cliques que valem em qualquer lugar (lista de ideias na Mesa, links de fontes do progresso)
document.addEventListener('click', e=>{
  const o=e.target.closest&&e.target.closest('[data-iopen]');
  if(o){ e.preventDefault(); ideiaOpenTab(o.dataset.iopen); return; }
  const u=e.target.closest&&e.target.closest('[data-iurl]');
  if(u){ e.preventDefault(); invoke('open_url',{ url:u.dataset.iurl }).catch(()=>{}); }
});
bindClick('ideiaClose', ()=>{ if(typeof ovHide==='function') ovHide('ideiaOverlay'); });
// entrada pela tela inicial sem projeto ("O que você quer fazer?"): o texto digitado vira a 1ª mensagem
bindClick('emIdeia', ()=>{ const t=$id('emWhat'); ideiaNew(t&&t.value); if(t) t.value=''; });

// ---------------- pesquisa ampliada (Agent Reach) no Ambiente ----------------
const REACH={ st:null, ch:null, busy:'', log:[], err:'' };
try{ window.__TAURI__.event.listen('reach-progress', ev=>{ const l=String((ev&&ev.payload&&ev.payload.line)||'').trim(); if(!l) return; REACH.log.push(l); if(REACH.log.length>8) REACH.log.shift(); reachPaint(); }); }catch(_){ }
function reachPaint(){ const h=$id('reachHost'); if(h){ h.innerHTML=reachEnvInner(); reachEnvWire(h); } }
function reachEnvInner(){
  const s=REACH.st, inst=!!(s&&s.installed);
  const chs=(REACH.ch||[]).map(c=>`<li class="reach-${iEsc(c.uso)}"><b>${iEsc(c.nome)}</b> <span class="dim">— ${iEsc(c.uso==='ativo'?'ativo':c.uso==='bloqueado'?'desligado':c.uso==='fora'?'fora da pesquisa':'indisponível')}${c.nota&&c.uso!=='ativo'?': '+iEsc(c.nota):''}</span></li>`).join('');
  const state=!s?'verificando…':inst?`instalado · v${iEsc(s.version||s.pinned)} (versão fixa)`:'não instalado';
  return `<div class="as-card envcard reachcard"><div class="reachh"><span class="as-chk" style="background:${inst?'var(--accent)':'var(--text-3)'}">${inst?IC.ok:'–'}</span><div style="min-width:0;flex:1">`+
    `<div class="reacht">Pesquisa ampliada (Agent Reach)<span class="envtag">opcional</span></div>`+
    `<div class="reachd">Dá à pesquisa de ideias leitura de páginas pelo Jina Reader, legendas e busca do YouTube, RSS e GitHub público — e deixa o gateway da empresa pesquisar. A pesquisa já funciona sem isto com a web do Claude, Codex ou DeepSeek.</div>`+
    `<div class="reachs">${state}${s&&s.dir?` · <span class="mono">${iEsc(String(s.dir).replace(/^\/Users\/[^/]+/,'~'))}</span>`:''}</div>`+
    `<div class="reachtos">Canais com login ou cookies (X, Reddit, Instagram, LinkedIn…) ficam desligados: usar cookies viola os termos desses sites e pode banir a conta.</div>`+
    (REACH.err?`<div class="ideianote warn" role="alert">${iEsc(REACH.err)}</div>`:'')+
    (REACH.busy==='install'&&REACH.log.length?`<ul class="reachlog">${REACH.log.map(l=>`<li>${iEsc(ideiaCut(l,140))}</li>`).join('')}</ul>`:'')+
    (chs?`<ul class="reachch">${chs}</ul>`:'')+
    `<div class="reachb">${inst?`<button class="as-btn" id="reachDoctor"${REACH.busy?' disabled':''}>${REACH.busy==='doctor'?'verificando…':'verificar canais'}</button><button class="as-btn" id="reachRemove"${REACH.busy?' disabled':''}>remover</button>`:`<button class="as-btn primary" id="reachInstall"${REACH.busy||!s?' disabled':''}>${REACH.busy==='install'?'instalando…':'instalar'}</button>${s&&!s.installer?'<span class="dim">precisa do uv ou de Python 3.10+</span>':''}`}</div>`+
    `</div></div></div>`;
}
function reachEnvHtml(){ if(!REACH.st && !REACH.busy){ REACH.busy='status'; ideiaCall()('reach_status').then(s=>{ REACH.st=s; }).catch(e=>{ REACH.st={ installed:false }; REACH.err=ideiaErr(e,'Não consegui ver a pesquisa ampliada'); }).finally(()=>{ REACH.busy=''; reachPaint(); }); } return `<div id="reachHost">${reachEnvInner()}</div>`; }
function reachEnvWire(root){
  const b=id=>root.querySelector('#'+id);
  const run=async(kind, fn)=>{ REACH.busy=kind; REACH.err=''; if(kind==='install') REACH.log=[]; reachPaint(); try{ await fn(); }catch(e){ REACH.err=ideiaErr(e,'Não deu'); } finally{ REACH.busy=''; reachPaint(); IDEIA.mode=null; } };
  if(b('reachInstall')) b('reachInstall').onclick=()=>run('install', async()=>{ REACH.st=await invoke('reach_install'); REACH.ch=await ideiaCall()('reach_doctor').catch(()=>null); toast('Pesquisa ampliada instalada.','ok'); });
  if(b('reachDoctor')) b('reachDoctor').onclick=()=>run('doctor', async()=>{ REACH.ch=await invoke('reach_doctor'); });
  if(b('reachRemove')) b('reachRemove').onclick=async()=>{ if(!await askYes('Remover a pesquisa ampliada (Agent Reach) deste computador? A pesquisa de ideias continua com a web da sua IA.','Remover')) return; run('remove', async()=>{ await invoke('reach_remove'); REACH.st=await invoke('reach_status'); REACH.ch=null; }); };
}
window.reachEnvHtml=reachEnvHtml; window.reachEnvWire=reachEnvWire;
