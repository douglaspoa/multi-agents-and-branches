// Proxy da Prévia (spec-navegador-design): serve UMA origem alvo (o dev server da tarefa ou um site remoto) numa
// porta aleatória do Starfork em 127.0.0.1, pra página abrir dentro de um <iframe> do app com o script de seleção
// (browser-picker.ts) injetado. Regras:
// - só escuta em 127.0.0.1 e só atende socket de loopback com Host apontando pro próprio proxy (anti DNS-rebinding);
// - não reescreve conteúdo: só injeta UMA tag <script> nas respostas HTML; o resto (JS, CSS, imagens) passa intacto;
// - tira Content-Security-Policy* e X-Frame-Options SÓ das respostas que passam por aqui (senão o iframe é barrado);
// - WebSocket (HMR do Vite/Next) é repassado byte a byte;
// - alvo só http(s) — nunca file:, data:, javascript:…
// Ciclo de vida (CLI `cardume browser-proxy`): stdin fechado = o Starfork morreu → sai; ocioso sem socket aberto → sai.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { PICKER_JS } from "./browser-picker.ts";

export const PICKER_PATH = "/__starfork__/picker.js";
export const PICKER_TAG = `<script src="${PICKER_PATH}" data-starfork-picker></script>`;
const LOCALISH = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|[\w-]+\.(localhost|local|test))(:\d+)?(\/|$)/i;

/** Texto digitado na barra → origem alvo. Sem esquema: local vira http, o resto https. Erro em português. */
export function normalizeTarget(raw: string): URL {
  let s = String(raw ?? "").trim();
  if (!s) throw new Error("digite um endereço");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) || /^(localhost|[\w.-]+):\d+/i.test(s)) s = (LOCALISH.test(s) ? "http://" : "https://") + s;
  let u: URL;
  try { u = new URL(s); } catch { throw new Error("endereço inválido: " + String(raw).slice(0, 120)); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("só endereços http(s) abrem na prévia");
  if (!u.hostname) throw new Error("endereço sem servidor: " + String(raw).slice(0, 120));
  if (u.username || u.password) throw new Error("endereço com usuário/senha não é aceito — tire a parte antes do @");
  return u;
}

export function isLoopbackHost(h: string): boolean {
  const x = h.replace(/^\[|\]$/g, "").toLowerCase();
  return x === "localhost" || x === "::1" || x === "0.0.0.0" || /^127\./.test(x) || x.endsWith(".localhost");
}
export function isLoopbackAddr(a: string | undefined): boolean {
  return !!a && (a === "::1" || /^127\./.test(a) || /^::ffff:127\./.test(a));
}

/** Injeta o script UMA vez: logo depois do <head>, senão do <html>, senão do doctype, senão no começo. */
export function injectPicker(html: string, tag = PICKER_TAG): string {
  if (html.includes(PICKER_PATH)) return html;
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) { const at = m.index + m[0].length; return html.slice(0, at) + tag + html.slice(at); }
  }
  return tag + html;
}

/** Location absoluto pra origem alvo volta pro proxy (caminho relativo); outra origem passa como está. */
export function rewriteLocation(loc: string, target: URL): string {
  try {
    const u = new URL(loc, target);
    if (u.origin === target.origin) return u.pathname + u.search + u.hash;
  } catch { /* fica como veio */ }
  return loc;
}

/** Cookie do alvo precisa valer no 127.0.0.1 do proxy: sem Domain, sem Secure (é http local), SameSite=None → Lax. */
export function rewriteSetCookie(c: string): string {
  return c.split(";").map((p) => p.trim()).filter((p) => p && !/^domain=/i.test(p) && !/^secure$/i.test(p) && !/^partitioned$/i.test(p))
    .map((p) => (/^samesite=none$/i.test(p) ? "SameSite=Lax" : p)).join("; ");
}

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const DROP_RES = new Set(["content-security-policy", "content-security-policy-report-only", "x-frame-options"]);

/** Cabeçalhos da RESPOSTA que voltam pro iframe (só das respostas proxiadas). */
export function cleanResponseHeaders(h: IncomingHttpHeaders, target: URL): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (v === undefined || HOP.has(key) || DROP_RES.has(key)) continue;
    if (key === "location" && typeof v === "string") { out[key] = rewriteLocation(v, target); continue; }
    if (key === "set-cookie") { out[key] = (Array.isArray(v) ? v : [String(v)]).map(rewriteSetCookie); continue; }
    out[key] = v;
  }
  return out;
}

/** Cabeçalhos do PEDIDO que seguem pro alvo: Host/Origin/Referer do alvo (dev servers checam), sem hop-by-hop. */
export function forwardRequestHeaders(h: IncomingHttpHeaders, target: URL, proxyOrigin: string, keepUpgrade = false): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (v === undefined) continue;
    if (HOP.has(key) && !(keepUpgrade && (key === "connection" || key === "upgrade"))) continue;
    out[key] = v;
  }
  out.host = target.host;
  if (typeof out.origin === "string" && out.origin === proxyOrigin) out.origin = target.origin;
  if (typeof out.referer === "string" && out.referer.startsWith(proxyOrigin)) out.referer = target.origin + out.referer.slice(proxyOrigin.length);
  return out;
}

function decode(buf: Buffer, enc: string): Buffer | null {
  try {
    if (!enc || enc === "identity") return buf;
    if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(buf);
    if (enc === "deflate") { try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); } }
    if (enc === "br") return zlib.brotliDecompressSync(buf);
  } catch { /* corpo estranho: repassa sem injetar */ }
  return null;
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export function errorPage(target: URL, err: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Prévia fora do ar</title><body style="font:14px/1.5 -apple-system,system-ui,sans-serif;color:#333;padding:32px;max-width:560px">` +
    `<h2 style="margin:0 0 8px">O site não respondeu</h2><p>Tentei abrir <b>${escHtml(target.origin)}</b> e não deu (${escHtml(err)}).</p>` +
    `<p>Se é o site local da tarefa, suba o servidor (globo no topo › subir) ou peça pro agente subir — depois clique em recarregar.</p></body>`;
}

export interface BrowserProxy { port: number; origin: string; target: URL; close(): Promise<void>; sockets(): number; lastActivity(): number }

export async function startBrowserProxy(opts: { target: string | URL; port?: number; host?: string }): Promise<BrowserProxy> {
  const target = typeof opts.target === "string" ? normalizeTarget(opts.target) : opts.target;
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("o proxy da prévia só escuta em 127.0.0.1");
  const mod = target.protocol === "https:" ? https : http;
  const tport = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  // certificado de dev (mkcert/self-signed) só é aceito em alvo LOCAL; site remoto exige certificado válido
  const insecureOk = isLoopbackHost(target.hostname);
  let port = 0, last = Date.now(), open = 0;
  const tunnels = new Set<net.Socket>(); // sockets de WebSocket (o server.close não os enxerga depois do upgrade)
  const proxyOrigin = () => `http://127.0.0.1:${port}`;
  const hostOk = (h: string | undefined) => !!h && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(h.toLowerCase());

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    last = Date.now();
    if (!isLoopbackAddr(req.socket.remoteAddress) || !hostOk(req.headers.host)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("só o Starfork usa este proxy"); return; }
    if (req.url === PICKER_PATH || req.url?.startsWith(PICKER_PATH + "?")) {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" }).end(PICKER_JS); return;
    }
    const up = mod.request({
      protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ""), port: tport, method: req.method, path: req.url || "/",
      headers: forwardRequestHeaders(req.headers, target, proxyOrigin()), servername: net.isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: !insecureOk,
    }, (ur) => {
      const headers = cleanResponseHeaders(ur.headers, target);
      const ctype = String(ur.headers["content-type"] || "");
      const status = ur.statusCode || 502;
      const isHtml = /text\/html|application\/xhtml\+xml/i.test(ctype) && req.method !== "HEAD" && status !== 204 && status !== 304;
      if (!isHtml) { res.writeHead(status, ur.statusMessage, headers); ur.pipe(res); return; }
      const chunks: Buffer[] = [];
      ur.on("data", (c: Buffer) => chunks.push(c));
      ur.on("error", () => res.destroy());
      ur.on("end", () => {
        const raw = Buffer.concat(chunks);
        const enc = String(ur.headers["content-encoding"] || "").trim().toLowerCase();
        const plain = decode(raw, enc);
        if (!plain) { res.writeHead(status, ur.statusMessage, headers).end(raw); return; }
        const body = Buffer.from(injectPicker(plain.toString("utf8")), "utf8");
        delete headers["content-encoding"]; delete headers["content-length"]; delete headers["etag"];
        headers["content-length"] = String(body.length);
        res.writeHead(status, ur.statusMessage, headers).end(body);
      });
    });
    up.on("error", (e: NodeJS.ErrnoException) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(errorPage(target, e.code || e.message));
    });
    req.pipe(up);
  });
  server.on("connection", (s: net.Socket) => {
    if (!isLoopbackAddr(s.remoteAddress)) { s.destroy(); return; }
    open++; last = Date.now(); s.on("close", () => { open--; last = Date.now(); });
  });
  // WebSocket (HMR): repassa o pedido de upgrade cru e depois os bytes nos dois sentidos
  server.on("upgrade", (req: IncomingMessage, sock: net.Socket, head: Buffer) => {
    last = Date.now();
    sock.pause(); // o que o cliente mandar antes do alvo conectar fica no buffer (o pipe retoma)
    if (!isLoopbackAddr(sock.remoteAddress) || !hostOk(req.headers.host)) { sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const h = forwardRequestHeaders(req.headers, target, proxyOrigin(), true);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(h)) for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined) lines.push(`${k}: ${x}`);
    const hn = target.hostname.replace(/^\[|\]$/g, "");
    const upSock: net.Socket = target.protocol === "https:"
      ? tls.connect({ host: hn, port: tport, servername: net.isIP(hn) ? undefined : hn, rejectUnauthorized: !insecureOk })
      : net.connect({ host: hn, port: tport });
    tunnels.add(sock); tunnels.add(upSock);
    const kill = () => { upSock.destroy(); sock.destroy(); };
    upSock.setTimeout(10_000, () => { if (!upSock.readyState || upSock.connecting) kill(); });
    upSock.once(target.protocol === "https:" ? "secureConnect" : "connect", () => {
      upSock.setTimeout(0);
      upSock.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) upSock.write(head);
      upSock.pipe(sock); sock.pipe(upSock);
    });
    upSock.on("error", kill); sock.on("error", kill); upSock.on("close", () => { tunnels.delete(upSock); sock.destroy(); }); sock.on("close", () => { tunnels.delete(sock); upSock.destroy(); });
  });
  await new Promise<void>((ok, bad) => { server.once("error", bad); server.listen(opts.port ?? 0, host, () => ok()); });
  port = (server.address() as net.AddressInfo).port;
  return {
    port, origin: proxyOrigin(), target,
    sockets: () => open, lastActivity: () => last,
    close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections?.(); for (const s of tunnels) s.destroy(); tunnels.clear(); }),
  };
}

/** `cardume browser-proxy --target <url> [--idle-min 20]` — imprime {"port":N,"origin":…,"target":…} e fica no ar. */
export async function browserProxyCli(argv: { _: string[]; flags: Record<string, string> }): Promise<number> {
  let p: BrowserProxy;
  try { p = await startBrowserProxy({ target: argv.flags.target ?? argv._[1] ?? "" }); }
  catch (e) { console.log(JSON.stringify({ error: (e as Error).message })); return 1; }
  console.log(JSON.stringify({ port: p.port, origin: p.origin, target: p.target.origin }));
  const idleMs = Math.max(1, Number(argv.flags["idle-min"]) || 20) * 60_000;
  const bye = () => { p.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  // cordão umbilical: o Starfork segura o stdin; se ele morrer (ou fechar a prévia), o pipe fecha e o proxy sai
  process.stdin.on("end", bye); process.stdin.on("close", bye); process.stdin.on("error", bye); process.stdin.resume();
  process.on("SIGTERM", bye); process.on("SIGINT", bye);
  // ocioso: um timer só, re-armado pro que falta (sem laço de polling); socket aberto (HMR) = em uso
  const arm = (ms: number) => setTimeout(() => {
    const idle = Date.now() - p.lastActivity();
    if (p.sockets() > 0 || idle < idleMs) arm(p.sockets() > 0 ? idleMs : idleMs - idle); else bye();
  }, ms);
  arm(idleMs);
  await new Promise<never>(() => {});
  return 0;
}
