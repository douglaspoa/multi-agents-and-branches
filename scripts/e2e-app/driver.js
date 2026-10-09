// Roteiro do e2e do APP (build de teste isolada). Usa as MESMAS funções que os botões chamam; teclas via xterm.input
// (= onData, o mesmo caminho do teclado). Relatório linha a linha (e2e_report); "SHOT x" = o watcher fotografa a janela.
(async()=>{
const R=(l)=>invokeQuiet('e2e_report',{ line:String(l) }).catch(()=>{});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms=30000,step=300)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ try{ const v=await fn(); if(v) return v; }catch(_){ } await sleep(step); } return null; };
const shot=async(name)=>{ await R('SHOT '+name); await sleep(4000); };
const T=id=>(state.tasks||[]).find(t=>t.id===id);
const buf=id=>{ const st=TERM[id]; if(!st||!st.term) return ''; const b=st.term.buffer.active; let s=''; for(let i=0;i<b.length;i++){ const l=b.getLine(i); if(l) s+=l.translateToString(true)+'\n'; } return s; };
const termTab=async()=>{ const b=[...document.querySelectorAll('button,a,[role=tab]')].find(x=>x.offsetParent && x.textContent.trim()==='Terminal'); if(b){ b.click(); await sleep(1200); } else if(typeof fwSetMode==='function'){ await fwSetMode('conversa'); await sleep(1200); } };
const show=async(id)=>{ for(let i=0;i<4;i++){ openWorkspace(id); await sleep(1500); await termTab(); if(TERM[id] && TERM[id].box.clientWidth>0 && TERM[id].host.isConnected) return true; } return false; };
const type=(id, s)=>{ const st=TERM[id]; st.term.focus(); st.term.input(s, true); };
const ok=(name, v, extra)=>R((v?'OK   ':'FALHA ')+name+(extra?' · '+extra:''));
window.askYes=async()=>true; try{ askYes=async()=>true; }catch(_){ }
try{
  await until(()=>(state.tasks||[]).length>=7, 60000);
  await R('BOOT tarefas: '+state.tasks.map(t=>t.id+'['+t.status+(t.termRun?',terminal':'')+']').join(' '));
  const SC=(window.STARFORK_E2E_ONLY||'A,B,C,D,R').split(',');
  // ---------------- A: tarefa criada pelo CLI → Iniciar → PTY vivo e digitável
  if(SC.includes('A')){
    await show('cli-a');
    await ok('A: tarefa do CLI sem termMode já aparece como terminal (regra única)', T('cli-a').termRun===true && !(T('cli-a').spec||{}).termMode);
    const started=await startTask('cli-a');
    const live=await until(()=>TERM['cli-a'] && TERM['cli-a'].alive && /FAKE-AI/.test(buf('cli-a')), 40000);
    await ok('A: ▶ Iniciar abriu o PTY (shell → starfork ia claude)', started && !!live, 'termMode gravado='+((T('cli-a').spec||{}).termMode||'?'));
    const kick=await until(()=>/construí/.test(buf('cli-a')), 20000);
    await ok('A: o kickoff chegou como 1ª mensagem (a IA construiu)', !!kick);
    await until(()=>/FAKE-PROMPT>/.test(buf('cli-a').split('construí').pop()), 15000);
    type('cli-a', 'oi, digitado direto no terminal\r');
    const eco=await until(()=>/FAKE-ECO:oi, digitado direto no terminal/.test(buf('cli-a')), 15000);
    await ok('A: digitar no terminal chega na IA (sem caixa de chat)', !!eco);
    const nobg=!document.querySelector('[data-termnote="bg"]') && !/segundo plano/.test(document.body.innerText);
    await ok('A: nada de "rodando em segundo plano" na tela', nobg);
    await sleep(800); await shot('A-cli-iniciar-pty');
  }
  // ---------------- B: "Iniciar épico" com 3 tarefas na onda 1 → 3 PTYs (ou na espera por limite), cada um digitável
  if(SC.includes('B')){
    if(typeof setSlotMax==='function') setSlotMax(4);
    // o botão da CENTRAL (o mesmo do print do dono)
    if(typeof activateTab==='function') activateTab('flow'); await sleep(2000);
    const btn=document.querySelector('[data-epstart="epico-teste"]');
    await ok('B: a Central mostra "Iniciar épico"', !!btn);
    if(btn) btn.click(); else await epicStart('epico-teste');
    const ids=['onda1-t1','onda1-t2','onda1-t3'];
    const all=await until(async()=>{ for(const id of ids){ const s=await invokeQuiet('term_status',{ taskId:id }); if(!s||!s.alive) return false; } return true; }, 60000, 800);
    await ok('B: Iniciar épico abriu 3 PTYs vivos (onda 1)', !!all);
    await sleep(1500); await shot('B-central-epico-iniciado');
    for(const id of ids){
      await R('  '+id+' na tela='+await show(id));
      const t0=Date.now(); const ready=await until(()=>TERM[id] && TERM[id].alive && /construí/.test(buf(id)), 15000); await R('  '+id+' pronto em '+(Date.now()-t0)+'ms');
      await until(()=>/FAKE-PROMPT>/.test(buf(id).split('construí').pop()), 15000);
      type(id, 'pergunta pra '+id+'\r');
      const e=await until(()=>new RegExp('FAKE-ECO:pergunta pra '+id).test(buf(id)), 15000);
      await shot('B-'+id);
      await ok('B: '+id+' vivo e digitável', !!(ready && e), 'vivo='+!!ready+' eco='+!!e+' alive='+(TERM[id]&&TERM[id].alive)+(ready?'':' attached='+(TERM[id]&&TERM[id].attached)+' holding='+(TERM[id]&&TERM[id].holding)+' pend='+(TERM[id]&&TERM[id].pend&&TERM[id].pend.length)+' conn='+(TERM[id]&&TERM[id].host.isConnected)+' w='+(TERM[id]&&TERM[id].box.clientWidth)+' mode='+(TERM[id]&&TERM[id].mode)+' tela='+JSON.stringify(buf(id).slice(0,300))));
    }
    const armed=(()=>{ try{ return JSON.stringify(epAutoLocalGet()); }catch(_){ return '?'; } })();
    await ok('B: onda 2 ficou ARMADA (espera a onda 1)', /onda2-t4/.test(armed), armed);
    await shot('B-epico-onda1-tarefa3');
  }
  // ---------------- D: auto-início da onda 2 → PTY
  if(SC.includes('D')){
    await R('D: entregando a onda 1 (integra as 3 no banco de teste)…');
    await invokeQuiet('e2e_report',{ line:'SQL UPDATE task SET status=\'merged\' WHERE id IN (\'onda1-t1\',\'onda1-t2\',\'onda1-t3\')' });
    const t4=await until(()=>T('onda2-t4') && T('onda2-t4').status!=='draft', 90000, 1000);
    const live4=await until(async()=>{ const s=await invokeQuiet('term_status',{ taskId:'onda2-t4' }); return s && s.alive; }, 40000, 800);
    await ok('D: onda 2 começou SOZINHA e no terminal', !!(t4 && live4), 'status='+(T('onda2-t4')||{}).status);
    await show('onda2-t4');
    await until(()=>/construí/.test(buf('onda2-t4')), 20000);
    await until(()=>/FAKE-PROMPT>/.test(buf('onda2-t4').split('construí').pop()), 15000);
    type('onda2-t4', 'oi onda 2\r');
    await ok('D: onda 2 digitável', !!await until(()=>/FAKE-ECO:oi onda 2/.test(buf('onda2-t4')), 15000));
    await shot('D-onda2-auto-pty');
  }
  // ---------------- C: tarefa rodando de FUNDO (legado) → digitar converte pra PTY com a MESMA sessão
  if(SC.includes('C')){
    const bg=await until(()=>T('fundo-c') && T('fundo-c').bg===true, 30000, 800);
    await ok('C: tarefa de fundo detectada (lock vivo que não é o PTY)', !!bg, 'status='+(T('fundo-c')||{}).status);
    await show('fundo-c'); await sleep(1000);
    const note=document.querySelector('[data-termnote="bg"]');
    await ok('C: faixa explica em uma linha', !!note, note?note.textContent.trim():'');
    await shot('C1-fundo-antes');
    // clicar só foca (não mata o turno)
    TERM['fundo-c'].box.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, button:0 })); await sleep(1500);
    await ok('C: clicar NÃO converte (turno de fundo segue)', T('fundo-c').bg===true && !TERM['fundo-c'].alive);
    const sidBefore=await invokeQuiet('e2e_report',{ line:'SID-ANTES' });
    type('fundo-c', 'assumi pelo teclado\r');
    await sleep(600);
    const taking=document.querySelector('[data-termnote="taking"]');
    await ok('C: enquanto converte, a faixa diz o que está acontecendo', !!taking, taking?taking.textContent.trim():'(já tinha trocado)');
    if(taking) await shot('C2-fundo-trazendo');
    const live=await until(()=>TERM['fundo-c'] && TERM['fundo-c'].alive && /FAKE-RESUME:/.test(buf('fundo-c')), 40000);
    const eco=await until(()=>/FAKE-ECO:assumi pelo teclado/.test(buf('fundo-c')), 20000);
    const m=buf('fundo-c').match(/FAKE-RESUME:([\w-]+)/);
    await ok('C: virou PTY retomando a sessão (claude --resume)', !!live, 'sessão retomada='+(m?m[1]:'?'));
    await ok('C: o texto digitado foi a 1ª mensagem na sessão retomada', !!eco);
    await R('C-SID '+(m?m[1]:''));
    await ok('C: não está mais de fundo', T('fundo-c').bg===false);
    await shot('C3-fundo-convertido');
  }
  // ---------------- R: revisor no MESMO terminal (Ajustes › revisor automático ligado no HOME de teste)
  if(SC.includes('R')){
    await show('revisor-r');
    await startTask('revisor-r');
    const rv=await until(()=>/papel=revisor/.test(buf('revisor-r')), 60000, 500);
    await ok('R: construtor terminou → o revisor entrou no mesmo terminal (linha visível)', !!rv);
    const line=/ia claude.*--papel revisor/.test(buf('revisor-r').replace(/\n/g,''));
    await ok('R: o comando da troca ficou visível no terminal', line);
    const bar=await until(()=>{ const n=document.querySelector('[data-termnote="review"]'); return n && n.textContent.trim(); }, 15000);
    await ok('R: a faixa mostra quem fala', !!bar, bar||'');
    await shot('R1-revisor-falando');
    const back=await until(()=>/papel=construtor/.test(buf('revisor-r')), 60000, 500);
    await ok('R: aprovado → a conversa voltou pra quem constrói', !!back);
    await until(()=>T('revisor-r').status==='review', 20000);
    await ok('R: tarefa foi pra review com 1 rodada gravada', T('revisor-r').status==='review', 'rodadas='+(((T('revisor-r').spec||{}).reviewRounds)||[]).length);
    await termTab(); await shot('R2-revisor-voltou');
  }
  await R('FIM');
}catch(e){ await R('ERRO '+(e&&e.stack||e)); await R('FIM'); }
})();
