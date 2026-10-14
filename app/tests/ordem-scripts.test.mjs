// Ordem de carga dos <script> (harness 14/10: "kbCentralNow is not defined" / "capCheck is not defined" no console).
// Carrega TODOS os scripts do index.html, na ordem dele, num vm com DOM e __TAURI__ falsos (dados fictícios) e deixa
// as promessas andarem ENTRE um script e outro — como o WebView faz (microtarefas rodam quando cada <script> termina).
// Qualquer ReferenceError (função chamada antes do arquivo que a define carregar) reprova.
// `node --test app/tests/ordem-scripts.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = new URL('../src/', import.meta.url);
const html = readFileSync(new URL('index.html', SRC), 'utf8');
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]);

// elemento "faz-tudo": qualquer propriedade/chamada devolve outro faz-tudo; vira '' em texto e 0 em número
function stub() {
  const target = function () {};
  return new Proxy(target, {
    get(_t, k) {
      if (k === Symbol.toPrimitive) return (h) => (h === 'number' ? 0 : '');
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined; // não é Promise
      if (k === 'length' || k === 'scrollTop' || k === 'scrollHeight' || k === 'clientHeight' || k === 'offsetWidth') return 0;
      if (k === 'dataset') return {};
      if (k === 'style') return new Proxy({}, { get: (o, p) => (p in o ? o[p] : (p === 'setProperty' || p === 'removeProperty' ? () => {} : p === 'getPropertyValue' ? () => '' : '')), set: (o, p, v) => { o[p] = v; return true; } });
      if (k === 'value' || k === 'textContent' || k === 'innerHTML' || k === 'innerText' || k === 'className' || k === 'id') return '';
      if (k === 'checked' || k === 'hidden' || k === 'open' || k === 'disabled') return false;
      if (k === 'querySelectorAll' || k === 'getElementsByClassName' || k === 'getElementsByTagName') return () => [];
      if (k === 'getBoundingClientRect') return () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
      if (k === 'contains' || k === 'matches' || k === 'hasAttribute') return () => false;
      if (k === 'getAttribute') return () => null;
      return stub();
    },
    set() { return true; },
    apply() { return stub(); },
    construct() { return stub(); },
  });
}

function makeContext(errors) {
  const listeners = {};
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear(), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };
  const doc = new Proxy({
    readyState: 'loading', hidden: false, visibilityState: 'visible', cookie: '',
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener() {},
    getElementById: () => stub(), querySelector: () => stub(), querySelectorAll: () => [], createElement: () => stub(),
    createElementNS: () => stub(), createTextNode: () => stub(), createTreeWalker: () => ({ nextNode: () => null }),
    body: stub(), documentElement: stub(), head: stub(), activeElement: null, fonts: { ready: Promise.resolve(), load: async () => [] },
  }, { get: (t, k) => (k in t ? t[k] : stub()), set: (t, k, v) => { t[k] = v; return true; } });
  // snapshot fictício, com uma tarefa rodando: faz o refresh passar por render + teto de custo
  const snap = { repo: '/tmp/demo/loja', tasks: [{ id: 't1', title: 'Demo', status: 'running', createdAt: Date.now() - 60000, spec: {}, roles: [] }], events: [], graph: null, pending: [], stats: {} };
  const invoke = async (cmd) => {
    if (cmd === 'snapshot') return JSON.parse(JSON.stringify(snap));
    if (/^list_|_list$|projects|recent/.test(cmd)) return [];
    return null;
  };
  const noop = () => {};
  const ctx = {
    console: { log: noop, info: noop, warn: noop, debug: noop, error: (...a) => errors.push(a) },
    document: doc, localStorage: ls, sessionStorage: ls,
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', language: 'pt-BR', languages: ['pt-BR'], clipboard: { writeText: async () => {} }, onLine: true },
    location: { href: 'tauri://localhost/index.html', search: '', hash: '', protocol: 'tauri:', host: 'localhost', origin: 'tauri://localhost', reload: noop },
    __TAURI__: { core: { invoke, convertFileSrc: (p) => p }, event: { listen: async () => noop, emit: async () => {} }, window: { getCurrentWindow: () => stub() }, webview: stub(), notification: null },
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, // tempo parado: só o que é síncrono + promessas
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop, requestIdleCallback: () => 0, queueMicrotask,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop }),
    getComputedStyle: () => new Proxy({}, { get: () => '' }), getSelection: () => null,
    fetch: async () => { throw new Error('sem rede no teste'); },
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, postMessage: noop,
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} }, MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
    Element: class {}, HTMLElement: class {}, Node: class {}, Event: class { constructor(t) { this.type = t; } }, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    KeyboardEvent: class {}, MouseEvent: class {}, Option: class { constructor(t, v) { this.text = t; this.value = v; } }, FileReader: class {}, FormData: class {}, Headers: class {}, Notification: class { static requestPermission() { return Promise.resolve('denied'); } }, BroadcastChannel: class { postMessage() {} close() {} }, WebSocket: class { close() {} }, Worker: class { postMessage() {} terminate() {} },
    alert: noop, confirm: () => false, prompt: () => null, open: noop, close: noop, scrollTo: noop, focus: noop, blur: noop, print: noop, history: { pushState: noop, replaceState: noop, back: noop }, caches: undefined, indexedDB: undefined, DOMParser: class { parseFromString() { return doc; } }, Image: class {}, Audio: class { play() { return Promise.resolve(); } },
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, Blob: globalThis.Blob, crypto: globalThis.crypto, performance: globalThis.performance,
    Intl, structuredClone, atob, btoa,
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2, screen: { width: 1280, height: 800 },
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx; ctx.top = ctx; ctx.parent = ctx;
  vm.createContext(ctx);
  return { ctx, listeners, doc };
}

// nomes declarados no topo dos scripts do app (function/const/let/var e window.X=): o ReferenceError que importa é
// "função do app usada antes do arquivo dela carregar"; global do navegador que falte no vm falso não conta
const APP_NAMES = new Set();
for (const s of scripts.filter((x) => x.startsWith('js/'))) {
  const code = readFileSync(new URL(s, SRC), 'utf8');
  for (const m of code.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)|window\.([A-Za-z_$][\w$]*)\s*=[^=]/gm)) APP_NAMES.add(m[1] || m[2] || m[3]);
}
const refName = (e) => { const m = /([A-Za-z_$][\w$]*) is not defined/.exec(String(e && (e.message || e))); return m ? m[1] : null; };
const isRefErr0 = (e) => !!e && (e.name === 'ReferenceError' || /ReferenceError|is not defined/.test(String(e && (e.stack || e.message || e))));
const isRefErr = (e) => isRefErr0(e) && APP_NAMES.has(refName(e));
const flush = () => new Promise((r) => setImmediate(r));

test('scripts na ordem do index.html: nenhuma função usada antes do arquivo que a define (ReferenceError)', async () => {
  assert.ok(scripts.length > 60, 'achou os <script src> do index.html');
  const errors = []; const rejs = [];
  const onRej = (e) => rejs.push(e);
  process.on('unhandledRejection', onRej);
  const { ctx, listeners, doc } = makeContext(errors);
  const refs = [];
  try {
    for (const s of scripts) {
      const code = readFileSync(new URL(s, SRC), 'utf8');
      try { vm.runInContext(code, ctx, { filename: s }); } catch (e) { if (isRefErr(e)) refs.push(s + ' (ao carregar): ' + (e.message || e)); else if (process.env.ORDEM_DEBUG) console.log('carga', s, String(e && e.message || e)); }
      for (let i = 0; i < 6; i++) await flush(); // o WebView roda as microtarefas entre um <script> e o próximo
    }
    doc.readyState = 'interactive';
    for (const fn of listeners.DOMContentLoaded || []) { try { fn({ type: 'DOMContentLoaded' }); } catch (e) { if (isRefErr(e)) refs.push('DOMContentLoaded: ' + e.message); } }
    for (let i = 0; i < 20; i++) await flush();
  } finally { process.off('unhandledRejection', onRej); }
  if (process.env.ORDEM_DEBUG) { errors.forEach((a) => console.log('console.error', a.map((y) => String(y && y.message || y)).join(' ').slice(0, 200))); rejs.forEach((e) => console.log('rej', String(e && e.message || e).slice(0, 200))); }
  for (const a of errors) for (const x of a) if (isRefErr(x)) refs.push('console.error: ' + a.map((y) => String(y && y.message || y)).join(' '));
  for (const e of rejs) if (isRefErr(e)) refs.push('promessa: ' + (e.message || e));
  assert.deepEqual(refs, [], 'ReferenceError por ordem de carga:\n' + refs.join('\n'));
  assert.equal(typeof ctx.refresh, 'function', 'o app carregou de fato (refresh existe)');
  assert.equal(vm.runInContext("typeof state!=='undefined' && state && state.repo", ctx), '/tmp/demo/loja', 'o boot rodou o refresh com o snapshot fictício');
});

test('o boot (33) espera todos os scripts: roda no DOMContentLoaded, não no meio da carga', () => {
  const sw = readFileSync(new URL('js/33-switcher-projetos.js', SRC), 'utf8');
  assert.match(sw, /document\.readyState==='loading'\) document\.addEventListener\('DOMContentLoaded', sfBoot/);
  assert.doesNotMatch(sw, /^refresh\(\)\.then\(loadProjects\)/m, 'refresh solto no topo do 33 roda antes do 34–99 existirem');
});
