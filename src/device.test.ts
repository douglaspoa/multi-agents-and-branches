// Painel Dispositivo (spec-dispositivo-no-app): mapeamento clique → toque (com escala), comandos montados pro AXe e
// pro console do emulador, H.264 Annex-B → access units, o servidor do espelho com simctl/adb/AXe FALSOS (token,
// trava do Android, print pelos nomes de sempre, captura só com cliente) — e o console do emulador num TCP falso.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnnexB, androidConsoleLines, consolePort, curateIosOptions, deviceInfo, frame, imageSize, iosAxeArgs, iosPointScale, mirrorSize, parseAndroidScreen,
  parseInput, startMirror, toDevice, type Screen,
} from "./device.ts";
import { makeCtx, mobileCli, safeId, type ExecOut, type MobileDeps } from "./mobile.ts";

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), "sf-device-" + p + "-"))); made.push(d); return d; };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), Buffer.from([0, 0, 4, 0xb6, 0, 0, 0x0a, 0x3e]), Buffer.alloc(200, 7)]); // 1206×2622
const IPHONE: Screen = { w: 1206, h: 2622, ptScale: 3 };
const PIXEL: Screen = { w: 1080, h: 2400, ptScale: 1 };

// ------------------------------------------------------------------ entrada
test("clique normalizado → PONTOS no iOS (pixels ÷ escala) e PIXELS no Android; fora da tela é cortado", () => {
  assert.deepEqual(toDevice(IPHONE, "ios", 0.5, 0.5), { x: 201, y: 437 }, "iPhone 17: 402×874 pt");
  assert.deepEqual(toDevice(IPHONE, "ios", 1, 1), { x: 401, y: 873 }, "a borda não vira coordenada fora da tela");
  assert.deepEqual(toDevice(PIXEL, "android", 0.25, 0.75), { x: 270, y: 1800 });
  assert.deepEqual(toDevice(PIXEL, "android", -3, 9), { x: 0, y: 2399 });
  assert.deepEqual(toDevice(PIXEL, "android", Number.NaN, 0.5), { x: 0, y: 1200 });
});
test("entrada do front é validada (tipo fechado, texto limpo e curto, duração com teto)", () => {
  assert.deepEqual(parseInput({ t: "tap", x: 0.5, y: 2 }), { t: "tap", x: 0.5, y: 1 });
  assert.deepEqual(parseInput({ t: "swipe", x: 0, y: 0, x2: 1, y2: 1, ms: 99999 }), { t: "swipe", x: 0, y: 0, x2: 1, y2: 1, ms: 3000 });
  assert.deepEqual(parseInput({ t: "text", text: "olá\u0000\n" }), { t: "text", text: "olá" });
  assert.equal(parseInput({ t: "text", text: "" }), null);
  assert.equal((parseInput({ t: "text", text: "x".repeat(900) }) as { text: string }).text.length, 500);
  assert.equal(parseInput({ t: "key", key: "rm -rf" }), null);
  assert.equal(parseInput({ t: "button", name: "power" }), null);
  assert.equal(parseInput({ t: "exec" }), null);
  assert.equal(parseInput("lixo"), null);
});
test("iOS → AXe: toque físico em pontos, deslizar com duração, texto, teclas HID e botões; voltar não existe", () => {
  assert.deepEqual(iosAxeArgs({ t: "tap", x: 0.5, y: 0.25 }, "U1", IPHONE), [["tap", "-x", "201", "-y", "219", "--tap-style", "physical", "--udid", "U1"]]);
  assert.deepEqual(iosAxeArgs({ t: "swipe", x: 0.5, y: 0.8, x2: 0.5, y2: 0.2, ms: 400 }, "U1", IPHONE),
    [["drag", "--start-x", "201", "--start-y", "699", "--end-x", "201", "--end-y", "175", "--duration", "0.40", "--steps", "25", "--udid", "U1"]], "drag (toque baixo nível): o swipe do AXe depende da acessibilidade");
  assert.deepEqual(iosAxeArgs({ t: "text", text: "a b" }, "U1", IPHONE), [["type", "--udid", "U1", "--", "a b"]], "texto vai como UM argumento (sem shell)");
  assert.deepEqual(iosAxeArgs({ t: "text", text: "-rf" }, "U1", IPHONE), [["type", "--udid", "U1", "--", "-rf"]], "texto com '-' depois do '--' não vira opção");
  assert.deepEqual(iosAxeArgs({ t: "key", key: "backspace" }, "U1", IPHONE), [["key", "42", "--udid", "U1"]]);
  assert.deepEqual(iosAxeArgs({ t: "button", name: "home" }, "U1", IPHONE), [["button", "home", "--udid", "U1"]]);
  assert.equal(iosAxeArgs({ t: "button", name: "back" }, "U1", IPHONE), null);
  assert.equal(iosAxeArgs({ t: "move", x: 0, y: 0 }, "U1", IPHONE), null, "no iOS o gesto vai inteiro no soltar");
});
test("Android → console do emulador: toque, arrasto AO VIVO, deslizar interpolado, texto com espaço, teclas", () => {
  assert.deepEqual(androidConsoleLines({ t: "tap", x: 0.5, y: 0.5 }, PIXEL), ["event mouse 540 1200 0 1", "event mouse 540 1200 0 0"]);
  assert.deepEqual(androidConsoleLines({ t: "down", x: 0.1, y: 0.1 }, PIXEL), ["event mouse 108 240 0 1"]);
  assert.deepEqual(androidConsoleLines({ t: "move", x: 0.2, y: 0.1 }, PIXEL), ["event mouse 216 240 0 1"]);
  assert.deepEqual(androidConsoleLines({ t: "up", x: 0.2, y: 0.1 }, PIXEL), ["event mouse 216 240 0 0"]);
  const sw = androidConsoleLines({ t: "swipe", x: 0.5, y: 0.9, x2: 0.5, y2: 0.1, ms: 320 }, PIXEL);
  assert.equal(sw[0], "event mouse 540 2160 0 1"); assert.equal(sw.at(-1), "event mouse 540 240 0 0"); assert.equal(sw.length, 22);
  assert.deepEqual(androidConsoleLines({ t: "text", text: "oi tudo" }, PIXEL), ["event text oi", "event send EV_KEY:KEY_SPACE:1 EV_KEY:KEY_SPACE:0", "event text tudo"]);
  assert.deepEqual(androidConsoleLines({ t: "button", name: "back" }, PIXEL), ["event send EV_KEY:KEY_BACK:1 EV_KEY:KEY_BACK:0"]);
  assert.deepEqual(androidConsoleLines({ t: "button", name: "home" }, PIXEL), ["event send EV_KEY:KEY_HOMEPAGE:1 EV_KEY:KEY_HOMEPAGE:0"]);
  assert.equal(consolePort("emulator-5584"), 5584);
  assert.equal(consolePort("R58M123ABC"), null, "aparelho físico não tem console");
});

// ------------------------------------------------------------------ H.264 / imagens / telas
const nal = (type: number, body: number[] = [0x88, 1, 2]) => Buffer.from([0, 0, 0, 1, type, ...body]);
test("Annex-B → access units: SPS/PPS vão junto do IDR (chave); NAL partido entre pedaços; flush entrega o último quadro", () => {
  const p = new AnnexB();
  const stream = Buffer.concat([nal(0x67, [0x42, 0xc0, 0x29]), nal(0x68), nal(0x65), nal(0x41), nal(0x41)]);
  const aus = [...p.push(stream.subarray(0, 13)), ...p.push(stream.subarray(13))];
  assert.equal(aus.length, 2, "o último NAL só fecha com o próximo começo… ou no flush");
  assert.equal(aus[0].key, true); assert.equal(aus[0].data[4], 0x67, "começa no SPS");
  assert.equal(aus[1].key, false);
  const tail = p.flush(); assert.equal(tail.length, 1); assert.equal(tail[0].key, false);
  assert.deepEqual(p.flush(), []);
  // começo de NAL de 3 bytes também
  const q = new AnnexB();
  assert.equal(q.push(Buffer.concat([Buffer.from([0, 0, 1, 0x65, 9]), Buffer.from([0, 0, 1, 0x41, 9])])).length, 1);
});
test("pedaço do /stream: [tipo][tamanho u32 BE][dados]; tamanho de PNG/JPEG pelo cabeçalho; tela do Android com rotação", () => {
  const f = frame(3, Buffer.from("abc"));
  assert.deepEqual([...f], [3, 0, 0, 0, 3, 97, 98, 99]);
  assert.deepEqual(imageSize(PNG), { w: 1206, h: 2622 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x05, 0x1f, 0x02, 0x5b, 3, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { w: 603, h: 1311 });
  assert.equal(imageSize(Buffer.from("lixo")), null);
  assert.deepEqual(parseAndroidScreen("Physical size: 1080x2400\n", "SurfaceOrientation: 0"), PIXEL);
  assert.deepEqual(parseAndroidScreen("Physical size: 1080x2400\nOverride size: 720x1600\n", "  SurfaceOrientation: 1"), { w: 1600, h: 720, ptScale: 1, rotated: true }, "deitado + override");
  assert.equal(parseAndroidScreen("", ""), null);
  assert.deepEqual(parseAndroidScreen("Physical size: 1080x2400\n", "  init=1080x2400 420dpi cur=2400x1080 app=2400x1080"), { w: 2400, h: 1080, ptScale: 1, rotated: true }, "Android 15: cur= já girado (init é o natural)");
  assert.deepEqual(mirrorSize(PIXEL), { w: 540, h: 1200 });
  assert.equal(iosPointScale(1206, 2622), 3, "iPhone 17"); assert.equal(iosPointScale(750, 1334), 2, "iPhone SE"); assert.equal(iosPointScale(2064, 2752), 2, "iPad");
  assert.deepEqual(mirrorSize({ w: 1440, h: 3120, ptScale: 1 }), { w: 590, h: 1280 }, "lado maior no máximo 1280, par");
});
test("seletor iOS enxuto: iPhones das 2 gerações mais novas (padrão primeiro), Air, 4 iPads e o aparelho atual", () => {
  const m = (n: string) => ({ runtime: "rt", runtimeName: "iOS 26.5", deviceType: "dt." + n.replace(/\s+/g, "-"), deviceName: n });
  const all = ["iPhone 17 Pro", "iPhone 17", "iPhone Air", "iPhone 16", "iPhone 15", "iPhone SE (3rd generation)", "iPad Pro 13-inch (M5)", "iPad Air 11-inch (M4)", "iPad mini (A17 Pro)", "iPad (A16)", "iPad (10th generation)"].map(m);
  const o = curateIosOptions(all, "iPhone 15");
  assert.deepEqual(o.map((x) => x.label.split(" · ")[0]), ["iPhone 17", "iPhone 17 Pro", "iPhone 16", "iPhone Air", "iPad Pro 13-inch (M5)", "iPad Air 11-inch (M4)", "iPad mini (A17 Pro)", "iPad (A16)", "iPhone 15"]);
});

// ------------------------------------------------------------------ servidor do espelho com deps falsos
function fakeDeps(home: string, respond: (cmd: string, args: string[]) => Partial<ExecOut> | void = () => {}) {
  const calls: string[] = [];
  const deps: MobileDeps = {
    exec: async (cmd, args) => {
      const b = cmd.split("/").pop()!;
      if (b === "ps") return { code: 1, stdout: "", stderr: "" };
      calls.push([b, ...args].join(" "));
      const r = respond(cmd, args) ?? {};
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    execToFile: async (cmd, args, file) => { calls.push([cmd.split("/").pop(), ...args, ">", file].join(" ")); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, PNG); return { code: 0, stdout: "", stderr: "" }; },
    spawnBg: () => 4242, alive: () => false, signal: () => {},
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), now: () => Date.now(),
    home, env: { PATH: "/usr/bin" }, platform: "darwin", arch: "arm64",
  };
  return { deps, calls };
}
const simctlFake = (cmd: string, args: string[]): Partial<ExecOut> | void => {
  if (cmd === "xcrun" && args[0] === "simctl" && args[1] === "io" && args[3] === "screenshot") { writeFileSync(args.at(-1)!, PNG); return {}; }
  if (cmd === "xcrun" && args[0] === "clang") return { code: 1, stderr: "sem clang no teste" }; // sfsim indisponível → cai pros prints
};
function setupTask(home: string, raw: string, st: object) {
  const safe = safeId(raw);
  mkdirSync(join(home, ".constellation", "mobile", "tasks"), { recursive: true });
  writeFileSync(join(home, ".constellation", "mobile", "tasks", safe + ".json"), JSON.stringify({ taskId: safe, rawId: raw, ...st }));
  return safe;
}
const post = async (base: string, path: string, body: unknown) => { const r = await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, json: await r.json() as Record<string, unknown> }; };

test("espelho iOS: token obrigatório; stream SÓ com cliente (cai pros prints sem o sfsim); toque vira AXe em pontos; print pelos nomes de sempre", async () => {
  const home = tmp("home"), wt = tmp("wt");
  const axe = join(home, ".local", "bin", "axe"); mkdirSync(join(axe, ".."), { recursive: true }); writeFileSync(axe, "#!/bin/sh\n"); chmodSync(axe, 0o755);
  setupTask(home, "t-ios", { wt, ios: { udid: "U-T1", name: "Starfork-x", device: "iPhone 17", runtime: "iOS 26.5" } });
  const f = fakeDeps(home, simctlFake);
  const h = await startMirror(makeCtx("t-ios", wt, f.deps, () => {}, { viewer: true }), "ios", { captureGraceMs: 50, idleExitMs: 60_000 });
  const base = `http://127.0.0.1:${h.port}`, q = `?t=${h.token}`;
  try {
    assert.equal((await fetch(`${base}/state?t=errado`)).status, 403, "sem token → 403");
    assert.equal((await fetch(`${base}/state`)).status, 403);
    const st = await (await fetch(`${base}/state${q}`)).json() as Record<string, unknown>;
    assert.equal(st.touch, true); assert.equal(st.liveDrag, false); assert.equal(st.rotate, false); assert.equal(st.busy, null);
    assert.ok(!f.calls.some((c) => c.includes("screenshot")), "sem espectador, nada de captura");
    // cliente no /stream: meta + 1 imagem (tela parada não reenvia)
    const ctl = new AbortController();
    const r = await fetch(`${base}/stream${q}`, { signal: ctl.signal });
    const rd = r.body!.getReader(); let buf = Buffer.alloc(0); const kinds: number[] = []; let meta = "";
    while (kinds.filter((k) => k === 1).length < 1) {
      const { value, done } = await rd.read(); if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
      while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) { const n = buf.readUInt32BE(1); kinds.push(buf[0]); if (buf[0] === 0) meta = buf.subarray(5, 5 + n).toString(); buf = buf.subarray(5 + n); }
    }
    assert.deepEqual(kinds.slice(0, 2), [0, 1]);
    assert.deepEqual(JSON.parse(meta), { plat: "ios", w: 1206, h: 2622, ptScale: 3, codec: "image", via: "screenshot" });
    // toque: clique no meio → AXe em PONTOS (402×874)
    assert.deepEqual((await post(base, `/input${q}`, { t: "tap", x: 0.5, y: 0.5 })).json, { ok: true });
    assert.ok(f.calls.includes("axe tap -x 201 -y 437 --tap-style physical --udid U-T1"), f.calls.filter((c) => c.startsWith("axe")).join("\n"));
    assert.equal((await post(base, `/input${q}`, { t: "nada" })).status, 400);
    // girar não existe no iOS → erro humano (409), não 500
    const rot = await post(base, `/action${q}`, { name: "rotate" });
    assert.equal(rot.status, 409); assert.match(String(rot.json.error), /Simulador iOS não gira|não é possível/);
    // print → .cardume/artifacts/mobile-ios-1.png (mesmo nome que o agente usa)
    const shot = await post(base, `/action${q}`, { name: "shot" });
    assert.deepEqual(shot.json, { ok: true, file: "mobile-ios-1.png" });
    assert.ok(readdirSync(join(wt, ".cardume", "artifacts")).includes("mobile-ios-1.png"));
    // tema e barra de status pelo simctl
    await post(base, `/action${q}`, { name: "appearance", value: "dark" });
    assert.ok(f.calls.includes("xcrun simctl ui U-T1 appearance dark"));
    await post(base, `/action${q}`, { name: "statusbar", value: "on" });
    assert.ok(f.calls.some((c) => c.startsWith("xcrun simctl status_bar U-T1 override --time 9:41")));
    assert.equal((await post(base, `/action${q}`, { name: "openurl", value: "javascript:alert(1)" })).status, 409, "URL sem esquema://");
    // espectador saiu → a captura para (depois do respiro)
    ctl.abort();
    await new Promise((res) => setTimeout(res, 700));
    const n0 = f.calls.filter((c) => c.includes("screenshot")).length;
    await new Promise((res) => setTimeout(res, 1200));
    assert.equal(f.calls.filter((c) => c.includes("screenshot")).length, n0, "sem espectador a captura PARA");
  } finally { h.close(); }
});

test("espelho Android: agente com a trava → só visualização (toque recusado, nada enviado); livre → console do emulador ao vivo", async () => {
  const home = tmp("home"), wt = tmp("wt");
  writeFileSync(join(home, ".emulator_console_auth_token"), "segredo123");
  // console falso do emulador
  const got: string[] = [];
  const srv = net.createServer((s) => { s.on("data", (b) => got.push(...String(b).split("\r\n").filter(Boolean))); s.write("Android Console\r\nOK\r\n"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  setupTask(home, "t-and", { wt, android: { serial: `emulator-${port}`, avd: "starfork-pixel" } });
  // adb no SDK falso (o espelho acha pelo ~/Library/Android/sdk)
  const pt = join(home, "Library", "Android", "sdk", "platform-tools"); mkdirSync(pt, { recursive: true }); writeFileSync(join(pt, "adb"), ""); chmodSync(join(pt, "adb"), 0o755);
  const f = fakeDeps(home, (cmd, args) => {
    if (cmd.endsWith("adb") && args.includes("wm")) return { stdout: "Physical size: 1080x2400\n" };
    if (cmd.endsWith("adb") && args.includes("dumpsys")) return { stdout: "init=1080x2400 420dpi cur=1080x2400 app=1080x2400\n" };
  });
  const lock = join(home, ".constellation", "mobile", "android.lock");
  writeFileSync(lock, JSON.stringify({ taskId: "outra-abc123", at: Date.now() })); // agente de OUTRA tarefa usando (sem dono: vale 30 min)
  const h = await startMirror(makeCtx("t-and", wt, f.deps, () => {}, { viewer: true }), "android", { idleExitMs: 60_000 });
  const base = `http://127.0.0.1:${h.port}`, q = `?t=${h.token}`;
  try {
    const st = await (await fetch(`${base}/state${q}`)).json() as Record<string, unknown>;
    assert.match(String(st.busy), /agente da tarefa outra-abc123 está usando o emulador — só visualização/);
    assert.equal(st.liveDrag, true); assert.equal(st.rotate, true);
    const r = await post(base, `/input${q}`, { t: "tap", x: 0.5, y: 0.5 });
    assert.equal(r.status, 409); assert.match(String(r.json.error), /só visualização/);
    assert.equal((await post(base, `/action${q}`, { name: "shot" })).status, 409, "print pelo painel também respeita a trava");
    assert.deepEqual(got, [], "nada chegou no emulador");
    // trava solta → toque e arrasto ao vivo pelo console (com o token de auth)
    rmSync(lock);
    // sem quadro nenhum ainda: o tamanho da tela vem do `wm size` na hora do toque
    assert.deepEqual((await post(base, `/input${q}`, { t: "down", x: 0.5, y: 0.5 })).json, { ok: true });
    await post(base, `/input${q}`, { t: "move", x: 0.5, y: 0.25 });
    await post(base, `/input${q}`, { t: "up", x: 0.5, y: 0.25 });
    await post(base, `/input${q}`, { t: "button", name: "back" });
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(got, ["auth segredo123", "event mouse 540 1200 0 1", "event mouse 540 600 0 1", "event mouse 540 600 0 0", "event send EV_KEY:KEY_BACK:1 EV_KEY:KEY_BACK:0"]);
    // disparados JUNTOS (o front não espera cada um): chegam EM ORDEM (fila no servidor)
    got.length = 0;
    await Promise.all([0.1, 0.2, 0.3, 0.4].map((y, i) => post(base, `/input${q}`, { t: i === 0 ? "down" : i === 3 ? "up" : "move", x: 0.5, y })));
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(got, ["event mouse 540 240 0 1", "event mouse 540 480 0 1", "event mouse 540 720 0 1", "event mouse 540 960 0 0"]);
    // URL vai entre aspas pro shell do aparelho (sem ; & | $)
    await post(base, `/action${q}`, { name: "openurl", value: "exp://h?a=1&b=2;reboot" });
    assert.ok(f.calls.some((c2) => c2.endsWith(`am start -a android.intent.action.VIEW -d 'exp://h?a=1&b=2;reboot'`)), f.calls.filter((c2) => c2.includes("am start")).join("\n"));
    assert.equal((await post(base, `/action${q}`, { name: "statusbar", value: "on" })).status, 409, "barra de status é do iOS");
    assert.equal((await fetch(`${base}/input${q}`, { method: "POST", body: "{lixo" })).status, 400, "JSON quebrado → 400");
    const hostStatus = await new Promise<number>((res2) => { const r2 = http.request({ host: "127.0.0.1", port: h.port, path: `/state${q}`, headers: { Host: "evil.example" } }, (rs) => { rs.resume(); res2(rs.statusCode ?? 0); }); r2.end(); });
    assert.equal(hostStatus, 403, "Host estranho (DNS rebinding) → 403");
  } finally { h.close(); srv.close(); }
});

test("espelho sai sozinho sem ninguém olhando; info do painel: projeto, plataformas, aparelhos e quem usa o emulador", async () => {
  const home = tmp("home"), wt = tmp("wt");
  setupTask(home, "t-idle", { wt, ios: { udid: "U1", name: "Starfork-y", device: "iPhone 17", runtime: "iOS 26.5" } });
  const f = fakeDeps(home, simctlFake);
  let exited = false;
  const h = await startMirror(makeCtx("t-idle", wt, f.deps), "ios", { idleExitMs: 120, onExit: () => { exited = true; } });
  await new Promise((res) => setTimeout(res, 400));
  assert.ok(exited, "ocioso → sai (o app não fica com processo pendurado)");
  h.close();
  // info: projeto Expo → iOS + Android
  writeFileSync(join(wt, "package.json"), JSON.stringify({ dependencies: { expo: "1" } }));
  const RT = JSON.stringify({ runtimes: [{ identifier: "rt.26", name: "iOS 26.5", version: "26.5", isAvailable: true, platform: "iOS", supportedDeviceTypes: [{ identifier: "dt.17", name: "iPhone 17", productFamily: "iPhone" }, { identifier: "dt.17p", name: "iPhone 17 Pro", productFamily: "iPhone" }] }] });
  const g = fakeDeps(home, (cmd, args) => {
    if (cmd === "xcrun" && args.includes("runtimes")) return { stdout: RT };
    if (cmd === "xcrun" && args.includes("devices")) return { stdout: JSON.stringify({ devices: { "rt.26": [{ udid: "U1", name: "Starfork-y", state: "Booted" }] } }) };
  });
  const info = await deviceInfo(makeCtx("t-idle", wt, g.deps));
  assert.equal(info.mobile, true); assert.equal(info.label, "Expo"); assert.deepEqual(info.platforms, ["ios", "android"]);
  assert.equal(info.ios?.up, true); assert.equal(info.ios?.deviceType, "dt.17", "aparelho atual achado pelo nome");
  assert.deepEqual(info.ios?.options.map((o) => o.label), ["iPhone 17 · iOS 26.5", "iPhone 17 Pro · iOS 26.5"]);
  assert.equal(info.ios?.touch, false, "sem AXe nesta casa falsa → só visualização");
  assert.match(String(info.ios?.touchFix), /brew install cameroncooke\/axe\/axe/);
  assert.equal(info.android?.up, false);
  const web = tmp("web"); writeFileSync(join(web, "package.json"), JSON.stringify({ dependencies: { vite: "5" } }));
  const wi = await deviceInfo(makeCtx("t-web", web, g.deps));
  assert.equal(wi.mobile, false); assert.deepEqual(wi.platforms, [], "projeto web: o painel nem aparece");
});

test("CLI `mirror` com o aparelho desligado responde o erro humano (o Rust mostra no painel); print da PESSOA não segura a trava do Android", async () => {
  const home = tmp("home"), wt = tmp("wt");
  const out: string[] = [];
  const f = fakeDeps(home);
  assert.equal(await mobileCli({ _: ["mobile", "mirror"], flags: { platform: "ios", task: "t-off", wt } }, f.deps, (s) => out.push(s)), 1);
  assert.match(out.join("\n"), /simulador iOS desta tarefa está desligado[\s\S]*ligue no botão de energia do painel/);
  // print pelo painel (viewer) no Android: confere a trava e NÃO a cria (antes um print prendia o emulador 30 min)
  setupTask(home, "t-p", { wt, android: { serial: "emulator-5554" } });
  const pt = join(home, "Library", "Android", "sdk", "platform-tools"); mkdirSync(pt, { recursive: true }); writeFileSync(join(pt, "adb"), ""); chmodSync(join(pt, "adb"), 0o755);
  const { mobileShot } = await import("./mobile.ts");
  const file = await mobileShot(makeCtx("t-p", wt, f.deps, () => {}, { viewer: true, waitMs: 0 }), "android");
  assert.match(file, /mobile-android-1\.png$/);
  assert.ok(!readdirSync(join(home, ".constellation", "mobile")).includes("android.lock"), "a pessoa não fica com a trava");
  writeFileSync(join(home, ".constellation", "mobile", "android.lock"), JSON.stringify({ taskId: safeId("t-p"), at: Date.now() }));
  await assert.rejects(mobileShot(makeCtx("t-p", wt, f.deps, () => {}, { viewer: true, waitMs: 0 }), "android"), /em uso pelo agente desta tarefa — só visualização/);
});

test("Android GIRADO: toque vai pelo `adb shell input` em coordenadas lógicas (o console fala na posição natural); arrasto vira swipe", async () => {
  const home = tmp("home"), wt = tmp("wt");
  setupTask(home, "t-rot", { wt, android: { serial: "emulator-5998", avd: "starfork-pixel" } });
  const pt = join(home, "Library", "Android", "sdk", "platform-tools"); mkdirSync(pt, { recursive: true }); writeFileSync(join(pt, "adb"), ""); chmodSync(join(pt, "adb"), 0o755);
  const f = fakeDeps(home, (cmd, args) => {
    if (cmd.endsWith("adb") && args.includes("wm")) return { stdout: "Physical size: 1080x2400\n" };
    if (cmd.endsWith("adb") && args.includes("dumpsys")) return { stdout: "init=1080x2400 420dpi cur=2400x1080 app=2400x1080\n" };
  });
  const h = await startMirror(makeCtx("t-rot", wt, f.deps, () => {}, { viewer: true }), "android");
  const base = `http://127.0.0.1:${h.port}`, q = `?t=${h.token}`;
  try {
    assert.deepEqual((await post(base, `/input${q}`, { t: "tap", x: 0.5, y: 0.25 })).json, { ok: true });
    assert.ok(f.calls.some((c2) => c2.endsWith("-s emulator-5998 shell input tap 1200 270")), f.calls.join("\n"));
    await post(base, `/input${q}`, { t: "down", x: 0.1, y: 0.5 });
    await post(base, `/input${q}`, { t: "move", x: 0.5, y: 0.5 });
    await post(base, `/input${q}`, { t: "up", x: 0.9, y: 0.5 });
    assert.ok(f.calls.some((c2) => / shell input swipe 240 540 2160 540 \d+$/.test(c2)), f.calls.filter((c2) => c2.includes("swipe")).join("\n"));
  } finally { h.close(); }
});

test("sfsim que não compila não é recompilado a cada conexão (marca de falha por 10 min)", async () => {
  const { ensureSfsim } = await import("./device.ts");
  const home = tmp("home");
  const f = fakeDeps(home, (cmd, args) => (cmd === "xcrun" && args[0] === "clang" ? { code: 1, stderr: "sem Xcode" } : undefined));
  assert.equal(await ensureSfsim(f.deps), null);
  assert.equal(await ensureSfsim(f.deps), null);
  assert.equal(f.calls.filter((c2) => c2.startsWith("xcrun clang")).length, 1, "2ª conexão não roda o clang de novo");
  assert.equal(await ensureSfsim({ ...f.deps, platform: "linux" }), null, "fora do macOS: sem helper");
});

test("painel (`--viewer`): ligar o Android que FALHA solta a trava; desligar com agente usando é recusado", async () => {
  const home = tmp("home"), wt = tmp("wt");
  const mob = join(home, ".constellation", "mobile"); mkdirSync(mob, { recursive: true });
  const sdk = join(home, "Library", "Android", "sdk");
  for (const [dir, bin] of [["platform-tools", "adb"], ["emulator", "emulator"]]) { mkdirSync(join(sdk, dir), { recursive: true }); writeFileSync(join(sdk, dir, bin), ""); chmodSync(join(sdk, dir, bin), 0o755); }
  // o emulador do Starfork já está ligado com OUTRO aparelho → `up --avd x` falha DEPOIS de pegar a trava
  writeFileSync(join(mob, "android.json"), JSON.stringify({ pid: 4242, serial: "emulator-5584", avd: "starfork-pixel" }));
  const f = fakeDeps(home);
  f.deps.alive = (pid) => pid === 4242;
  const out: string[] = [];
  assert.equal(await mobileCli({ _: ["mobile", "up"], flags: { platform: "android", avd: "Pixel_9", task: "t-v", wt, viewer: "true" } }, f.deps, (s2) => out.push(s2)), 1);
  assert.match(out.join("\n"), /ligado com outro aparelho/);
  assert.ok(!readdirSync(mob).includes("android.lock"), "falhou → a trava NÃO fica presa (30 min pra todas as tarefas)");
  // desligar pelo painel com um agente segurando a trava → recusa (não arranca o emulador no meio do turno)
  setupTask(home, "t-v", { wt, android: { serial: "emulator-5584" } });
  writeFileSync(join(mob, "android.lock"), JSON.stringify({ taskId: safeId("t-v"), at: Date.now() }));
  out.length = 0;
  assert.equal(await mobileCli({ _: ["mobile", "down"], flags: { platform: "android", task: "t-v", wt, viewer: "true" } }, f.deps, (s2) => out.push(s2)), 1);
  assert.match(out.join("\n"), /em uso pelo agente desta tarefa/);
  assert.ok(readdirSync(mob).includes("android.lock"), "a trava do agente continua");
});

// ------------------------------------------------------------------ REAL (CARDUME_MOBILE_REAL=1): aparelho de verdade
const REAL = { skip: process.env.CARDUME_MOBILE_REAL === "1" ? false : "teste real: rode com CARDUME_MOBILE_REAL=1" };
/** Lê o /stream por `ms` e conta os pedaços por tipo. */
async function readStream(base: string, q: string, ms: number) {
  const ctl = new AbortController(); setTimeout(() => ctl.abort(), ms);
  const n: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 }; let meta = "", bytes = 0;
  try {
    const r = await fetch(`${base}/stream${q}`, { signal: ctl.signal }); const rd = r.body!.getReader(); let buf = Buffer.alloc(0);
    for (;;) { const { value, done } = await rd.read(); if (done) break; buf = Buffer.concat([buf, Buffer.from(value)]);
      while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) { const len = buf.readUInt32BE(1); n[buf[0]]++; bytes += len; if (buf[0] === 0) meta = buf.subarray(5, 5 + len).toString(); buf = buf.subarray(5 + len); } }
  } catch (e) { if ((e as Error).name !== "AbortError") throw e; }
  return { n, meta, bytes };
}
test("REAL Android: emulador sobe, ~3 s de H.264 ao vivo, toque pelo console, print pelo painel, desliga", { ...REAL, timeout: 900_000 }, async (t) => {
  const { realDeps, mobileUp, mobileDown, releaseAndroidLockOf } = await import("./mobile.ts");
  const deps = realDeps(); const wt = tmp("realdev-and");
  const c = makeCtx("real-dev-and-" + process.pid, wt, deps, () => {}, { waitMs: 120_000 });
  try { await mobileUp(c, "android"); } catch (e) { t.skip(`emulador indisponível: ${(e as Error).message}`); await mobileDown(c); return; }
  releaseAndroidLockOf(deps, c.taskId); // painel = pessoa: sem trava
  const h = await startMirror({ ...c, viewer: true, waitMs: 0 }, "android");
  const base = `http://127.0.0.1:${h.port}`, q = `?t=${h.token}`;
  try {
    const s1 = readStream(base, q, 3500);
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual((await post(base, `/input${q}`, { t: "swipe", x: 0.5, y: 0.85, x2: 0.5, y2: 0.3, ms: 300 })).json, { ok: true });
    const s = await s1;
    assert.equal(s.n[0], 1); assert.match(s.meta, /"codec":"h264"/);
    assert.ok(s.n[3] >= 1, "quadro-chave chegou"); assert.ok(s.n[2] + s.n[3] >= 2, `quadros: ${JSON.stringify(s.n)}`);
    assert.deepEqual((await post(base, `/input${q}`, { t: "button", name: "home" })).json, { ok: true });
    const shot = await post(base, `/action${q}`, { name: "shot" });
    assert.match(String(shot.json.file), /^mobile-android-\d+\.png$/);
    process.stdout.write(`# REAL Android: ${JSON.stringify(s.n)} em 3,5 s · ${(s.bytes / 1024).toFixed(0)} KB\n`);
  } finally { h.close(); await mobileDown(c); }
});
test("REAL iOS: simulador da tarefa, ~3 s de quadros do framebuffer (sfsim), toque pelo AXe, print, apaga", { ...REAL, timeout: 600_000 }, async (t) => {
  if (process.platform !== "darwin") return;
  const { realDeps, mobileUp, mobileDown, axeBin } = await import("./mobile.ts");
  const deps = realDeps(); const wt = tmp("realdev-ios");
  const c = makeCtx("real-dev-ios-" + process.pid, wt, deps);
  try { await mobileUp(c, "ios"); } catch (e) { t.skip(`simulador indisponível: ${(e as Error).message}`); await mobileDown(c); return; }
  const h = await startMirror({ ...c, viewer: true }, "ios");
  const base = `http://127.0.0.1:${h.port}`, q = `?t=${h.token}`;
  try {
    const touch = !!axeBin(deps);
    // 1º gesto "aquece" o AXe (logo após o boot ele espera a acessibilidade do simulador) — antes de medir
    if (touch) assert.deepEqual((await post(base, `/input${q}`, { t: "swipe", x: 0.8, y: 0.5, x2: 0.2, y2: 0.5, ms: 300 })).json, { ok: true });
    const s1 = readStream(base, q, 3500);
    await new Promise((r) => setTimeout(r, 800));
    if (touch) assert.deepEqual((await post(base, `/input${q}`, { t: "swipe", x: 0.2, y: 0.5, x2: 0.8, y2: 0.5, ms: 300 })).json, { ok: true });
    const s = await s1;
    assert.match(s.meta, /"via":"(framebuffer|screenshot)"/);
    assert.ok(s.n[1] >= (touch ? 3 : 1), `quadros: ${JSON.stringify(s.n)} (com toque, a página deslizando gera vários)`);
    if (axeBin(deps)) assert.deepEqual((await post(base, `/input${q}`, { t: "button", name: "home" })).json, { ok: true });
    const shot = await post(base, `/action${q}`, { name: "shot" });
    assert.match(String(shot.json.file), /^mobile-ios-\d+\.png$/);
    process.stdout.write(`# REAL iOS: ${s.meta} · ${JSON.stringify(s.n)} em 3,5 s · toque ${touch ? "AXe" : "indisponível"}\n`);
  } finally { h.close(); await mobileDown(c); }
});
