// Provas MOBILE: `cardume mobile …` — a ferramenta ÚNICA que os três motores (Claude/Codex/DeepSeek) usam
// pra provar trabalho em app iOS/Android (nativo, React Native, Expo, Flutter, Capacitor) com PRINT e VÍDEO reais.
//
//  - iOS: um Simulador DEDICADO por tarefa ("Starfork-<id>-<hash>", criado do iPhone padrão mais novo do runtime
//    iOS mais novo) — tarefas em paralelo não brigam pela tela. Ele VIVE enquanto a tarefa vive: só é apagado no
//    fim da TAREFA (merge/remoção) ou pela varredura (doctor/boot do app) quando a tarefa não existe mais.
//  - Android: o AVD `starfork-pixel` headless, um só na máquina → TRAVA GLOBAL entre tarefas. A trava vale enquanto
//    o processo dono do turno vive; no fim de cada turno ela é solta (o emulador fica ligado pra próxima tarefa).
//  - prints/vídeos vão pra `.cardume/artifacts/mobile-<plat>-<n>[-nome].png|mp4` (o agente cita no requirements.json).
//    Gravação em andamento fica FORA da pasta de artefatos (~/.constellation/mobile/rec/) até o `rec stop`.
//  - fluxos de toque com Maestro, quando instalado (os prints do fluxo também viram artefatos).
//
// NUNCA instala Xcode/SDK/Maestro pela pessoa e NUNCA mexe em simulador/emulador que não foi o Starfork que criou.
// Tudo que roda processo passa por `MobileDeps` (testes usam simctl/adb falsos — src/mobile.test.ts).
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

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
  /** stdout BINÁRIO direto pra um arquivo (ex.: `adb exec-out screencap -p`) */
  execToFile(cmd: string, args: string[], file: string, opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ExecOut>;
  /** processo em SEGUNDO PLANO que sobrevive ao fim do comando (gravação, emulador) → pid */
  spawnBg(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; logFile?: string }): number;
  alive(pid: number): boolean;
  signal(pid: number, sig: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
}

/** Código de saída distinto por causa: 0 ok · n do processo · 124 tempo esgotado · 128+sinal morto por sinal · 127 não existe. */
export function exitCodeOf(e: (Error & { code?: number | string; killed?: boolean; signal?: string | null }) | null): number {
  if (!e) return 0;
  if (typeof e.code === "number") return e.code;
  if (e.killed) return 124;
  if (e.signal) return 128 + ((osConstants.signals as Record<string, number>)[e.signal] ?? 0);
  return e.code === "ENOENT" ? 127 : 1;
}

export function realDeps(): MobileDeps {
  return {
    exec: (cmd, args, opts = {}) =>
      new Promise((res) => {
        execFile(cmd, args, { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = exitCodeOf(err as never);
          res({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err && code === 127 ? err.message : "") });
        });
      }),
    execToFile: (cmd, args, file, opts = {}) =>
      new Promise((res) => {
        mkdirSync(dirname(file), { recursive: true });
        const fd = openSync(file, "w");
        let stderr = "";
        let killed = false;
        const cp = spawn(cmd, args, { env: opts.env, stdio: ["ignore", fd, "pipe"] });
        const t = setTimeout(() => { killed = true; cp.kill("SIGTERM"); }, opts.timeoutMs ?? 60_000);
        cp.stderr?.on("data", (b) => { stderr += String(b); });
        cp.on("error", (e) => { clearTimeout(t); closeSync(fd); res({ code: 127, stdout: "", stderr: e.message }); });
        cp.on("close", (code, sig) => {
          clearTimeout(t);
          try { closeSync(fd); } catch { /* já fechado */ }
          res({ code: killed ? 124 : code ?? (sig ? 128 + ((osConstants.signals as Record<string, number>)[sig] ?? 0) : 1), stdout: "", stderr });
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
    arch: process.arch,
  };
}

// ---------------------------------------------------------------- detecção do projeto
export interface MobileProject {
  iosNative: boolean;
  androidNative: boolean;
  reactNative: boolean;
  expo: boolean;
  flutter: boolean;
  capacitor: boolean;
  /** rótulo curto: "Expo", "React Native", "Flutter", "Capacitor", "iOS nativo", "Android nativo", "iOS nativo + Android nativo" */
  label: string;
}
const SKIP_DIRS = new Set(["node_modules", ".git", ".cardume", "Pods", "build", "DerivedData", ".gradle", "dist", ".expo", "vendor", ".dart_tool"]);
const readText = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/** Detecta por ARQUIVOS (nunca pelo texto da tarefa). Olha a raiz e até 2 níveis abaixo (monorepo: apps/mobile).
 * Só APP conta: biblioteca Android (com.android.library) e pacote Swift sem `.iOSApplication` não são app. */
export function detectMobileProject(dir: string): MobileProject {
  const out = { iosNative: false, androidNative: false, reactNative: false, expo: false, flutter: false, capacitor: false };
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
        if (deps["@capacitor/core"]) out.capacitor = true;
      } catch { /* package.json inválido */ }
    }
    if (names.includes("app.json") && /"expo"\s*:/.test(readText(join(d, "app.json")))) out.expo = true;
    if (names.some((n) => /^app\.config\.(js|ts|mjs|cjs|json)$/.test(n))) out.expo = true;
    if (names.some((n) => /^capacitor\.config\.(ts|js|json)$/.test(n))) out.capacitor = true;
    if (names.includes("pubspec.yaml") && /^\s*flutter\s*:|sdk:\s*flutter/m.test(readText(join(d, "pubspec.yaml")))) out.flutter = true;
    if (names.some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace"))) out.iosNative = true;
    // SwiftPM só é app iOS com o produto de app (Swift Playgrounds/AppleProductTypes); pacote de biblioteca não conta
    if (names.includes("Package.swift") && /\.iOSApplication\s*\(/.test(readText(join(d, "Package.swift")))) out.iosNative = true;
    if (isAndroidApp(d) || (names.includes("app") && isAndroidApp(join(d, "app")))) out.androidNative = true;
    if (names.includes("android") && (isAndroidApp(join(d, "android", "app")) || isAndroidApp(join(d, "android")))) out.androidNative = true;
    if (depth >= 2) return;
    for (const n of names) {
      if (n.startsWith(".") || SKIP_DIRS.has(n) || n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace")) continue;
      try { if (statSync(join(d, n)).isDirectory()) visit(join(d, n), depth + 1); } catch { /* ignora */ }
    }
  };
  visit(dir, 0);
  // RN/Expo/Flutter/Capacitor têm ios/ e android/ nativos dentro — o rótulo é o do framework
  const label = out.expo ? "Expo" : out.reactNative ? "React Native" : out.flutter ? "Flutter" : out.capacitor ? "Capacitor"
    : [out.iosNative && "iOS nativo", out.androidNative && "Android nativo"].filter(Boolean).join(" + ");
  return { ...out, label };
}
export const isMobileProject = (p: MobileProject) => p.iosNative || p.androidNative || p.reactNative || p.expo || p.flutter || p.capacitor;

// ---------------------------------------------------------------- ferramentas (fora do PATH também)
type ToolDeps = Pick<MobileDeps, "env" | "home" | "platform">;
const exeName = (n: string, plat: NodeJS.Platform) => (plat === "win32" ? (n === "emulator" || n === "adb" ? n + ".exe" : n + ".bat") : n);

/** Pasta do Android SDK: ANDROID_HOME → ANDROID_SDK_ROOT → lugares padrão (app aberto pelo Finder não tem as envs). */
export function androidSdk(d: ToolDeps): string | null {
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
export function adbBin(d: ToolDeps): string | null {
  const sdk = androidSdk(d);
  const p = sdk ? join(sdk, "platform-tools", exeName("adb", d.platform)) : "";
  return (p && existsSync(p) ? p : null) ?? inPath(exeName("adb", d.platform), d) ?? (existsSync("/opt/homebrew/bin/adb") ? "/opt/homebrew/bin/adb" : null);
}
export function emulatorBin(d: ToolDeps): string | null {
  const sdk = androidSdk(d);
  const p = sdk ? join(sdk, "emulator", exeName("emulator", d.platform)) : "";
  return p && existsSync(p) ? p : null;
}
export function maestroBin(d: ToolDeps): string | null {
  const n = d.platform === "win32" ? "maestro.bat" : "maestro";
  for (const p of [join(d.home, ".maestro", "bin", n), join(d.home, ".maestro", "maestro", "bin", n), "/opt/homebrew/bin/maestro", "/usr/local/bin/maestro"]) {
    if (existsSync(p)) return p;
  }
  return inPath(n, d);
}
/** AXe (cameroncooke/axe): toque/digitação no Simulador iOS pelo painel Dispositivo. Brew, ~/.local (instalação de
 * usuário da mesma tarball da fórmula) ou PATH. */
export function axeBin(d: ToolDeps): string | null {
  if (d.platform !== "darwin") return null;
  for (const p of [join(d.home, ".local", "lib", "axe", "axe"), join(d.home, ".local", "bin", "axe"), "/opt/homebrew/bin/axe", "/usr/local/bin/axe"]) {
    if (existsSync(p)) return p;
  }
  return inPath("axe", d);
}
export const AXE_FIX = "brew install cameroncooke/axe/axe (se o brew recusar por \"Command Line Tools too outdated\", atualize-as em Ajustes do Sistema → Atualização de Software e rode de novo)";
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
 * Xcode.app, usa DEVELOPER_DIR do Xcode — sem trocar a configuração da máquina (o xcode-select fica como está). */
export function xcodeEnv(d: Pick<MobileDeps, "env">): NodeJS.ProcessEnv {
  const env = { ...d.env };
  const cur = env.DEVELOPER_DIR || "";
  if (cur && existsSync(join(cur, "usr", "bin", "simctl"))) return env;
  try {
    const apps = readdirSync("/Applications").filter((n) => /^Xcode.*\.app$/.test(n)).sort((a, b) => (a === "Xcode.app" ? -1 : b === "Xcode.app" ? 1 : a.localeCompare(b)));
    for (const a of apps) {
      const dev = join("/Applications", a, "Contents", "Developer");
      if (existsSync(join(dev, "usr", "bin", "simctl"))) { env.DEVELOPER_DIR = dev; return env; }
    }
  } catch { /* sem /Applications */ }
  if (/CommandLineTools/.test(cur)) delete env.DEVELOPER_DIR; // deixa o xcode-select decidir
  return env;
}
/** Env com as ferramentas no PATH (adb, emulator, maestro, java) — vale pros comandos que o AGENTE roda também. */
export function toolEnv(d: ToolDeps): NodeJS.ProcessEnv {
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

// ---------------------------------------------------------------- correções (texto humano)
const XCODE_FIX = "instale o Xcode pela App Store e abra-o uma vez (aceite a licença e instale a plataforma iOS) — o Starfork usa o Xcode sozinho, sem mudar o xcode-select da máquina";
export const ANDROID_AVD = "starfork-pixel";
/** Comando de criação do AVD pro processador DESTA máquina, com o caminho completo das ferramentas do SDK. */
export function avdFix(d: ToolDeps & Pick<MobileDeps, "arch">): string {
  const abi = d.arch === "arm64" ? "arm64-v8a" : "x86_64";
  const img = `system-images;android-35;google_apis;${abi}`;
  const bin = join(androidSdk(d) ?? (d.platform === "darwin" ? join(d.home, "Library", "Android", "sdk") : join(d.home, "Android", "Sdk")), "cmdline-tools", "latest", "bin");
  const ext = d.platform === "win32" ? ".bat" : "";
  return `"${join(bin, "sdkmanager" + ext)}" "${img}" && "${join(bin, "avdmanager" + ext)}" create avd -n ${ANDROID_AVD} -k "${img}" -d pixel_7`;
}
const sdkFix = (d: ToolDeps & Pick<MobileDeps, "arch">) =>
  "instale o Android Studio (developer.android.com/studio) — ele traz o SDK, o adb e o emulador; depois crie o AVD: " + avdFix(d);

// ---------------------------------------------------------------- estado
interface ProcRef { pid: number; sig: string }
export interface RecState {
  plat: Platform;
  pid: number;
  sig: string;
  /** arquivo temporário FORA dos artefatos enquanto grava */
  tmp: string;
  /** destino final em .cardume/artifacts */
  file: string;
  remote?: string;
  devPid?: number;
  startedAt: number;
}
export interface TaskMobileState {
  /** id seguro (safeId) */
  taskId: string;
  /** id real da tarefa (pra varredura achar no state.sqlite) */
  rawId?: string;
  wt?: string;
  /** nome do simulador sendo criado (a varredura não apaga no meio do `up`) */
  iosPending?: string;
  ios?: { udid: string; name: string; device: string; runtime: string; deviceType?: string; runtimeId?: string };
  android?: { serial: string; avd?: string };
  rec?: RecState;
}
/** id seguro e SEM colisão: o texto limpo + hash curto do id real ("a/b" e "a_b" viram ids diferentes). */
export const safeId = (id: string) => {
  const raw = String(id ?? "");
  const base = raw.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(-40) || "tarefa";
  return `${base}-${createHash("sha1").update(raw).digest("hex").slice(0, 6)}`;
};
/** Nome do simulador da tarefa (recebe o id SEGURO). */
export const simName = (safe: string) => `Starfork-${safe}`;
const mobileDir = (d: Pick<MobileDeps, "home">) => join(d.home, ".constellation", "mobile");
const tasksDir = (d: Pick<MobileDeps, "home">) => join(mobileDir(d), "tasks");
const taskStateFile = (d: Pick<MobileDeps, "home">, safe: string) => join(tasksDir(d), safe + ".json");
const recDir = (d: Pick<MobileDeps, "home">, safe: string) => join(mobileDir(d), "rec", safe);
const ANDROID_LOCK = (d: Pick<MobileDeps, "home">) => join(mobileDir(d), "android.lock");
const ANDROID_OWN = (d: Pick<MobileDeps, "home">) => join(mobileDir(d), "android.json");
const ANDROID_WAIT = (d: Pick<MobileDeps, "home">) => join(mobileDir(d), "android-wait");
const readJson = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; } };
/** Escrita ATÔMICA (tmp + rename): quem lê nunca vê o arquivo pela metade. */
const writeJson = (p: string, v: unknown) => {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2));
  renameSync(tmp, p);
};
export function loadState(d: Pick<MobileDeps, "home">, safe: string): TaskMobileState {
  return readJson<TaskMobileState>(taskStateFile(d, safe)) ?? { taskId: safe };
}
function saveState(d: Pick<MobileDeps, "home">, s: TaskMobileState) {
  if (!s.ios && !s.android && !s.rec && !s.iosPending) { try { unlinkSync(taskStateFile(d, s.taskId)); } catch { /* já não existe */ } return; }
  writeJson(taskStateFile(d, s.taskId), s);
}
/** Move (rename; entre discos: copia + apaga). */
function moveFile(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try { renameSync(from, to); } catch { copyFileSync(from, to); try { unlinkSync(from); } catch { /* ok */ } }
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
/** Modelo ESCOLHIDO (seletor do painel): o tipo pedido no runtime pedido (ou no iOS mais novo que o suporta). */
export function pickDevice(runtimesJson: string, deviceType: string, runtime?: string): { runtime: string; runtimeName: string; deviceType: string; deviceName: string } | null {
  for (const m of iosModels(runtimesJson)) if (m.deviceType === deviceType && (!runtime || m.runtime === runtime)) return m;
  return null;
}
/** Aparelhos iOS (iPhone/iPad) por runtime iOS disponível, do mais novo pro mais antigo — opções do seletor. */
export function iosModels(runtimesJson: string): Array<{ runtime: string; runtimeName: string; deviceType: string; deviceName: string }> {
  let rts: SimRuntime[] = [];
  try { rts = (JSON.parse(runtimesJson) as { runtimes?: SimRuntime[] }).runtimes ?? []; } catch { return []; }
  const ios = rts.filter((r) => r.isAvailable !== false && (r.platform === "iOS" || /^iOS\b/.test(r.name ?? "") || /SimRuntime\.iOS/.test(r.identifier)))
    .sort((a, b) => verNum(b.version ?? "") - verNum(a.version ?? ""));
  const out: Array<{ runtime: string; runtimeName: string; deviceType: string; deviceName: string }> = [];
  for (const rt of ios) {
    for (const t of rt.supportedDeviceTypes ?? []) {
      if (!(t.productFamily === "iPhone" || t.productFamily === "iPad" || /^iP(hone|ad)/.test(t.name))) continue;
      out.push({ runtime: rt.identifier, runtimeName: rt.name ?? rt.identifier, deviceType: t.identifier, deviceName: t.name });
    }
  }
  return out;
}
interface SimDevice { udid: string; name: string; state: string; isAvailable?: boolean }
export function listSims(devicesJson: string): SimDevice[] {
  try {
    const all = (JSON.parse(devicesJson) as { devices?: Record<string, SimDevice[]> }).devices ?? {};
    return Object.values(all).flat();
  } catch { return []; }
}
export function findSim(devicesJson: string, name: string): SimDevice | null {
  return listSims(devicesJson).find((d) => d.name === name) ?? null;
}

// ---------------------------------------------------------------- Android
/** `adb devices` → só os PRONTOS (estado "device"); offline/unauthorized não servem pra comando. */
export function parseAdbDevices(out: string, all = false): Array<{ serial: string; state: string }> {
  const list = out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2 && p[0]).map(([serial, state]) => ({ serial, state }));
  return all ? list : list.filter((x) => x.state === "device");
}

// ---------------------------------------------------------------- contexto
export interface MobileCtx {
  /** id SEGURO (safeId) */
  taskId: string;
  rawId: string;
  artDir: string;
  cwd: string;
  deps: MobileDeps;
  log: (s: string) => void;
  /** quanto o `up`/comando Android espera a trava (ms) */
  waitMs?: number;
  /** processo dono do turno (o motor): a trava Android vale enquanto ele vive */
  ownerPid?: number;
  /** comando da PESSOA (painel Dispositivo): no Android só CONFERE a trava (agente usando → recusa na hora), nunca a
   * segura além do próprio comando — senão um print pelo painel prendia o emulador 30 min pras outras tarefas */
  viewer?: boolean;
}
export function makeCtx(rawId: string, wt: string, deps: MobileDeps, log: (s: string) => void = () => {}, extra: Partial<MobileCtx> = {}): MobileCtx {
  return { taskId: safeId(rawId), rawId, artDir: join(wt, ".cardume", "artifacts"), cwd: wt, deps, log, ...extra };
}
const relArt = (c: MobileCtx, f: string) => {
  const r = relative(c.cwd, f);
  return r && !r.startsWith("..") ? r : f;
};
function fileOk(f: string): boolean { try { return statSync(f).isFile() && statSync(f).size > 0; } catch { return false; } }
function isPng(f: string): boolean {
  try {
    const fd = openSync(f, "r");
    const b = Buffer.alloc(8);
    readSync(fd, b, 0, 8, 0);
    closeSync(fd);
    return b.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } catch { return false; }
}
/** Assinatura do processo (hora de início) — confere que o pid salvo ainda é O MESMO processo antes de sinalizar. */
export async function procSig(d: MobileDeps, pid: number): Promise<string> {
  if (!(pid > 0) || d.platform === "win32") return "";
  const r = await d.exec("ps", ["-o", "lstart=", "-p", String(pid)], { timeoutMs: 5000 });
  return r.code === 0 ? r.stdout.trim() : "";
}
async function sameProc(d: MobileDeps, ref: ProcRef): Promise<boolean> {
  if (!d.alive(ref.pid)) return false;
  if (!ref.sig) return true; // sem como conferir (Windows): o pid vivo vale
  return (await procSig(d, ref.pid)) === ref.sig;
}
async function signalIfSame(d: MobileDeps, ref: ProcRef, sig: NodeJS.Signals): Promise<boolean> {
  if (!(await sameProc(d, ref))) return false;
  d.signal(ref.pid, sig);
  return true;
}

async function xcrun(c: MobileCtx, args: string[], timeoutMs = 120_000): Promise<ExecOut> {
  return c.deps.exec("xcrun", ["simctl", ...args], { env: xcodeEnv(c.deps), timeoutMs });
}
function needAdb(c: MobileCtx): string {
  const a = adbBin(c.deps);
  if (!a) throw new MobileError("Não achei o Android SDK (adb) nesta máquina.", sdkFix(c.deps));
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

function stateOf(c: MobileCtx): TaskMobileState {
  const st = loadState(c.deps, c.taskId);
  st.rawId = c.rawId;
  st.wt = c.cwd;
  return st;
}

export interface UpPrefs { deviceType?: string; runtime?: string; avd?: string }
export async function mobileUp(c: MobileCtx, plat: Platform, prefs: UpPrefs = {}): Promise<TaskMobileState> {
  return plat === "ios" ? upIos(c, prefs) : upAndroid(c, prefs.avd);
}

async function upIos(c: MobileCtx, prefs: UpPrefs = {}): Promise<TaskMobileState> {
  if (c.deps.platform !== "darwin") throw new MobileError("Simulador iOS só existe no macOS.", "rode a parte iOS num Mac com Xcode; aqui use --platform android");
  const st = stateOf(c);
  const name = simName(c.taskId);
  const devs = await xcrun(c, ["list", "-j", "devices"]);
  if (devs.code !== 0) throw new MobileError(`O Simulador iOS não respondeu (xcrun simctl): ${(devs.stderr || devs.stdout).trim().slice(0, 200)}`, XCODE_FIX);
  let dev = findSim(devs.stdout, name);
  // outro MODELO pedido (seletor do painel): o simulador da tarefa é recriado com o aparelho escolhido
  if (dev && prefs.deviceType && st.ios?.deviceType !== prefs.deviceType) {
    await xcrun(c, ["shutdown", dev.udid], 60_000).catch(() => null);
    const del = await xcrun(c, ["delete", dev.udid], 60_000);
    if (del.code !== 0 && !/Invalid device|could not be found/i.test(del.stderr)) throw new MobileError(`não consegui trocar o aparelho: ${del.stderr.trim().slice(0, 200)}`, "desligue o simulador e tente de novo");
    st.ios = undefined;
    dev = null;
  }
  let label = st.ios ? `${st.ios.device} · ${st.ios.runtime}` : "";
  if (!dev) {
    const rts = await xcrun(c, ["list", "-j", "runtimes"]);
    let pick = prefs.deviceType ? pickDevice(rts.stdout, prefs.deviceType, prefs.runtime) : pickIphone(rts.stdout);
    if (!pick && prefs.deviceType) throw new MobileError(`o aparelho escolhido não existe neste Xcode: ${prefs.deviceType}`, "escolha outro modelo na lista");
    if (!pick) pick = pickIphone(rts.stdout, (await xcrun(c, ["list", "-j", "devicetypes"])).stdout);
    if (!pick) throw new MobileError("Nenhum runtime iOS instalado no Xcode.", "abra o Xcode → Settings → Components e instale a plataforma iOS (ou: xcodebuild -downloadPlatform iOS)");
    st.iosPending = name; // a varredura não apaga um simulador recém-criado antes de o estado ser salvo
    saveState(c.deps, st);
    const cr = await xcrun(c, ["create", name, pick.deviceType, pick.runtime]);
    const udid = cr.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (cr.code !== 0 || !udid) {
      st.iosPending = undefined;
      saveState(c.deps, st);
      throw new MobileError(`Não consegui criar o simulador: ${(cr.stderr || cr.stdout).trim().slice(0, 200)}`, XCODE_FIX);
    }
    dev = { udid, name, state: "Shutdown" };
    label = `${pick.deviceName} · ${pick.runtimeName}`;
    st.ios = { udid, name, device: pick.deviceName, runtime: pick.runtimeName, deviceType: pick.deviceType, runtimeId: pick.runtime };
  } else if (!st.ios || st.ios.udid !== dev.udid) {
    // achou pelo nome mas o estado aponta outro udid (estado velho/apagado à mão): o que vale é o que existe
    st.ios = { udid: dev.udid, name, device: st.ios?.device ?? "iPhone", runtime: st.ios?.runtime ?? "iOS" };
    label = `${st.ios.device} · ${st.ios.runtime}`;
  }
  st.iosPending = undefined;
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

// ---------------------------------------------------------------- trava global do Android
interface LockRec { taskId: string; at: number; ownerPid?: number; ownerSig?: string }
const LOCK_IDLE_MS = 30 * 60_000; // dono sem processo conhecido: vale 30 min desde o último uso
const LOCK_GRACE_MS = 60_000;     // dono com processo: morreu → solta depois de 1 min
const DEFAULT_WAIT_S = 90;        // abaixo do tempo-limite do Bash dos agentes
const lockWaitMs = (c: MobileCtx) => {
  if (c.waitMs !== undefined) return c.waitMs;
  const n = Number(c.deps.env.CARDUME_MOBILE_LOCK_WAIT_S);
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAIT_S) * 1000;
};
/** A trava ainda vale? Enquanto o processo dono do turno vive, sim (sem depender de renovação); senão expira. */
async function lockFresh(d: MobileDeps, cur: LockRec | null, mtimeMs: number): Promise<boolean> {
  if (!cur || !cur.taskId) return d.now() - mtimeMs < 10_000; // arquivo sendo escrito agora
  if (cur.ownerPid && (await sameProc(d, { pid: cur.ownerPid, sig: cur.ownerSig ?? "" }))) return true;
  return d.now() - (cur.at || 0) < (cur.ownerPid ? LOCK_GRACE_MS : LOCK_IDLE_MS);
}
async function myLock(c: MobileCtx): Promise<LockRec> {
  const rec: LockRec = { taskId: c.taskId, at: c.deps.now() };
  if (c.ownerPid && c.deps.alive(c.ownerPid)) { rec.ownerPid = c.ownerPid; rec.ownerSig = await procSig(c.deps, c.ownerPid); }
  return rec;
}
/** Trava GLOBAL do emulador Android: uma tarefa por vez. Espera até o prazo (padrão 90 s, `--wait <s>`) e devolve
 * "ocupado" — o agente tenta de novo depois. Retomada de trava velha é ATÔMICA (rename + conferência). */
export async function acquireAndroidLock(c: MobileCtx): Promise<void> {
  const lock = ANDROID_LOCK(c.deps);
  const waiter = join(ANDROID_WAIT(c.deps), c.taskId);
  const deadline = c.deps.now() + lockWaitMs(c);
  mkdirSync(dirname(lock), { recursive: true });
  let announced = false;
  const clearWaiter = () => { try { unlinkSync(waiter); } catch { /* não esperava */ } };
  for (;;) {
    try {
      // cria só se não existe (atômico); o conteúdo vai num tmp renomeado por cima
      writeFileSync(lock, "", { flag: "wx" });
      writeJson(lock, await myLock(c));
      clearWaiter();
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
    }
    let raw = "";
    let mtime = 0;
    try { raw = readFileSync(lock, "utf8"); mtime = statSync(lock).mtimeMs; } catch { continue; } // sumiu: tenta criar de novo
    let cur: LockRec | null = null;
    try { cur = JSON.parse(raw) as LockRec; } catch { cur = null; }
    if (cur && cur.taskId === c.taskId) { writeJson(lock, await myLock(c)); clearWaiter(); return; }
    if (!(await lockFresh(c.deps, cur, mtime))) {
      // retomada atômica: só um consegue renomear; e só vale se o conteúdo é o MESMO que julgamos velho
      const aside = `${lock}.stale-${c.taskId}-${c.deps.now()}`;
      try { renameSync(lock, aside); } catch { continue; }
      const moved = readText(aside);
      try { unlinkSync(aside); } catch { /* ok */ }
      if (moved !== raw) { try { writeFileSync(lock, moved, { flag: "wx" }); } catch { /* outro já pegou */ } }
      continue;
    }
    if (c.deps.now() >= deadline) {
      clearWaiter();
      throw new MobileError(`O emulador Android está ocupado pela tarefa ${cur?.taskId ?? "?"} — tente de novo em ~1 min.`,
        "rode o mesmo comando de novo daqui a pouco (ou espere mais: acrescente --wait 300)");
    }
    if (!announced) { c.log(`… emulador Android em uso pela tarefa ${cur?.taskId ?? "?"} — aguardando a vez (até ${Math.round(lockWaitMs(c) / 1000)} s)`); announced = true; }
    mkdirSync(dirname(waiter), { recursive: true });
    writeFileSync(waiter, String(c.deps.now()));
    await c.deps.sleep(3000);
  }
}
function releaseAndroidLock(d: MobileDeps, safe: string): boolean {
  const cur = readJson<LockRec>(ANDROID_LOCK(d));
  if (cur && cur.taskId === safe) { try { unlinkSync(ANDROID_LOCK(d)); return true; } catch { /* ok */ } }
  return false;
}
function freshWaiters(d: MobileDeps): boolean {
  try {
    return readdirSync(ANDROID_WAIT(d)).some((f) => {
      try { return d.now() - statSync(join(ANDROID_WAIT(d), f)).mtimeMs < 120_000; } catch { return false; }
    });
  } catch { return false; }
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

async function upAndroid(c: MobileCtx, avdWanted?: string): Promise<TaskMobileState> {
  const avd = avdWanted || ANDROID_AVD;
  needAdb(c);
  const emu = emulatorBin(c.deps);
  await acquireAndroidLock(c);
  const st = stateOf(c);
  try {
    const own = readJson<{ pid: number; sig?: string; serial: string; avd?: string }>(ANDROID_OWN(c.deps));
    if (avdWanted && own && (own.avd ?? ANDROID_AVD) !== avd && (await sameProc(c.deps, { pid: own.pid, sig: own.sig ?? "" })))
      throw new MobileError(`o emulador do Starfork está ligado com outro aparelho (${own.avd ?? ANDROID_AVD})`, "desligue-o antes de trocar de aparelho (botão de energia do painel Dispositivo ou cardume mobile down --platform android)");
    const all = parseAdbDevices((await adb(c, ["devices"])).stdout, true).filter((x) => /^emulator-/.test(x.serial));
    const ready = all.filter((x) => x.state === "device");
    let serial = "";
    if (own && (await sameProc(c.deps, { pid: own.pid, sig: own.sig ?? "" })) && all.some((x) => x.serial === own.serial)) serial = own.serial; // o nosso já está de pé (talvez ainda ligando)
    else if (ready.length) serial = ready[0].serial; // um emulador da pessoa já rodando: usa (e NUNCA desliga)
    else {
      if (own) { try { unlinkSync(ANDROID_OWN(c.deps)); } catch { /* ok */ } }
      if (!emu) throw new MobileError("Não achei o emulador do Android SDK.", sdkFix(c.deps));
      const avds = (await c.deps.exec(emu, ["-list-avds"], { env: toolEnv(c.deps), timeoutMs: 30_000 })).stdout.split("\n").map((s) => s.trim());
      if (!avds.includes(avd)) throw new MobileError(`O AVD "${avd}" não existe nesta máquina.`, avd === ANDROID_AVD ? avdFix(c.deps) : `escolha um destes: ${avds.filter(Boolean).join(", ") || "(nenhum)"}`);
      let port = 5584;
      while (all.some((x) => x.serial === `emulator-${port}`) && port < 5680) port += 2;
      serial = `emulator-${port}`;
      const logFile = join(mobileDir(c.deps), "emulator.log");
      mkdirSync(dirname(logFile), { recursive: true });
      writeFileSync(logFile, ""); // log só desta subida (o motivo de uma queda é a última linha FATAL)
      const pid = c.deps.spawnBg(emu, ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save", "-port", String(port)], { env: toolEnv(c.deps), logFile });
      if (!(pid > 0)) throw new MobileError("O emulador Android não abriu.", "veja o log em ~/.constellation/mobile/emulator.log");
      writeJson(ANDROID_OWN(c.deps), { pid, sig: await procSig(c.deps, pid), serial, avd, startedAt: c.deps.now() });
      c.log(`… subindo o AVD ${avd} (sem janela) em ${serial}`);
    }
    const ownNow = readJson<{ serial: string; avd?: string }>(ANDROID_OWN(c.deps));
    st.android = { serial, avd: ownNow?.serial === serial ? (ownNow.avd ?? ANDROID_AVD) : undefined }; // undefined = emulador da pessoa
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
        throw new MobileError(`O emulador Android fechou durante o boot${why ? `: ${why}` : "."}`, "veja ~/.constellation/mobile/emulator.log (falta de memória? AVD corrompido? recrie: " + avdFix(c.deps) + ")");
      }
      if (c.deps.now() > deadline) throw new MobileError("O emulador Android não terminou de ligar em 5 min.", "rode de novo; se persistir, apague e recrie o AVD: " + avdFix(c.deps));
      await c.deps.sleep(2000);
    }
    // tela acesa e sem bloqueio: logo depois do boot o display fica preto/bloqueado e o print sai todo preto
    await adb(c, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP"], 15_000).catch(() => null);
    await adb(c, ["-s", serial, "shell", "wm", "dismiss-keyguard"], 15_000).catch(() => null);
    for (let i = 0; i < 15; i++) { // espera o launcher/app em foco (até ~30 s)
      const w = await adb(c, ["-s", serial, "shell", "dumpsys", "window"], 15_000).catch(() => null);
      if (!w || /mCurrentFocus=Window\{[^}]*\s\S+\/\S+\}/.test(w.stdout)) break;
      await c.deps.sleep(2000);
    }
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
      releaseAndroidLock(c.deps, c.taskId);
    }
    throw e;
  }
}

function iosOf(st: TaskMobileState) {
  if (!st.ios) throw new MobileError("o simulador iOS desta tarefa não está de pé", "rode antes: cardume mobile up --platform ios");
  return st.ios;
}
/** Comando Android: a tarefa precisa estar com a trava (o fim do turno solta — aqui pega de volta, se livre).
 * Comando da PESSOA (`viewer`): só confere — agente usando → recusa com quem está usando. */
async function androidOf(c: MobileCtx, st: TaskMobileState) {
  if (!st.android) throw new MobileError("o emulador Android desta tarefa não está de pé", "rode antes: cardume mobile up --platform android");
  if (c.viewer) {
    const h = await androidLockHolder(c.deps);
    if (h && !h.mine) throw new MobileError(`o emulador Android está em uso pelo agente${h.taskId === c.taskId ? " desta tarefa" : ` da tarefa ${h.taskId}`} — só visualização por enquanto`, "espere o agente terminar o turno (ou pare a tarefa) e tente de novo");
    return st.android;
  }
  await acquireAndroidLock(c);
  return st.android;
}
/** Quem está com a trava do emulador AGORA (trava velha não conta). `mine` = segurada por ESTE processo (gravação do painel). */
export async function androidLockHolder(d: MobileDeps): Promise<{ taskId: string; mine: boolean } | null> {
  let raw = "", mtime = 0;
  try { raw = readFileSync(ANDROID_LOCK(d), "utf8"); mtime = statSync(ANDROID_LOCK(d)).mtimeMs; } catch { return null; }
  let cur: LockRec | null = null;
  try { cur = JSON.parse(raw) as LockRec; } catch { cur = null; }
  if (!(await lockFresh(d, cur, mtime))) return null;
  return { taskId: cur?.taskId ?? "?", mine: !!cur?.ownerPid && cur.ownerPid === process.pid };
}
/** Solta a trava Android desta tarefa (o painel depois de ligar o emulador / parar a própria gravação). */
export function releaseAndroidLockOf(d: MobileDeps, safe: string): boolean { return releaseAndroidLock(d, safe); }

export async function mobileInstall(c: MobileCtx, plat: Platform, app: string): Promise<void> {
  const p = isAbsolute(app) ? app : resolve(c.cwd, app);
  if (!existsSync(p)) throw new MobileError(`arquivo não encontrado: ${app}`, plat === "ios" ? "compile antes (xcodebuild … -destination id=<udid>) e passe o .app gerado em Build/Products/Debug-iphonesimulator/" : "compile antes (./gradlew assembleDebug) e passe o .apk de app/build/outputs/apk/debug/");
  const st = stateOf(c);
  if (plat === "ios") {
    const r = await xcrun(c, ["install", iosOf(st).udid, p], 300_000);
    if (r.code !== 0) throw new MobileError(`instalação falhou: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, "confira se o .app foi compilado PRA SIMULADOR (Debug-iphonesimulator), não pra aparelho");
  } else {
    const r = await adb(c, ["-s", (await androidOf(c, st)).serial, "install", "-r", p], 300_000);
    if (r.code !== 0 || /Failure/.test(r.stdout)) throw new MobileError(`instalação falhou: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, "confira se o .apk é de debug e compatível com o processador do emulador");
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
  const st = stateOf(c);
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
  if (plat === "ios") {
    const { udid } = iosOf(st);
    if (/^exps?:\/\//i.test(target)) await ensureExpoGoIos(c, udid);
    const r = isUrl ? await xcrun(c, ["openurl", udid, target]) : await xcrun(c, ["launch", udid, target]);
    if (r.code !== 0) throw new MobileError(`não abriu: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, isUrl ? "o servidor (Metro/Expo) está rodando nessa porta?" : "o app está instalado? (cardume mobile install …) e o bundle id está certo?");
  } else {
    const { serial } = await androidOf(c, st);
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
  const st = stateOf(c);
  const file = nextArtifact(c.artDir, plat, "png", name);
  const tmp = join(recDir(c.deps, c.taskId), "shot-" + basename(file));
  mkdirSync(dirname(tmp), { recursive: true });
  if (plat === "ios") {
    const r = await xcrun(c, ["io", iosOf(st).udid, "screenshot", "--type=png", tmp]);
    if (r.code !== 0) throw new MobileError(`o print falhou: ${r.stderr.trim().slice(0, 200)}`, "o simulador está ligado? rode cardume mobile up --platform ios");
  } else {
    const { serial } = await androidOf(c, st);
    // direto pro arquivo local (nada em /sdcard — o Android novo nega escrita lá pro shell)
    const r = await c.deps.execToFile(needAdb(c), ["-s", serial, "exec-out", "screencap", "-p"], tmp, { env: toolEnv(c.deps), timeoutMs: 30_000 });
    if (r.code !== 0) throw new MobileError(`o print falhou: ${r.stderr.trim().slice(0, 200)}`, "o emulador está ligado? rode cardume mobile up --platform android");
  }
  if (!fileOk(tmp) || !isPng(tmp)) { try { unlinkSync(tmp); } catch { /* ok */ } throw new MobileError("o print saiu vazio ou inválido", "rode de novo em alguns segundos (a tela ainda estava carregando?)"); }
  moveFile(tmp, file);
  c.log(`✓ print: ${relArt(c, file)}`);
  return file;
}

const ANDROID_REC_LIMIT_S = 180;
const recLog = (c: MobileCtx) => join(recDir(c.deps, c.taskId), "rec.log");
export async function mobileRec(c: MobileCtx, plat: Platform, action: string): Promise<string> {
  const st = stateOf(c);
  if (action === "start") {
    if (st.rec) {
      if (await sameProc(c.deps, st.rec)) throw new MobileError("já está gravando", "rode cardume mobile rec stop antes de começar outra gravação");
      // gravação anterior morreu sem `rec stop` (fim do turno, crash): finaliza o que der antes de começar outra
      const old = await finishRec(c, st);
      if (old) c.log(`✓ gravação anterior finalizada: ${relArt(c, old)}`);
    }
    const file = nextArtifact(c.artDir, plat, "mp4");
    const tmp = join(recDir(c.deps, c.taskId), basename(file)); // FORA dos artefatos até o stop
    mkdirSync(dirname(tmp), { recursive: true });
    try { unlinkSync(tmp); } catch { /* ok */ }
    writeFileSync(recLog(c), "");
    let pid: number, remote: string | undefined, devPid: number | undefined;
    if (plat === "ios") {
      pid = c.deps.spawnBg("xcrun", ["simctl", "io", iosOf(st).udid, "recordVideo", "--codec=h264", "--force", tmp], { env: xcodeEnv(c.deps), logFile: recLog(c) });
    } else {
      const { serial } = await androidOf(c, st);
      remote = `/data/local/tmp/starfork-rec-${c.taskId}.mp4`;
      // `exec` mantém o pid do shell: o screenrecord tem o pid que o echo mostra (pra parar SÓ ele, nunca pkill)
      pid = c.deps.spawnBg(needAdb(c), ["-s", serial, "shell", `echo STARFORK_PID=$$; exec screenrecord --time-limit ${ANDROID_REC_LIMIT_S} ${remote}`], { env: toolEnv(c.deps), logFile: recLog(c) });
    }
    await c.deps.sleep(1500);
    if (!(pid > 0) || !c.deps.alive(pid)) throw new MobileError("a gravação não começou", `veja o log em ${recLog(c)}`);
    if (plat === "android") {
      devPid = Number((readText(recLog(c)).match(/STARFORK_PID=(\d+)/) || [])[1]) || undefined;
      if (!devPid) { c.deps.signal(pid, "SIGTERM"); throw new MobileError("a gravação não começou no emulador", `veja o log em ${recLog(c)}`); }
    }
    st.rec = { plat, pid, sig: await procSig(c.deps, pid), tmp, file, remote, devPid, startedAt: c.deps.now() };
    saveState(c.deps, st);
    c.log(`● gravando ${plat === "ios" ? "o simulador" : `o emulador (máx. ${ANDROID_REC_LIMIT_S} s)`} → ${relArt(c, file)} — faça o fluxo e rode: cardume mobile rec stop`);
    return file;
  }
  if (action !== "stop") throw new MobileError(`ação desconhecida: rec ${action}`, "use: cardume mobile rec start | rec stop");
  const rec = st.rec;
  if (!rec) throw new MobileError("não há gravação em andamento", "comece com: cardume mobile rec start");
  const out = await finishRec(c, st);
  if (!out) throw new MobileError("o vídeo saiu vazio", `veja o log em ${recLog(c)}`);
  const secs = Math.round((c.deps.now() - rec.startedAt) / 1000);
  c.log(`✓ vídeo: ${relArt(c, out)} (${secs} s${rec.plat === "android" && secs >= ANDROID_REC_LIMIT_S ? `, cortado em ${ANDROID_REC_LIMIT_S} s pelo Android` : ""})`);
  return out;
}
/** Encerra a gravação (se ainda viva — só o PRÓPRIO processo), finaliza o mp4 e move pra pasta de artefatos.
 * Devolve o arquivo final, ou "" se não sobrou vídeo. Limpa o estado da gravação. Não lança. */
async function finishRec(c: MobileCtx, st: TaskMobileState): Promise<string> {
  const rec = st.rec;
  if (!rec) return "";
  try {
    if (rec.plat === "ios") {
      await signalIfSame(c.deps, rec, "SIGINT"); // o simctl fecha o mp4 no SIGINT
    } else if (st.android && rec.devPid) {
      // só o screenrecord DESTA gravação: confere a linha de comando do pid no aparelho antes do kill -2
      const cmd = await adb(c, ["-s", st.android.serial, "shell", "cat", `/proc/${rec.devPid}/cmdline`], 15_000).catch(() => null);
      if (cmd && cmd.code === 0 && cmd.stdout.includes("screenrecord") && (!rec.remote || cmd.stdout.includes(rec.remote))) {
        await adb(c, ["-s", st.android.serial, "shell", "kill", "-2", String(rec.devPid)], 15_000).catch(() => null);
      }
    }
    for (let i = 0; i < 40 && (await sameProc(c.deps, rec)); i++) await c.deps.sleep(500);
    if (await sameProc(c.deps, rec)) await signalIfSame(c.deps, rec, "SIGTERM");
    if (rec.plat === "android" && rec.remote && st.android) {
      await c.deps.sleep(1000); // o screenrecord termina de escrever o moov
      await adb(c, ["-s", st.android.serial, "pull", rec.remote, rec.tmp], 120_000);
      await adb(c, ["-s", st.android.serial, "shell", "rm", "-f", rec.remote]);
    }
  } catch { /* segue: o arquivo é conferido abaixo */ }
  st.rec = undefined;
  saveState(c.deps, st);
  if (!fileOk(rec.tmp)) { try { unlinkSync(rec.tmp); } catch { /* ok */ } return ""; }
  let file = rec.file;
  if (existsSync(file)) file = nextArtifact(dirname(file), rec.plat, "mp4"); // nome tomado nesse meio-tempo
  moveFile(rec.tmp, file);
  return file;
}

export async function mobileFlow(c: MobileCtx, plat: Platform, yaml: string): Promise<string[]> {
  const m = maestroBin(c.deps);
  if (!m) throw new MobileError("O Maestro não está instalado — sem fluxos de toque por enquanto; siga provando com `shot` e `rec`.", 'curl -fsSL "https://get.maestro.mobile.dev" | bash');
  const f = isAbsolute(yaml) ? yaml : resolve(c.cwd, yaml);
  if (!existsSync(f)) throw new MobileError(`fluxo não encontrado: ${yaml}`, "escreva o fluxo Maestro (.yaml com appId e passos tapOn/inputText/assertVisible/takeScreenshot) e passe o caminho");
  if (!javaHome(c.deps)) throw new MobileError("O Maestro precisa de Java (JDK 17).", "brew install openjdk@17");
  const st = stateOf(c);
  const device = plat === "ios" ? iosOf(st).udid : (await androidOf(c, st)).serial;
  const out = join(tmpdir(), `starfork-maestro-${c.taskId}-${c.deps.now()}`);
  mkdirSync(out, { recursive: true });
  const r = await c.deps.exec(m, ["--device", device, "test", f, "--test-output-dir", out], { env: toolEnv(c.deps), cwd: out, timeoutMs: 15 * 60_000 });
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
 * Desliga o que ESTA tarefa subiu: finaliza a gravação, desliga e APAGA o simulador iOS dedicado (só "Starfork-…";
 * se o delete falhar o estado FICA, pra tentar de novo), solta a trava do Android e desliga o emulador só se foi o
 * Starfork que subiu e ninguém mais usa/espera.
 */
export async function mobileDown(c: MobileCtx, only?: Platform): Promise<string[]> {
  const st = loadState(c.deps, c.taskId);
  const done: string[] = [];
  if (st.rec && (!only || st.rec.plat === only)) {
    const f = await finishRec(c, st);
    done.push(f ? `gravação finalizada: ${relArt(c, f)}` : "gravação encerrada");
  }
  if (st.ios && (!only || only === "ios")) {
    const { udid, name } = st.ios;
    if (name.startsWith("Starfork-")) {
      await xcrun(c, ["shutdown", udid], 60_000).catch(() => null);
      const del = await xcrun(c, ["delete", udid], 60_000).catch(() => ({ code: 1, stdout: "", stderr: "falhou" }));
      const gone = del.code === 0 || /Invalid device|could not be found/i.test(del.stderr);
      if (gone) { done.push(`simulador ${name} apagado`); st.ios = undefined; }
      else done.push(`não consegui apagar o simulador ${name} (${del.stderr.trim().slice(0, 120)}) — tento de novo na próxima limpeza`);
    } else st.ios = undefined;
  }
  if (st.android && (!only || only === "android")) {
    releaseAndroidLock(c.deps, c.taskId);
    done.push(await maybeStopOwnEmulator(c, st.android.serial));
    st.android = undefined;
  }
  saveState(c.deps, st);
  for (const d of done) c.log(`✓ ${d}`);
  return done;
}
/** Desliga o emulador que o STARFORK subiu, se ninguém está com a trava, esperando ou com estado Android vivo. */
async function maybeStopOwnEmulator(c: MobileCtx, serial: string, skipStateOf?: string): Promise<string> {
  const own = readJson<{ pid: number; sig?: string; serial: string }>(ANDROID_OWN(c.deps));
  if (!own || own.serial !== serial) return "emulador Android liberado (não foi o Starfork que subiu — fica como está)";
  const lockNow = readJson<LockRec>(ANDROID_LOCK(c.deps));
  const others = allStates(c.deps).some((s) => s.taskId !== c.taskId && s.taskId !== skipStateOf && s.android?.serial === serial);
  if (lockNow || freshWaiters(c.deps) || others) return "emulador Android liberado (segue ligado pra próxima tarefa)";
  await adb(c, ["-s", own.serial, "emu", "kill"], 30_000).catch(() => null);
  for (let i = 0; i < 20 && c.deps.alive(own.pid); i++) await c.deps.sleep(500);
  if (c.deps.alive(own.pid)) await signalIfSame(c.deps, { pid: own.pid, sig: own.sig ?? "" }, "SIGTERM");
  try { unlinkSync(ANDROID_OWN(c.deps)); } catch { /* ok */ }
  return `emulador ${own.serial} desligado`;
}
function allStates(d: Pick<MobileDeps, "home">): TaskMobileState[] {
  try {
    return readdirSync(tasksDir(d)).filter((f) => f.endsWith(".json")).map((f) => readJson<TaskMobileState>(join(tasksDir(d), f))).filter(Boolean) as TaskMobileState[];
  } catch { return []; }
}

/** A tarefa deixou algo de pé com `cardume mobile`? (checagem barata de arquivo; recebe o id REAL) */
export function hasMobileState(rawId: string, deps: Pick<MobileDeps, "home"> = { home: homedir() }): boolean {
  return existsSync(taskStateFile(deps, safeId(rawId)));
}
/** FIM DO TURNO (orquestrador): só solta a trava do Android desta tarefa. NÃO apaga o simulador (a próxima rodada
 * do chat reaproveita), não mexe na trava de turno da tarefa e nunca lança. */
export function mobileTurnRelease(rawId: string, deps: Pick<MobileDeps, "home"> = { home: homedir() }): boolean {
  try { return releaseAndroidLock(deps as MobileDeps, safeId(rawId)); } catch { return false; }
}
/** FIM DA TAREFA (merge/remoção): desliga e apaga tudo que ela subiu. Rápido e mudo sem estado; nunca lança. */
export async function mobileCleanup(rawId: string, worktree: string, deps: MobileDeps = realDeps()): Promise<string[]> {
  if (!hasMobileState(rawId, deps)) return [];
  try {
    return await mobileDown(makeCtx(rawId, worktree, deps));
  } catch { return []; /* limpeza nunca derruba o fluxo */ }
}

/** Status da tarefa no state.sqlite do repo dela: "missing" (apagada), o status, ou null (não deu pra ler). */
function taskStatusInRepo(wt: string, rawId: string): string | null {
  const repo = wt.split(/[\\/]\.cardume[\\/]/)[0];
  const db = join(repo, ".cardume", "state.sqlite");
  if (!existsSync(db)) return null;
  try {
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      const row = conn.prepare("SELECT * FROM task WHERE id = ?").get(rawId) as { status?: string; flag?: string } | undefined;
      if (!row) return "missing";
      return row.flag === "closed" ? "closed" : String(row.status ?? "");
    } finally { conn.close(); }
  } catch { return null; }
}
const DEAD_STATUS = new Set(["missing", "merged", "done", "cancelled", "closed"]);
/**
 * VARREDURA (doctor — roda no boot do app pelo Ambiente — e `cardume mobile down --sweep`): limpa o que sobrou de
 * tarefas que já acabaram: estado de tarefa sem worktree/apagada/mergeada, simulador "Starfork-*" sem dono e o
 * emulador que o Starfork subiu e ninguém usa. Nunca toca simulador/emulador da pessoa.
 */
export async function mobileSweep(deps: MobileDeps): Promise<string[]> {
  const done: string[] = [];
  for (const st of allStates(deps)) {
    const dead = !st.wt || !existsSync(st.wt) || (st.rawId ? DEAD_STATUS.has(taskStatusInRepo(st.wt, st.rawId) ?? "") : false);
    if (!dead) continue;
    const c: MobileCtx = { taskId: st.taskId, rawId: st.rawId ?? st.taskId, artDir: join(st.wt ?? tmpdir(), ".cardume", "artifacts"), cwd: st.wt ?? tmpdir(), deps, log: () => {} };
    done.push(...(await mobileDown(c).catch(() => [])));
    if (st.iosPending) { const s = loadState(deps, st.taskId); s.iosPending = undefined; saveState(deps, s); }
  }
  // simuladores "Starfork-*" que nenhuma tarefa viva reivindica (tarefa apagada pelo app, estado perdido…)
  if (deps.platform === "darwin") {
    const live = allStates(deps);
    const claimed = new Set(live.flatMap((s) => [s.ios?.udid ?? "", s.iosPending ?? "", s.ios?.name ?? ""]).filter(Boolean));
    const r = await deps.exec("xcrun", ["simctl", "list", "-j", "devices"], { env: xcodeEnv(deps), timeoutMs: 15_000 });
    if (r.code === 0) {
      for (const s of listSims(r.stdout)) {
        if (!/^Starfork-/.test(s.name) || claimed.has(s.udid) || claimed.has(s.name)) continue;
        await deps.exec("xcrun", ["simctl", "shutdown", s.udid], { env: xcodeEnv(deps), timeoutMs: 60_000 });
        const del = await deps.exec("xcrun", ["simctl", "delete", s.udid], { env: xcodeEnv(deps), timeoutMs: 60_000 });
        if (del.code === 0) done.push(`simulador órfão ${s.name} apagado`);
      }
    }
  }
  // emulador do Starfork sem ninguém: processo morto → esquece; vivo e sem uso → desliga
  const own = readJson<{ pid: number; sig?: string; serial: string }>(ANDROID_OWN(deps));
  if (own) {
    if (!deps.alive(own.pid)) { try { unlinkSync(ANDROID_OWN(deps)); } catch { /* ok */ } }
    else {
      const lk = readJson<LockRec>(ANDROID_LOCK(deps));
      let mt = 0; try { mt = statSync(ANDROID_LOCK(deps)).mtimeMs; } catch { /* sem trava */ }
      if (lk && !(await lockFresh(deps, lk, mt))) { try { unlinkSync(ANDROID_LOCK(deps)); } catch { /* ok */ } }
      if (!allStates(deps).some((s) => s.android?.serial === own.serial)) {
        const c: MobileCtx = { taskId: "_sweep", rawId: "_sweep", artDir: tmpdir(), cwd: tmpdir(), deps, log: () => {} };
        const msg = await maybeStopOwnEmulator(c, own.serial).catch(() => "");
        if (/desligado/.test(msg)) done.push(msg);
      }
    }
  }
  return done;
}

// ---------------------------------------------------------------- doctor (Ambiente do app + agente)
export interface DoctorItem { id: "ios" | "android" | "maestro" | "axe"; name: string; ok: boolean; detail: string; fix: string }
export async function mobileDoctor(deps: MobileDeps): Promise<DoctorItem[]> {
  const ios = async (): Promise<DoctorItem> => {
    if (deps.platform !== "darwin") return { id: "ios", name: "Simulador iOS (Xcode)", ok: false, detail: "só existe no macOS", fix: "" };
    const r = await deps.exec("xcrun", ["simctl", "list", "-j", "runtimes"], { env: xcodeEnv(deps), timeoutMs: 15_000 });
    const pick = r.code === 0 ? pickIphone(r.stdout) : null;
    return pick
      ? { id: "ios", name: "Simulador iOS (Xcode)", ok: true, detail: `${pick.runtimeName} · ${pick.deviceName} — cada tarefa ganha o seu simulador`, fix: "" }
      : { id: "ios", name: "Simulador iOS (Xcode)", ok: false, detail: r.code === 0 ? "Xcode sem runtime iOS instalado" : "Xcode não encontrado (só as Command Line Tools não bastam)", fix: r.code === 0 ? "xcodebuild -downloadPlatform iOS" : XCODE_FIX };
  };
  const android = async (): Promise<DoctorItem> => {
    const adb = adbBin(deps), emu = emulatorBin(deps);
    if (!adb || !emu) return { id: "android", name: "Emulador Android (SDK + AVD)", ok: false, detail: adb ? "adb ok, mas sem o emulador do SDK" : "Android SDK não encontrado", fix: sdkFix(deps) };
    const avds = (await deps.exec(emu, ["-list-avds"], { env: toolEnv(deps), timeoutMs: 15_000 })).stdout.split("\n").map((s) => s.trim());
    return avds.includes(ANDROID_AVD)
      ? { id: "android", name: "Emulador Android (SDK + AVD)", ok: true, detail: `${androidSdk(deps)} · AVD ${ANDROID_AVD}`, fix: "" }
      : { id: "android", name: "Emulador Android (SDK + AVD)", ok: false, detail: `SDK ok, mas sem o AVD ${ANDROID_AVD}`, fix: avdFix(deps) };
  };
  const maestro = (): DoctorItem => {
    const m = maestroBin(deps);
    const jh = javaHome(deps);
    return !m
      ? { id: "maestro", name: "Maestro (fluxos de toque)", ok: false, detail: "não instalado — os agentes provam só com prints e vídeos", fix: 'curl -fsSL "https://get.maestro.mobile.dev" | bash' }
      : !jh
        ? { id: "maestro", name: "Maestro (fluxos de toque)", ok: false, detail: `${m} — falta o Java (JDK 17)`, fix: "brew install openjdk@17" }
        : { id: "maestro", name: "Maestro (fluxos de toque)", ok: true, detail: `${m} · Java ${jh}`, fix: "" };
  };
  const axe = (): DoctorItem => {
    const a = axeBin(deps);
    return a
      ? { id: "axe", name: "AXe (tocar no Simulador iOS pelo app)", ok: true, detail: `${a} — clique vira toque, teclado vira texto no painel Dispositivo`, fix: "" }
      : { id: "axe", name: "AXe (tocar no Simulador iOS pelo app)", ok: false, detail: "não instalado — o painel Dispositivo mostra o iPhone ao vivo, mas só pra ver (sem tocar)", fix: AXE_FIX };
  };
  // em paralelo: o Ambiente espera o mais lento, não a soma
  const [a, b] = await Promise.all([ios(), android()]);
  return deps.platform === "darwin" ? [a, b, maestro(), axe()] : [a, b, maestro()];
}

// ---------------------------------------------------------------- prova mobile no gate da entrega
/** Requisito VISUAL: `"visual": true` no requirements.json manda; sem a marca, o texto decide. */
export const VISUAL_RE = /\b(tela|telas|ui|ux|layout|visual|bot[ãa]o|bot[õo]es|[íi]cones?|modal|p[áa]gina|screens?|buttons?|exib\w*|mostr\w*|aparec\w*|anima\w*|formul[áa]rio|card|cards|lista|navega\w*|estilo|cores?|tema|dark mode|responsiv\w*)\b/i;
export const PROOF_MEDIA_RE = /\.(png|jpe?g|webp|gif|mp4|m4v|mov|webm)$/i;
/** Arquivo de TELA do app (pra regra no nível da tarefa quando nenhum requisito é marcado como visual). */
export const UI_FILE_RE = /\.(tsx|jsx|swift|kt|dart|vue|storyboard|xib)$|(^|\/)res\/(layout|drawable)[^/]*\//i;
export const MOBILE_GAP = "faltou print/vídeo do app rodando no simulador";
/**
 * Lacunas de PROVA VISUAL num projeto mobile: requisito visual "done" sem print/vídeo existente; e, se nenhum
 * requisito é visual mas a tarefa mexeu em arquivo de tela, a tarefa inteira sem nenhum print/vídeo. Requisito
 * não-visual segue só com a regra geral (evidência existente).
 */
export function mobileProofGaps(list: Array<{ req?: string; status?: string; evidence?: string[]; visual?: boolean }>, uiChanged: boolean, mediaOk: (e: string) => boolean): string[] {
  const out: string[] = [];
  const done = list.filter((r) => r && r.status === "done");
  const isVisual = (r: { req?: string; visual?: boolean }) => r.visual === true || (r.visual !== false && VISUAL_RE.test(String(r.req ?? "")));
  const hasMedia = (r: { evidence?: string[] }) => (Array.isArray(r.evidence) ? r.evidence : []).some((e) => PROOF_MEDIA_RE.test(String(e)) && mediaOk(String(e)));
  const visual = done.filter(isVisual);
  for (const r of visual) if (!hasMedia(r)) out.push(`${MOBILE_GAP}: ${String(r.req ?? "requisito").slice(0, 70)}`);
  if (!visual.length && uiChanged && done.length && !done.some(hasMedia)) out.push(`${MOBILE_GAP}/emulador (a tarefa mudou telas do app e nenhum requisito tem print ou vídeo)`);
  return out;
}

// ---------------------------------------------------------------- roteiro pros motores
/** Caminho do CLI que os agentes chamam: CARDUME_CLI → este bundle (cli.mjs do app empacotado, onde este módulo
 * vive DENTRO do cli.mjs) → src/cli.ts ao lado deste arquivo (dev). Igual ao jeito que o motor acha o server MCP. */
export function selfCliPath(): string {
  if (process.env.CARDUME_CLI && existsSync(process.env.CARDUME_CLI)) return process.env.CARDUME_CLI;
  const here = fileURLToPath(import.meta.url);
  if (/mobile\.(ts|js|mjs)$/.test(here)) return join(dirname(here), "cli.ts");
  return here; // empacotado: o módulo É o cli.mjs
}
/** Escapa pro shell do agente: aspas simples no POSIX ('…'\''…'), aspas duplas no Windows. */
export function shq(s: string, plat: NodeJS.Platform = process.platform): string {
  if (plat === "win32") return `"${String(s).replace(/"/g, '""')}"`;
  return /^[A-Za-z0-9_\/.:=@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}
/** Prefixo EXATO do comando pro agente (node + CLI; tarefa, worktree e dono do turno amarrados). */
export function mobileCmd(rawTaskId: string, worktree: string, ownerPid = process.pid): string {
  const node = [process.execPath, ...process.execArgv.filter((a) => a === "--experimental-sqlite"), "--disable-warning=ExperimentalWarning"];
  return [...node.map((x) => shq(x)), shq(selfCliPath()), "mobile", "--task", shq(rawTaskId), "--wt", shq(worktree), "--owner", String(ownerPid)].join(" ");
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
  if (p.expo) how.push("Expo: Expo Go, SEM CocoaPods/prebuild — suba o Metro em segundo plano (`CI=1 npx expo start --port 8081 &`), depois `M launch exp://127.0.0.1:8081` (no Android o Starfork faz o adb reverse); se o Expo Go faltar, rode uma vez `npx expo start --ios` (ou --android, que instala o Expo Go no emulador) e repita o launch");
  else if (p.reactNative) how.push("React Native (bare): `npx react-native run-ios --udid <udid do up>` / `npx react-native run-android --deviceId <serial do up>`");
  else if (p.flutter) how.push("Flutter: `flutter run -d <udid do up>` (iOS) / `flutter run -d <serial do up>` (Android) — deixe rodando em segundo plano e prove com shot/rec");
  else if (p.capacitor) how.push("Capacitor: `npx cap sync` e `npx cap run ios --target <udid do up>` / `npx cap run android --target <serial do up>`");
  if (p.iosNative && !p.expo && !p.reactNative && !p.flutter && !p.capacitor) how.push("iOS nativo: `xcodebuild -scheme <Scheme> -destination id=<udid do up> -derivedDataPath .cardume/tmp/dd build`, depois `M install .cardume/tmp/dd/Build/Products/Debug-iphonesimulator/<App>.app` e `M launch <bundle id>`");
  if (p.androidNative && !p.expo && !p.reactNative && !p.flutter && !p.capacitor) how.push("Android nativo: `./gradlew assembleDebug`, depois `M install app/build/outputs/apk/debug/app-debug.apk` e `M launch <pacote>`");
  return (
    ` PROVAS MOBILE (este projeto é ${p.label}): prove NA TELA do simulador/emulador — NUNCA descreva a tela lendo o código. Use SEMPRE a ferramenta do Starfork (chamada M abaixo):\n` +
    `M = ${cmd}\n` +
    `(M é só abreviação neste texto — no terminal rode SEMPRE o comando completo, ex.: ${cmd} up --platform ios)\n` +
    `- \`M doctor\` mostra o que existe nesta máquina (Xcode, Android SDK/AVD, Maestro).\n` +
    `- \`M up --platform ios\` cria e liga um Simulador iOS SÓ desta tarefa (imprime o udid; ele continua de pé entre as rodadas). \`M up --platform android\` liga o emulador Android — é UM por máquina: se outra tarefa estiver usando, espera até 90 s e responde "ocupado"; tente de novo em ~1 min (ou acrescente --wait 300).\n` +
    `- Compile e rode: ${how.join("; ")}.\n` +
    `- \`M shot [nome]\` tira um PRINT → .cardume/artifacts/mobile-<plat>-<n>[-nome].png — no MÍNIMO 1 print por requisito visual.\n` +
    `- \`M rec start\` … faça o fluxo principal … \`M rec stop\` grava um VÍDEO curto (Android corta em 180 s) → .cardume/artifacts/mobile-<plat>-<n>.mp4 — no MÍNIMO 1 vídeo do fluxo principal.\n` +
    `- \`M flow <arquivo.yaml>\` roda um fluxo de toques com Maestro (takeScreenshot vira artefato); sem Maestro, siga com shot/rec.\n` +
    `- Com os dois (iOS e Android) de pé, acrescente --platform ios|android nos comandos. \`M down\` desliga tudo desta tarefa (o Starfork também apaga sozinho quando a tarefa acaba).\n` +
    `- CITE os arquivos (ex.: "mobile-ios-1.png", "mobile-ios-1.mp4") no "evidence" de cada requisito no .cardume/artifacts/requirements.json e marque "visual": true nos requisitos de tela — a entrega é REPROVADA se requisito visual não tiver print/vídeo. Se M der erro, ele já diz a correção: não instale Xcode/SDK/Maestro por conta própria — pergunte ao humano.`
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
      // varredura junto: o Ambiente roda o doctor no boot do app → limpa sobras de tarefas que acabaram
      const [items, swept] = await Promise.all([mobileDoctor(deps), mobileSweep(deps).catch(() => [] as string[])]);
      // sem --wt NÃO varre pasta nenhuma (o app aberto pelo Finder tem cwd "/")
      const proj = argv.flags.wt ? detectMobileProject(argv.flags.wt) : null;
      if (json) { out(JSON.stringify({ items, swept, project: proj ? { ...proj, mobile: isMobileProject(proj) } : null })); return 0; }
      for (const it of items) out(`${it.ok ? "✓" : "–"} ${it.name}: ${it.detail}${it.fix ? `\n    como resolver: ${it.fix}` : ""}`);
      for (const s of swept) out(`  limpeza: ${s}`);
      if (proj) out(`  projeto: ${isMobileProject(proj) ? proj.label : "não parece app mobile"}`);
      return 0;
    }
    const wt = argv.flags.wt || findWorktree(process.cwd()) || process.cwd();
    const rawTask = argv.flags.task || process.env.CARDUME_TASK || taskIdFromYaml(wt);
    if (!rawTask) throw new MobileError("não sei de qual tarefa é este comando", "rode de dentro da worktree da tarefa ou passe --task <id>");
    const waitS = Number(argv.flags.wait);
    const owner = Number(argv.flags.owner);
    const viewer = argv.flags.viewer === "true";
    const c = makeCtx(rawTask, wt, deps, out, {
      // painel (pessoa): não espera a trava do Android — ocupado responde na hora
      waitMs: viewer ? 0 : argv.flags.wait !== undefined && Number.isFinite(waitS) && waitS >= 0 ? waitS * 1000 : undefined,
      ownerPid: Number.isFinite(owner) && owner > 0 ? owner : undefined,
      viewer,
    });
    const st = loadState(deps, c.taskId);
    const plat = () => resolvePlatform(st, argv.flags.platform);
    switch (sub) {
      case "up": {
        const p = argv.flags.platform;
        if (p !== "ios" && p !== "android") throw new MobileError("diga a plataforma", "cardume mobile up --platform ios (ou android)");
        try {
          await mobileUp(c, p, { deviceType: argv.flags.device, runtime: argv.flags.runtime, avd: argv.flags.avd });
        } finally {
          // ligado pelo PAINEL (pessoa): não fica com a trava do Android — nem quando a subida FALHA (sem dono, a
          // trava velha valeria 30 min e travaria os agentes de todas as tarefas)
          if (p === "android" && viewer) releaseAndroidLock(deps, c.taskId);
        }
        return 0;
      }
      case "info": {
        const { deviceInfo } = await import("./device.ts");
        out(JSON.stringify(await deviceInfo(c)));
        return 0;
      }
      case "mirror": {
        const p = argv.flags.platform;
        if (p !== "ios" && p !== "android") throw new MobileError("diga a plataforma", "cardume mobile mirror --platform ios (ou android)");
        const { runMirror } = await import("./device.ts");
        await runMirror({ ...c, viewer: true }, p, out);
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
        // a PESSOA não desliga o emulador no meio do turno de um agente (desta ou de outra tarefa)
        if (viewer && argv.flags.platform !== "ios") {
          const h = await androidLockHolder(deps);
          if (h && !h.mine && loadState(deps, c.taskId).android) throw new MobileError(`o emulador Android está em uso pelo agente${h.taskId === c.taskId ? " desta tarefa" : ` da tarefa ${h.taskId}`}`, "espere o agente terminar o turno e desligue de novo");
        }
        const done = await mobileDown(c, argv.flags.platform === "ios" || argv.flags.platform === "android" ? argv.flags.platform : undefined);
        if (!done.length) out("nada de pé pra esta tarefa");
        return 0;
      }
      default:
        out(`uso: cardume mobile doctor [--json]
       cardume mobile up --platform ios|android [--wait <s>]
       cardume mobile install <App.app|app.apk>
       cardume mobile launch <bundleId|pacote|exp://…>
       cardume mobile shot [nome]
       cardume mobile rec start|stop
       cardume mobile flow <fluxo.yaml>     (Maestro)
       cardume mobile down
       cardume mobile info                  (JSON: projeto, aparelhos, o que está de pé — painel Dispositivo)
       cardume mobile mirror --platform ios|android   (espelho ao vivo pro painel Dispositivo; 1ª linha = porta/token)
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
