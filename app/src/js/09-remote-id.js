// ---- Identidade do projeto na nuvem (remote normalizado) ----
// O Rust normaliza o remote do github.com (alias de ssh tipo github.com-work, usuário/token, www., .git)
// pra `github.com/owner/repo` — assim quem usa alias bate com o resto do time. Linhas e chaves gravadas
// ANTES ficaram na forma antiga desta máquina (`legacy`, ex.: github.com-work/owner/repo):
// LER aceita as duas; GRAVAR usa sempre `remote`. Nada é apagado nem renomeado na nuvem.
// @puro-inicio
// [remote, legacy] sem vazios nem repetidos
function remoteIdsList(ids){ const out=[]; if(ids){ [ids.remote, ids.legacy].forEach(v=>{ if(v && !out.includes(v)) out.push(v); }); } return out; }
// `r` é deste projeto (forma nova OU antiga)?
function remoteSame(r, ids){ return !!r && remoteIdsList(ids).includes(r); }
// `r` é de ALGUM projeto desta máquina? `list` = [{remote,legacy}, …] (um por projeto local — localRemoteIdsList)
function remoteLocal(r, list){ return !!r && (list||[]).some(ids=>remoteSame(r, ids)); }
// filtro PostgREST: col=eq.X (uma forma) ou col=in.("X","Y") (nova + antiga)
function remoteInQ(col, ids){
  const v=remoteIdsList(ids); if(!v.length) return col+'=eq.';
  if(v.length===1) return col+'=eq.'+encodeURIComponent(v[0]);
  return col+'=in.('+v.map(x=>encodeURIComponent('"'+String(x).replace(/["\\]/g,'\\$&')+'"')).join(',')+')';
}
// entre as linhas achadas, a da forma nova ganha; senão a antiga
function remotePick(rows, ids, col){
  rows=rows||[]; if(!ids) return rows[0]||null;
  return rows.find(r=>r[col]===ids.remote) || rows.find(r=>r[col]===ids.legacy) || null;
}
// linhas por chave (ex.: slug) vindas das duas formas: fica a mais recente (updated_at);
// `legacyOnly` = chaves que só existem na forma antiga (serão copiadas pra nova na próxima escrita)
function remoteMergeRows(rows, ids, col, key){
  const by={}, hasNew=new Set();
  (rows||[]).forEach(r=>{ const k=r[key]; if(r[col]===ids.remote) hasNew.add(k);
    const cur=by[k]; if(!cur || (Date.parse(r.updated_at)||0)>(Date.parse(cur.updated_at)||0)) by[k]=r; });
  const legacy=ids.legacy && ids.legacy!==ids.remote;
  return { rows:Object.values(by), legacyOnly:legacy?Object.keys(by).filter(k=>!hasNew.has(k)):[] };
}
// chave do localStorage que mudou de nome (forma antiga → nova): copia UMA vez, sem sobrescrever
function lsMigrateKey(oldKey, newKey, get, set){
  if(!oldKey || oldKey===newKey) return false;
  const cur=get(newKey); if(cur!==null && cur!==undefined && cur!=='') return false;
  const old=get(oldKey); if(old===null || old===undefined || old==='') return false;
  set(newKey, old); return true;
}
// @puro-fim
// {remote, legacy} do projeto aberto (path vazio) ou de uma pasta; cache curto (é pedido a cada tick)
const remoteIdsCache={};
async function repoRemoteIds(path){
  const k=path||((typeof state!=='undefined'&&state&&state.repo)||''); const c=remoteIdsCache[k];
  if(c && Date.now()-c.at<60000) return c.ids;
  let ids=null;
  try{ const r=await invokeQuiet('repo_remote_ids', { path:path||null }); if(r && r.remote) ids={ remote:String(r.remote), legacy:String(r.legacy||r.remote) }; }
  catch(_){ try{ const r=String(await invokeQuiet(path?'repo_remote_of':'repo_remote', path?{ path }:undefined)||''); if(r) ids={ remote:r, legacy:r }; }catch(_){ } }
  if(ids) remoteIdsCache[k]={ ids, at:Date.now() };
  return ids||{ remote:'', legacy:'' };
}
// ids {remote,legacy} de TODOS os projetos locais (list_projects) + o aberto — "esse projeto existe nesta máquina?"
// (fila dos épicos na Central, cartões do Time). Cache de 60 s; guarda a última lista pra leitura síncrona.
let localRemoteList=[], localRemoteAt=0, localRemoteP=null;
function localRemoteIdsList(){
  if(Date.now()-localRemoteAt<60000 && localRemoteList.length) return Promise.resolve(localRemoteList);
  if(localRemoteP) return localRemoteP;
  localRemoteP=(async()=>{
    const out=[]; const push=ids=>{ if(ids && ids.remote && !out.some(x=>x.remote===ids.remote)) out.push(ids); };
    try{ push(await repoRemoteIds()); }catch(_){ }
    try{ const locals=(await invokeQuiet('list_projects', { user:(typeof cloudUserId==='function'?cloudUserId():undefined) }))||[]; for(const p of locals){ if(p&&p.path){ try{ push(await repoRemoteIds(p.path)); }catch(_){ } } } }catch(_){ }
    localRemoteList=out; localRemoteAt=Date.now(); return out;
  })().finally(()=>{ localRemoteP=null; });
  return localRemoteP;
}
