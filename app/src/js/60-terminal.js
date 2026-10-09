// ===== MODO TERMINAL — o CLI oficial (claude/codex) da tarefa num terminal de verdade (xterm.js local) =====
// A aba "Terminal" SUBSTITUI a Conversa em toda tarefa de motor Claude Code (e nas de modo terminal do Codex):
//  - sessão VIVA (PTY aberto): o xterm é o terminal de verdade (term_attach/term-data);
//  - tarefa PARADA (concluída, pra revisar, antiga/headless): o xterm mostra o HISTÓRICO da sessão — o transcript do
//    Claude Code (term_history, lido no Rust fora da UI), senão o log do PTY, senão os eventos do state.sqlite —
//    pintado na gramática do mock (● fala · ⎿ ferramenta · > você), sem PTY. Mandar algo pelo compositor RETOMA a
//    sessão (`claude --resume <sessão>` no PTY, talk_task → term::route) e o xterm passa a ser o vivo;
//  - ABRIR A TAREFA = TERMINAL VIVO (08/10): a aba ficou visível com a pasta da tarefa existindo → retoma SOZINHO no
//    PTY em modo QUIETO (`claude --resume` sem prompt: não gasta nada, não muda status). O histórico fica na tela como
//    placeholder; o que o PTY desenha vai pra uma fila e entra de UMA vez (RIS + retrato num único write — nunca
//    reset() síncrono + write assíncrono, que pintava um quadro vazio: a "bugada") quando a IA terminou de desenhar.
//    O foco vai pro xterm; o que se digitar no meio entra em ordem depois da troca. Terminal fora da tela e parado há
//    termIdleMin (padrão 15 min) é encerrado no Rust (term.rs › reap_tick) — voltar à tarefa retoma de novo;
//  - DeepSeek/gateway/Codex headless seguem com a Conversa.
// Desempenho: um xterm por tarefa, criado na 1ª vez que aparece e REAPROVEITADO (o DOM é movido pro slot a cada
// render); só recebe eventos enquanto está visível (term_attach/term_detach); o histórico só é relido quando o
// arquivo muda (carimbo tamanho:mtime) e o PTY só é redimensionado quando o tamanho muda (ResizeObserver).
const TERM = {};
// tarefa integrada (worktree apagada): o backend recria a pasta e retoma a sessão — dá pra conversar de novo (04/10)
const TERM_WT_GONE='tarefa integrada · digite pra perguntar sobre o que foi feito'; // taskId → { term, fit, host, attached, alive, mode:'live'|'hist', hinfo, hstamp, ro, lastSize, opening }
// regra ÚNICA resolvida no backend (term::starts_in_terminal → t.termRun): tarefa do CLI/MCP sem termMode também é terminal
function termModeOf(t){ return !!(t && (t.termRun || (t.spec && t.spec.termMode === 'terminal'))); }
/** A tarefa mostra a aba Terminal (e não a Conversa)? Modo terminal sempre; senão toda tarefa Claude Code que já rodou. */
function termViewOf(t){
  if(!t) return false;
  if(termModeOf(t)) return true;
  if(t.status==='draft') return false;
  return typeof aiEngineOf==='function' && aiEngineOf(t.engine)==='claude';
}
function termSlotHtml(t){ return `<div class="fwthread fwtermslot" id="fwThread" data-term="${escA(t.id)}"></div>`; }
function termCss(name, fb){ try{ const v=getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v||fb; }catch(_){ return fb; } }
// tema a partir dos tokens do app (redesenho F2): o terminal é SEMPRE escuro — marinho no claro (Cartório), verde-quase-
// preto no escuro — com a paleta ANSI de cada tema (--term-*, --ansi-* em css/10-base.css). Os fallbacks são os do escuro.
// @cor-dado-inicio — fallbacks do termTheme: os valores do tema escuro, só se o token não existir
function termTheme(){
  const c=(n, fb)=>termCss(n, fb);
  return { background:c('--term-bg','#0A1513'), foreground:c('--term-fg','#DCE8E1'), cursor:c('--term-live','#3FD68A'),
    cursorAccent:c('--term-bg','#0A1513'), selectionBackground:c('--term-sel','rgba(63,214,138,.28)'),
    black:c('--ansi-black','#1E332C'), red:c('--ansi-red','#F0A48F'), green:c('--ansi-green','#7FDCA7'), yellow:c('--ansi-yellow','#E0B868'),
    blue:c('--ansi-blue','#9CD3F5'), magenta:c('--ansi-magenta','#C9A7F0'), cyan:c('--ansi-cyan','#6CCFD3'), white:c('--ansi-white','#DCE8E1'),
    brightBlack:c('--ansi-bblack','#6F857A'), brightRed:c('--ansi-bred','#F7BBA9'), brightGreen:c('--ansi-bgreen','#3FD68A'), brightYellow:c('--ansi-byellow','#F0D58C'),
    brightBlue:c('--ansi-bblue','#BCE2FA'), brightMagenta:c('--ansi-bmagenta','#DCC4F7'), brightCyan:c('--ansi-bcyan','#9BE3E6'), brightWhite:c('--ansi-bwhite','#F4FAF6') };
}
// @cor-dado-fim
// trocou o tema (04-tema dispara 'sf-theme'): todo xterm aberto — visível ou guardado — repinta na hora (evento, sem polling)
function termRetheme(){ const th=termTheme(); for(const k of Object.keys(TERM)){ const x=TERM[k]; if(x && x.term) try{ x.term.options.theme=th; }catch(_){ } } }
if(typeof window!=='undefined' && window.addEventListener) window.addEventListener('sf-theme', termRetheme);
// a Martian Mono local terminou de carregar depois de um xterm já aberto: re-mede a célula (senão a grade fica com a
// largura da fonte reserva) e reencaixa
try{ if(document.fonts && document.fonts.ready) document.fonts.ready.then(()=>{ for(const k of Object.keys(TERM)){ const x=TERM[k]; if(!x || !x.term) continue; try{ x.term.options.fontFamily=termCss('--mono','ui-monospace, Menlo, monospace'); const h=x.host; if(x.fit && h && h.isConnected && h.offsetWidth>0 && h.offsetHeight>0) x.fit.fit(); }catch(_){ } /* só encaixa o visível: escondido mede 0 e o PTY encolheria à toa */ } }); }catch(_){ }
function termCtor(){ const T=window.Terminal; return T && (T.Terminal||T); }
function termFitCtor(){ const F=window.FitAddon; return F && (F.FitAddon||F); }

// @term-hist-puro-inicio (puro — testado em app/tests/terminal-sempre.test.mjs)
// Histórico → texto ANSI na gramática do mock: "> você", "● fala", "  ⎿ Ferramenta arg", "● Update(arq) +N −M".
const TH_MAX_LINES={ you:6, say:40, ask:4 };
const thC=(code, s)=>'\x1b['+code+'m'+s+'\x1b[0m';
// nada do transcript pode virar sequência de controle no xterm (cor, cursor, título, colagem)
function thClean(s){ return String(s==null?'':s).replace(/\r\n?/g,'\n').replace(/\t/g,'  ').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,''); }
function thMd(s){ return s.replace(/^#{1,6}\s+(.*)$/, (_,x)=>thC('1',x)).replace(/\*\*([^*]+)\*\*/g, (_,x)=>thC('1',x)).replace(/`([^`\n]+)`/g, (_,x)=>thC('36',x)); }
function thBlock(text, max, first, rest, md){
  const L=thClean(text).split('\n'); while(L.length && !L[L.length-1].trim()) L.pop();
  const keep=L.slice(0, max), more=L.length-keep.length;
  const out=keep.map((l,i)=>(i?rest:first)+(md?thMd(l):l));
  if(more>0) out.push(rest+thC('2','… +'+more+' linha'+(more>1?'s':'')));
  return out;
}
function thToolArg(it){
  const a=thClean(it.arg||'').replace(/\n/g,' ');
  if(!a) return '';
  const color=/^(Bash|WebSearch)$/.test(it.name)?'33':/^(Read|Grep|Glob|mcp|Agent)$/.test(it.name)?'34':'0';
  return ' '+(color==='0'?a:thC(color,a));
}
function thItemLines(it){
  const out=thClean(it.out||'').replace(/\n/g,' ');
  switch(it.k){
    case 'you': return thBlock(it.text, TH_MAX_LINES.you, thC('1;97','> '), '  ', false);
    case 'say': return thBlock(it.text, TH_MAX_LINES.say, thC('32','● '), '  ', true);
    case 'edit': return [thC('32','● ')+thC('1;97', it.name||'Update')+'('+thC('34', thClean(it.arg))+')'+(it.add?'  '+thC('32','+'+it.add):'')+(it.del?' '+thC('31','−'+it.del):'')+(it.err?'  '+thC('31','✗ '+out):'')];
    case 'tool': {
      const meta=it.err?'  '+thC('31','✗ '+(out||'falhou')) : (it.name==='Read' && it.lines)?' '+thC('2','('+it.lines+' linhas)') : out?'  '+thC('2',out) : '';
      return ['  '+thC('2','⎿ '+(it.name||''))+thToolArg(it)+meta];
    }
    case 'ask': { const L=thBlock(it.text, TH_MAX_LINES.ask, thC('33','? '), '  ', false);
      L.push(it.done ? '  '+thC('32','✓ respondido: ')+out.replace(/^User (has )?answered[^:]*:\s*/i,'') : '  '+thC('2','aguardando sua resposta…')); return L; }
    case 'note': return thBlock(it.text, 3, thC('36','▸ '), '  ', false).map((l,i)=>i?thC('2',l):l);
    case 'err': return thBlock(it.text, 4, thC('31','✗ '), '  ', false);
    case 'sys': return [thC('2','── '+thClean(it.text)+' ──')];
    default: return [];
  }
}
// nota de sistema com código/motivo cru do CLI ("sessão encerrada (other)", "terminal fechado (código 143)") → pt-BR
const TH_END_WHY={ clear:'conversa limpa (/clear)', logout:'você saiu da conta do Claude', prompt_input_exit:'você saiu do terminal', other:'a sessão terminou', bypass_permissions_disabled:'o modo sem confirmação foi desligado' };
function thSysText(tx){
  const t=String(tx==null?'':tx);
  let m=t.match(/^terminal: sessão encerrada(?: \(([\w-]+)\))?$/);
  if(m) return 'terminal: '+(TH_END_WHY[m[1]]||'a sessão terminou');
  m=t.match(/^terminal fechado(?: \(código (-?\d+)\))?$/);
  if(m) return m[1]==null ? 'terminal fechado pelo app' : +m[1]===0 ? 'terminal fechado' : 'o terminal fechou com erro';
  if(/^⏸ esperando você no terminal: Claude is waiting for your input\.?$/.test(t)) return '⏸ o Claude está esperando você no terminal';
  return t;
}
// eventos do state.sqlite (tarefa sem transcript) → os mesmos itens
function thTs(e){ const v=e&&e.ts; return typeof v==='number'?v:(Date.parse(v||'')||0); }
function thFromEvents(evs){
  const out=[];
  for(const e of evs||[]){
    const tx=String(e.text||''); const ts=thTs(e);
    if(!tx.trim() || e.type==='papel' || e.type==='suggest') continue; // suggest: vira chip embaixo do terminal
    if(e.agent==='Você' && /^Você:\s/.test(tx)){ out.push({ k:'you', ts, text:tx.replace(/^Você:\s*/,'') }); continue; }
    if(/^humano respondeu:/.test(tx)){ out.push({ k:'you', ts, text:tx.replace(/^humano respondeu:\s*/,'') }); continue; }
    if(e.agent==='Sistema'){ out.push({ k:'note', ts, text:thSysText(tx) }); continue; }
    if(e.type==='error'){ out.push({ k:'err', ts, text:tx }); continue; }
    if(e.type==='edit'||e.type==='write'){ out.push({ k:'edit', ts, name:e.type==='write'?'Write':'Update', arg:tx }); continue; }
    if(e.type==='read'){ out.push({ k:'tool', ts, name:'Read', arg:tx }); continue; }
    if(e.type==='bash'){ out.push({ k:'tool', ts, name:'Bash', arg:tx }); continue; }
    if(/^perguntou ao humano:/.test(tx)){ out.push({ k:'ask', ts, text:tx.replace(/^perguntou ao humano:\s*/,''), done:true, out:'' }); continue; }
    if(['think','note','done'].includes(e.type)){ out.push({ k:'say', ts, text:tx }); continue; }
  }
  return out;
}
// notas do Starfork que entram no meio do transcript (PR aberto, fila, requisito, sessão retomada…)
function thSysNotes(evs){
  return (evs||[]).filter(e=>{ const tx=String(e.text||''); return tx.trim() && ((e.agent==='Sistema' && (e.type==='note'||e.type==='status')) || /^(PR aberto|PR NÃO aberto|requisito adicionado:|falha ao finalizar)/i.test(tx)); })
    .map(e=>({ k:'note', ts:thTs(e), text:thSysText(e.text) }));
}
// quebra POR PALAVRA na largura do xterm (o xterm sozinho corta no meio da palavra). Conta só o visível (sem os
// códigos de cor); a continuação alinha depois do marcador (●, ⎿, >, ?…). Palavra maior que a linha é partida.
const thVis=(s)=>s.replace(/\x1b\[[0-9;]*m/g,'');
function thWrap(line, cols){
  const W=(+cols||0)-1; if(W<20) return [line];
  const v=thVis(line); if(v.length<=W) return [line];
  const m=v.match(/^( *)([●⎿>?▸✗✓] )?/); const ind=' '.repeat(Math.min(W>>1, m[1].length+(m[2]?2:0)));
  const lead=(line.match(/^ */)||[''])[0]; // recuo da própria linha (continuação de fala) fica
  const toks=line.slice(lead.length).split(/( +)/); const out=[]; let cur=lead, w=lead.length;
  const push=()=>{ out.push(cur.replace(/ +$/,'')); cur=ind; w=ind.length; };
  for(const tk of toks){
    if(!tk) continue;
    const tw=thVis(tk).length;
    if(/^ +$/.test(tk)){ if(w && w+tw<=W){ cur+=tk; w+=tw; } continue; }
    if(w+tw>W && w>Math.max(ind.length, lead.length)) push();
    if(tw>W-ind.length){ // palavra gigante (caminho, URL): parte por caractere visível
      let rest=tk; while(thVis(rest).length>W-w){ let i=0, n=0; while(i<rest.length && n<W-w){ if(rest[i]==='\x1b'){ const e=rest.indexOf('m',i); i=e<0?rest.length:e+1; continue; } i++; n++; } cur+=rest.slice(0,i); rest=rest.slice(i); push(); }
      cur+=rest; w+=thVis(rest).length; continue;
    }
    cur+=tk; w+=tw;
  }
  if(thVis(cur).trim()) out.push(cur);
  return out;
}
/** itens (+ notas do sistema intercaladas pelo horário) → texto pro xterm. o: { head, foot, notes, cols } */
function thRender(items, o){
  o=o||{}; const notes=(o.notes||[]).slice().sort((a,b)=>a.ts-b.ts); let ni=0;
  const L=[]; if(o.head) L.push(thC('2','╭─ '+thClean(o.head)), '');
  const flush=(upTo)=>{ while(ni<notes.length && (upTo==null || notes[ni].ts<=upTo)) L.push(...thItemLines(notes[ni++])); };
  let last=0;
  for(const it of items||[]){
    const ts=+it.ts||last; if(ts) { flush(ts); last=ts; }
    const lines=thItemLines(it); if(!lines.length) continue;
    // um respiro antes de cada fala/edição/pergunta (como o Claude Code); ferramentas ficam coladas na fala
    if(L.length && it.k!=='tool' && L[L.length-1]!=='') L.push('');
    L.push(...lines);
  }
  flush(null);
  if(!items || !items.length) L.push(thC('2','(a sessão ainda não tem nada registrado)'));
  if(o.foot) L.push('', thC('2','╰─ '+thClean(o.foot)));
  return (o.cols?L.flatMap(l=>thWrap(l, o.cols)):L).join('\r\n')+'\r\n';
}
// @term-hist-puro-fim

// @term-vivo-puro-inicio (puro — testado em app/tests/terminal-vivo.test.mjs)
const TERM_RIS='\x1bc'; // reset COMPLETO dentro do próprio fluxo do write: limpa e desenha no mesmo quadro
const TERM_READY={ quietMs:350, settleMs:2500, maxMs:9000 };
const TERM_MARK='▸ Starfork'; // o `starfork ia` avisa (stderr) logo antes de a IA subir no shell
const termVis=(s)=>String(s==null?'':s).replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g,'');
/** Retomar SOZINHO ao abrir? Só a tarefa visível, com a pasta existindo, sessão a retomar, sem turno em segundo
 *  plano, sem teto batido/pausa, uma vez por visita e nunca logo depois de o terminal fechar. */
function termAutoOk(o){
  o=o||{}; const h=o.hinfo;
  if(!o.enabled || !o.on || o.hidden || o.mode!=='hist' || o.alive || o.opening || o.tried) return false;
  if(!h || h.resumes!==true || !h.worktreeExists) return false; // integrada sem pasta (ou pasta sumida): só o histórico
  if(o.headless || o.budget || o.paused) return false;
  if(!h.sessionId && (!h.source || h.source==='none')) return false; // nada pra retomar (tarefa nova: botão "abrir terminal")
  if(o.exitAt && (o.now||0)-o.exitAt<60000) return false; // acabou de fechar: não reabre em laço
  return true;
}
/** A IA terminou de desenhar? (shell: depois do aviso do `starfork ia`; direto: qualquer coisa visível) + silêncio. */
function termReadyNow(o){
  const now=o.now, quiet=now-(o.last||o.t0);
  if(now-o.t0>=TERM_READY.maxMs) return true;
  const tx=String(o.text||'');
  let drawn;
  if(o.shell){ const i=tx.lastIndexOf(TERM_MARK); if(i<0) return quiet>=TERM_READY.settleMs && !!termVis(tx).trim(); const nl=tx.indexOf('\n', i); drawn=nl>=0 && !!termVis(tx.slice(nl+1)).trim(); }
  else drawn=!!termVis(tx).trim();
  return drawn ? quiet>=TERM_READY.quietMs : false;
}
/** O CLI está perguntando se confia na pasta? (Claude Code / Codex — só o fim da tela importa) */
function termTrustAsk(tail){
  return /Do you trust the files in this folder|Is this a project you (?:created or one you )?trust|trust the contents of this directory|Do you trust this (?:folder|directory)|Yes, I trust this folder/i.test(termVis(tail).slice(-3000));
}
/** O foco pode ir pro terminal? (não rouba de campo de texto nem de folha de pergunta) */
function termFocusFree(ae, host){
  if(!ae || ae.tagName==='BODY' || (host && host.contains && host.contains(ae))) return true;
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName||'') || ae.isContentEditable) return false;
  return !(ae.closest && ae.closest('.tlsheet,.tisheet,[role="dialog"],[role="menu"]'));
}
// @term-vivo-puro-fim
// Ajustes › "Terminal ao abrir a tarefa" (termAutoResume; padrão ligado) — lido do settings, guardado por 30 s.
// auto:null = ainda não lido: quem pergunta ESPERA a leitura (desligado nos Ajustes não pode retomar na 1ª tarefa)
const TERM_CFG={ auto:null, at:0, p:null };
function termAutoLoad(){
  if(TERM_CFG.p) return TERM_CFG.p;
  TERM_CFG.at=Date.now();
  let p; try{ p=Promise.resolve(invokeQuiet('read_settings')); }catch(e){ p=Promise.reject(e); }
  TERM_CFG.p=p.then(s=>{ let o={}; try{ o=JSON.parse(s||'{}')||{}; }catch(_){ } TERM_CFG.auto=!(o.termAutoResume===false||o.termAutoResume==='0'||o.termAutoResume==='false'); })
    .catch(()=>{ if(TERM_CFG.auto==null) TERM_CFG.auto=true; }).finally(()=>{ TERM_CFG.p=null; });
  return TERM_CFG.p;
}
/** true/false; null = ainda lendo (termAutoMaybe tenta de novo quando a leitura volta). */
function termAutoEnabled(){
  if(TERM_CFG.auto==null || Date.now()-TERM_CFG.at>30000) termAutoLoad();
  return TERM_CFG.auto;
}
let TERM_WANT_FOCUS=null; // a tarefa que acabou de ABRIR: o teclado vai pro xterm assim que ele aparecer
function termWantFocus(taskId){ TERM_WANT_FOCUS=taskId||null; }
function termTakeFocus(taskId){
  const st=TERM[taskId]; if(!st || !st.term || TERM_WANT_FOCUS!==taskId) return;
  if(!termFocusFree(document.activeElement, st.host)){ TERM_WANT_FOCUS=null; return; }
  TERM_WANT_FOCUS=null; try{ st.term.focus(); }catch(_){ }
}
/** Abriu a tarefa (ou ela voltou pra tela): retoma sozinha se der (termAutoOk). */
function termAutoMaybe(taskId){
  const st=TERM[taskId]; if(!st || !st.term) return;
  if(termAutoEnabled()==null){ termAutoLoad().then(()=>termAutoMaybe(taskId)); return; }
  const t=(state.tasks||[]).find(x=>x.id===taskId);
  const on=!!(st.host.isConnected && st.box.clientWidth>0 && st.box.clientHeight>0);
  const ok=termAutoOk({ enabled:termAutoEnabled(), on, hidden:typeof document!=='undefined' && document.hidden, mode:st.mode, alive:st.alive, opening:st.opening||st.holding,
    tried:st.autoTried, hinfo:st.hinfo, headless:termHeadless(t), budget:typeof tiBudgetOpen==='function' && tiBudgetOpen(t), paused:!!(t && (t.status==='paused' || (t.spec&&t.spec.budgetHit))),
    exitAt:st.exitAt, now:Date.now() });
  if(!ok) return;
  st.autoTried=true;
  if(typeof tiGoLive==='function') tiGoLive(taskId, { auto:true }); else termResume(taskId, { quiet:true, auto:true });
}
/** Troca histórico → vivo SEM PULO: o retrato inteiro do PTY entra num único write precedido de RIS. */
function termSwap(taskId, data){
  const st=TERM[taskId]; if(!st || !st.term) return;
  st.holding=false; st.pend=null; st.mode='live'; st.hlast=null; st.ttail='';
  const d=String(data||'');
  st.term.write(TERM_RIS+d, ()=>{ try{ st.term.scrollToBottom(); }catch(_){ } });
  termSetAlive(taskId, true);
  termTrustSeen(taskId, d);
  // o PTY nasceu: a doca relê qual IA está rodando (o retrato anterior era de antes do terminal existir)
  if(typeof tiStatRefresh==='function'){ const t=(state.tasks||[]).find(x=>x.id===taskId); if(t) setTimeout(()=>tiStatRefresh(t, true), 400); }
  if(st.term.cols) invokeQuiet('term_resize',{ taskId, cols:st.term.cols, rows:st.term.rows }).catch(()=>{});
}
/** Pergunta de confiança da pasta: vira aviso na barra do terminal (confiar e continuar / sair), nada trava. */
function termTrustSeen(taskId, chunk){
  const st=TERM[taskId]; if(!st || st.mode!=='live') return;
  st.ttail=((st.ttail||'')+String(chunk||'')).slice(-6000);
  const ask=termTrustAsk(st.ttail);
  if(ask!==!!st.trust){ st.trust=ask; termSetAlive(taskId, true); }
}
/**
 * Retoma a sessão no PTY mantendo o histórico na tela até a IA desenhar (sem flash). o: { quiet, auto, btn }.
 * quiet = abrir pra olhar (sem kickoff, não gasta); botão "abrir terminal" de tarefa nova vai com quiet:false.
 */
async function termResume(taskId, o){
  o=o||{};
  const st=termEnsure(taskId); if(!st.term) return false;
  if(st.alive && st.mode==='live') return true;
  if(st.openP) return st.openP;
  st.opening=true;
  const b=o.btn||null; const bTx=b?b.textContent:''; if(b){ b.disabled=true; b.textContent='abrindo…'; }
  const p=(async()=>{
    try{
      const cols=(st.term&&st.term.cols)||120, rows=(st.term&&st.term.rows)||34;
      // o histórico FICA na tela; o que o PTY desenhar vai pra fila (st.pend) e entra de uma vez na troca
      st.attached=true; st.pend=[]; st.pendAt=0; st.holding=true;
      // ASSUMIR: um turno de fundo é dono da sessão — para ele num ponto seguro e abre o PTY na MESMA sessão (o backend
      // espera o processo morrer e o transcript parar). A faixa diz "Trazendo a IA pra cá… nada se perde."
      if(o.takeover){ st.taking=true; st.takeErr=false; termSetAlive(taskId, false);
        try{ await invoke('term_takeover',{ taskId, cols, rows }); }
        catch(e){ st.takeErr=true; throw e; }
        finally{ st.taking=false; } }
      const info=await invoke('term_open',{ taskId, cols, rows, resume:true, quiet:!!o.quiet });
      // saiu da tela / descartado / o terminal fechou enquanto abria: solta o attach que o term_open fez
      const drop=()=>{ invokeQuiet('term_detach',{ taskId }).catch(()=>{}); return false; };
      if(TERM[taskId]!==st || !st.holding) return drop();
      if(!info || !info.alive) throw new Error('o terminal fechou logo ao abrir');
      const head=String(info.data||''); const t0=Date.now();
      while(st.holding && !termReadyNow({ t0, now:Date.now(), last:st.pendAt||t0, text:head+(st.pend||[]).join(''), shell:!!info.shell })) await new Promise(r=>setTimeout(r, 50));
      if(!st.holding || TERM[taskId]!==st) return drop();
      termSwap(taskId, head+(st.pend||[]).join(''));
      termTakeFocus(taskId);
      if(!o.auto){ try{ st.term.focus(); }catch(_){ } }
      lastSig=''; refresh().catch(()=>{});
      return true;
    }catch(e){
      st.holding=false; st.pend=null;
      if(b && b.isConnected){ b.disabled=false; b.textContent=bTx; }
      st.bar.__html=''; termSetAlive(taskId, false);
      if(!o.auto) showErr(e, 'Não consegui abrir o terminal');
      termSayLine(taskId, 'não consegui abrir o terminal: '+(typeof errShort==='function'?errShort(e):String(e&&e.message||e)), '31'); // a barra mantém "abrir tarefa de ajuste"
      return false;
    }finally{ st.opening=false; st.openP=null; }
  })();
  st.openP=p; return p;
}
function termEnsure(taskId){
  let st=TERM[taskId]; if(st) return st;
  const Term=termCtor(), Fit=termFitCtor();
  const host=document.createElement('div'); host.className='fwterm'; host.dataset.task=taskId;
  const bar=document.createElement('div'); bar.className='fwtermbar'; bar.style.display='none'; host.appendChild(bar);
  const box=document.createElement('div'); box.className='fwtermbox'; host.appendChild(box);
  st=TERM[taskId]={ term:null, fit:null, host, bar, box, attached:false, alive:false, mode:'', hinfo:null, hstamp:'', hsys:'', ro:null, lastSize:'', opening:false };
  if(!Term){ box.textContent='terminal indisponível (xterm não carregou)'; return st; }
  const term=new Term({ fontFamily:termCss('--mono','ui-monospace, Menlo, monospace'), fontSize:12.5, lineHeight:1.15, cursorBlink:false,
    scrollback:8000, allowProposedApi:false, convertEol:false, macOptionIsMeta:true, theme:termTheme() });
  const fit=Fit?new Fit():null; if(fit) term.loadAddon(fit);
  term.open(box);
  // vivo: tecla → PTY. Histórico: digitar RETOMA a sessão sozinho (64-terminal-integrado guarda as teclas e escreve
  // quando o Claude Code abrir) — antes o xterm parado engolia tudo calado
  // (abertura em voo: TUDO vai pra fila do 64 — mesmo com o PTY já vivo — e sai num único write, em ordem)
  term.onData(d=>{ if(typeof tiTakeKey==='function' && tiTakeKey(taskId, d)) return; if(st.alive){ invokeQuiet('term_write',{ taskId, data:d }).catch(()=>{}); return; } if(typeof tiHistKey==='function') tiHistKey(taskId, d); });
  // respondeu a pergunta de confiança pelo teclado: a barra velha some (o "sair" dela mandaria Esc no meio de um turno)
  term.onData(()=>{ if(st.trust && st.alive){ st.trust=false; st.ttail=''; termSetAlive(taskId, true); } });
  st.term=term; st.fit=fit;
  if(typeof tiHostWire==='function') tiHostWire(taskId, st); // clique retoma · colar/arrastar arquivo = anexo @arquivo
  // redimensiona o PTY só quando o tamanho REAL muda; tamanho zero = escondido → para os eventos
  st.ro=new ResizeObserver(()=>{ clearTimeout(st.rt); st.rt=setTimeout(()=>termFit(taskId), 60); });
  st.ro.observe(box);
  return st;
}
function termFit(taskId){
  const st=TERM[taskId]; if(!st||!st.term) return;
  const w=st.box.clientWidth, h=st.box.clientHeight;
  if(!w||!h||!st.host.isConnected){ termDetach(taskId); return; }
  if(!st.attached) termAttach(taskId);
  try{ st.fit && st.fit.fit(); }catch(_){ }
  const k=st.term.cols+'x'+st.term.rows;
  if(k!==st.lastSize){ st.lastSize=k; if(st.alive) invokeQuiet('term_resize',{ taskId, cols:st.term.cols, rows:st.term.rows }).catch(()=>{}); }
  // histórico: a quebra por palavra depende da largura — refaz do que já está na memória (sem reler o arquivo)
  // (fora do ciclo do fit: reset no meio do redimensionamento deixava o desenho do xterm vazio)
  if(st.mode==='hist' && st.hlast && st.hcols!==st.term.cols && !st.hloading){ clearTimeout(st.hrt); st.hrt=setTimeout(()=>termHistRepaint(taskId), 40); }
}
function termHistRepaint(taskId){
  const st=TERM[taskId]; if(!st||st.mode!=='hist'||!st.hlast||st.hloading||st.hcols===st.term.cols) return;
  st.hcols=st.term.cols;
  const out=thRender(st.hlast.items, { ...st.hlast.o, cols:st.term.cols });
  const b=st.term.buffer&&st.term.buffer.active; const atEnd=!b||b.viewportY>=b.baseY-1;
  st.term.write(TERM_RIS+out, ()=>{ try{ if(atEnd) st.term.scrollToBottom(); st.term.refresh(0, st.term.rows-1); }catch(_){ } });
}
async function termAttach(taskId){
  const st=TERM[taskId]; if(!st||!st.term||st.attached||st.holding) return;
  st.attached=true; st.pend=[]; // o que chegar ENQUANTO o retrato vem fica guardado e é escrito depois dele
  try{
    const info=await invokeQuiet('term_attach',{ taskId });
    // descartado enquanto o retrato vinha (termDispose): solta o PTY de novo — senão o contador de quem assiste fica >0
    if(TERM[taskId]!==st){ if(info && info.alive) invokeQuiet('term_detach',{ taskId }).catch(()=>{}); return; }
    if(info && info.alive){
      // retrato + o que chegou no meio, num único write com RIS (sem quadro vazio entre limpar e desenhar)
      termSwap(taskId, String(info.data||'')+(st.pend||[]).join(''));
      termTakeFocus(taskId);
      return;
    }
    st.pend=null;
    const was=st.mode; st.mode='hist'; st.alive=false;
    if(was!=='hist'){ st.hitems=undefined; st.hraw=undefined; }
    await termHistLoad(taskId, was!=='hist');
  }catch(e){ st.attached=false; st.pend=null; console.error('term_attach', e); }
}
function termDetach(taskId){
  const st=TERM[taskId]; if(!st) return;
  st.autoTried=false; // saiu da tela: voltar a ela pode retomar de novo
  if(!st.attached) return;
  // abrindo em segundo plano (histórico na tela): a troca não acontece — o termResume solta o attach do term_open
  if(st.holding){ st.holding=false; st.pend=null; }
  st.attached=false; if(st.mode==='live') invokeQuiet('term_detach',{ taskId }).catch(()=>{});
}
function termEvents(taskId){ return (typeof fwTask!=='undefined' && fwTask===taskId && typeof fwEvents!=='undefined' && fwEvents.length) ? fwEvents : (typeof eventsOf==='function'?eventsOf(taskId):[]); }
/** Histórico da sessão (tarefa sem terminal vivo). force: repinta mesmo sem mudança (voltou do vivo, abriu agora). */
async function termHistLoad(taskId, force){
  const st=TERM[taskId]; if(!st||!st.term||st.mode!=='hist'||st.holding) return;
  if(st.hloading){ st.hagain=st.hagain||(force?2:1); return; }
  st.hloading=true; st.hat=Date.now();
  let next=null; // continuação DEPOIS de soltar a trava (nunca uma chamada aninhada com a trava aberta)
  let auto=false; // histórico pintado: dá pra retomar sozinho (termAutoMaybe) depois de soltar a trava
  try{
    // sem o conteúdo guardado (1ª vez, ou voltou do vivo) não vale pedir "só se mudou"
    const have=st.hitems!==undefined || st.hraw!==undefined;
    const h=await invokeQuiet('term_history',{ taskId, since:(force||!have)?null:(st.hstamp||null) });
    if(st.mode!=='hist') return;
    if(h && h.alive){ next=()=>{ st.attached=false; termAttach(taskId); }; return; } // o PTY nasceu (retomada)
    const evs=termEvents(taskId);
    const sysSig=evs.length+':'+(evs.length?evs[evs.length-1].id:0);
    st.hinfo=h;
    if(!force && h.unchanged && sysSig===st.hsys){ termSetAlive(taskId, false); auto=true; return; }
    st.hsys=sysSig;
    if(!h.unchanged){ st.hstamp=h.stamp||''; st.hitems=h.source==='transcript'?h.items:null; st.hraw=h.source==='log'?String(h.raw||''):undefined; }
    const t=(state.tasks||[]).find(x=>x.id===taskId);
    const wt=String(h.worktree||(t&&t.worktree)||'').split('/').filter(Boolean).pop()||'';
    const eng=(t&&typeof aiEngineOf==='function')?aiEngineOf(t.engine):'claude';
    const head=`${eng} · ${h.sessionId?'sessão '+String(h.sessionId).slice(0,8):'sem sessão gravada'}${wt?' · worktree '+wt:''} · histórico${h.source==='transcript'?(h.clipped?' (só o fim — a sessão é longa)':''):h.source==='log'?' (log do terminal)':' (eventos da tarefa)'}`;
    const foot=termGone(h)?'tarefa integrada · digite aqui pra perguntar sobre o que foi feito — a sessão retoma neste terminal':termHeadless(t)?termBgNote(t, false).text:h.resumes?'fim do histórico · digite aqui pra continuar a conversa — a sessão retoma neste terminal':'fim do histórico · o compositor manda a mensagem no modo automático (Ajustes › Como as tarefas rodam)';
    // log cru do PTY: sai da tela alternativa/colagem antes do rodapé (o TUI pode ter deixado ligado)
    const out=st.hraw!==undefined ? st.hraw+'\x1b[?1049l\x1b[?2004l\x1b[?25h\x1b[0m\r\n\r\n'+thC('2','╰─ '+foot)+'\r\n'
      : (st.hlast={ items:st.hitems||thFromEvents(evs), o:{ head, foot, notes:st.hitems?thSysNotes(evs):[] } }, thRender(st.hlast.items, { ...st.hlast.o, cols:st.term.cols }));
    if(st.hraw!==undefined) st.hlast=null;
    st.hcols=st.term.cols;
    // quem rolou pra cima continua onde estava (poll da tarefa rodando em segundo plano)
    const b=st.term.buffer&&st.term.buffer.active; const atEnd=!b || force || b.viewportY>=b.baseY-1; const y=b?b.viewportY:0;
    st.term.write(TERM_RIS+out, ()=>{ try{ if(atEnd) st.term.scrollToBottom(); else st.term.scrollToLine(y); st.term.refresh(0, st.term.rows-1); }catch(_){ } });
    termSetAlive(taskId, false);
    termTakeFocus(taskId); // abriu a tarefa: o teclado já fica no terminal (tecla no histórico também retoma)
    auto=true;
  }catch(e){ console.error('term_history', e); try{ st.term.write('\r\n'+thC('31','não consegui ler o histórico desta sessão: '+thClean(typeof errShort==='function'?errShort(e):String(e)))+'\r\n'); }catch(_){ } }
  finally{
    st.hloading=false;
    if(next) next();
    else if(st.hagain){ const f=st.hagain===2; st.hagain=0; termHistLoad(taskId, f); }
    else if(auto) termAutoMaybe(taskId);
  }
}
/** Poll do workspace (fwLiveUpdate): no histórico de uma tarefa rodando em segundo plano, relê quando o arquivo muda. */
function termHistTick(t){
  const st=t&&TERM[t.id]; if(!st||st.mode!=='hist'||!st.attached||st.hloading||st.holding) return;
  const evs=termEvents(t.id); const sysSig=evs.length+':'+(evs.length?evs[evs.length-1].id:0);
  const due=termHeadless(t) ? Date.now()-(st.hat||0)>2500 : sysSig!==st.hsys;
  if(due) termHistLoad(t.id, false);
}
// turno de FUNDO dono da tarefa agora (t.bg: lock vivo que não é o PTY — tarefa antiga, ou a que rodava no deploy).
// Sem t.bg (snapshot antigo): o critério de antes. Digitar ASSUME (term_takeover); clicar só foca.
function termHeadless(t){ if(!t) return false; if(typeof t.bg==='boolean') return t.bg; return !termModeOf(t) && (ACTIVE_ST.has(t.status)||t.status==='thinking'||!!t.busy); }
// @term-bar-puro-inicio (puro — testado em app/tests/terminal-sempre-vivo.test.mjs)
const TERM_BAR={
  bg:'A IA está trabalhando sozinha. Digite aqui para entrar na conversa.',
  taking:'Trazendo a IA pra cá… nada se perde.',
  takeFail:'Não deu pra trazer agora',
  autopilot:'O piloto automático conduz esta tarefa sozinho — pare o piloto para entrar na conversa.',
  budget:'Pausei: chegou a 80% do limite de gasto. Liberar e continuar?',
  plan:'A IA fez um plano · aprove no terminal (Enter) ou peça mudança',
};
/** Faixa do terminal VIVO (só o que muda o que a pessoa faz agora): teto pausado, plano esperando aprovação, revisor falando. */
function termLiveNote(t){
  const sp=(t&&t.spec)||{};
  if(sp.budgetHit) return { k:'budget', text:TERM_BAR.budget };
  if(sp.needsYou && sp.needsYou.kind==='plano') return { k:'plan', text:TERM_BAR.plan };
  const r=sp.termRole; if(r && r.role==='reviewer') return { k:'review', text:`${r.name||'O revisor'} está revisando o trabalho de ${r.builder||'quem construiu'} · rodada ${r.round||1} de ${r.max||3}. Pode comentar.` };
  return null;
}
/** Faixa do terminal SEM PTY vivo numa tarefa de fundo: assumindo / piloto / trabalhando sozinha. */
function termBgNote(t, taking){
  if(taking) return { k:'taking', text:TERM_BAR.taking };
  if(t && t.spec && t.spec.autopilot) return { k:'autopilot', text:TERM_BAR.autopilot };
  return { k:'bg', text:TERM_BAR.bg };
}
// @term-bar-puro-fim
function termGone(h){ return !!(h && h.merged && !h.worktreeExists); }
/** A worktree desta tarefa foi apagada ao integrar? (então não há sessão pra retomar) */
function termWtGone(taskId){ const st=TERM[taskId]; return !!(st && st.mode==='hist' && termGone(st.hinfo)); }
/** Uma linha no próprio terminal (aviso do app, não do agente). */
function termSayLine(taskId, text, code){ const st=TERM[taskId]; if(st&&st.term) try{ st.term.write('\r\n'+thC(code||'33','! '+thClean(text))+'\r\n'); st.term.scrollToBottom(); }catch(_){ } }
/** Depois de mandar pelo compositor: se o PTY nasceu (retomada), o xterm passa a ser o vivo. */
async function termGoLive(taskId){
  // o talk_task volta com o PTY já criado; ainda assim tenta mais um pouco (máquina lenta) antes de desistir
  for(let i=0;i<6;i++){ const st=TERM[taskId]; if(!st||st.mode==='live'||!st.host.isConnected) return; st.attached=false; await termAttach(taskId); if(st.mode==='live') return; await new Promise(r=>setTimeout(r, 700)); }
}
function termSetAlive(taskId, alive){
  const st=TERM[taskId]; if(!st) return; st.alive=alive;
  const t=(state.tasks||[]).find(x=>x.id===taskId); const h=st.hinfo||{};
  if(alive){
    st.mode='live';
    let th=st.trust ? `<span>${esc('a IA pergunta se você confia nesta pasta — é a pasta da tarefa, criada pelo Starfork a partir do seu repositório')}</span><span class="cc-sp"></span><button class="btn sm primary" data-termtrust="yes" data-task="${escA(taskId)}">confiar e continuar</button><button class="btn sm" data-termtrust="no" data-task="${escA(taskId)}" title="fecha a IA (Esc); o terminal volta pro shell">sair</button>` : '';
    // faixa de UMA linha do que muda o que a pessoa faz: teto pausado (decidir), plano pra aprovar, revisor falando
    if(!th){ const n=termLiveNote(t);
      if(n) th=`<span data-termnote="${n.k}">${esc(n.text)}</span><span class="cc-sp"></span>`+(n.k==='budget'?`<button class="btn sm primary" data-termbudget="${escA(taskId)}" title="abre a decisão do teto: liberar mais (com motivo) ou parar aqui">decidir</button>`:''); }
    st.bar.style.display=th?'flex':'none'; if(st.bar.__html!==th){ st.bar.__html=th; st.bar.innerHTML=th; } return;
  }
  const fresh=t && (t.status==='draft' || t.status==='queued') && (!h.source || h.source==='none');
  let html;
  if(termGone(h)) html=`<span>${esc(TERM_WT_GONE)}</span><span class="cc-sp"></span><button class="btn sm primary" data-termopen="${escA(taskId)}" title="retoma a sessão da tarefa (a pasta dela é recriada)">conversar</button><button class="btn sm" data-termfix="${escA(taskId)}">abrir tarefa de ajuste</button>`;
  else if(st.taking || termHeadless(t)){ const n=termBgNote(t, !!st.taking);
    html=`<span data-termnote="${n.k}"><span class="pulse" style="--pc:var(--good)"></span> ${esc(n.text)}</span><span class="cc-sp"></span>`+(st.takeErr?`<span class="dim">${esc(TERM_BAR.takeFail)}</span><button class="btn sm" data-termtake="${escA(taskId)}">tentar de novo</button>`:''); }
  else if(fresh) html=`<span>o terminal desta tarefa ainda não foi aberto</span><span class="cc-sp"></span><button class="btn sm primary" data-termopen="${escA(taskId)}">abrir terminal</button>`;
  // redesenho F1: sem a barra "histórico · digite pra continuar" — digitar ou clicar no terminal já retoma, e o
  // "retomar sessão" mora na barra de status (tlBarHtml). Fica só o aviso que muda o que acontece: modo automático.
  else if(h.resumes===false) html=`<span>o compositor manda no modo automático</span><span class="cc-sp"></span><button class="btn sm" data-termopen="${escA(taskId)}" title="abre o terminal retomando a sessão, sem mandar nada">retomar sessão</button>`;
  else html='';
  st.bar.style.display=html?'flex':'none';
  if(st.bar.__html!==html){ st.bar.__html=html; st.bar.innerHTML=html; }
}
async function termOpen(taskId){
  const st=termEnsure(taskId); if(st.opening) return;
  // o botão pode estar na barra do xterm ou no "retomar sessão" da barra de status (tlBarHtml, redesenho F1)
  const sel='[data-termopen="'+String(taskId).replace(/["\\]/g,'')+'"]';
  const b=st.bar.querySelector(sel)||st.bar.querySelector('[data-termopen]')||(typeof document!=='undefined' && document.querySelector ? document.querySelector(sel) : null);
  // clique explícito: tarefa nova começa a trabalhar (kickoff); as outras só retomam — a troca é a mesma, sem flash
  const t=(state.tasks||[]).find(x=>x.id===taskId); const fresh=!!(t && (t.status==='draft'||t.status==='queued'));
  // (se falhar, termResume devolve o botão — não fica "abrindo…" desabilitado pra sempre)
  return termResume(taskId, { quiet:!fresh, btn:b });
}
/** Chamado pelo render da tarefa: põe o terminal (já existente) no slot e solta os que saíram da tela. */
function termMount(t){
  const slot=document.querySelector(`#fwThread[data-term="${CSS.escape(t.id)}"]`); if(!slot) return;
  const st=termEnsure(t.id); st.used=Date.now();
  if(st.host.parentNode!==slot){ slot.innerHTML=''; slot.appendChild(st.host); }
  termSweep();
  requestAnimationFrame(()=>termFit(t.id));
}
/** Terminais que não estão mais na tela param de receber eventos (a sessão segue viva no app). */
function termSweep(){
  for(const id in TERM){ if(!TERM[id].host.isConnected) termDetach(id); }
  // xterm fora da tela não fica pra sempre na memória: passou de TERM_KEEP, os mais antigos são descartados
  // (a sessão continua viva no app; reabrir a tarefa pede o retrato de novo ao term_attach)
  const list=Object.keys(TERM).map(id=>({ id, on:TERM[id].host.isConnected, used:TERM[id].used||0, busy:termBusy(TERM[id]) }));
  for(const id of termDropIds(list, TERM_KEEP, typeof fwTask!=='undefined'?fwTask:null)) termDispose(id);
}
// @term-sweep-puro-inicio (testado em app/tests/atrap-tarefa.test.mjs)
const TERM_KEEP=6;
/** Em voo: abrindo, lendo o histórico ou com o retrato do attach chegando (st.pend é a fila do attach) — não descarta. */
function termBusy(st){ return !!(st && (st.opening || st.hloading || Array.isArray(st.pend))); }
/** Quais terminais descartar: só os fora da tela, sem abertura/leitura em voo, nunca a tarefa aberta; os mais antigos primeiro. */
function termDropIds(list, keep, cur){
  const over=(list||[]).length-keep; if(over<=0) return [];
  return list.filter(x=>!x.on && !x.busy && x.id!==cur).sort((a,b)=>(a.used||0)-(b.used||0)).slice(0, over).map(x=>x.id);
}
// @term-sweep-puro-fim
function termDispose(taskId){
  const st=TERM[taskId]; if(!st) return;
  termDetach(taskId); clearTimeout(st.rt); clearTimeout(st.hrt);
  try{ st.ro && st.ro.disconnect(); }catch(_){ }
  try{ st.term && st.term.dispose(); }catch(_){ }
  st.host.remove(); delete TERM[taskId];
  // a folha de pergunta da tarefa (60-terminal-layout) vai junto se também está fora da tela
  if(typeof TL!=='undefined' && TL.sheets[taskId] && !TL.sheets[taskId].isConnected){ try{ TL.sheets[taskId].__ro && TL.sheets[taskId].__ro.disconnect(); }catch(_){ } delete TL.sheets[taskId]; }
}

try{
  window.__TAURI__.event.listen('term-data', ev=>{ const p=ev&&ev.payload; const st=p&&TERM[p.taskId]; if(!st||!st.attached||!st.term) return; if(st.pend){ st.pend.push(p.data); st.pendAt=Date.now(); return; } if(st.mode==='hist') return; st.term.write(p.data); termTrustSeen(p.taskId, p.data); }); // retrato em voo (inclusive hist→vivo): guarda
  // terminal fechou: o xterm vira o histórico da sessão (o transcript já tem o último turno)
  window.__TAURI__.event.listen('term-exit', ev=>{ const p=ev&&ev.payload; if(!p) return; const st=TERM[p.taskId];
    if(st){ st.exitAt=p.reaped?0:Date.now(); /* encerrado por ficar parado: voltar retoma na hora */ st.trust=false; if(st.holding){ st.holding=false; st.pend=null; } st.alive=false; st.mode='hist'; st.hstamp=''; st.hitems=undefined; st.hraw=undefined; termSetAlive(p.taskId, false); if(st.attached) termHistLoad(p.taskId, true); }
    lastSig=''; refresh().catch(()=>{}); });
}catch(_){ }
document.addEventListener('visibilitychange', ()=>{ for(const id in TERM){ if(document.hidden) termDetach(id); else if(TERM[id].host.isConnected) termFit(id); } });
document.addEventListener('click', (e)=>{
  const b=e.target.closest&&e.target.closest('[data-termopen],[data-termfix],[data-termtrust],[data-termtake],[data-termbudget]'); if(!b) return; e.stopPropagation();
  if(b.dataset.termopen){ termOpen(b.dataset.termopen); return; }
  if(b.dataset.termtake){ if(typeof tiGoLive==='function') tiGoLive(b.dataset.termtake, { takeover:true }); return; }
  if(b.dataset.termbudget){ if(typeof tiCompShow==='function') tiCompShow(b.dataset.termbudget); return; }
  if(b.dataset.termtrust){ const id=b.dataset.task, st=TERM[id]; if(!st) return; // Enter = a 1ª opção (sim); Esc = sair
    invokeQuiet('term_write',{ taskId:id, data:b.dataset.termtrust==='yes'?'\r':'\x1b' }).catch(()=>{}); st.trust=false; st.ttail=''; termSetAlive(id, true); try{ st.term.focus(); }catch(_){ } return; }
  const t=(state.tasks||[]).find(x=>x.id===b.dataset.termfix); if(t && typeof openLinkedFix==='function') openLinkedFix(t);
});
