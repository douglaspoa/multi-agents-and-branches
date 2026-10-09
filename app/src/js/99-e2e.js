// Starfork — 99-e2e: roteiro de teste do APP (só na build de teste isolada, `--features e2e`). No app de verdade o
// comando e2e_script recusa e nada roda.
(async()=>{ try{ const js=await invokeQuiet('e2e_script'); if(js) (new Function(js))(); }catch(_){ } })();
