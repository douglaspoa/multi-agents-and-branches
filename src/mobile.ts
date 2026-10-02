// Provas MOBILE: `cardume mobile …` — a ferramenta ÚNICA que os três motores (Claude/Codex/DeepSeek) usam
// pra provar trabalho em app iOS/Android (nativo, React Native, Expo) com PRINT e VÍDEO reais.
//
//  - iOS: um Simulador DEDICADO por tarefa ("Starfork-<taskId>", criado do iPhone padrão mais novo do
//    runtime iOS mais novo) — tarefas em paralelo não brigam pela tela; `down` apaga o simulador.
//  - Android: o AVD `starfork-pixel` headless, um só na máquina → TRAVA GLOBAL entre tarefas (a 2ª espera);
//    `down` só desliga o emulador se foi o Starfork que subiu e ninguém mais está usando/esperando.
//  - prints/vídeos vão pra `.cardume/artifacts/mobile-<plat>-<n>[-nome].png|mp4` (o agente cita no requirements.json).
//  - fluxos de toque com Maestro, quando instalado (os prints do fluxo também viram artefatos).
//
// NUNCA instala Xcode/SDK/Maestro pela pessoa e NUNCA mexe em simulador/emulador que não foi o Starfork que criou.
// Tudo que roda processo passa por `MobileDeps` (testes usam simctl/adb falsos — src/mobile.test.ts).
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";

export type Platform = "ios" | "android";

/** Erro HUMANO: o que aconteceu + a correção (comando ou instrução). */
export class MobileError extends Error {
  fix: string;
  constructor(msg: string, fix = "") {
    super(msg);
    this.fix = fix;
  }
}

export interface ExecOut { code: number; stdout: string; stderr: string }
export interface MobileDeps {
  exec(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string }): Promise<ExecOut>;
  /** processo em SEGUNDO PLANO que sobrevive ao fim do comando (gravação, emulador) → pid */
  spawnBg(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; logFile?: string }): number;
  alive(pid: number): boolean;
  signal(pid: number, sig: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

export function realDeps(): MobileDeps {
  return {
    exec: (cmd, args, opts = {}) =>
      new Promise((res) => {
        execFile(cmd, args, { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
          const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
          const code = !e ? 0 : typeof e.code === "number" ? e.code : e.killed ? 124 : 127;
          res({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (e && code === 127 ? e.message : "") });
        });
      }),
    spawnBg: (cmd, args, opts = {}) => {
      let fd: number | "ignore" = "ignore";
      if (opts.logFile) { mkdirSync(dirname(opts.logFile), { recursive: true }); fd = openSync(opts.logFile, "a"); }
      const cp = spawn(cmd, args, { env: opts.env, detached: true, stdio: ["ignore", fd, fd] });
      cp.on("error", () => { /* o chamador confere com alive() */ });
      cp.unref();
      if (typeof fd === "number") closeSync(fd);
      return cp.pid ?? -1;
    },
    alive: (pid) => {
      if (!(pid > 0)) return false;
      try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
    },
    signal: (pid, sig) => { try { process.kill(pid, sig); } catch { /* já saiu */ } },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    home: homedir(),
    env: process.env,
    platform: process.platform,
  };
}

// ---------------------------------------------------------------- detecção do projeto
export interface MobileProject {
  iosNative: boolean;
  androidNative: boolean;
  reactNative: boolean;
  expo: boolean;
  /** rótulo curto: "Expo", "React Native", "iOS nativo", "Android nativo", "iOS nativo + Android nativo" */
  label: string;
}
const SKIP_DIRS = new Set(["node_modules", ".git", ".cardume", "Pods", "build", "DerivedData", ".gradle", "dist", ".expo", "vendor"]);
const readText = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/** Detecta por ARQUIVOS (nunca pelo texto da tarefa). Olha a raiz e até 2 níveis abaixo (monorepo: apps/mobile). */
export function detectMobileProject(dir: string): MobileProject {
  const out = { iosNative: false, androidNative: false, reactNative: false, expo: false };
  const isAndroidApp = (d: string) =>
    ["build.gradle", "build.gradle.kts"].some((f) => /com\.android\.application/.test(readText(join(d, f))));
  const visit = (d: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    const pkg = names.includes("package.json") ? readText(join(d, "package.json")) : "";
    if (pkg) {
      try {
        const j = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
        if (deps["expo"]) out.expo = true;
        if (deps["react-native"]) out.reactNative = true;
      } catch { /* package.json inválido */ }
    }
    if (names.includes("app.json") && /"expo"\s*:/.test(readText(join(d, "app.json")))) out.expo = true;
    if (names.some((n) => /^app\.config\.(js|ts|mjs|cjs|json)$/.test(n))) out.expo = true;
    if (names.some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace"))) out.iosNative = true;
    if (names.includes("Package.swift") && /\.iOS\s*\(|iOS/.test(readText(join(d, "Package.swift")))) out.iosNative = true;
    if (isAndroidApp(d) || (names.includes("app") && isAndroidApp(join(d, "app")))) out.androidNative = true;
    if (names.includes("android") && (isAndroidApp(join(d, "android", "app")) || isAndroidApp(join(d, "android")))) out.androidNative = true;
    if (depth >= 2) return;
    for (const n of names) {
      if (n.startsWith(".") || SKIP_DIRS.has(n) || n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace")) continue;
      try { if (statSync(join(d, n)).isDirectory()) visit(join(d, n), depth + 1); } catch { /* ignora */ }
    }
  };
  visit(dir, 0);
  // RN/Expo têm ios/ e android/ nativos dentro — o rótulo é o do framework
  const label = out.expo ? "Expo" : out.reactNative ? "React Native"
    : [out.iosNative && "iOS nativo", out.androidNative && "Android nativo"].filter(Boolean).join(" + ");
  return { ...out, label };
}
export const isMobileProject = (p: MobileProject) => p.iosNative || p.androidNative || p.reactNative || p.expo;

// ---------------------------------------------------------------- ferramentas (fora do PATH também)
const exeName = (n: string, plat: NodeJS.Platform) => (plat === "win32" ? (n === "emulator" || n === "adb" ? n + ".exe" : n + ".bat") : n);

/** Pasta do Android SDK: ANDROID_HOME → ANDROID_SDK_ROOT → lugares padrão (app aberto pelo Finder não tem as envs). */
export function androidSdk(d: Pick<MobileDeps, "env" | "home" | "platform">): string | null {
  const cands = [
    d.env.ANDROID_HOME, d.env.ANDROID_SDK_ROOT,
    join(d.home, "Library", "Android", "sdk"),
    join(d.home, "Android", "Sdk"),
    d.env.LOCALAPPDATA ? join(d.env.LOCALAPPDATA, "Android", "Sdk") : "",
    "/opt/homebrew/share/android-commandlinetools",
  ].filter(Boolean) as string[];
  return cands.find((p) => existsSync(join(p, "platform-tools")) || existsSync(join(p, "emulator"))) ?? null;
}
function inPath(name: string, d: Pick<MobileDeps, "env">): string | null {
  for (const dir of String(d.env.PATH || "").split(delimiter).filter(Boolean)) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}
export function adbBin(d: Pick<MobileDeps, "env" | "home" | "platform">): string | null {
  const sdk = androidSdk(d);
  const p = sdk ? join(sdk, "platform-tools", exeName("adb", d.platform)) : "";
  return (p && existsSync(p) ? p : null) ?? inPath(exeName("adb", d.platform), d) ?? (existsSync("/opt/homebrew/bin/adb") ? "/opt/homebrew/bin/adb" : null);
}
export function emulatorBin(d: Pick<MobileDeps, "env" | "home" | "platform">): string | null {
  const sdk = androidSdk(d);
  const p = sdk ? join(sdk, "emulator", exeName("emulator", d.platform)) : "";
  return p && existsSync(p) ? p : null;
}
export function maestroBin(d: Pick<MobileDeps, "env" | "home" | "platform">): string | null {
  const n = d.platform === "win32" ? "maestro.bat" : "maestro";
  for (const p of [join(d.home, ".maestro", "bin", n), join(d.home, ".maestro", "maestro", "bin", n), "/opt/homebrew/bin/maestro", "/usr/local/bin/maestro"]) {
    if (existsSync(p)) return p;
  }
  return inPath(n, d);
}
/** JAVA_HOME pro Maestro: o do ambiente → openjdk@17 do Homebrew → openjdk do Homebrew. */
export function javaHome(d: Pick<MobileDeps, "env">): string | null {
  if (d.env.JAVA_HOME && existsSync(d.env.JAVA_HOME)) return d.env.JAVA_HOME;
  for (const b of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    for (const v of ["openjdk@17", "openjdk@21", "openjdk"]) {
      const p = join(b, v, "libexec", "openjdk.jdk", "Contents", "Home");
      if (existsSync(p)) return p;
    }
  }
  return null;
}
/** Ambiente pros comandos do Xcode: se o xcode-select aponta pras Command Line Tools (sem simctl) mas há um
 * Xcode.app, usa DEVELOPER_DIR do Xcode — sem trocar a configuração da máquina. */
export function xcodeEnv(d: Pick<MobileDeps, "env">): NodeJS.ProcessEnv {
  const env = { ...d.env };
  const cur = env.DEVELOPER_DIR || "";
  if (cur && existsSync(join(cur, "usr", "bin", "simctl"))) return env;
  try {
    const apps = readdirSync("/Applications").filter((n) => /^Xcode.*\.app$/.test(n)).sort((a, b) => (a === "Xcode.app" ? -1 : b === "Xcode.app" ? 1 : a.localeCompare(b)));
    const sel = cur || "";
    if (!sel || /CommandLineTools/.test(sel)) {
      for (const a of apps) {
        const dev = join("/Applications", a, "Contents", "Developer");
        if (existsSync(join(dev, "usr", "bin", "simctl"))) { env.DEVELOPER_DIR = dev; return env; }
      }
    }
  } catch { /* sem /Applications */ }
  if (/CommandLineTools/.test(cur)) delete env.DEVELOPER_DIR; // deixa o xcode-select decidir
  return env;
}
/** Env com as ferramentas no PATH (adb, emulator, maestro, java) — vale pros comandos que o AGENTE roda também. */
export function toolEnv(d: Pick<MobileDeps, "env" | "home" | "platform">): NodeJS.ProcessEnv {
  const env = d.platform === "darwin" ? xcodeEnv(d) : { ...d.env };
  const extra: string[] = [];
  const sdk = androidSdk(d);
  if (sdk) { extra.push(join(sdk, "platform-tools"), join(sdk, "emulator")); env.ANDROID_HOME = env.ANDROID_HOME || sdk; }
  const m = maestroBin(d);
  if (m) extra.push(dirname(m));
  const jh = javaHome(d);
  if (jh) { env.JAVA_HOME = jh; extra.push(join(jh, "bin")); }
  const cur = String(env.PATH || "").split(delimiter).filter(Boolean);
  env.PATH = [...extra.filter((x) => !cur.includes(x)), ...cur].join(delimiter);
  return env;
}

// ---------------------------------------------------------------- estado
export interface TaskMobileState {
  taskId: string;
  ios?: { udid: string; name: string; device: string; runtime: string };
  android?: { serial: string };
  rec?: { plat: Platform; pid: number; file: string; remote?: string; startedAt: number };
}
export const safeId = (id: string) => String(id || "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(-60) || "tarefa";
export const simName = (taskId: string) => `Starfork-${safeId(taskId)}`;
const mobileDir = (d: Pick<MobileDeps, "home">) => join(d.home, ".constellation", "mobile");
const taskStateFile = (d: Pick<MobileDeps, "home">, taskId: string) => join(mobileDir(d), "tasks", safeId(taskId) + ".json");
const ANDROID_LOCK = (d: Pick<MobileDeps, "home">) => join(mobileDir(d), "android.lock");
const ANDROID_OWN = (d: Pick<MobileDeps, "home">) => join(mobileDir(d), "android.json");
const ANDROID_WAIT = (d: Pick<MobileDeps, "home">) => join(mobileDir(d), "android-wait");
const readJson = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; } };
const writeJson = (p: string, v: unknown) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };
export function loadState(d: Pick<MobileDeps, "home">, taskId: string): TaskMobileState {
  return readJson<TaskMobileState>(taskStateFile(d, taskId)) ?? { taskId };
}
function saveState(d: Pick<MobileDeps, "home">, s: TaskMobileState) {
  if (!s.ios && !s.android && !s.rec) { try { unlinkSync(taskStateFile(d, s.taskId)); } catch { /* já não existe */ } return; }
  writeJson(taskStateFile(d, s.taskId), s);
}

// ---------------------------------------------------------------- nomes dos artefatos
/** Próximo `mobile-<plat>-<n>[-nome].<ext>` livre na pasta de artefatos (n por plataforma+extensão). */
export function nextArtifact(artDir: string, plat: Platform, ext: "png" | "mp4", name?: string): string {
  let max = 0;
  try {
    for (const f of readdirSync(artDir)) {
      const m = f.match(new RegExp(`^mobile-${plat}-(\\d+)(?:-[^.]*)?\\.${ext}$`));
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* pasta ainda não existe */ }
  const slug = String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return join(artDir, `mobile-${plat}-${max + 1}${slug ? "-" + slug : ""}.${ext}`);
}

// ---------------------------------------------------------------- iOS
interface SimRuntime { identifier: string; name?: string; version?: string; isAvailable?: boolean; platform?: string; supportedDeviceTypes?: Array<{ identifier: string; name: string; productFamily?: string }> }
const verNum = (v: string) => String(v || "").split(".").map((x) => Number(x) || 0).reduce((a, n, i) => a + n / Math.pow(1000, i), 0);
/** O iPhone PADRÃO mais novo (ex.: "iPhone 17", não "17 Pro Max"/"Air"/"e") no runtime iOS mais novo disponível. */
export function pickIphone(runtimesJson: string, deviceTypesJson = ""): { runtime: string; runtimeName: string; deviceType: string; deviceName: string } | null {
  let rts: SimRuntime[] = [];
  try { rts = (JSON.parse(runtimesJson) as { runtimes?: SimRuntime[] }).runtimes ?? []; } catch { return null; }
  const ios = rts.filter((r) => r.isAvailable !== false && (r.platform === "iOS" || /^iOS\b/.test(r.name ?? "") || /SimRuntime\.iOS/.test(r.identifier)))
    .sort((a, b) => verNum(b.version ?? "") - verNum(a.version ?? ""));
  const rt = ios[0];
  if (!rt) return null;
  let types = (rt.supportedDeviceTypes ?? []).filter((t) => t.productFamily === "iPhone" || /^iPhone/.test(t.name));
  if (!types.length && deviceTypesJson) {
    try { types = ((JSON.parse(deviceTypesJson) as { devicetypes?: Array<{ identifier: string; name: string; productFamily?: string }> }).devicetypes ?? []).filter((t) => /^iPhone/.test(t.name)); } catch { /* ignora */ }
  }
  if (!types.length) return null;
  const num = (n: string) => Number((n.match(/^iPhone (\d+)/) || [])[1] || 0);
  const plain = types.filter((t) => /^iPhone \d+$/.test(t.name)).sort((a, b) => num(b.name) - num(a.name));
  const any = types.slice().sort((a, b) => num(b.name) - num(a.name));
  const t = plain[0] ?? any[0];
  return { runtime: rt.identifier, runtimeName: rt.name ?? rt.identifier, deviceType: t.identifier, deviceName: t.name };
}
interface SimDevice { udid: string; name: string; state: string; isAvailable?: boolean }
export function findSim(devicesJson: string, name: string): SimDevice | null {
  try {
    const all = (JSON.parse(devicesJson) as { devices?: Record<string, SimDevice[]> }).devices ?? {};
    for (const list of Object.values(all)) for (const dv of list) if (dv.name === name) return dv;
  } catch { /* ignora */ }
  return null;
}
const XCODE_FIX = "instale o Xcode pela App Store, abra uma vez e rode no Terminal: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer && xcodebuild -runFirstLaunch";

// ---------------------------------------------------------------- Android
export function parseAdbDevices(out: string): Array<{ serial: string; state: string }> {
  return out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2 && p[0]).map(([serial, state]) => ({ serial, state }));
}
export const ANDROID_AVD = "starfork-pixel";
const AVD_FIX = `sdkmanager "system-images;android-35;google_apis;arm64-v8a" && avdmanager create avd -n ${ANDROID_AVD} -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7`;
const SDK_FIX = "instale o Android Studio (developer.android.com/studio) — ele traz o SDK, o adb e o emulador; depois crie o AVD: " + AVD_FIX;

// ---------------------------------------------------------------- a ferramenta
export interface MobileCtx { taskId: string; artDir: string; cwd: string; deps: MobileDeps; log: (s: string) => void }
const LOCK_STALE_MS = 30 * 60_000;
const lockWaitMs = (d: MobileDeps) => {
  const n = Number(d.env.CARDUME_MOBILE_LOCK_WAIT_S);
  return (Number.isFinite(n) && n >= 0 ? n : 600) * 1000;
};
const relArt = (c: MobileCtx, f: string) => {
  const r = relative(c.cwd, f);
  return r && !r.startsWith("..") ? r : f;
};
function fileOk(f: string): boolean { try { return statSync(f).size > 0; } catch { return false; } }

async function xcrun(c: MobileCtx, args: string[], timeoutMs = 120_000): Promise<ExecOut> {
  return c.deps.exec("xcrun", ["simctl", ...args], { env: xcodeEnv(c.deps), timeoutMs });
}
function needAdb(c: MobileCtx): string {
  const a = adbBin(c.deps);
  if (!a) throw new MobileError("Não achei o Android SDK (adb) nesta máquina.", SDK_FIX);
  return a;
}
async function adb(c: MobileCtx, args: string[], timeoutMs = 60_000): Promise<ExecOut> {
  return c.deps.exec(needAdb(c), args, { env: toolEnv(c.deps), timeoutMs });
}

/** Plataforma do comando: --platform → a única que está de pé pra esta tarefa. */
export function resolvePlatform(st: TaskMobileState, flag?: string): Platform {
  if (flag) {
    if (flag !== "ios" && flag !== "android") throw new MobileError(`plataforma desconhecida: ${flag}`, "use --platform ios ou --platform android");
    return flag;
  }
  if (st.ios && !st.android) return "ios";
  if (st.android && !st.ios) return "android";
  if (st.ios && st.android) throw new MobileError("os dois (iOS e Android) estão de pé nesta tarefa — diga qual", "acrescente --platform ios ou --platform android");
  throw new MobileError("nenhum simulador/emulador de pé pra esta tarefa", "rode antes: cardume mobile up --platform ios (ou android)");
}

export async function mobileUp(c: MobileCtx, plat: Platform): Promise<TaskMobileState> {
  return plat === "ios" ? upIos(c) : upAndroid(c);
}

async function upIos(c: MobileCtx): Promise<TaskMobileState> {
  if (c.deps.platform !== "darwin") throw new MobileError("Simulador iOS só existe no macOS.", "rode a parte iOS num Mac com Xcode; aqui use --platform android");
  const st = loadState(c.deps, c.taskId);
  const name = simName(c.taskId);
  const devs = await xcrun(c, ["list", "-j", "devices"]);
  if (devs.code !== 0) throw new MobileError(`O Simulador iOS não respondeu (xcrun simctl): ${(devs.stderr || devs.stdout).trim().slice(0, 200)}`, XCODE_FIX);
  let dev = findSim(devs.stdout, name);
  let label = st.ios ? `${st.ios.device} · ${st.ios.runtime}` : "";
  if (!dev) {
    const rts = await xcrun(c, ["list", "-j", "runtimes"]);
    let pick = pickIphone(rts.stdout);
    if (!pick) pick = pickIphone(rts.stdout, (await xcrun(c, ["list", "-j", "devicetypes"])).stdout);
    if (!pick) throw new MobileError("Nenhum runtime iOS instalado no Xcode.", "abra o Xcode → Settings → Components e instale a plataforma iOS (ou: xcodebuild -downloadPlatform iOS)");
    const cr = await xcrun(c, ["create", name, pick.deviceType, pick.runtime]);
    const udid = cr.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (cr.code !== 0 || !udid) throw new MobileError(`Não consegui criar o simulador: ${(cr.stderr || cr.stdout).trim().slice(0, 200)}`, XCODE_FIX);
    dev = { udid, name, state: "Shutdown" };
    label = `${pick.deviceName} · ${pick.runtimeName}`;
    st.ios = { udid, name, device: pick.deviceName, runtime: pick.runtimeName };
  } else if (!st.ios) {
    st.ios = { udid: dev.udid, name, device: "iPhone", runtime: "iOS" };
    label = "iPhone";
  }
  saveState(c.deps, st); // antes do boot: se travar, o `down` ainda acha e apaga
  if (dev.state !== "Booted") {
    const b = await xcrun(c, ["boot", dev.udid]);
    if (b.code !== 0 && !/current state: Booted/i.test(b.stderr)) throw new MobileError(`O simulador não ligou: ${b.stderr.trim().slice(0, 200)}`, XCODE_FIX);
  }
  const bs = await xcrun(c, ["bootstatus", dev.udid, "-b"], 300_000);
  if (bs.code !== 0) throw new MobileError(`O simulador não terminou de ligar: ${(bs.stderr || bs.stdout).trim().slice(-200)}`, "rode de novo; se persistir, feche o Simulator.app e tente outra vez");
  c.log(`✓ Simulador iOS da tarefa pronto: ${name} (${label}) · udid ${dev.udid}`);
  c.log(`  build nativo: xcodebuild -scheme <Scheme> -destination id=${dev.udid} -derivedDataPath .cardume/tmp/dd build → cardume mobile install <App.app>`);
  return st;
}

/** Trava GLOBAL do emulador Android: só uma tarefa por vez; a outra espera (com prazo). */
export async function acquireAndroidLock(c: MobileCtx): Promise<void> {
  const lock = ANDROID_LOCK(c.deps);
  const waitDir = ANDROID_WAIT(c.deps);
  const waiter = join(waitDir, safeId(c.taskId));
  const deadline = c.deps.now() + lockWaitMs(c.deps);
  mkdirSync(dirname(lock), { recursive: true });
  let announced = false;
  for (;;) {
    try {
      writeFileSync(lock, JSON.stringify({ taskId: c.taskId, at: c.deps.now() }), { flag: "wx" });
      try { unlinkSync(waiter); } catch { /* não esperava */ }
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
    }
    const cur = readJson<{ taskId?: string; at?: number }>(lock);
    if (cur && cur.taskId === c.taskId) {
      writeFileSync(lock, JSON.stringify({ taskId: c.taskId, at: c.deps.now() }));
      try { unlinkSync(waiter); } catch { /* ok */ }
      return;
    }
    if (!cur || !cur.at || c.deps.now() - cur.at > LOCK_STALE_MS) { try { unlinkSync(lock); } catch { /* outro levou */ } continue; }
    if (c.deps.now() >= deadline) {
      try { unlinkSync(waiter); } catch { /* ok */ }
      const min = Math.max(1, Math.round((c.deps.now() - cur.at) / 60_000));
      throw new MobileError(`O emulador Android está em uso pela tarefa ${cur.taskId} (último uso há ${min} min) e a espera acabou.`,
        "espere a outra tarefa terminar (ou encerre-a) e rode de novo: cardume mobile up --platform android");
    }
    if (!announced) { c.log(`… emulador Android em uso pela tarefa ${cur.taskId} — aguardando a vez`); announced = true; }
    mkdirSync(waitDir, { recursive: true });
    writeFileSync(waiter, String(c.deps.now()));
    await c.deps.sleep(3000);
  }
}
function touchAndroidLock(c: MobileCtx) {
  const lock = ANDROID_LOCK(c.deps);
  const cur = readJson<{ taskId?: string }>(lock);
  if (cur && cur.taskId === c.taskId) writeFileSync(lock, JSON.stringify({ taskId: c.taskId, at: c.deps.now() }));
}

async function upAndroid(c: MobileCtx): Promise<TaskMobileState> {
  needAdb(c);
  const emu = emulatorBin(c.deps);
  await acquireAndroidLock(c);
  const st = loadState(c.deps, c.taskId);
  try {
    const own = readJson<{ pid: number; serial: string }>(ANDROID_OWN(c.deps));
    const devs = parseAdbDevices((await adb(c, ["devices"])).stdout).filter((x) => /^emulator-/.test(x.serial));
    let serial = "";
    if (own && c.deps.alive(own.pid) && devs.some((x) => x.serial === own.serial)) serial = own.serial; // o nosso já está de pé
    else if (devs.length) serial = devs[0].serial; // um emulador da pessoa já rodando: usa (e NUNCA desliga)
    else {
      if (own) { try { unlinkSync(ANDROID_OWN(c.deps)); } catch { /* ok */ } }
      if (!emu) throw new MobileError("Não achei o emulador do Android SDK.", SDK_FIX);
      const avds = (await c.deps.exec(emu, ["-list-avds"], { env: toolEnv(c.deps), timeoutMs: 30_000 })).stdout.split("\n").map((s) => s.trim());
      if (!avds.includes(ANDROID_AVD)) throw new MobileError(`O AVD "${ANDROID_AVD}" não existe nesta máquina.`, AVD_FIX);
      let port = 5584;
      while (devs.some((x) => x.serial === `emulator-${port}`) && port < 5680) port += 2;
      serial = `emulator-${port}`;
      const logFile = join(mobileDir(c.deps), "emulator.log");
      mkdirSync(dirname(logFile), { recursive: true });
      writeFileSync(logFile, ""); // log só desta subida (o motivo de uma queda é a última linha FATAL)
      const pid = c.deps.spawnBg(emu, ["-avd", ANDROID_AVD, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save", "-port", String(port)], { env: toolEnv(c.deps), logFile });
      if (!(pid > 0)) throw new MobileError("O emulador Android não abriu.", "veja o log em ~/.constellation/mobile/emulator.log");
      writeJson(ANDROID_OWN(c.deps), { pid, serial, avd: ANDROID_AVD, startedAt: c.deps.now() });
      c.log(`… subindo o AVD ${ANDROID_AVD} (sem janela) em ${serial}`);
    }
    st.android = { serial };
    saveState(c.deps, st);
    const deadline = c.deps.now() + 300_000;
    for (;;) {
      const r = await adb(c, ["-s", serial, "shell", "getprop", "sys.boot_completed"], 15_000);
      if (r.code === 0 && r.stdout.trim() === "1") break;
      const o = readJson<{ pid: number; serial: string }>(ANDROID_OWN(c.deps));
      if (o && o.serial === serial && !c.deps.alive(o.pid)) {
        try { unlinkSync(ANDROID_OWN(c.deps)); } catch { /* ok */ }
        const why = emulatorFatal(readText(join(mobileDir(c.deps), "emulator.log")));
        if (/not enough space|disk space/i.test(why)) throw new MobileError(`O emulador Android não tem espaço em disco pra ligar (${why}).`, "libere espaço no disco (o AVD precisa de ~12 GB livres) e rode de novo");
        throw new MobileError(`O emulador Android fechou durante o boot${why ? `: ${why}` : "."}`, "veja ~/.constellation/mobile/emulator.log (falta de memória? AVD corrompido? recrie: " + AVD_FIX + ")");
      }
      if (c.deps.now() > deadline) throw new MobileError("O emulador Android não terminou de ligar em 5 min.", "rode de novo; se persistir, apague e recrie o AVD: " + AVD_FIX);
      await c.deps.sleep(2000);
    }
    touchAndroidLock(c);
    c.log(`✓ Emulador Android pronto: ${serial}`);
    c.log(`  build nativo: ./gradlew assembleDebug → cardume mobile install app/build/outputs/apk/debug/app-debug.apk`);
    return st;
  } catch (e) {
    // não deixou nada de pé pra esta tarefa → esquece o Android e solta a trava (a outra tarefa não espera à toa)
    const o = readJson<{ pid: number }>(ANDROID_OWN(c.deps));
    if (!o || !c.deps.alive(o.pid)) {
      const s2 = loadState(c.deps, c.taskId);
      s2.android = undefined;
      saveState(c.deps, s2);
      releaseAndroidLock(c);
    }
    throw e;
  }
}
/** Última linha FATAL/ERROR do log do emulador (o motivo real de ele ter fechado). */
export function emulatorFatal(log: string): string {
  const lines = log.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 80; i--) {
    const m = lines[i].match(/^(?:FATAL|ERROR)\s*\|\s*(.+)$/);
    if (m) return m[1].slice(0, 220);
  }
  return "";
}
function releaseAndroidLock(c: MobileCtx) {
  const cur = readJson<{ taskId?: string }>(ANDROID_LOCK(c.deps));
  if (cur && cur.taskId === c.taskId) { try { unlinkSync(ANDROID_LOCK(c.deps)); } catch { /* ok */ } }
}

function iosOf(st: TaskMobileState) {
  if (!st.ios) throw new MobileError("o simulador iOS desta tarefa não está de pé", "rode antes: cardume mobile up --platform ios");
  return st.ios;
}
function androidOf(c: MobileCtx, st: TaskMobileState) {
  if (!st.android) throw new MobileError("o emulador Android desta tarefa não está de pé", "rode antes: cardume mobile up --platform android");
  touchAndroidLock(c);
  return st.android;
}

export async function mobileInstall(c: MobileCtx, plat: Platform, app: string): Promise<void> {
  const p = isAbsolute(app) ? app : resolve(c.cwd, app);
  if (!existsSync(p)) throw new MobileError(`arquivo não encontrado: ${app}`, plat === "ios" ? "compile antes (xcodebuild … -destination id=<udid>) e passe o .app gerado em Build/Products/Debug-iphonesimulator/" : "compile antes (./gradlew assembleDebug) e passe o .apk de app/build/outputs/apk/debug/");
  const st = loadState(c.deps, c.taskId);
  if (plat === "ios") {
    const r = await xcrun(c, ["install", iosOf(st).udid, p], 300_000);
    if (r.code !== 0) throw new MobileError(`instalação falhou: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, "confira se o .app foi compilado PRA SIMULADOR (Debug-iphonesimulator), não pra aparelho");
  } else {
    const r = await adb(c, ["-s", androidOf(c, st).serial, "install", "-r", p], 300_000);
    if (r.code !== 0 || /Failure/.test(r.stdout)) throw new MobileError(`instalação falhou: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, "confira se o .apk é de debug e compatível com arm64");
  }
  c.log(`✓ instalado: ${basename(p)}`);
}

/** Expo Go no simulador da tarefa: usa a cópia que o PRÓPRIO Expo CLI baixou (~/.expo/ios-simulator-app-cache). */
async function ensureExpoGoIos(c: MobileCtx, udid: string): Promise<void> {
  const has = await xcrun(c, ["get_app_container", udid, "host.exp.Exponent"]);
  if (has.code === 0) return;
  const cache = join(c.deps.home, ".expo", "ios-simulator-app-cache");
  let app = "";
  try { app = readdirSync(cache).filter((n) => n.endsWith(".app")).sort().pop() ?? ""; } catch { /* sem cache */ }
  if (!app) throw new MobileError("O Expo Go ainda não está neste simulador.", "rode uma vez `npx expo start --ios` (o Expo baixa o Expo Go) e repita o launch");
  const r = await xcrun(c, ["install", udid, join(cache, app)], 300_000);
  if (r.code !== 0) throw new MobileError(`não consegui instalar o Expo Go: ${r.stderr.trim().slice(0, 200)}`, "rode `npx expo start --ios` uma vez e repita o launch");
}

export async function mobileLaunch(c: MobileCtx, plat: Platform, target: string): Promise<void> {
  if (!target) throw new MobileError("diga o que abrir", "cardume mobile launch <bundleId | pacote | exp://127.0.0.1:8081>");
  const st = loadState(c.deps, c.taskId);
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
  if (plat === "ios") {
    const { udid } = iosOf(st);
    if (/^exps?:\/\//i.test(target)) await ensureExpoGoIos(c, udid);
    const r = isUrl ? await xcrun(c, ["openurl", udid, target]) : await xcrun(c, ["launch", udid, target]);
    if (r.code !== 0) throw new MobileError(`não abriu: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, isUrl ? "o servidor (Metro/Expo) está rodando nessa porta?" : "o app está instalado? (cardume mobile install …) e o bundle id está certo?");
  } else {
    const { serial } = androidOf(c, st);
    if (isUrl) {
      const port = (target.match(/:(\d{2,5})(?:\/|$)/) || [])[1];
      if (port && /127\.0\.0\.1|localhost/.test(target)) await adb(c, ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`]);
      const r = await adb(c, ["-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", target]);
      if (r.code !== 0 || /Error/.test(r.stdout)) throw new MobileError(`não abriu: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, /^exp/.test(target) ? "instale o Expo Go no emulador: rode `npx expo start --android` uma vez" : "confira a URL");
    } else {
      const r = await adb(c, ["-s", serial, "shell", "monkey", "-p", target, "-c", "android.intent.category.LAUNCHER", "1"]);
      if (r.code !== 0 || /No activities found|monkey aborted/i.test(r.stdout + r.stderr)) throw new MobileError(`não abriu: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, "o app está instalado? (cardume mobile install …) e o pacote está certo?");
    }
  }
  c.log(`✓ aberto: ${target}`);
}

export async function mobileShot(c: MobileCtx, plat: Platform, name?: string): Promise<string> {
  mkdirSync(c.artDir, { recursive: true });
  const st = loadState(c.deps, c.taskId);
  const file = nextArtifact(c.artDir, plat, "png", name);
  if (plat === "ios") {
    const r = await xcrun(c, ["io", iosOf(st).udid, "screenshot", "--type=png", file]);
    if (r.code !== 0) throw new MobileError(`o print falhou: ${r.stderr.trim().slice(0, 200)}`, "o simulador está ligado? rode cardume mobile up --platform ios");
  } else {
    const { serial } = androidOf(c, st);
    const remote = "/sdcard/starfork-shot.png";
    const r = await adb(c, ["-s", serial, "shell", "screencap", "-p", remote]);
    if (r.code !== 0) throw new MobileError(`o print falhou: ${r.stderr.trim().slice(0, 200)}`, "o emulador está ligado? rode cardume mobile up --platform android");
    const p = await adb(c, ["-s", serial, "pull", remote, file]);
    await adb(c, ["-s", serial, "shell", "rm", "-f", remote]);
    if (p.code !== 0) throw new MobileError(`não consegui copiar o print: ${p.stderr.trim().slice(0, 200)}`);
  }
  if (!fileOk(file)) throw new MobileError("o print saiu vazio", "rode de novo em alguns segundos (a tela ainda estava carregando?)");
  c.log(`✓ print: ${relArt(c, file)}`);
  return file;
}

const ANDROID_REC_LIMIT_S = 180;
export async function mobileRec(c: MobileCtx, plat: Platform, action: string): Promise<string> {
  const st = loadState(c.deps, c.taskId);
  if (action === "start") {
    if (st.rec && c.deps.alive(st.rec.pid)) throw new MobileError("já está gravando", "rode cardume mobile rec stop antes de começar outra gravação");
    mkdirSync(c.artDir, { recursive: true });
    const file = nextArtifact(c.artDir, plat, "mp4");
    const logFile = join(mobileDir(c.deps), "rec-" + safeId(c.taskId) + ".log");
    let pid: number, remote: string | undefined;
    if (plat === "ios") {
      pid = c.deps.spawnBg("xcrun", ["simctl", "io", iosOf(st).udid, "recordVideo", "--codec=h264", "--force", file], { env: xcodeEnv(c.deps), logFile });
    } else {
      const { serial } = androidOf(c, st);
      remote = `/sdcard/starfork-rec-${safeId(c.taskId)}.mp4`;
      pid = c.deps.spawnBg(needAdb(c), ["-s", serial, "shell", "screenrecord", "--time-limit", String(ANDROID_REC_LIMIT_S), remote], { env: toolEnv(c.deps), logFile });
    }
    await c.deps.sleep(1500);
    if (!(pid > 0) || !c.deps.alive(pid)) throw new MobileError("a gravação não começou", `veja o log em ${logFile}`);
    st.rec = { plat, pid, file, remote, startedAt: c.deps.now() };
    saveState(c.deps, st);
    c.log(`● gravando ${plat === "ios" ? "o simulador" : `o emulador (máx. ${ANDROID_REC_LIMIT_S} s)`} → ${relArt(c, file)} — faça o fluxo e rode: cardume mobile rec stop`);
    return file;
  }
  if (action !== "stop") throw new MobileError(`ação desconhecida: rec ${action}`, "use: cardume mobile rec start | rec stop");
  const rec = st.rec;
  if (!rec) throw new MobileError("não há gravação em andamento", "comece com: cardume mobile rec start");
  await stopRec(c, st);
  if (!fileOk(rec.file)) throw new MobileError("o vídeo saiu vazio", `veja o log em ${join(mobileDir(c.deps), "rec-" + safeId(c.taskId) + ".log")}`);
  const secs = Math.round((c.deps.now() - rec.startedAt) / 1000);
  c.log(`✓ vídeo: ${relArt(c, rec.file)} (${secs} s${rec.plat === "android" && secs >= ANDROID_REC_LIMIT_S ? `, cortado em ${ANDROID_REC_LIMIT_S} s pelo Android` : ""})`);
  return rec.file;
}
/** Encerra a gravação em andamento (se houver) e finaliza o arquivo. Não lança. */
async function stopRec(c: MobileCtx, st: TaskMobileState): Promise<void> {
  const rec = st.rec;
  if (!rec) return;
  try {
    if (rec.plat === "ios") {
      c.deps.signal(rec.pid, "SIGINT"); // o simctl fecha o mp4 no SIGINT
    } else if (st.android) {
      await adb(c, ["-s", st.android.serial, "shell", "pkill", "-INT", "screenrecord"], 15_000).catch(() => null);
    }
    for (let i = 0; i < 40 && c.deps.alive(rec.pid); i++) await c.deps.sleep(500);
    if (c.deps.alive(rec.pid)) c.deps.signal(rec.pid, "SIGTERM");
    if (rec.plat === "android" && rec.remote && st.android) {
      await c.deps.sleep(1000); // o screenrecord termina de escrever o moov
      await adb(c, ["-s", st.android.serial, "pull", rec.remote, rec.file], 120_000);
      await adb(c, ["-s", st.android.serial, "shell", "rm", "-f", rec.remote]);
    }
  } catch { /* segue: o arquivo é conferido por quem chamou */ }
  st.rec = undefined;
  saveState(c.deps, st);
}

export async function mobileFlow(c: MobileCtx, plat: Platform, yaml: string): Promise<string[]> {
  const m = maestroBin(c.deps);
  if (!m) throw new MobileError("O Maestro não está instalado — sem fluxos de toque por enquanto; siga provando com `shot` e `rec`.", 'curl -fsSL "https://get.maestro.mobile.dev" | bash');
  const f = isAbsolute(yaml) ? yaml : resolve(c.cwd, yaml);
  if (!existsSync(f)) throw new MobileError(`fluxo não encontrado: ${yaml}`, "escreva o fluxo Maestro (.yaml com appId e passos tapOn/inputText/assertVisible/takeScreenshot) e passe o caminho");
  const st = loadState(c.deps, c.taskId);
  const device = plat === "ios" ? iosOf(st).udid : androidOf(c, st).serial;
  const out = join(tmpdir(), `starfork-maestro-${safeId(c.taskId)}-${c.deps.now()}`);
  mkdirSync(out, { recursive: true });
  const env = toolEnv(c.deps);
  if (!javaHome(c.deps)) throw new MobileError("O Maestro precisa de Java (JDK 17).", "brew install openjdk@17");
  const r = await c.deps.exec(m, ["--device", device, "test", f, "--test-output-dir", out], { env, cwd: out, timeoutMs: 15 * 60_000 });
  // prints do fluxo (takeScreenshot) → artefatos, com o nome que o fluxo deu
  mkdirSync(c.artDir, { recursive: true });
  const shots: string[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      const p = join(d, n);
      try {
        if (statSync(p).isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
      } catch { continue; }
      if (!/\.png$/i.test(n)) continue;
      const dst = nextArtifact(c.artDir, plat, "png", "flow-" + n.replace(/\.png$/i, ""));
      try { copyFileSync(p, dst); shots.push(dst); } catch { /* ignora */ }
    }
  };
  walk(out, 0);
  try { rmSync(out, { recursive: true, force: true }); } catch { /* ok */ }
  for (const s of shots) c.log(`✓ print do fluxo: ${relArt(c, s)}`);
  if (r.code !== 0) {
    const tail = (r.stdout + "\n" + r.stderr).trim().split("\n").slice(-25).join("\n");
    throw new MobileError(`o fluxo Maestro FALHOU (código ${r.code}):\n${tail}`, "corrija o app ou o fluxo e rode de novo — a falha acima é o comportamento real");
  }
  c.log(`✓ fluxo ok: ${basename(f)}${shots.length ? "" : " (sem takeScreenshot no fluxo — use cardume mobile shot depois)"}`);
  return shots;
}

/**
 * Desliga o que ESTA tarefa subiu: para a gravação, desliga e APAGA o simulador iOS dedicado (só "Starfork-…"),
 * solta a trava do Android e desliga o emulador só se foi o Starfork que subiu e ninguém mais usa/espera.
 */
export async function mobileDown(c: MobileCtx, only?: Platform): Promise<string[]> {
  const st = loadState(c.deps, c.taskId);
  const done: string[] = [];
  if (st.rec && (!only || st.rec.plat === only)) { await stopRec(c, st); done.push("gravação encerrada"); }
  if (st.ios && (!only || only === "ios")) {
    const { udid, name } = st.ios;
    if (name.startsWith("Starfork-")) {
      await xcrun(c, ["shutdown", udid], 60_000).catch(() => null);
      await xcrun(c, ["delete", udid], 60_000).catch(() => null);
      done.push(`simulador ${name} apagado`);
    }
    st.ios = undefined;
  }
  if (st.android && (!only || only === "android")) {
    releaseAndroidLock(c);
    const own = readJson<{ pid: number; serial: string }>(ANDROID_OWN(c.deps));
    const lockNow = readJson<{ taskId?: string }>(ANDROID_LOCK(c.deps));
    let waiting = false;
    try {
      waiting = readdirSync(ANDROID_WAIT(c.deps)).some((f) => {
        try { return c.deps.now() - statSync(join(ANDROID_WAIT(c.deps), f)).mtimeMs < 120_000; } catch { return false; }
      });
    } catch { /* ninguém esperando */ }
    if (own && own.serial === st.android.serial && !lockNow && !waiting) {
      await adb(c, ["-s", own.serial, "emu", "kill"], 30_000).catch(() => null);
      for (let i = 0; i < 20 && c.deps.alive(own.pid); i++) await c.deps.sleep(500);
      if (c.deps.alive(own.pid)) c.deps.signal(own.pid, "SIGTERM");
      try { unlinkSync(ANDROID_OWN(c.deps)); } catch { /* ok */ }
      done.push(`emulador ${own.serial} desligado`);
    } else {
      done.push("emulador Android liberado" + (own && own.serial === st.android.serial ? " (segue ligado pra próxima tarefa)" : " (não foi o Starfork que subiu — fica como está)"));
    }
    st.android = undefined;
  }
  saveState(c.deps, st);
  for (const d of done) c.log(`✓ ${d}`);
  return done;
}

/** A tarefa deixou algo de pé com `cardume mobile`? (checagem barata de arquivo) */
export function hasMobileState(taskId: string, deps: Pick<MobileDeps, "home"> = { home: homedir() }): boolean {
  return existsSync(taskStateFile(deps, safeId(taskId)));
}
/** Fim do turno/tarefa (orquestrador): limpa o que a tarefa deixou de pé. Rápido e mudo sem estado; nunca lança. */
export async function mobileCleanup(taskId: string, worktree: string, deps: MobileDeps = realDeps()): Promise<void> {
  if (!hasMobileState(taskId, deps)) return;
  try {
    await mobileDown({ taskId: safeId(taskId), artDir: join(worktree, ".cardume", "artifacts"), cwd: worktree, deps, log: () => {} });
  } catch { /* limpeza nunca derruba o fim do turno */ }
}

// ---------------------------------------------------------------- doctor (Ambiente do app + agente)
export interface DoctorItem { id: "ios" | "android" | "maestro"; name: string; ok: boolean; detail: string; fix: string }
export async function mobileDoctor(deps: MobileDeps): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  if (deps.platform === "darwin") {
    const r = await deps.exec("xcrun", ["simctl", "list", "-j", "runtimes"], { env: xcodeEnv(deps), timeoutMs: 20_000 });
    const pick = r.code === 0 ? pickIphone(r.stdout) : null;
    items.push(pick
      ? { id: "ios", name: "Simulador iOS (Xcode)", ok: true, detail: `${pick.runtimeName} · ${pick.deviceName} — cada tarefa ganha o seu simulador`, fix: "" }
      : { id: "ios", name: "Simulador iOS (Xcode)", ok: false, detail: r.code === 0 ? "Xcode sem runtime iOS instalado" : "Xcode não encontrado (só as Command Line Tools não bastam)", fix: r.code === 0 ? "xcodebuild -downloadPlatform iOS" : XCODE_FIX });
  } else {
    items.push({ id: "ios", name: "Simulador iOS (Xcode)", ok: false, detail: "só existe no macOS", fix: "" });
  }
  const adb = adbBin(deps), emu = emulatorBin(deps);
  if (!adb || !emu) {
    items.push({ id: "android", name: "Emulador Android (SDK + AVD)", ok: false, detail: adb ? "adb ok, mas sem o emulador do SDK" : "Android SDK não encontrado", fix: SDK_FIX });
  } else {
    const avds = (await deps.exec(emu, ["-list-avds"], { env: toolEnv(deps), timeoutMs: 20_000 })).stdout.split("\n").map((s) => s.trim());
    items.push(avds.includes(ANDROID_AVD)
      ? { id: "android", name: "Emulador Android (SDK + AVD)", ok: true, detail: `${androidSdk(deps)} · AVD ${ANDROID_AVD}`, fix: "" }
      : { id: "android", name: "Emulador Android (SDK + AVD)", ok: false, detail: `SDK ok, mas sem o AVD ${ANDROID_AVD}`, fix: AVD_FIX });
  }
  const m = maestroBin(deps);
  const jh = javaHome(deps);
  items.push(!m
    ? { id: "maestro", name: "Maestro (fluxos de toque)", ok: false, detail: "não instalado — os agentes provam só com prints e vídeos", fix: 'curl -fsSL "https://get.maestro.mobile.dev" | bash' }
    : !jh
      ? { id: "maestro", name: "Maestro (fluxos de toque)", ok: false, detail: `${m} — falta o Java (JDK 17)`, fix: "brew install openjdk@17" }
      : { id: "maestro", name: "Maestro (fluxos de toque)", ok: true, detail: `${m} · Java ${jh}`, fix: "" });
  return items;
}

// ---------------------------------------------------------------- roteiro pros motores
/** Prefixo EXATO do comando pro agente (node + CLI que este processo usa; tarefa e worktree amarradas). */
export function mobileCmd(taskId: string, worktree: string): string {
  const node = `"${process.execPath}"` + (process.execArgv.includes("--experimental-sqlite") ? " --experimental-sqlite" : "");
  return `${node} --disable-warning=ExperimentalWarning "${process.argv[1] || "cardume"}" mobile --task ${safeId(taskId)} --wt "${worktree}"`;
}
const detectCache = new Map<string, { at: number; p: MobileProject }>();
export function detectCached(dir: string): MobileProject {
  const c = detectCache.get(dir);
  if (c && Date.now() - c.at < 60_000) return c.p;
  const p = detectMobileProject(dir);
  detectCache.set(dir, { at: Date.now(), p });
  return p;
}
/** O projeto da worktree é app mobile (e o papel faz prova)? */
export function needsMobile(input: { cwd: string; role?: string; spec: { kind?: string } }): boolean {
  if (input.role === "planner" || input.spec.kind === "review") return false;
  return isMobileProject(detectCached(input.cwd));
}

/** Roteiro das provas mobile — o MESMO texto nos três motores. "" quando o projeto não é mobile. */
export function mobileRule(input: { cwd: string; role?: string; spec: { id: string; kind?: string } }): string {
  if (!needsMobile(input)) return "";
  const p = detectCached(input.cwd);
  const cmd = mobileCmd(input.spec.id, input.cwd);
  const how: string[] = [];
  if (p.expo) how.push("Expo: Expo Go, SEM CocoaPods/prebuild — suba o Metro em segundo plano (`CI=1 npx expo start --port 8081 &`), depois `M launch exp://127.0.0.1:8081` (no Android o Starfork faz o adb reverse); se o Expo Go faltar no simulador, rode uma vez `npx expo start --ios` (ou --android) e repita o launch");
  else if (p.reactNative) how.push("React Native (bare): `npx react-native run-ios --udid <udid do up>` / `npx react-native run-android --deviceId <serial do up>`");
  if (p.iosNative && !p.expo && !p.reactNative) how.push("iOS nativo: `xcodebuild -scheme <Scheme> -destination id=<udid do up> -derivedDataPath .cardume/tmp/dd build`, depois `M install .cardume/tmp/dd/Build/Products/Debug-iphonesimulator/<App>.app` e `M launch <bundle id>`");
  if (p.androidNative && !p.expo && !p.reactNative) how.push("Android nativo: `./gradlew assembleDebug`, depois `M install app/build/outputs/apk/debug/app-debug.apk` e `M launch <pacote>`");
  return (
    ` PROVAS MOBILE (este projeto é ${p.label}): prove NA TELA do simulador/emulador — NUNCA descreva a tela lendo o código. Use SEMPRE a ferramenta do Starfork (chamada M abaixo):\n` +
    `M = ${cmd}\n` +
    `(M é só abreviação neste texto — no terminal rode SEMPRE o comando completo, ex.: ${cmd} up --platform ios)\n` +
    `- \`M doctor\` mostra o que existe nesta máquina (Xcode, Android SDK/AVD, Maestro).\n` +
    `- \`M up --platform ios\` cria e liga um Simulador iOS SÓ desta tarefa (imprime o udid); \`M up --platform android\` liga o emulador Android (um por máquina — se outra tarefa estiver usando, espera a vez).\n` +
    `- Compile e rode: ${how.join("; ")}.\n` +
    `- \`M shot [nome]\` tira um PRINT → .cardume/artifacts/mobile-<plat>-<n>[-nome].png — no MÍNIMO 1 print por requisito visual.\n` +
    `- \`M rec start\` … faça o fluxo principal … \`M rec stop\` grava um VÍDEO curto (Android corta em 180 s) → .cardume/artifacts/mobile-<plat>-<n>.mp4 — no MÍNIMO 1 vídeo do fluxo principal.\n` +
    `- \`M flow <arquivo.yaml>\` roda um fluxo de toques com Maestro (takeScreenshot vira artefato); sem Maestro, siga com shot/rec.\n` +
    `- Com os dois (iOS e Android) de pé, acrescente --platform ios|android nos comandos. \`M down\` desliga tudo (o Starfork também desliga sozinho no fim do turno).\n` +
    `- CITE os arquivos (ex.: "mobile-ios-1.png", "mobile-ios-1.mp4") no "evidence" de cada requisito no .cardume/artifacts/requirements.json. Se M der erro, ele já diz a correção: não instale Xcode/SDK/Maestro por conta própria — pergunte ao humano.`
  );
}

// ---------------------------------------------------------------- CLI
/** Acha a worktree (pasta com .cardume/TASK.yaml) subindo a partir de `from`. */
function findWorktree(from: string): string | null {
  let d = resolve(from);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, ".cardume", "TASK.yaml"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}
function taskIdFromYaml(wt: string): string {
  const m = readText(join(wt, ".cardume", "TASK.yaml")).match(/^id:\s*["']?([^"'\n]+)["']?\s*$/m);
  return m ? m[1].trim() : "";
}

export async function mobileCli(argv: { _: string[]; flags: Record<string, string> }, deps: MobileDeps = realDeps(), out: (s: string) => void = (s) => console.log(s)): Promise<number> {
  const sub = argv._[1] ?? "";
  const json = argv.flags.json === "true";
  try {
    if (sub === "doctor") {
      const items = await mobileDoctor(deps);
      const proj = detectMobileProject(argv.flags.wt || process.cwd());
      if (json) { out(JSON.stringify({ items, project: { ...proj, mobile: isMobileProject(proj) } })); return 0; }
      for (const it of items) out(`${it.ok ? "✓" : "–"} ${it.name}: ${it.detail}${it.fix ? `\n    como resolver: ${it.fix}` : ""}`);
      out(`  projeto: ${isMobileProject(proj) ? proj.label : "não parece app mobile"}`);
      return 0;
    }
    const wt = argv.flags.wt || findWorktree(process.cwd()) || process.cwd();
    const rawTask = argv.flags.task || process.env.CARDUME_TASK || taskIdFromYaml(wt);
    const taskId = rawTask ? safeId(rawTask) : "";
    if (!taskId) throw new MobileError("não sei de qual tarefa é este comando", "rode de dentro da worktree da tarefa ou passe --task <id>");
    const c: MobileCtx = { taskId, artDir: join(wt, ".cardume", "artifacts"), cwd: wt, deps, log: out };
    const st = loadState(deps, taskId);
    const plat = () => resolvePlatform(st, argv.flags.platform);
    switch (sub) {
      case "up": {
        const p = argv.flags.platform;
        if (p !== "ios" && p !== "android") throw new MobileError("diga a plataforma", "cardume mobile up --platform ios (ou android)");
        await mobileUp(c, p);
        return 0;
      }
      case "install": await mobileInstall(c, plat(), argv._[2] ?? ""); return 0;
      case "launch": await mobileLaunch(c, plat(), argv._[2] ?? ""); return 0;
      case "shot": await mobileShot(c, plat(), argv._[2] ?? argv.flags.name); return 0;
      case "rec": {
        // `rec stop` sem --platform: a plataforma da gravação em andamento
        const p = argv._[2] === "stop" && !argv.flags.platform && st.rec ? st.rec.plat : plat();
        await mobileRec(c, p, argv._[2] ?? "");
        return 0;
      }
      case "flow": await mobileFlow(c, plat(), argv._[2] ?? ""); return 0;
      case "down": {
        const done = await mobileDown(c, argv.flags.platform === "ios" || argv.flags.platform === "android" ? argv.flags.platform : undefined);
        if (!done.length) out("nada de pé pra esta tarefa");
        return 0;
      }
      default:
        out(`uso: cardume mobile doctor [--json]
       cardume mobile up --platform ios|android
       cardume mobile install <App.app|app.apk>
       cardume mobile launch <bundleId|pacote|exp://…>
       cardume mobile shot [nome]
       cardume mobile rec start|stop
       cardume mobile flow <fluxo.yaml>     (Maestro)
       cardume mobile down
  (todos aceitam --platform ios|android, --task <id> e --wt <worktree>)`);
        return sub ? 1 : 0;
    }
  } catch (e) {
    if (e instanceof MobileError) {
      out(`✕ ${e.message}${e.fix ? `\n  como resolver: ${e.fix}` : ""}`);
      return 1;
    }
    out(`✕ ${(e as Error)?.message ?? String(e)}`);
    return 1;
  }
}
