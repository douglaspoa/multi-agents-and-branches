// Proxy da Prévia (spec-navegador-design): cabeçalhos, injeção do script de seleção, WebSocket (HMR) com upstream
// falso, só loopback, alvo inválido, compressão, redirect e o processo da CLI (porta no stdout, sai quando o stdin fecha).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import {
  cleanResponseHeaders, forwardRequestHeaders, injectPicker, isLoopbackAddr, normalizeTarget, PICKER_PATH, PICKER_TAG,
  rewriteLocation, rewriteSetCookie, startBrowserProxy, type BrowserProxy,
} from "./browser-proxy.ts";
import { PICKER_JS } from "./browser-picker.ts";

const closers: (() => unknown)[] = [];
after(async () => { for (const c of closers.reverse()) await c(); });

/** Servidor "Vite" falso: HTML (opcionalmente gzip), CSP/XFO, redirect, cookie, JS e eco de WebSocket. */
async function fakeUpstream(): Promise<{ port: number; origin: string; seen: http.IncomingHttpHeaders[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const page = "<!doctype html><html><head><title>t</title></head><body><button id=cta>Comprar</button></body></html>";
  const srv = http.createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === "/gz") { res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }); res.end(zlib.gzipSync(page)); return; }
    if (req.url === "/go") { res.writeHead(302, { location: `http://127.0.0.1:${port}/login?x=1`, "set-cookie": "sid=1; Domain=localhost; Path=/; Secure; HttpOnly; SameSite=None" }); res.end(); return; }
    if (req.url === "/app.js") { res.writeHead(200, { "content-type": "text/javascript", "x-frame-options": "DENY" }); res.end("console.log('<head>')"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "SAMEORIGIN", "content-length": String(Buffer.byteLength(page)), etag: '"abc"' });
    res.end(page);
  });
  // eco de WebSocket "de mentira": responde o 101 e devolve o que chegar em maiúsculas
  const socks = new Set<net.Socket>();
  srv.on("upgrade", (req, sock, head) => {
    seen.push(req.headers); socks.add(sock as net.Socket);
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    if (head.length) sock.write(head.toString().toUpperCase());
    sock.on("data", (d) => sock.write(d.toString().toUpperCase()));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  const port = (srv.address() as net.AddressInfo).port;
  closers.push(() => new Promise<void>((ok) => { srv.close(() => ok()); srv.closeAllConnections(); for (const s of socks) s.destroy(); }));
  return { port, origin: `http://127.0.0.1:${port}`, seen };
}
async function proxyFor(origin: string): Promise<BrowserProxy> { const p = await startBrowserProxy({ target: origin }); closers.push(() => p.close()); return p; }
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((ok, bad) => {
    http.get({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (r) => {
      const cs: Buffer[] = []; r.on("data", (c) => cs.push(c)); r.on("end", () => ok({ status: r.statusCode || 0, headers: r.headers, body: Buffer.concat(cs).toString() }));
    }).on("error", bad);
  });
}

test("alvo: só http(s); sem esquema local vira http, remoto vira https; file/javascript/data/credencial recusados", () => {
  assert.equal(normalizeTarget("localhost:5173").href, "http://localhost:5173/");
  assert.equal(normalizeTarget("127.0.0.1:3000/login").href, "http://127.0.0.1:3000/login");
  assert.equal(normalizeTarget("meusite.com.br/x").href, "https://meusite.com.br/x");
  assert.equal(normalizeTarget("  http://app.localhost:8080 ").origin, "http://app.localhost:8080");
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,oi", "ftp://x.com", "", "http://user:senha@x.com"]) assert.throws(() => normalizeTarget(bad), /http|endereço|usuário/);
});

test("injeção: uma tag só, depois do <head> (ou <html>/doctype/começo); idempotente", () => {
  assert.equal(injectPicker("<html><head><title>x</title></head></html>"), `<html><head>${PICKER_TAG}<title>x</title></head></html>`);
  assert.equal(injectPicker('<HTML lang="pt"><body>oi</body>'), `<HTML lang="pt">${PICKER_TAG}<body>oi</body>`);
  assert.equal(injectPicker("<!doctype html><p>x"), `<!doctype html>${PICKER_TAG}<p>x`);
  assert.equal(injectPicker("<p>x</p>"), `${PICKER_TAG}<p>x</p>`);
  assert.ok(!injectPicker("<header>x</header>").startsWith("<header>" + PICKER_TAG), "<header> não é <head>");
  const once = injectPicker("<head></head>"); assert.equal(injectPicker(once), once);
});

test("cabeçalhos: CSP/XFO e hop-by-hop saem; Location da mesma origem volta pro proxy; cookie vale no 127.0.0.1", () => {
  const t = new URL("http://localhost:5173");
  const h = cleanResponseHeaders({ "content-security-policy": "x", "content-security-policy-report-only": "y", "x-frame-options": "DENY", connection: "keep-alive", "transfer-encoding": "chunked",
    location: "http://localhost:5173/a?b=1#c", "set-cookie": ["s=1; Domain=localhost; Secure; SameSite=None; Partitioned"], "content-type": "text/html" }, t);
  assert.deepEqual(Object.keys(h).sort(), ["content-type", "location", "set-cookie"]);
  assert.equal(h.location, "/a?b=1#c");
  assert.deepEqual(h["set-cookie"], ["s=1; SameSite=Lax"]);
  assert.equal(rewriteLocation("https://outro.com/x", t), "https://outro.com/x", "outra origem passa como está");
  assert.equal(rewriteLocation("/rel", t), "/rel");
  assert.equal(rewriteSetCookie("a=b; Path=/; HttpOnly"), "a=b; Path=/; HttpOnly");
  const f = forwardRequestHeaders({ host: "127.0.0.1:9", origin: "http://127.0.0.1:9", referer: "http://127.0.0.1:9/p?q", connection: "upgrade", upgrade: "websocket", "accept-encoding": "gzip" }, t, "http://127.0.0.1:9");
  assert.equal(f.host, "localhost:5173"); assert.equal(f.origin, "http://localhost:5173"); assert.equal(f.referer, "http://localhost:5173/p?q");
  assert.equal(f.connection, undefined); assert.equal(f.upgrade, undefined);
  const w = forwardRequestHeaders({ connection: "Upgrade", upgrade: "websocket", origin: "https://outro" }, t, "http://127.0.0.1:9", true);
  assert.equal(w.connection, "Upgrade"); assert.equal(w.upgrade, "websocket"); assert.equal(w.origin, "https://outro", "Origin de outro lugar não é reescrito");
  assert.ok(isLoopbackAddr("::ffff:127.0.0.1") && isLoopbackAddr("127.0.0.1") && isLoopbackAddr("::1"));
  assert.ok(!isLoopbackAddr("192.168.0.10") && !isLoopbackAddr(undefined));
});

test("proxy real: HTML com script injetado e sem CSP/XFO; JS intacto; gzip descomprimido; redirect e cookie; picker servido", async () => {
  const up = await fakeUpstream();
  const p = await proxyFor(up.origin);
  assert.equal(p.origin, `http://127.0.0.1:${p.port}`);
  const r = await get(p.port, "/");
  assert.equal(r.status, 200);
  assert.match(r.body, new RegExp(`<head>${PICKER_TAG.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}<title>`));
  assert.equal(r.headers["content-security-policy"], undefined); assert.equal(r.headers["x-frame-options"], undefined);
  assert.equal(r.headers["content-length"], String(Buffer.byteLength(r.body)), "tamanho recalculado depois da injeção");
  assert.equal(r.headers.etag, undefined, "etag do HTML original não vale pro HTML injetado");
  assert.equal(up.seen[0].host, `127.0.0.1:${up.port}`, "Host do alvo (dev servers checam)");
  const js = await get(p.port, "/app.js");
  assert.equal(js.body, "console.log('<head>')", "não-HTML passa intacto");
  assert.equal(js.headers["x-frame-options"], undefined);
  const gz = await get(p.port, "/gz", { "accept-encoding": "gzip" });
  assert.match(gz.body, /data-starfork-picker/); assert.equal(gz.headers["content-encoding"], undefined);
  const go = await get(p.port, "/go");
  assert.equal(go.status, 302); assert.equal(go.headers.location, "/login?x=1");
  assert.deepEqual(go.headers["set-cookie"], ["sid=1; Path=/; HttpOnly; SameSite=Lax"]);
  const pk = await get(p.port, PICKER_PATH);
  assert.equal(pk.body, PICKER_JS); assert.match(String(pk.headers["content-type"]), /javascript/);
});

test("proxy real: alvo fora do ar → 502 com página em português", async () => {
  const dead = net.createServer(); await new Promise<void>((ok) => dead.listen(0, "127.0.0.1", () => ok()));
  const port = (dead.address() as net.AddressInfo).port; await new Promise<void>((ok) => dead.close(() => ok()));
  const p = await proxyFor(`http://127.0.0.1:${port}`);
  const r = await get(p.port, "/");
  assert.equal(r.status, 502); assert.match(r.body, /O site não respondeu/); assert.match(r.body, /ECONNREFUSED/);
});

test("WebSocket (HMR): upgrade repassado com Host/Origin do alvo e bytes nos dois sentidos", async () => {
  const up = await fakeUpstream();
  const p = await proxyFor(up.origin);
  const sock = net.connect(p.port, "127.0.0.1");
  closers.push(() => sock.destroy());
  await new Promise<void>((ok) => sock.once("connect", () => ok()));
  let got = "";
  const done = new Promise<void>((ok) => sock.on("data", (d) => { got += d.toString(); if (got.includes("OLA HMR")) ok(); }));
  sock.write(`GET /?token=abc HTTP/1.1\r\nHost: 127.0.0.1:${p.port}\r\nOrigin: http://127.0.0.1:${p.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
  sock.write("ola hmr"); // logo de cara, antes do 101: o proxy segura no buffer até o alvo conectar
  await done;
  assert.match(got, /^HTTP\/1\.1 101/);
  const wsReq = up.seen.find((h) => h.upgrade === "websocket")!;
  assert.equal(wsReq.host, `127.0.0.1:${up.port}`); assert.equal(wsReq.origin, up.origin);
  assert.equal(p.sockets() >= 1, true, "socket aberto conta como uso (não fecha por ocioso)");
});

test("só loopback: escuta em 127.0.0.1, recusa Host estranho (DNS rebinding) e não aceita outra interface", async () => {
  const up = await fakeUpstream();
  const p = await proxyFor(up.origin);
  const r = await get(p.port, "/", { host: "evil.example:80" });
  assert.equal(r.status, 403);
  await assert.rejects(startBrowserProxy({ target: up.origin, host: "0.0.0.0" }), /127\.0\.0\.1/);
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (lan) {
    await assert.rejects(new Promise((ok, bad) => { const s = net.connect(p.port, lan.address); s.setTimeout(2000, () => { s.destroy(); bad(new Error("ETIMEDOUT")); }); s.once("connect", () => { s.destroy(); ok(1); }); s.once("error", bad); }), /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/);
  }
});

test("CLI: imprime a porta em JSON, serve o alvo e sai quando o stdin fecha (Starfork morreu)", async () => {
  const up = await fakeUpstream();
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const ch = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "browser-proxy", "--target", up.origin], { stdio: ["pipe", "pipe", "inherit"] });
  closers.push(() => ch.kill("SIGKILL"));
  const line = await new Promise<string>((ok) => { let b = ""; ch.stdout.on("data", (d) => { b += d; const i = b.indexOf("\n"); if (i >= 0) ok(b.slice(0, i)); }); });
  const info = JSON.parse(line);
  assert.equal(info.target, up.origin); assert.ok(info.port > 0);
  const r = await get(info.port, "/");
  assert.match(r.body, /data-starfork-picker/);
  const exited = new Promise<number | null>((ok) => ch.on("exit", (c) => ok(c)));
  ch.stdin.end();
  assert.equal(await exited, 0);
  const bad = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "browser-proxy", "--target", "file:///etc/passwd"], { stdio: ["pipe", "pipe", "inherit"] });
  let out = ""; bad.stdout.on("data", (d) => (out += d));
  const code = await new Promise<number | null>((ok) => bad.on("exit", (c) => ok(c)));
  assert.equal(code, 1); assert.match(JSON.parse(out.trim()).error, /http/);
});
