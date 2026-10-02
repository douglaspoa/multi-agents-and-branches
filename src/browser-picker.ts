// Script de seleção do modo design da Prévia (spec-navegador-design). O proxy da prévia (browser-proxy.ts) serve
// este texto em /__starfork__/picker.js e injeta UMA tag <script> nas respostas HTML que passam por ele — página
// aberta fora do proxy nunca recebe isto. Roda DENTRO do iframe (origem do proxy) e fala com o Starfork só por
// postMessage: o app é de outra origem e não lê o DOM daqui.
//
// Comandos aceitos (só de window.parent): hello · pick {on} · unmark {id} · clear · hide {nonce} · show · back ·
// forward · reload. Mensagens enviadas: ready · loc {url,title} · pick {item} · hidden {nonce} · esc.
// Tudo com { sf: 'nav' } pra o app separar do resto do tráfego de postMessage.
export const PICKER_JS = String.raw`(function(){
  if (window.__sfPicker) return; window.__sfPicker = 1;
  if (window.parent === window) return; // aberto fora do Starfork: não faz nada
  var P = window.parent, picking = false, seq = 0, marks = [], hoverEl = null, raf = 0;
  var Z = '2147483647', ACC = '#5b8cff';
  // destino '*' de propósito: P é SEMPRE o pai fixo (o app). A origem do app é um esquema próprio (tauri://localhost),
  // que o postMessage trata como opaca — com origem explícita a mensagem podia sumir calada.
  function send(m){ m.sf = 'nav'; try { P.postMessage(m, '*'); } catch(_){ } }
  function loc(){ send({ type:'loc', url: location.href, title: document.title || '' }); }
  // ---- caixas (destaque do hover + seleções numeradas): fixas, sem eventos, no topo ----
  var root = null, hov = null, curStyle = null;
  function ensureRoot(){
    if (root && root.isConnected) return;
    root = document.createElement('div'); root.setAttribute('data-sf-picker','');
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:'+Z;
    hov = document.createElement('div');
    hov.style.cssText = 'position:fixed;display:none;border:2px solid '+ACC+';background:rgba(91,140,255,.12);border-radius:3px;box-sizing:border-box';
    var lb = document.createElement('div'); lb.setAttribute('data-l','');
    lb.style.cssText = 'position:absolute;left:-2px;bottom:100%;margin-bottom:3px;background:'+ACC+';color:#fff;font:600 11px/1.5 -apple-system,system-ui,sans-serif;padding:0 6px;border-radius:4px;white-space:nowrap';
    hov.appendChild(lb); root.appendChild(hov);
    (document.body || document.documentElement).appendChild(root);
  }
  function place(box, el){
    var r = el.getBoundingClientRect();
    box.style.left = r.left+'px'; box.style.top = r.top+'px'; box.style.width = Math.max(r.width,1)+'px'; box.style.height = Math.max(r.height,1)+'px';
  }
  function paintMarks(){ raf = 0; for (var i=0;i<marks.length;i++){ var m = marks[i]; if (m.el.isConnected){ m.box.style.display=''; place(m.box, m.el); } else m.box.style.display='none'; } }
  function onMove(){ if (marks.length && !raf) raf = requestAnimationFrame(paintMarks); }
  window.addEventListener('scroll', onMove, { passive:true, capture:true });
  window.addEventListener('resize', onMove, { passive:true });
  function renumber(){ for (var i=0;i<marks.length;i++){ marks[i].box.firstChild.textContent = String(i+1); } }
  function mark(el, id){
    ensureRoot();
    var b = document.createElement('div');
    b.style.cssText = 'position:fixed;border:2px solid '+ACC+';border-radius:3px;box-sizing:border-box;box-shadow:0 0 0 9999px rgba(0,0,0,0)';
    var n = document.createElement('div');
    n.style.cssText = 'position:absolute;left:-2px;top:-2px;transform:translateY(-100%);background:'+ACC+';color:#fff;font:700 11px/1.6 -apple-system,system-ui,sans-serif;padding:0 6px;border-radius:4px 4px 4px 0';
    b.appendChild(n); root.appendChild(b); marks.push({ id:id, el:el, box:b }); renumber(); place(b, el);
  }
  // ---- o que vai pro agente ----
  var KEYS = ['display','position','box-sizing','width','height','margin','padding','border','border-radius','color','background-color','background-image','font-family','font-size','font-weight','line-height','letter-spacing','text-align','text-transform','flex-direction','justify-content','align-items','gap','grid-template-columns','opacity','box-shadow','z-index'];
  var SKIP = { '':1, 'none':1, 'normal':1, 'auto':1, '0px':1, 'rgba(0, 0, 0, 0)':1 };
  function uniq(s){ try { return document.querySelectorAll(s).length === 1; } catch(_) { return false; } }
  function esc(s){ return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, function(c){ return '\\'+c; }); }
  function selectorOf(el){
    if (el.id && uniq('#'+esc(el.id))) return '#'+esc(el.id);
    var parts = [], cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 7){
      var p;
      if (cur.id && uniq('#'+esc(cur.id))) { parts.unshift('#'+esc(cur.id)); break; }
      p = cur.tagName.toLowerCase();
      var cls = [].slice.call(cur.classList || []).filter(function(c){ return c.length < 40 && !/^\d/.test(c); }).slice(0,2);
      if (cls.length) p += cls.map(function(c){ return '.'+esc(c); }).join('');
      var par = cur.parentElement;
      if (par){ var same = [].filter.call(par.children, function(x){ return x.tagName === cur.tagName; }); if (same.length > 1) p += ':nth-of-type('+(same.indexOf(cur)+1)+')'; }
      parts.unshift(p);
      if (uniq(parts.join(' > '))) break;
      cur = par;
    }
    return parts.join(' > ');
  }
  function info(el){
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el), st = {};
    for (var i=0;i<KEYS.length;i++){ var v = cs.getPropertyValue(KEYS[i]); if (v && !SKIP[v.trim()]) st[KEYS[i]] = v.length > 200 ? v.slice(0,200)+'…' : v; }
    var html = el.outerHTML || '', full = html.length;
    if (full > 4000) html = html.slice(0,4000) + '\n<!-- … cortado: '+full+' caracteres no total -->';
    return { selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: String(el.innerText || el.textContent || '').replace(/\s+/g,' ').trim().slice(0,160),
      html: html, htmlLen: full, styles: st,
      box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), pageX: Math.round(r.left + window.scrollX), pageY: Math.round(r.top + window.scrollY) },
      url: location.href, title: document.title || '', vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio || 1 };
  }
  // ---- mira ----
  function targetOf(e){ var t = e.target; if (t && t.nodeType !== 1) t = t.parentElement; if (!t || t === document.documentElement) return null; return t; }
  function hover(e){
    var t = targetOf(e); if (!t) return; hoverEl = t; ensureRoot();
    place(hov, t); hov.style.display = '';
    var r = t.getBoundingClientRect(), c = t.classList && t.classList[0] ? '.'+t.classList[0] : '';
    hov.firstChild.textContent = t.tagName.toLowerCase()+c+'  '+Math.round(r.width)+'×'+Math.round(r.height);
    hov.firstChild.style.bottom = r.top < 22 ? 'auto' : '100%'; hov.firstChild.style.top = r.top < 22 ? '100%' : 'auto';
  }
  function swallow(e){ if (!picking) return; e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }
  function click(e){
    if (!picking) return; swallow(e);
    var t = targetOf(e); if (!t) return;
    hov.style.display = 'none'; // o número da seleção substitui o destaque (senão um cobre o outro)
    var id = ++seq; mark(t, id); send({ type:'pick', id:id, item: info(t) });
  }
  function key(e){ if (picking && e.key === 'Escape'){ swallow(e); setPick(false); send({ type:'esc' }); } }
  function setPick(on){
    picking = !!on; ensureRoot();
    if (!picking){ hov.style.display = 'none'; hoverEl = null; }
    if (picking && !curStyle){ curStyle = document.createElement('style'); curStyle.textContent = '*{cursor:crosshair!important}'; (document.head || document.documentElement).appendChild(curStyle); }
    if (!picking && curStyle){ curStyle.remove(); curStyle = null; }
  }
  window.addEventListener('mousemove', function(e){ if (picking) hover(e); }, true);
  ['mousedown','mouseup','pointerdown','pointerup','dblclick','auxclick','contextmenu','submit'].forEach(function(n){ window.addEventListener(n, swallow, true); });
  window.addEventListener('click', click, true);
  window.addEventListener('keydown', key, true);
  // ---- comandos do app (só do pai) ----
  window.addEventListener('message', function(e){
    if (e.source !== P) return;
    var d = e.data; if (!d || d.sf !== 'nav' || !d.cmd) return;
    switch (d.cmd){
      case 'hello': loc(); break;
      case 'pick': setPick(d.on); break;
      case 'unmark': for (var i=0;i<marks.length;i++){ if (marks[i].id === d.id){ marks[i].box.remove(); marks.splice(i,1); renumber(); break; } } break;
      case 'clear': marks.forEach(function(m){ m.box.remove(); }); marks = []; break;
      case 'hide': if (root) root.style.display = 'none'; requestAnimationFrame(function(){ requestAnimationFrame(function(){ send({ type:'hidden', nonce: d.nonce }); }); }); break;
      case 'show': if (root) root.style.display = ''; break;
      case 'back': history.back(); break;
      case 'forward': history.forward(); break;
      case 'reload': location.reload(); break;
    }
  });
  // ---- navegação de SPA: a barra de endereço do app acompanha ----
  ['pushState','replaceState'].forEach(function(k){ var o = history[k]; history[k] = function(){ var r = o.apply(this, arguments); setTimeout(loc, 0); return r; }; });
  window.addEventListener('popstate', loc); window.addEventListener('hashchange', loc);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loc); else loc();
  send({ type:'ready' });
})();`;
