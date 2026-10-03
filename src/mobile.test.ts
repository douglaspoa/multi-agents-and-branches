// Provas mobile (spec-provas-mobile): detecção do projeto por ARQUIVOS, comandos montados com simctl/adb FALSOS
// (o que a ferramenta manda rodar, em que ordem), trava global do emulador Android, gravação segura, varredura,
// gate da entrega, roteiro dos três motores, ciclo de vida no orquestrador — e, com CARDUME_MOBILE_REAL=1, o teste
// REAL no Simulador iOS e no emulador Android (boot, print, vídeo 3 s, down).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireAndroidLock, avdFix, detectMobileProject, emulatorFatal, exitCodeOf, findSim, hasMobileState, isMobileProject, loadState, makeCtx,
  mobileCleanup, mobileCli, mobileCmd, mobileDown, mobileProofGaps, mobileRec, mobileRule, mobileShot, mobileSweep, mobileTurnRelease, mobileUp,
  nextArtifact, parseAdbDevices, pickIphone, realDeps, resolvePlatform, safeId, shq, simName,
  type ExecOut, type MobileCtx, type MobileDeps,
} from "./mobile.ts";
import { buildDshPrompt } from "./engine/dsh.ts";
import { evidenceExists, Orchestrator } from "./orchestrator.ts";

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), "sf-mobile-" + p + "-"))); made.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer = "") => { const f = join(root, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, body); };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// ------------------------------------------------------------------ detecção
test("detecção por arquivos: Expo, RN bare, Flutter, Capacitor, iOS/Android nativo, SPM só com app, monorepo e web", () => {
  const expo = tmp("expo"); put(expo, "package.json", JSON.stringify({ dependencies: { expo: "~54.0.0", "react-native": "0.81.0" } })); put(expo, "app.json", '{"expo":{"name":"x"}}');
  let p = detectMobileProject(expo); assert.ok(p.expo && p.reactNative); assert.equal(p.label, "Expo");
  const expoCfg = tmp("expocfg"); put(expoCfg, "app.config.ts", "export default {}"); assert.ok(detectMobileProject(expoCfg).expo, "app.config.* conta como Expo");
  const rn = tmp("rn"); put(rn, "package.json", JSON.stringify({ dependencies: { "react-native": "0.76.0" } }));
  put(rn, "ios/App.xcworkspace/contents.xcworkspacedata", "<x/>"); put(rn, "android/app/build.gradle", "apply plugin: 'com.android.application'");
  p = detectMobileProject(rn); assert.ok(p.reactNative && !p.expo && p.iosNative && p.androidNative); assert.equal(p.label, "React Native");
  const fl = tmp("flutter"); put(fl, "pubspec.yaml", "name: x\ndependencies:\n  flutter:\n    sdk: flutter\n"); assert.equal(detectMobileProject(fl).label, "Flutter");
  const cap = tmp("cap"); put(cap, "capacitor.config.ts", "export default {}"); assert.equal(detectMobileProject(cap).label, "Capacitor");
  const dart = tmp("dart"); put(dart, "pubspec.yaml", "name: lib\ndependencies:\n  http: ^1.0.0\n"); assert.ok(!isMobileProject(detectMobileProject(dart)), "pacote Dart sem flutter não é app");
  const ios = tmp("ios"); put(ios, "Demo.xcodeproj/project.pbxproj", "//"); p = detectMobileProject(ios); assert.ok(p.iosNative && !p.androidNative); assert.equal(p.label, "iOS nativo");
  const and = tmp("and"); put(and, "settings.gradle.kts", ""); put(and, "app/build.gradle.kts", 'plugins { id("com.android.application") }');
  p = detectMobileProject(and); assert.ok(p.androidNative && !p.iosNative); assert.equal(p.label, "Android nativo");
  const lib = tmp("lib"); put(lib, "build.gradle", "apply plugin: 'com.android.library'"); assert.ok(!isMobileProject(detectMobileProject(lib)), "biblioteca Android não é app");
  const spmLib = tmp("spmlib"); put(spmLib, "Package.swift", "platforms: [.iOS(.v17)], products: [.library(name: \"X\")]");
  assert.ok(!detectMobileProject(spmLib).iosNative, "pacote Swift de biblioteca (mesmo com .iOS) não é app — igual à lib Android");
  const spmApp = tmp("spmapp"); put(spmApp, "Package.swift", "import AppleProductTypes\nproducts: [.iOSApplication(name: \"App\")]"); assert.ok(detectMobileProject(spmApp).iosNative);
  const mono = tmp("mono"); put(mono, "package.json", "{}"); put(mono, "apps/mobile/package.json", JSON.stringify({ dependencies: { expo: "1" } }));
  assert.ok(detectMobileProject(mono).expo, "monorepo: apps/mobile");
  const web = tmp("web"); put(web, "package.json", JSON.stringify({ dependencies: { react: "18", vite: "5" } })); put(web, "node_modules/react-native/package.json", "{}");
  put(web, "node_modules/x/Demo.xcodeproj/a", "");
  assert.ok(!isMobileProject(detectMobileProject(web)), "web não é mobile (node_modules não conta)");
});

// ------------------------------------------------------------------ iOS: escolha do iPhone, ids
const RUNTIMES = JSON.stringify({ runtimes: [
  { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2", name: "iOS 18.2", version: "18.2", isAvailable: true, platform: "iOS", supportedDeviceTypes: [{ identifier: "dt.16", name: "iPhone 16", productFamily: "iPhone" }] },
  { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", name: "iOS 26.5", version: "26.5", isAvailable: true, platform: "iOS", supportedDeviceTypes: [
    { identifier: "dt.17pm", name: "iPhone 17 Pro Max", productFamily: "iPhone" }, { identifier: "dt.air", name: "iPhone Air", productFamily: "iPhone" },
    { identifier: "dt.17", name: "iPhone 17", productFamily: "iPhone" }, { identifier: "dt.16e", name: "iPhone 16e", productFamily: "iPhone" },
    { identifier: "dt.ipad", name: "iPad Pro 13-inch (M5)", productFamily: "iPad" }] },
  { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-0", name: "watchOS 26.0", version: "26.0", isAvailable: true, platform: "watchOS", supportedDeviceTypes: [] },
] });
test("iPhone PADRÃO mais novo; ids seguros sem colisão", () => {
  assert.deepEqual(pickIphone(RUNTIMES), { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", runtimeName: "iOS 26.5", deviceType: "dt.17", deviceName: "iPhone 17" });
  assert.equal(pickIphone('{"runtimes":[]}'), null);
  assert.equal(pickIphone("lixo"), null);
  assert.equal(findSim(JSON.stringify({ devices: { r: [{ udid: "U1", name: "Starfork-t1", state: "Booted" }] } }), "Starfork-t1")?.udid, "U1");
  assert.notEqual(safeId("a/b"), safeId("a_b"), "ids que limpariam igual NÃO colidem (hash do id real)");
  assert.match(safeId("t/1 x"), /^t_1_x-[0-9a-f]{6}$/);
  assert.equal(safeId("t1"), safeId("t1"), "estável");
  assert.equal(simName(safeId("t1")), "Starfork-" + safeId("t1"));
});

// ------------------------------------------------------------------ deps falsos
interface Fake { deps: MobileDeps; calls: string[]; bg: Array<{ cmd: string; args: string[]; pid: number }>; signals: Array<[number, string]>; alive: Set<number>; t: { now: number }; sigs: Map<number, string> }
function fakeDeps(home: string, respond: (cmd: string, args: string[]) => Partial<ExecOut> | void = () => {}): Fake {
  const calls: string[] = [], bg: Fake["bg"] = [], signals: Fake["signals"] = [], alive = new Set<number>(), sigs = new Map<number, string>();
  const t = { now: 1_000_000 };
  let nextPid = 4000;
  const deps: MobileDeps = {
    exec: async (cmd, args) => {
      const b = cmd.split("/").pop()!;
      if (b === "ps") return { code: alive.has(Number(args[3])) ? 0 : 1, stdout: sigs.get(Number(args[3])) ?? "", stderr: "" };
      calls.push([b, ...args].join(" "));
      const r = respond(cmd, args) ?? {};
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    execToFile: async (cmd, args, file) => {
      calls.push([cmd.split("/").pop(), ...args, ">", file].join(" "));
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, PNG);
      return { code: 0, stdout: "", stderr: "" };
    },
    spawnBg: (cmd, args, opts = {}) => {
      const pid = nextPid++;
      bg.push({ cmd: cmd.split("/").pop()!, args, pid }); alive.add(pid); sigs.set(pid, "start-" + pid);
      if (opts.logFile && args.some((a) => a.includes("screenrecord"))) writeFileSync(opts.logFile, "STARFORK_PID=777\n");
      return pid;
    },
    alive: (pid) => alive.has(pid),
    signal: (pid, sig) => { signals.push([pid, sig]); alive.delete(pid); },
    sleep: async (ms) => { t.now += ms; },
    now: () => t.now,
    home, env: { PATH: "/usr/bin" }, platform: "darwin", arch: "arm64",
  };
  return { deps, calls, bg, signals, alive, t, sigs };
}
const ctxOf = (f: Fake, rawId: string, wt: string, log: string[] = [], extra: Partial<MobileCtx> = {}): MobileCtx => makeCtx(rawId, wt, f.deps, (s) => log.push(s), extra);
const recFiles = (wt: string) => { try { return readdirSync(join(wt, ".cardume", "artifacts")); } catch { return []; } };

/** simctl falso: lista sem o simulador da tarefa → create devolve udid; screenshot/recordVideo escrevem o arquivo. */
function simctl(state: { created?: string; name?: string; deleteFails?: boolean }) {
  return (cmd: string, args: string[]): Partial<ExecOut> | void => {
    if (cmd !== "xcrun") return;
    const [, sub, ...rest] = args;
    if (sub === "list" && rest.includes("devices")) return { stdout: JSON.stringify({ devices: { r: [{ udid: "PESSOA", name: "iPhone 17", state: "Booted" }, ...(state.created ? [{ udid: state.created, name: state.name, state: "Shutdown" }] : [])] } }) };
    if (sub === "list" && rest.includes("runtimes")) return { stdout: RUNTIMES };
    if (sub === "create") { state.created = "UDID-T1"; state.name = rest[0]; return { stdout: "UDID-T1\n" }; }
    if (sub === "delete" && state.deleteFails) return { code: 1, stderr: "Unable to delete: busy" };
    if (sub === "io" && rest[1] === "screenshot") { writeFileSync(rest[rest.length - 1], PNG); return {}; }
  };
}
const S1 = safeId("t1");

test("iOS: up cria o simulador DA TAREFA, liga e espera; shot/rec (fora dos artefatos até o stop)/down com os comandos certos", async () => {
  const home = tmp("home"), wt = tmp("wt"); const st: { created?: string; name?: string } = {};
  const f = fakeDeps(home, simctl(st)); const log: string[] = []; const c = ctxOf(f, "t1", wt, log);
  await mobileUp(c, "ios");
  assert.deepEqual(f.calls, [
    "xcrun simctl list -j devices", "xcrun simctl list -j runtimes",
    `xcrun simctl create Starfork-${S1} dt.17 com.apple.CoreSimulator.SimRuntime.iOS-26-5`,
    "xcrun simctl boot UDID-T1", "xcrun simctl bootstatus UDID-T1 -b",
  ]);
  assert.match(log.join("\n"), new RegExp(`Starfork-${S1} \\(iPhone 17 · iOS 26\\.5\\) · udid UDID-T1`));
  assert.equal(loadState(f.deps, S1).ios?.udid, "UDID-T1");
  assert.equal(loadState(f.deps, S1).rawId, "t1");
  assert.ok(hasMobileState("t1", f.deps));

  // up de novo: reaproveita o mesmo simulador (não cria outro)
  f.calls.length = 0; await mobileUp(c, "ios");
  assert.ok(!f.calls.some((x) => x.includes("create")), f.calls.join("\n"));

  const shot = await mobileShot(c, "ios", "Tela de Login");
  assert.equal(shot, join(wt, ".cardume", "artifacts", "mobile-ios-1-tela-de-login.png"));
  assert.ok(f.calls.some((x) => x.startsWith("xcrun simctl io UDID-T1 screenshot --type=png ") && !x.includes(".cardume")), "print vai pra um tmp e só depois entra nos artefatos");
  assert.equal(await mobileShot(c, "ios"), join(wt, ".cardume", "artifacts", "mobile-ios-2.png"));

  const vid = await mobileRec(c, "ios", "start");
  assert.equal(vid, join(wt, ".cardume", "artifacts", "mobile-ios-1.mp4"));
  const rec = loadState(f.deps, S1).rec!;
  assert.deepEqual(f.bg[0].args, ["simctl", "io", "UDID-T1", "recordVideo", "--codec=h264", "--force", rec.tmp]);
  assert.ok(!rec.tmp.includes(".cardume"), "gravação em andamento FORA da pasta de artefatos");
  assert.ok(!recFiles(wt).some((n) => n.endsWith(".mp4")), "não aparece na lista enquanto grava");
  assert.equal(rec.sig, "start-" + rec.pid, "guarda a assinatura do processo");
  await assert.rejects(mobileRec(c, "ios", "start"), /já está gravando/);
  writeFileSync(rec.tmp, "MP4");
  assert.equal(await mobileRec(c, "ios", "stop"), vid);
  assert.deepEqual(f.signals[0], [f.bg[0].pid, "SIGINT"], "SIGINT fecha o mp4");
  assert.ok(existsSync(vid) && !existsSync(rec.tmp), "movido pros artefatos no stop");

  f.calls.length = 0;
  await mobileDown(c);
  assert.deepEqual(f.calls, ["xcrun simctl shutdown UDID-T1", "xcrun simctl delete UDID-T1"], "só o simulador DA TAREFA; o da pessoa (PESSOA) nunca");
  assert.ok(!hasMobileState("t1", f.deps), "estado limpo");
});

test("iOS: estado com udid velho é corrigido pelo que existe; delete que falha MANTÉM o estado", async () => {
  const home = tmp("home"), wt = tmp("wt"); const st = { created: "UDID-NOVO", name: simName(S1), deleteFails: true };
  const f = fakeDeps(home, simctl(st));
  put(home, `.constellation/mobile/tasks/${S1}.json`, JSON.stringify({ taskId: S1, ios: { udid: "UDID-VELHO", name: simName(S1), device: "iPhone 17", runtime: "iOS 26.5" } }));
  const c = ctxOf(f, "t1", wt);
  await mobileUp(c, "ios");
  assert.equal(loadState(f.deps, S1).ios?.udid, "UDID-NOVO");
  const done = await mobileDown(c);
  assert.match(done.join(" "), /não consegui apagar/);
  assert.equal(loadState(f.deps, S1).ios?.udid, "UDID-NOVO", "fica pra próxima limpeza");
});

test("iOS: sem Xcode → erro humano (sem mandar trocar o xcode-select); shot sem up → diz pra subir antes", async () => {
  const home = tmp("home"), wt = tmp("wt");
  const f = fakeDeps(home, (cmd) => (cmd === "xcrun" ? { code: 72, stderr: "xcrun: error: unable to find utility \"simctl\"" } : undefined));
  const out: string[] = [];
  const code = await mobileCli({ _: ["mobile", "up"], flags: { platform: "ios", task: "t9", wt } }, f.deps, (s) => out.push(s));
  assert.equal(code, 1);
  assert.match(out.join("\n"), /✕ O Simulador iOS não respondeu/);
  assert.match(out.join("\n"), /como resolver: instale o Xcode pela App Store/);
  assert.ok(!/sudo xcode-select/.test(out.join("\n")), "nunca manda trocar o xcode-select (esta máquina fica nas CLT)");
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
/** adb/emulator falsos: `devices` lista `running` (serial→estado); boot_completed = 1; /proc do screenrecord. */
function adbFake(running: Record<string, string>, recTask = "") {
  return (cmd: string, args: string[]): Partial<ExecOut> | void => {
    const b = cmd.split("/").pop();
    if (b === "emulator" && args[0] === "-list-avds") return { stdout: "Pixel_8\nstarfork-pixel\n" };
    if (b !== "adb") return;
    if (args[0] === "devices") return { stdout: "List of devices attached\n" + Object.entries(running).map(([s, st]) => `${s}\t${st}`).join("\n") + "\n" };
    if (args.includes("getprop")) return { stdout: "1\n" };
    if (args.includes("cat") && args.some((a) => a.startsWith("/proc/777/"))) return { stdout: "screenrecord\u0000--time-limit\u0000180\u0000" + `/data/local/tmp/starfork-rec-${safeId(recTask)}.mp4` };
    if (args.includes("pull")) { writeFileSync(args[args.length - 1], "MP4DATA"); return {}; }
  };
}

test("Android: sobe o AVD headless; print direto pro arquivo (exec-out, nada em /sdcard); 2ª tarefa recebe 'ocupado' rápido", async () => {
  const home = androidHome(), wt = tmp("wt");
  const running: Record<string, string> = {};
  const f = fakeDeps(home, adbFake(running));
  const c1 = ctxOf(f, "tA", wt);
  await mobileUp(c1, "android");
  assert.equal(f.bg[0].cmd, "emulator");
  assert.deepEqual(f.bg[0].args, ["-avd", "starfork-pixel", "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save", "-port", "5584"]);
  assert.equal(loadState(f.deps, safeId("tA")).android?.serial, "emulator-5584");
  running["emulator-5584"] = "device";

  const shot = await mobileShot(c1, "android");
  assert.equal(shot, join(wt, ".cardume/artifacts/mobile-android-1.png"));
  assert.ok(f.calls.some((x) => /^adb -s emulator-5584 exec-out screencap -p > /.test(x)), f.calls.join("\n"));
  assert.ok(!f.calls.some((x) => x.includes("/sdcard")), "nada em /sdcard");

  // 2ª tarefa: espera curta (aqui --wait 6, relógio falso) e responde "ocupado"
  const out: string[] = [];
  const code = await mobileCli({ _: ["mobile", "up"], flags: { platform: "android", task: "tB", wt, wait: "6" } }, f.deps, (s) => out.push(s));
  assert.equal(code, 1);
  assert.match(out.join("\n"), /aguardando a vez \(até 6 s\)/);
  assert.match(out.join("\n"), new RegExp(`✕ O emulador Android está ocupado pela tarefa ${safeId("tA")} — tente de novo em ~1 min[\\s\\S]*--wait 300`));

  // fim do TURNO da tA: solta a trava (o emulador fica); a tB consegue e reaproveita o MESMO emulador
  assert.equal(mobileTurnRelease("tA", f.deps), true);
  const cB = ctxOf(f, "tB", wt);
  await mobileUp(cB, "android");
  assert.equal(f.bg.length, 1, "não sobe um 2º emulador");
  // a tA volta a usar: precisa da trava de novo → ocupado enquanto a tB tem
  await assert.rejects(mobileShot(ctxOf(f, "tA", wt, [], { waitMs: 0 }), "android"), /ocupado pela tarefa/);

  // fim da TAREFA tB com a tA ainda tendo estado Android → o emulador segue ligado
  f.calls.length = 0;
  let done = await mobileDown(cB);
  assert.match(done.join(" "), /segue ligado/);
  // fim da tA (última) → desliga o que o Starfork subiu
  done = await mobileDown(ctxOf(f, "tA", wt));
  assert.ok(f.calls.includes("adb -s emulator-5584 emu kill"), f.calls.join("\n"));
  assert.ok(!existsSync(join(home, ".constellation/mobile/android.json")));
});

test("Android: emulador da pessoa é usado e nunca desligado; offline não conta; gravação para SÓ o próprio pid", async () => {
  const home = androidHome(), wt = tmp("wt");
  const f = fakeDeps(home, adbFake({ "emulator-5554": "offline", "emulator-5556": "device" }, "tX"));
  const c = ctxOf(f, "tX", wt);
  await mobileUp(c, "android");
  assert.equal(f.bg.length, 0, "não sobe outro — usa o da pessoa");
  assert.equal(loadState(f.deps, c.taskId).android?.serial, "emulator-5556", "o offline não serve");
  const vid = await mobileRec(c, "android", "start");
  const remote = `/data/local/tmp/starfork-rec-${c.taskId}.mp4`;
  assert.deepEqual(f.bg[0].args, ["-s", "emulator-5556", "shell", `echo STARFORK_PID=$$; exec screenrecord --time-limit 180 ${remote}`]);
  assert.equal(loadState(f.deps, c.taskId).rec?.devPid, 777);
  assert.ok(!recFiles(wt).some((n) => n.endsWith(".mp4")), "não aparece nos artefatos enquanto grava");
  f.calls.length = 0;
  assert.equal(await mobileRec(c, "android", "stop"), vid);
  assert.ok(f.calls.includes("adb -s emulator-5556 shell cat /proc/777/cmdline"), "confere quem é o pid antes");
  assert.ok(f.calls.includes("adb -s emulator-5556 shell kill -2 777"));
  assert.ok(!f.calls.some((x) => /pkill/.test(x)), "NUNCA pkill (mataria a gravação de outra tarefa)");
  assert.ok(f.calls.some((x) => x.startsWith(`adb -s emulator-5556 pull ${remote} `)));
  assert.equal(readFileSync(vid, "utf8"), "MP4DATA");
  f.calls.length = 0;
  const done = await mobileDown(c);
  assert.ok(!f.calls.some((x) => /emu kill/.test(x)), "NUNCA desliga emulador alheio");
  assert.match(done.join(" "), /não foi o Starfork que subiu/);
});

test("gravação: a anterior que morreu sem stop é finalizada no próximo start; pid reciclado nunca recebe sinal", async () => {
  const home = tmp("home"), wt = tmp("wt"); const st = {};
  const f = fakeDeps(home, simctl(st));
  const c = ctxOf(f, "t1", wt);
  await mobileUp(c, "ios");
  await mobileRec(c, "ios", "start");
  const r1 = loadState(f.deps, S1).rec!;
  writeFileSync(r1.tmp, "MP4-1");
  f.alive.delete(r1.pid); // morreu sem rec stop (fim do turno, crash)
  const log: string[] = [];
  const c2 = ctxOf(f, "t1", wt, log);
  await mobileRec(c2, "ios", "start");
  assert.match(log.join("\n"), /gravação anterior finalizada: \.cardume\/artifacts\/mobile-ios-1\.mp4/);
  assert.ok(existsSync(join(wt, ".cardume/artifacts/mobile-ios-1.mp4")));
  // o pid da gravação atual foi "reciclado" por outro processo: assinatura diferente → não sinaliza
  const r2 = loadState(f.deps, S1).rec!;
  f.sigs.set(r2.pid, "OUTRO-PROCESSO");
  f.signals.length = 0;
  await assert.rejects(mobileRec(c2, "ios", "stop"), /vídeo saiu vazio/);
  assert.equal(f.signals.length, 0, "não manda sinal pra processo que não é o nosso");
});

test("trava: retomada atômica de trava velha; dono vivo segura mesmo antiga; dono morto solta após a carência", async () => {
  const home = tmp("lk"); const f = fakeDeps(home);
  const lock = join(home, ".constellation/mobile/android.lock");
  // velha (2 h, sem dono): retomada
  put(home, ".constellation/mobile/android.lock", JSON.stringify({ taskId: "velha", at: f.t.now - 2 * 3600_000 }));
  await acquireAndroidLock(ctxOf(f, "t1", tmp("wt"), [], { waitMs: 0 }));
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).taskId, S1);
  // dono VIVO (processo do turno): vale mesmo com `at` antigo
  f.alive.add(9999); f.sigs.set(9999, "start-9999");
  writeFileSync(lock, JSON.stringify({ taskId: "outra", at: f.t.now - 5 * 3600_000, ownerPid: 9999, ownerSig: "start-9999" }));
  await assert.rejects(acquireAndroidLock(ctxOf(f, "t2", tmp("wt"), [], { waitMs: 0 })), /ocupado pela tarefa outra/);
  // dono morreu: depois de 1 min de carência, solta
  f.alive.delete(9999);
  await acquireAndroidLock(ctxOf(f, "t2", tmp("wt"), [], { waitMs: 0 }));
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).taskId, safeId("t2"));
  // a mesma tarefa pega de novo sem esperar; com --owner o dono vai junto
  f.alive.add(4242); f.sigs.set(4242, "start-4242");
  await acquireAndroidLock(ctxOf(f, "t2", tmp("wt"), [], { waitMs: 0, ownerPid: 4242 }));
  assert.deepEqual([JSON.parse(readFileSync(lock, "utf8")).ownerPid, JSON.parse(readFileSync(lock, "utf8")).ownerSig], [4242, "start-4242"]);
});

test("Android: sem SDK → erro humano; AVD faltando → comando com o ABI desta máquina e caminho completo", async () => {
  const wt = tmp("wt");
  const f = fakeDeps(tmp("nohome"));
  await assert.rejects(mobileUp(ctxOf(f, "t", wt), "android"), (e: Error & { fix?: string }) => /Android SDK/.test(e.message) && /Android Studio/.test(e.fix ?? ""));
  const home = androidHome();
  const g = fakeDeps(home, (cmd, args) => (cmd.endsWith("emulator") ? { stdout: "Pixel_8\n" } : adbFake({})(cmd, args)));
  await assert.rejects(mobileUp(ctxOf(g, "t", wt), "android"), (e: Error & { fix?: string }) =>
    /starfork-pixel/.test(e.message) && (e.fix ?? "").includes(join(home, "Library/Android/sdk/cmdline-tools/latest/bin/avdmanager")) && /arm64-v8a/.test(e.fix ?? ""));
  assert.ok(!existsSync(join(home, ".constellation/mobile/android.lock")), "falhou → solta a trava");
  g.deps.arch = "x64";
  assert.match(avdFix(g.deps), /google_apis;x86_64/);
  assert.equal(emulatorFatal("INFO | a\nFATAL        | Not enough space to create userdata partition.\nINFO | b"), "Not enough space to create userdata partition.");
  assert.deepEqual(parseAdbDevices("List of devices attached\nemulator-5554\tdevice\nR58M\toffline\n\n").map((x) => x.serial), ["emulator-5554"]);
  assert.equal(parseAdbDevices("List of devices attached\nemulator-5554\tdevice\nR58M\toffline\n", true).length, 2);
});

test("Maestro ausente → orienta instalar e seguir com prints", async () => {
  const out: string[] = [];
  const f = fakeDeps(tmp("h"));
  assert.equal(await mobileCli({ _: ["mobile", "flow", "f.yaml"], flags: { task: "t", wt: tmp("wt"), platform: "ios" } }, f.deps, (s) => out.push(s)), 1);
  assert.match(out.join("\n"), /Maestro não está instalado[\s\S]*shot[\s\S]*get\.maestro\.mobile\.dev/);
});

test("exec: código distinto por causa (sinal ≠ não existe ≠ tempo esgotado)", () => {
  assert.equal(exitCodeOf(null), 0);
  assert.equal(exitCodeOf(Object.assign(new Error("x"), { code: 3 })), 3);
  assert.equal(exitCodeOf(Object.assign(new Error("x"), { killed: true, signal: "SIGTERM" })), 124);
  assert.equal(exitCodeOf(Object.assign(new Error("x"), { signal: "SIGKILL" })), 137);
  assert.equal(exitCodeOf(Object.assign(new Error("x"), { code: "ENOENT" })), 127);
});

// ------------------------------------------------------------------ varredura e doctor
test("varredura: estado de tarefa que acabou é limpo; simulador Starfork órfão some; o da pessoa e o de tarefa viva ficam", async () => {
  const home = tmp("home"), wtVivo = tmp("vivo");
  const sims = [
    { udid: "PESSOA", name: "iPhone 17", state: "Booted" }, { udid: "VIVO", name: simName(safeId("viva")), state: "Booted" },
    { udid: "MORTO", name: simName(safeId("morta")), state: "Booted" }, { udid: "ORFAO", name: "Starfork-sumiu-abc123", state: "Shutdown" },
    { udid: "BATIZADO", name: "Starfork-mobile-dev", state: "Booted" }, // nome dado pela pessoa: não é do Starfork
  ];
  const gone = new Set<string>();
  const f = fakeDeps(home, (cmd, args) => {
    if (cmd !== "xcrun") return;
    if (args[1] === "delete") gone.add(args[2]);
    if (args[1] === "list") return { stdout: JSON.stringify({ devices: { r: sims.filter((x) => !gone.has(x.udid)) } }) };
  });
  put(home, `.constellation/mobile/tasks/${safeId("viva")}.json`, JSON.stringify({ taskId: safeId("viva"), rawId: "viva", wt: wtVivo, ios: { udid: "VIVO", name: sims[1].name, device: "iPhone", runtime: "iOS" } }));
  put(home, `.constellation/mobile/tasks/${safeId("morta")}.json`, JSON.stringify({ taskId: safeId("morta"), rawId: "morta", wt: join(tmpdir(), "nao-existe-mais-" + process.pid), ios: { udid: "MORTO", name: sims[2].name, device: "iPhone", runtime: "iOS" } }));
  const done = await mobileSweep(f.deps);
  assert.ok(f.calls.includes("xcrun simctl delete MORTO"), "tarefa sem worktree: apaga");
  assert.ok(f.calls.includes("xcrun simctl delete ORFAO"), "órfão sem dono: apaga");
  assert.ok(!f.calls.some((x) => /delete (VIVO|PESSOA|BATIZADO)/.test(x)), "tarefa viva e simulador da pessoa (mesmo com 'Starfork-' no nome) ficam");
  assert.ok(!existsSync(join(home, `.constellation/mobile/tasks/${safeId("morta")}.json`)));
  assert.equal(done.length, 2);
});

test("doctor: mesmo JSON que o Rust lê (fixture dourado tests/fixtures/mobile-doctor.json); sem --wt não varre o cwd", async () => {
  const f = fakeDeps("/nonexistent-starfork-home", (cmd, args) => (cmd === "xcrun" && args.includes("runtimes") ? { stdout: RUNTIMES } : cmd === "xcrun" ? { stdout: '{"devices":{}}' } : undefined));
  const out: string[] = [];
  assert.equal(await mobileCli({ _: ["mobile", "doctor"], flags: { json: "true" } }, f.deps, (s) => out.push(s)), 0);
  const got = JSON.parse(out[0]);
  assert.equal(got.project, null, "sem --wt: nada de varrer pasta (o app pelo Finder tem cwd /)");
  const gold = new URL("../tests/fixtures/mobile-doctor.json", import.meta.url);
  if (process.env.CARDUME_UPDATE_GOLDEN === "1" || !existsSync(gold)) writeFileSync(gold, JSON.stringify(got, null, 2) + "\n");
  assert.deepEqual(got, JSON.parse(readFileSync(gold, "utf8")), "o Rust (env_mobile_tests) lê este mesmo arquivo");
  assert.deepEqual(got.items.map((i: { name: string }) => i.name), ["Simulador iOS (Xcode)", "Emulador Android (SDK + AVD)", "Maestro (fluxos de toque)", "AXe (tocar no Simulador iOS pelo app)"]);
});

// ------------------------------------------------------------------ gate da entrega
test("gate: evidência precisa ser ARQUIVO dentro da worktree/artefatos (nada de pasta, '..', absoluto fora, symlink pra fora)", () => {
  const wt = tmp("gate"); const art = join(wt, ".cardume", "artifacts"); const fora = tmp("fora");
  put(art, "mobile-ios-1.mp4", "MP4"); put(art, "mobile-android-2-login.png", "PNG"); put(wt, "tests/login.test.ts", "x"); put(fora, "segredo.png", "x");
  symlinkSync(join(fora, "segredo.png"), join(art, "link.png"));
  for (const e of ["mobile-ios-1.mp4", "./mobile-ios-1.mp4", ".cardume/artifacts/mobile-ios-1.mp4", "./.cardume/artifacts/mobile-android-2-login.png", "tests/login.test.ts", join(art, "mobile-ios-1.mp4")]) {
    assert.ok(evidenceExists(art, wt, e), e);
  }
  for (const e of ["mobile-ios-9.png", "", ".", "..", "tests", ".cardume/artifacts", "../" + "fora", join(fora, "segredo.png"), "link.png", "/etc/hosts"]) {
    assert.ok(!evidenceExists(art, wt, e), "devia recusar: " + e);
  }
});

test("gate mobile: requisito visual sem print/vídeo reprova com motivo humano; não-visual segue leniente; tarefa que mexeu em tela precisa de 1", () => {
  const ok = (e: string) => !e.includes("sumiu");
  assert.deepEqual(mobileProofGaps([{ req: "A tela de login mostra o erro", status: "done", evidence: ["tests.md"] }], false, ok), ["faltou print/vídeo do app rodando no simulador: A tela de login mostra o erro"]);
  assert.deepEqual(mobileProofGaps([{ req: "A tela de login mostra o erro", status: "done", evidence: ["mobile-ios-1.png"] }], false, ok), []);
  assert.deepEqual(mobileProofGaps([{ req: "A tela mostra", status: "done", evidence: ["mobile-ios-1-sumiu.png"] }], false, ok).length, 1, "print citado que não existe não conta");
  assert.deepEqual(mobileProofGaps([{ req: "salva o token no keychain", status: "done", evidence: ["tests.md"] }], false, ok), [], "não-visual: só a regra geral");
  assert.deepEqual(mobileProofGaps([{ req: "salva o token", status: "done", evidence: ["tests.md"], visual: true }], false, ok).length, 1, '"visual": true no requirements.json manda');
  assert.deepEqual(mobileProofGaps([{ req: "A tela X", status: "done", evidence: ["t.md"], visual: false }], false, ok), [], '"visual": false também manda');
  assert.match(mobileProofGaps([{ req: "salva o token", status: "done", evidence: ["tests.md"] }], true, ok)[0], /mudou telas do app/);
  assert.deepEqual(mobileProofGaps([{ req: "salva o token", status: "done", evidence: ["mobile-android-1.mp4"] }], true, ok), []);
});

// ------------------------------------------------------------------ roteiro dos motores
test("roteiro: só em projeto mobile e fora do planner; comando com escape de shell; --wait; mesmo texto nos 3 motores", () => {
  const web = tmp("web"); put(web, "package.json", JSON.stringify({ dependencies: { react: "18" } }));
  assert.equal(mobileRule({ cwd: web, role: "builder", spec: { id: "t1" } }), "");
  const expo = tmp("expo com espaço e 'aspas'"); put(expo, "package.json", JSON.stringify({ dependencies: { expo: "1", "react-native": "1" } }));
  const r = mobileRule({ cwd: expo, role: "builder", spec: { id: "t1" } });
  assert.match(r, /PROVAS MOBILE \(este projeto é Expo\)/);
  assert.ok(r.includes(`--wt ${shq(expo)}`), "worktree com espaço/aspas escapada");
  assert.ok(shq(expo).startsWith("'") && shq(expo).includes(`'\\''`), "aspas simples POSIX");
  assert.equal(shq('C:\\a b"c', "win32"), '"C:\\a b""c"');
  for (const k of [/up --platform ios/, /npx expo start/, /Expo Go, SEM CocoaPods/, /M shot/, /1 print por requisito visual/, /1 vídeo do fluxo principal/, /requirements\.json/, /NUNCA descreva a tela lendo o código/, /M flow/, /--wait 300/, /"visual": true/]) assert.match(r, k);
  const cmd = mobileCmd("t'1", "/w");
  assert.match(cmd, /src\/cli\.ts'? mobile --task 't'\\''1' --wt \/w --owner \d+$/, cmd);
  assert.equal(mobileRule({ cwd: expo, role: "planner", spec: { id: "t1" } }), "", "planner não prova");
  const ios = tmp("ios"); put(ios, "App.xcodeproj/x", "");
  assert.match(mobileRule({ cwd: ios, role: "builder", spec: { id: "t1" } }), /xcodebuild -scheme <Scheme> -destination id=<udid do up>/);
  const fl = tmp("fl"); put(fl, "pubspec.yaml", "flutter:\n"); assert.match(mobileRule({ cwd: fl, role: "builder", spec: { id: "t1" } }), /flutter run -d <udid do up>/);
  const cap = tmp("cap"); put(cap, "capacitor.config.json", "{}"); assert.match(mobileRule({ cwd: cap, role: "builder", spec: { id: "t1" } }), /npx cap run ios --target <udid do up>/);
  const and = tmp("and"); put(and, "app/build.gradle", "com.android.application");
  assert.match(mobileRule({ cwd: and, role: "tester", spec: { id: "t1" } }), /\.\/gradlew assembleDebug`, depois `M install app\/build\/outputs\/apk\/debug\/app-debug\.apk/);
  const p = buildDshPrompt({ cwd: expo, spec: { id: "t1", requirements: ["R1"] } as never, role: "builder", agentName: "a", dbFile: "", systemContext: "" });
  assert.match(p, /PROVAS MOBILE/);
  for (const f of ["engine/claude.ts", "engine/codex.ts"]) {
    const src = readFileSync(new URL("./" + f, import.meta.url), "utf8");
    assert.match(src, /mobileRule\(\{ cwd: input\.cwd, role: input\.role, spec: input\.spec \}\)/, f);
  }
});

// ------------------------------------------------------------------ orquestrador: turno × tarefa
test("orquestrador: fim do TURNO não pega a trava nem apaga o simulador (fila drena; lock Android solto); fim da TAREFA apaga", async () => {
  const root = tmp("orq"); const repo = join(root, "repo"); const home = tmp("orqhome");
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "a\n"); g("add", "-A"); g("commit", "-q", "-m", "base");
  const orch = new Orchestrator(repo);
  const st = { created: "UDID-T", name: simName(safeId("t")) };
  const f = fakeDeps(home, simctl(st));
  orch.mobileDeps = f.deps;
  try {
    orch.store.createTask({ id: "t", title: "t", objective: "o", agent: "A", roles: [], engine: "claude" } as never, "b", repo, "main");
    put(home, `.constellation/mobile/tasks/${safeId("t")}.json`, JSON.stringify({ taskId: safeId("t"), rawId: "t", wt: repo, ios: { udid: "UDID-T", name: st.name, device: "iPhone", runtime: "iOS" }, android: { serial: "emulator-5584" } }));
    put(home, ".constellation/mobile/android.lock", JSON.stringify({ taskId: safeId("t"), at: Date.now() }));
    const o = orch as unknown as { withTaskLock(id: string, k: string, p: object, fn: () => Promise<void>): Promise<void>; talkToAgentInner(...a: unknown[]): Promise<void> };
    const ran: string[] = [];
    o.talkToAgentInner = async (_t: unknown, m: unknown) => { ran.push(String(m)); };
    // durante o turno chega outro pedido (vai pra fila) — o fim do turno precisa DRENAR, não deixar preso
    await o.withTaskLock("t", "talk", { message: "1º" }, async () => { ran.push("1º"); orch.store.queueAdd("t", "talk", { message: "2º" }); });
    assert.deepEqual(ran, ["1º", "2º"], "a fila drenou");
    assert.equal(orch.store.queueCount("t"), 0);
    assert.equal(orch.store.busyPid("t"), null, "trava de turno solta");
    assert.ok(!f.calls.some((x) => /simctl (shutdown|delete)/.test(x)), "simulador continua de pé entre turnos");
    assert.ok(hasMobileState("t", f.deps));
    assert.ok(!existsSync(join(home, ".constellation/mobile/android.lock")), "trava do emulador solta no fim do turno");
    // fim da TAREFA (remoção): apaga o simulador e limpa o estado
    await orch.removeTask("t");
    assert.ok(f.calls.includes("xcrun simctl delete UDID-T"), f.calls.join("\n"));
    assert.ok(!hasMobileState("t", f.deps));
  } finally {
    orch.close();
  }
});

test("mobileCleanup sem estado não roda nada", async () => {
  const f = fakeDeps(tmp("home"));
  assert.deepEqual(await mobileCleanup("t1", tmp("wt"), f.deps), []);
  assert.equal(f.calls.length, 0);
});

// ------------------------------------------------------------------ REAL (opt-in)
const REAL = { skip: process.env.CARDUME_MOBILE_REAL === "1" ? false : "teste real: rode com CARDUME_MOBILE_REAL=1" };
const keepReal = (p: string) => { if (process.env.CARDUME_MOBILE_KEEP) { const d = join(process.env.CARDUME_MOBILE_KEEP); mkdirSync(d, { recursive: true }); execFileSync("cp", [p, d]); } };
test("REAL iOS: simulador da tarefa liga, print PNG e vídeo de 3 s reais, down apaga", { ...REAL, timeout: 600_000 }, async () => {
  if (process.platform !== "darwin") return;
  const wt = tmp("realios"); put(wt, "package.json", JSON.stringify({ dependencies: { expo: "1" } }));
  const deps = realDeps();
  const c = makeCtx("real-" + process.pid, wt, deps);
  try {
    await mobileUp(c, "ios");
    const png = await mobileShot(c, "ios");
    await mobileRec(c, "ios", "start");
    await deps.sleep(3000);
    const mp4 = await mobileRec(c, "ios", "stop");
    assert.match(execFileSync("file", [png], { encoding: "utf8" }), /PNG image data/);
    assert.match(execFileSync("file", [mp4], { encoding: "utf8" }), /ISO Media/);
    assert.ok(statSync(mp4).size > 1000);
    keepReal(png); keepReal(mp4);
  } finally {
    await mobileDown(c);
  }
  assert.ok(!execFileSync("xcrun", ["simctl", "list", "devices"], { encoding: "utf8" }).includes(simName(c.taskId)), "simulador apagado");
});
test("REAL Android: emulador sobe, print e vídeo reais, down desliga (se o SDK/AVD existir)", { ...REAL, timeout: 900_000 }, async (t) => {
  const deps = realDeps();
  const wt = tmp("realand");
  const c = makeCtx("real-and-" + process.pid, wt, deps, () => {}, { waitMs: 120_000 });
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
    await deps.sleep(4000);
    const mp4 = await mobileRec(c, "android", "stop");
    assert.match(execFileSync("file", [png], { encoding: "utf8" }), /PNG image data/);
    assert.match(execFileSync("file", [mp4], { encoding: "utf8" }), /ISO Media/);
    keepReal(png); keepReal(mp4);
  } finally {
    await mobileDown(c);
  }
  assert.ok(readdirSync(join(wt, ".cardume", "artifacts")).length >= 2);
});
