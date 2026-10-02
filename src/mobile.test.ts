// Provas mobile (spec-provas-mobile): detecção do projeto por ARQUIVOS, comandos montados com simctl/adb FALSOS
// (o que a ferramenta manda rodar, em que ordem), trava global do emulador Android, nomes dos artefatos, roteiro
// dos três motores — e, com CARDUME_MOBILE_REAL=1, o teste REAL no Simulador iOS (boot, print, vídeo 3 s, down)
// e no emulador Android (se o SDK/AVD existir e houver disco).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  acquireAndroidLock, detectMobileProject, emulatorFatal, findSim, hasMobileState, isMobileProject, loadState, mobileCli, mobileCleanup,
  mobileDown, mobileRec, mobileRule, mobileShot, mobileUp, nextArtifact, parseAdbDevices, pickIphone, realDeps, resolvePlatform, simName,
  type ExecOut, type MobileCtx, type MobileDeps,
} from "./mobile.ts";
import { buildDshPrompt } from "./engine/dsh.ts";
import { evidenceExists } from "./orchestrator.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), "sf-mobile-" + p + "-"));
const put = (root: string, rel: string, body = "") => { const f = join(root, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, body); };

// ------------------------------------------------------------------ detecção
test("detecção por arquivos: Expo, RN bare, iOS nativo, Android nativo, SPM, monorepo e web (não-mobile)", () => {
  const expo = tmp("expo"); put(expo, "package.json", JSON.stringify({ dependencies: { expo: "~54.0.0", "react-native": "0.81.0" } })); put(expo, "app.json", '{"expo":{"name":"x"}}');
  let p = detectMobileProject(expo); assert.ok(p.expo && p.reactNative); assert.equal(p.label, "Expo");
  const expoCfg = tmp("expocfg"); put(expoCfg, "app.config.ts", "export default {}"); assert.ok(detectMobileProject(expoCfg).expo, "app.config.* conta como Expo");
  const rn = tmp("rn"); put(rn, "package.json", JSON.stringify({ dependencies: { "react-native": "0.76.0" } }));
  put(rn, "ios/App.xcworkspace/contents.xcworkspacedata", "<x/>"); put(rn, "android/app/build.gradle", "apply plugin: 'com.android.application'");
  p = detectMobileProject(rn); assert.ok(p.reactNative && !p.expo && p.iosNative && p.androidNative); assert.equal(p.label, "React Native");
  const ios = tmp("ios"); put(ios, "Demo.xcodeproj/project.pbxproj", "//"); p = detectMobileProject(ios); assert.ok(p.iosNative && !p.androidNative); assert.equal(p.label, "iOS nativo");
  const and = tmp("and"); put(and, "settings.gradle.kts", ""); put(and, "app/build.gradle.kts", 'plugins { id("com.android.application") }');
  p = detectMobileProject(and); assert.ok(p.androidNative && !p.iosNative); assert.equal(p.label, "Android nativo");
  const lib = tmp("lib"); put(lib, "build.gradle", "apply plugin: 'com.android.library'"); assert.ok(!isMobileProject(detectMobileProject(lib)), "biblioteca Android não é app");
  const spm = tmp("spm"); put(spm, "Package.swift", "platforms: [.iOS(.v17)]"); assert.ok(detectMobileProject(spm).iosNative);
  const mono = tmp("mono"); put(mono, "package.json", "{}"); put(mono, "apps/mobile/package.json", JSON.stringify({ dependencies: { expo: "1" } }));
  assert.ok(detectMobileProject(mono).expo, "monorepo: apps/mobile");
  const web = tmp("web"); put(web, "package.json", JSON.stringify({ dependencies: { react: "18", vite: "5" } })); put(web, "node_modules/react-native/package.json", "{}");
  put(web, "node_modules/x/Demo.xcodeproj/a", "");
  assert.ok(!isMobileProject(detectMobileProject(web)), "web não é mobile (node_modules não conta)");
});

// ------------------------------------------------------------------ iOS: escolha do iPhone
const RUNTIMES = JSON.stringify({ runtimes: [
  { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2", name: "iOS 18.2", version: "18.2", isAvailable: true, platform: "iOS", supportedDeviceTypes: [{ identifier: "dt.16", name: "iPhone 16", productFamily: "iPhone" }] },
  { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", name: "iOS 26.5", version: "26.5", isAvailable: true, platform: "iOS", supportedDeviceTypes: [
    { identifier: "dt.17pm", name: "iPhone 17 Pro Max", productFamily: "iPhone" }, { identifier: "dt.air", name: "iPhone Air", productFamily: "iPhone" },
    { identifier: "dt.17", name: "iPhone 17", productFamily: "iPhone" }, { identifier: "dt.16e", name: "iPhone 16e", productFamily: "iPhone" },
    { identifier: "dt.ipad", name: "iPad Pro 13-inch (M5)", productFamily: "iPad" }] },
  { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-0", name: "watchOS 26.0", version: "26.0", isAvailable: true, platform: "watchOS", supportedDeviceTypes: [] },
] });
test("iPhone PADRÃO mais novo no runtime iOS mais novo", () => {
  assert.deepEqual(pickIphone(RUNTIMES), { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", runtimeName: "iOS 26.5", deviceType: "dt.17", deviceName: "iPhone 17" });
  assert.equal(pickIphone('{"runtimes":[]}'), null);
  assert.equal(pickIphone("lixo"), null);
  assert.equal(findSim(JSON.stringify({ devices: { r: [{ udid: "U1", name: "Starfork-t1", state: "Booted" }] } }), "Starfork-t1")?.udid, "U1");
  assert.equal(simName("t/1 x"), "Starfork-t_1_x");
});

// ------------------------------------------------------------------ deps falsos
interface Fake { deps: MobileDeps; calls: string[]; bg: Array<{ cmd: string; args: string[]; pid: number }>; signals: Array<[number, string]>; alive: Set<number>; t: { now: number } }
function fakeDeps(home: string, respond: (cmd: string, args: string[]) => Partial<ExecOut> | void = () => {}): Fake {
  const calls: string[] = [], bg: Fake["bg"] = [], signals: Fake["signals"] = [], alive = new Set<number>();
  const t = { now: 1_000_000 };
  let nextPid = 4000;
  const deps: MobileDeps = {
    exec: async (cmd, args) => {
      calls.push([cmd.split("/").pop(), ...args].join(" "));
      const r = respond(cmd, args) ?? {};
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    spawnBg: (cmd, args) => { const pid = nextPid++; bg.push({ cmd: cmd.split("/").pop()!, args, pid }); alive.add(pid); return pid; },
    alive: (pid) => alive.has(pid),
    signal: (pid, sig) => { signals.push([pid, sig]); alive.delete(pid); },
    sleep: async (ms) => { t.now += ms; },
    now: () => t.now,
    home, env: { PATH: "/usr/bin" }, platform: "darwin",
  };
  return { deps, calls, bg, signals, alive, t };
}
const ctxOf = (f: Fake, taskId: string, wt: string, log: string[] = []): MobileCtx => ({ taskId, artDir: join(wt, ".cardume", "artifacts"), cwd: wt, deps: f.deps, log: (s) => log.push(s) });

/** simctl falso: lista sem o simulador da tarefa → create devolve udid; screenshot/recordVideo escrevem o arquivo. */
function simctl(state: { created?: string }) {
  return (cmd: string, args: string[]): Partial<ExecOut> | void => {
    if (cmd !== "xcrun") return;
    const [, sub, ...rest] = args;
    if (sub === "list" && rest.includes("devices")) return { stdout: JSON.stringify({ devices: { r: [{ udid: "PESSOA", name: "iPhone 17", state: "Booted" }, ...(state.created ? [{ udid: state.created, name: "Starfork-t1", state: "Shutdown" }] : [])] } }) };
    if (sub === "list" && rest.includes("runtimes")) return { stdout: RUNTIMES };
    if (sub === "create") { state.created = "UDID-T1"; return { stdout: "UDID-T1\n" }; }
    if (sub === "io" && rest[1] === "screenshot") { writeFileSync(rest[rest.length - 1], "PNGDATA"); return {}; }
  };
}

test("iOS: up cria o simulador DA TAREFA do iPhone padrão, liga e espera o boot; shot/rec/down com os comandos certos", async () => {
  const home = tmp("home"), wt = tmp("wt"); const st: { created?: string } = {};
  const f = fakeDeps(home, simctl(st)); const log: string[] = []; const c = ctxOf(f, "t1", wt, log);
  await mobileUp(c, "ios");
  assert.deepEqual(f.calls, [
    "xcrun simctl list -j devices", "xcrun simctl list -j runtimes",
    "xcrun simctl create Starfork-t1 dt.17 com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    "xcrun simctl boot UDID-T1", "xcrun simctl bootstatus UDID-T1 -b",
  ]);
  assert.match(log.join("\n"), /Starfork-t1 \(iPhone 17 · iOS 26\.5\) · udid UDID-T1/);
  assert.match(log.join("\n"), /-destination id=UDID-T1/);
  assert.equal(loadState(f.deps, "t1").ios?.udid, "UDID-T1");
  assert.ok(hasMobileState("t1", f.deps));

  // up de novo: reaproveita o mesmo simulador (não cria outro)
  f.calls.length = 0; await mobileUp(c, "ios");
  assert.ok(!f.calls.some((x) => x.includes("create")), f.calls.join("\n"));

  const shot = await mobileShot(c, "ios", "Tela de Login");
  assert.equal(shot, join(wt, ".cardume", "artifacts", "mobile-ios-1-tela-de-login.png"));
  assert.ok(f.calls.includes(`xcrun simctl io UDID-T1 screenshot --type=png ${shot}`));
  assert.equal(await mobileShot(c, "ios"), join(wt, ".cardume", "artifacts", "mobile-ios-2.png"));

  const vid = await mobileRec(c, "ios", "start");
  assert.equal(vid, join(wt, ".cardume", "artifacts", "mobile-ios-1.mp4"));
  assert.deepEqual(f.bg[0], { cmd: "xcrun", args: ["simctl", "io", "UDID-T1", "recordVideo", "--codec=h264", "--force", vid], pid: f.bg[0].pid });
  await assert.rejects(mobileRec(c, "ios", "start"), /já está gravando/);
  writeFileSync(vid, "MP4");
  await mobileRec(c, "ios", "stop");
  assert.deepEqual(f.signals[0], [f.bg[0].pid, "SIGINT"], "SIGINT fecha o mp4");
  assert.equal(loadState(f.deps, "t1").rec, undefined);

  f.calls.length = 0;
  await mobileDown(c);
  assert.deepEqual(f.calls, ["xcrun simctl shutdown UDID-T1", "xcrun simctl delete UDID-T1"], "só o simulador DA TAREFA; o da pessoa (PESSOA) nunca");
  assert.ok(!hasMobileState("t1", f.deps), "estado limpo");
});

test("iOS: sem Xcode → erro humano com a correção; shot sem up → diz pra subir antes", async () => {
  const home = tmp("home"), wt = tmp("wt");
  const f = fakeDeps(home, (cmd) => (cmd === "xcrun" ? { code: 72, stderr: "xcrun: error: unable to find utility \"simctl\"" } : undefined));
  const out: string[] = [];
  const code = await mobileCli({ _: ["mobile", "up"], flags: { platform: "ios", task: "t9", wt } }, f.deps, (s) => out.push(s));
  assert.equal(code, 1);
  assert.match(out.join("\n"), /✕ O Simulador iOS não respondeu/);
  assert.match(out.join("\n"), /como resolver: instale o Xcode pela App Store/);
  out.length = 0;
  assert.equal(await mobileCli({ _: ["mobile", "shot"], flags: { task: "t9", wt } }, f.deps, (s) => out.push(s)), 1);
  assert.match(out.join("\n"), /nenhum simulador\/emulador de pé[\s\S]*mobile up --platform ios/);
  const linux = fakeDeps(home); linux.deps.platform = "linux";
  await assert.rejects(mobileUp(ctxOf(linux, "t9", wt), "ios"), /só existe no macOS/);
});

test("plataforma: --platform manda; sem flag usa a única de pé; com as duas exige a flag", () => {
  assert.equal(resolvePlatform({ taskId: "t", ios: { udid: "u", name: "n", device: "d", runtime: "r" } }), "ios");
  assert.equal(resolvePlatform({ taskId: "t", android: { serial: "emulator-5584" } }), "android");
  assert.throws(() => resolvePlatform({ taskId: "t", ios: { udid: "u", name: "n", device: "d", runtime: "r" }, android: { serial: "e" } }), (e: Error & { fix?: string }) => /diga qual/.test(e.message) && /--platform ios ou --platform android/.test(e.fix ?? ""));
  assert.throws(() => resolvePlatform({ taskId: "t" }, "web"), /plataforma desconhecida/);
});

test("nomes dos artefatos: mobile-<plat>-<n>[-nome].<ext>, numeração por plataforma e extensão", () => {
  const d = tmp("art");
  assert.equal(nextArtifact(d, "ios", "png"), join(d, "mobile-ios-1.png"));
  writeFileSync(join(d, "mobile-ios-1.png"), "x"); writeFileSync(join(d, "mobile-ios-7-login.png"), "x"); writeFileSync(join(d, "mobile-android-3.png"), "x");
  assert.equal(nextArtifact(d, "ios", "png", "Carrinho Vazio!"), join(d, "mobile-ios-8-carrinho-vazio.png"));
  assert.equal(nextArtifact(d, "ios", "mp4"), join(d, "mobile-ios-1.mp4"));
  assert.equal(nextArtifact(d, "android", "png"), join(d, "mobile-android-4.png"));
});

// ------------------------------------------------------------------ Android
function androidHome(): string {
  const home = tmp("ahome");
  put(home, "Library/Android/sdk/platform-tools/adb", ""); put(home, "Library/Android/sdk/emulator/emulator", "");
  return home;
}
/** adb/emulator falsos: `devices` lista o que está em `running`; boot_completed = 1. */
function adbFake(running: string[], log: string[] = []) {
  return (cmd: string, args: string[]): Partial<ExecOut> | void => {
    const b = cmd.split("/").pop();
    if (b === "emulator" && args[0] === "-list-avds") return { stdout: "Pixel_8\nstarfork-pixel\n" };
    if (b !== "adb") return;
    log.push(args.join(" "));
    if (args[0] === "devices") return { stdout: "List of devices attached\n" + running.map((s) => `${s}\tdevice`).join("\n") + "\n" };
    if (args.includes("getprop")) return { stdout: "1\n" };
    if (args.includes("pull")) { writeFileSync(args[args.length - 1], "DATA"); return {}; }
  };
}

test("Android: sobe o AVD starfork-pixel headless, trava global; a 2ª tarefa espera e estoura com erro humano", async () => {
  const home = androidHome(), wt = tmp("wt");
  const running: string[] = [];
  const f = fakeDeps(home, adbFake(running));
  const c1 = ctxOf(f, "tA", wt);
  await mobileUp(c1, "android");
  assert.equal(f.bg.length, 1);
  assert.equal(f.bg[0].cmd, "emulator");
  assert.deepEqual(f.bg[0].args, ["-avd", "starfork-pixel", "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save", "-port", "5584"]);
  assert.equal(loadState(f.deps, "tA").android?.serial, "emulator-5584");
  assert.equal(JSON.parse(readFileSync(join(home, ".constellation/mobile/android.lock"), "utf8")).taskId, "tA");
  running.push("emulator-5584");

  // 2ª tarefa: espera a trava; prazo 6 s (relógio falso) → erro humano
  f.deps.env.CARDUME_MOBILE_LOCK_WAIT_S = "6";
  const out: string[] = [];
  const code = await mobileCli({ _: ["mobile", "up"], flags: { platform: "android", task: "tB", wt } }, f.deps, (s) => out.push(s));
  assert.equal(code, 1);
  assert.match(out.join("\n"), /aguardando a vez/);
  assert.match(out.join("\n"), /✕ O emulador Android está em uso pela tarefa tA[\s\S]*como resolver: espere a outra tarefa terminar/);
  assert.ok(!existsSync(join(home, ".constellation/mobile/android-wait/tB")), "desistiu → sai da fila");

  // a 1ª termina: com alguém esperando há pouco, o emulador fica ligado pra ele
  put(home, ".constellation/mobile/android-wait/tC", String(f.t.now));
  utimesSync(join(home, ".constellation/mobile/android-wait/tC"), new Date(), new Date());
  f.t.now = Date.now();
  await mobileDown(c1);
  assert.ok(!existsSync(join(home, ".constellation/mobile/android.lock")), "trava solta");
  assert.ok(f.alive.has(f.bg[0].pid), "não desliga com tarefa esperando");

  // a 2ª agora consegue: reaproveita o MESMO emulador (não sobe outro)
  delete f.deps.env.CARDUME_MOBILE_LOCK_WAIT_S;
  const cB = ctxOf(f, "tB", wt);
  await mobileUp(cB, "android");
  assert.equal(f.bg.length, 1, "não sobe um 2º emulador");
  // ninguém esperando (o aviso da tC envelheceu) → o down da última desliga o que o Starfork subiu
  utimesSync(join(home, ".constellation/mobile/android-wait/tC"), new Date(0), new Date(0));
  f.calls.length = 0;
  await mobileDown(cB);
  assert.ok(f.calls.includes("adb -s emulator-5584 emu kill"), f.calls.join("\n"));
  assert.ok(!existsSync(join(home, ".constellation/mobile/android.json")));
});

test("Android: emulador que NÃO foi o Starfork que subiu é usado, mas nunca desligado; trava velha é retomada", async () => {
  const home = androidHome(), wt = tmp("wt");
  const f = fakeDeps(home, adbFake(["emulator-5554"]));
  // trava esquecida há 2 h por uma tarefa que morreu
  put(home, ".constellation/mobile/android.lock", JSON.stringify({ taskId: "velha", at: f.t.now - 2 * 3600_000 }));
  const c = ctxOf(f, "tX", wt);
  await mobileUp(c, "android");
  assert.equal(f.bg.length, 0, "não sobe outro — usa o da pessoa");
  assert.equal(loadState(f.deps, "tX").android?.serial, "emulator-5554");
  const shot = await mobileShot(c, "android");
  assert.equal(shot, join(wt, ".cardume/artifacts/mobile-android-1.png"));
  assert.ok(f.calls.includes("adb -s emulator-5554 shell screencap -p /sdcard/starfork-shot.png"));
  // gravação: screenrecord com teto de 180 s, depois pull do mp4
  const vid = await mobileRec(c, "android", "start");
  assert.deepEqual(f.bg[0].args, ["-s", "emulator-5554", "shell", "screenrecord", "--time-limit", "180", "/sdcard/starfork-rec-tX.mp4"]);
  await mobileRec(c, "android", "stop");
  assert.ok(f.calls.includes("adb -s emulator-5554 shell pkill -INT screenrecord"));
  assert.ok(f.calls.includes(`adb -s emulator-5554 pull /sdcard/starfork-rec-tX.mp4 ${vid}`));
  f.calls.length = 0;
  const done = await mobileDown(c);
  assert.ok(!f.calls.some((x) => /emu kill/.test(x)), "NUNCA desliga emulador alheio");
  assert.match(done.join(" "), /não foi o Starfork que subiu/);
});

test("Android: sem SDK → erro humano com a correção; AVD faltando → comando do avdmanager; motivo da queda vem do log", async () => {
  const wt = tmp("wt");
  const f = fakeDeps(tmp("nohome"));
  await assert.rejects(mobileUp(ctxOf(f, "t", wt), "android"), (e: Error & { fix?: string }) => /Android SDK/.test(e.message) && /Android Studio/.test(e.fix ?? ""));
  const home = androidHome();
  const g = fakeDeps(home, (cmd, args) => (cmd.endsWith("emulator") ? { stdout: "Pixel_8\n" } : adbFake([])(cmd, args)));
  await assert.rejects(mobileUp(ctxOf(g, "t", wt), "android"), (e: Error & { fix?: string }) => /starfork-pixel/.test(e.message) && /avdmanager create avd -n starfork-pixel/.test(e.fix ?? ""));
  assert.ok(!existsSync(join(home, ".constellation/mobile/android.lock")), "falhou → solta a trava");
  assert.equal(emulatorFatal("INFO | a\nFATAL        | Not enough space to create userdata partition.\nINFO | b"), "Not enough space to create userdata partition.");
  assert.equal(parseAdbDevices("List of devices attached\nemulator-5554\tdevice\nR58M\toffline\n\n").length, 2);
});

test("trava: a mesma tarefa pega de novo sem esperar", async () => {
  const home = tmp("lk"); const f = fakeDeps(home);
  const c = ctxOf(f, "t1", tmp("wt"));
  await acquireAndroidLock(c); await acquireAndroidLock(c);
  assert.equal(JSON.parse(readFileSync(join(home, ".constellation/mobile/android.lock"), "utf8")).taskId, "t1");
});

test("fim do turno: mobileCleanup apaga o simulador da tarefa; sem estado não roda nada", async () => {
  const home = tmp("home"), wt = tmp("wt"); const st: { created?: string } = {};
  const f = fakeDeps(home, simctl(st));
  await mobileCleanup("t1", wt, f.deps);
  assert.equal(f.calls.length, 0, "sem estado: instantâneo");
  await mobileUp(ctxOf(f, "t1", wt), "ios");
  f.calls.length = 0;
  await mobileCleanup("t1", wt, f.deps);
  assert.deepEqual(f.calls, ["xcrun simctl shutdown UDID-T1", "xcrun simctl delete UDID-T1"]);
});

test("Maestro ausente → orienta instalar e seguir com prints", async () => {
  const out: string[] = [];
  const f = fakeDeps(tmp("h"));
  const wt = tmp("wt");
  assert.equal(await mobileCli({ _: ["mobile", "flow", "f.yaml"], flags: { task: "t", wt, platform: "ios" } }, f.deps, (s) => out.push(s)), 1);
  assert.match(out.join("\n"), /Maestro não está instalado[\s\S]*shot[\s\S]*get\.maestro\.mobile\.dev/);
});

// ------------------------------------------------------------------ roteiro dos motores
test("roteiro: só em projeto mobile e fora do planner; mesmo texto chega ao DeepSeek; Claude e Codex usam o mesmo mobileRule", () => {
  const web = tmp("web"); put(web, "package.json", JSON.stringify({ dependencies: { react: "18" } }));
  assert.equal(mobileRule({ cwd: web, role: "builder", spec: { id: "t1" } }), "");
  const expo = tmp("expo"); put(expo, "package.json", JSON.stringify({ dependencies: { expo: "1", "react-native": "1" } }));
  const r = mobileRule({ cwd: expo, role: "builder", spec: { id: "t1" } });
  assert.match(r, /PROVAS MOBILE \(este projeto é Expo\)/);
  assert.match(r, new RegExp(`mobile --task t1 --wt "${expo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  for (const k of [/up --platform ios/, /npx expo start/, /Expo Go, SEM CocoaPods/, /M shot/, /1 print por requisito visual/, /1 vídeo do fluxo principal/, /requirements\.json/, /NUNCA descreva a tela lendo o código/, /M flow/]) assert.match(r, k);
  assert.equal(mobileRule({ cwd: expo, role: "planner", spec: { id: "t1" } }), "", "planner não prova");
  const ios = tmp("ios"); put(ios, "App.xcodeproj/x", "");
  assert.match(mobileRule({ cwd: ios, role: "builder", spec: { id: "t1" } }), /xcodebuild -scheme <Scheme> -destination id=<udid do up>/);
  const and = tmp("and"); put(and, "app/build.gradle", "com.android.application");
  assert.match(mobileRule({ cwd: and, role: "tester", spec: { id: "t1" } }), /\.\/gradlew assembleDebug`, depois `M install app\/build\/outputs\/apk\/debug\/app-debug\.apk/);
  const p = buildDshPrompt({ cwd: expo, spec: { id: "t1", requirements: ["R1"] } as never, role: "builder", agentName: "a", dbFile: "", systemContext: "" });
  assert.match(p, /PROVAS MOBILE/);
  for (const f of ["engine/claude.ts", "engine/codex.ts"]) {
    const src = readFileSync(new URL("./" + f, import.meta.url), "utf8");
    assert.match(src, /mobileRule\(\{ cwd: input\.cwd, role: input\.role, spec: input\.spec \}\)/, f);
  }
  const orch = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  assert.equal(orch.match(/await this\.mobileTurnEnd\(taskId\)/g)?.length, 3, "down no fim de todo turno (pipeline, conversa/entregável e fila)");
});

test("gate da entrega: print/vídeo mobile citado como evidência conta como prova real (qualquer jeito de citar)", () => {
  const wt = tmp("gate"); const art = join(wt, ".cardume", "artifacts");
  put(art, "mobile-ios-1.mp4", "MP4"); put(art, "mobile-android-2-login.png", "PNG"); put(wt, "tests/login.test.ts", "x");
  for (const e of ["mobile-ios-1.mp4", "./mobile-ios-1.mp4", ".cardume/artifacts/mobile-ios-1.mp4", "./.cardume/artifacts/mobile-android-2-login.png", "tests/login.test.ts"]) {
    assert.ok(evidenceExists(art, wt, e), e);
  }
  assert.ok(!evidenceExists(art, wt, "mobile-ios-9.png"));
  assert.ok(!evidenceExists(art, wt, ""));
});

// ------------------------------------------------------------------ REAL (opt-in)
const REAL = { skip: process.env.CARDUME_MOBILE_REAL === "1" ? false : "teste real: rode com CARDUME_MOBILE_REAL=1" };
test("REAL iOS: simulador da tarefa liga, print PNG e vídeo de 3 s reais, down apaga", { ...REAL, timeout: 600_000 }, async () => {
  if (process.platform !== "darwin") return;
  const wt = tmp("realios"); put(wt, "package.json", JSON.stringify({ dependencies: { expo: "1" } }));
  const deps = realDeps(); const log: string[] = [];
  const c: MobileCtx = { taskId: "real-" + process.pid, artDir: join(wt, ".cardume", "artifacts"), cwd: wt, deps, log: (s) => log.push(s) };
  try {
    await mobileUp(c, "ios");
    const png = await mobileShot(c, "ios");
    await mobileRec(c, "ios", "start");
    await deps.sleep(3000);
    const mp4 = await mobileRec(c, "ios", "stop");
    assert.match(execFileSync("file", [png], { encoding: "utf8" }), /PNG image data/);
    assert.match(execFileSync("file", [mp4], { encoding: "utf8" }), /ISO Media/);
    assert.ok(statSync(mp4).size > 1000);
  } finally {
    await mobileDown(c);
  }
  assert.ok(!execFileSync("xcrun", ["simctl", "list", "devices"], { encoding: "utf8" }).includes(simName(c.taskId)), "simulador apagado");
});
test("REAL Android: emulador sobe, print e vídeo reais, down desliga (se o SDK/AVD existir)", { ...REAL, timeout: 900_000 }, async (t) => {
  const deps = realDeps();
  const wt = tmp("realand");
  const c: MobileCtx = { taskId: "real-and-" + process.pid, artDir: join(wt, ".cardume", "artifacts"), cwd: wt, deps, log: () => {} };
  try {
    await mobileUp(c, "android");
  } catch (e) {
    t.skip(`emulador indisponível nesta máquina: ${(e as Error).message}`);
    await mobileDown(c);
    return;
  }
  try {
    const png = await mobileShot(c, "android");
    await mobileRec(c, "android", "start");
    await deps.sleep(3000);
    const mp4 = await mobileRec(c, "android", "stop");
    assert.match(execFileSync("file", [png], { encoding: "utf8" }), /PNG image data/);
    assert.match(execFileSync("file", [mp4], { encoding: "utf8" }), /ISO Media/);
  } finally {
    await mobileDown(c);
  }
  assert.ok(readdirSync(join(wt, ".cardume", "artifacts")).length >= 2);
});
