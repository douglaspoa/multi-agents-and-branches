// Painel DISPOSITIVO (spec-dispositivo-no-app): o Simulador iOS e o emulador Android DA TAREFA ao vivo dentro do app.
//
//  - `cardume mobile mirror --platform ios|android` sobe um servidor HTTP LOCAL (127.0.0.1, porta aleatória, token
//    aleatório) e imprime UMA linha JSON `{"port","token"}` — o Rust (device.rs) lê só essa linha, sem segurar nada.
//  - GET /stream: corpo binário em pedaços `[tipo u8][tamanho u32 BE][dados]` (0 = meta JSON, 1 = imagem JPEG/PNG,
//    2 = H.264 access unit, 3 = H.264 access unit CHAVE). O front lê com fetch()+ReadableStream e desenha num canvas.
//  - iOS: `sfsim` (Objective-C, compilado na máquina com o clang do Xcode no 1º uso) lê o framebuffer IOSurface do
//    CoreSimulator e só codifica JPEG (pela GPU) quando a tela MUDA — ~28 fps rolando com ~7 % de CPU, 0 parado.
//    Sem o helper: prints `simctl io screenshot` a ~2 fps. Toque/texto/botões: AXe (`axe tap|swipe|type|key|button`).
//  - Android: `adb exec-out screenrecord --output-format=h264` (só manda quadro quando a tela muda) → WebCodecs no
//    front; sem WebCodecs → `?codec=image` (screencap a ~2 fps). Toque AO VIVO pelo console do emulador
//    (`event mouse`, `event text`, `event send EV_KEY`, `rotate`) — uma conexão TCP, custo ~0 (o `adb shell input`
//    sobe uma JVM no aparelho a cada comando: ~2 núcleo·s). Respeita a TRAVA do emulador (agente usando → só ver).
//  - Ciclo de vida: a captura só roda com UM cliente no /stream (o painel visível); sem cliente por 3 s ela para;
//    sem nenhum pedido por 60 s, ou com o stdin fechado (o app morreu), o processo sai.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { basename, join } from "node:path";
import {
  acquireAndroidLock, adbBin, androidLockHolder, axeBin, releaseAndroidLockOf, detectMobileProject, emulatorBin, iosModels, isMobileProject, listSims, loadState, MobileError, mobileRec,
  mobileShot, toolEnv, xcodeEnv, ANDROID_AVD, type MobileCtx, type MobileDeps, type Platform,
} from "./mobile.ts";

// ---------------------------------------------------------------- entrada: clique (0..1) → toque no aparelho
export interface Screen { w: number; h: number; ptScale: number; /** Android girado em relação à posição natural */ rotated?: boolean }
export type InputEv =
  | { t: "tap"; x: number; y: number }
  | { t: "swipe"; x: number; y: number; x2: number; y2: number; ms?: number }
  | { t: "down" | "move" | "up"; x: number; y: number }
  | { t: "text"; text: string }
  | { t: "key"; key: "backspace" | "enter" | "tab" | "escape" }
  | { t: "button"; name: "home" | "back" | "lock" | "recents" };
const c01 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; };
/** Posição normalizada (0..1 na tela mostrada) → unidade do aparelho: PONTOS no iOS (AXe), PIXELS no Android (console). */
export function toDevice(s: Screen, plat: Platform, x: number, y: number): { x: number; y: number } {
  const k = plat === "ios" ? Math.max(1, s.ptScale || 1) : 1;
  const W = s.w / k, H = s.h / k;
  return { x: Math.round(Math.min(W - 1, c01(x) * W)), y: Math.round(Math.min(H - 1, c01(y) * H)) };
}
/** Valida o que chega do front (JSON livre) — nada de texto gigante nem tipo desconhecido. */
export function parseInput(raw: unknown): InputEv | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  switch (o.t) {
    case "tap": case "down": case "move": case "up": return { t: o.t, x: c01(o.x), y: c01(o.y) };
    case "swipe": return { t: "swipe", x: c01(o.x), y: c01(o.y), x2: c01(o.x2), y2: c01(o.y2), ms: Math.min(3000, Math.max(50, Number(o.ms) || 300)) };
    case "text": { const text = String(o.text ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 500); return text ? { t: "text", text } : null; }
    case "key": return ["backspace", "enter", "tab", "escape"].includes(String(o.key)) ? { t: "key", key: o.key as "enter" } : null;
    case "button": return ["home", "back", "lock", "recents"].includes(String(o.name)) ? { t: "button", name: o.name as "home" } : null;
    default: return null;
  }
}
/** HID usage (teclado) pro `axe key`. */
const IOS_KEYS: Record<string, number> = { enter: 40, escape: 41, backspace: 42, tab: 43 };
/** iOS → argumentos do AXe (cada item é UM processo `axe …`). null = não existe no iOS (ex.: voltar). */
export function iosAxeArgs(ev: InputEv, udid: string, s: Screen): string[][] | null {
  const u = ["--udid", udid];
  switch (ev.t) {
    case "tap": { const p = toDevice(s, "ios", ev.x, ev.y); return [["tap", "-x", String(p.x), "-y", String(p.y), "--tap-style", "physical", ...u]]; }
    case "swipe": {
      const a = toDevice(s, "ios", ev.x, ev.y), b = toDevice(s, "ios", ev.x2, ev.y2);
      // `drag` (toques baixo nível) e não `swipe`: o swipe do AXe consulta a acessibilidade e falha num simulador
      // recém-ligado ("No translation object returned")
      const ms = ev.ms ?? 300;
      return [["drag", "--start-x", String(a.x), "--start-y", String(a.y), "--end-x", String(b.x), "--end-y", String(b.y), "--duration", (ms / 1000).toFixed(2), "--steps", String(Math.max(10, Math.min(60, Math.round(ms / 16)))), ...u]];
    }
    case "text": return [["type", ...u, "--", ev.text]]; // "--": texto começando com "-" não vira opção
    case "key": return [["key", String(IOS_KEYS[ev.key]), ...u]];
    case "button": return ev.name === "home" ? [["button", "home", ...u]] : ev.name === "lock" ? [["button", "lock", ...u]] : null;
    default: return null; // down/move/up: no iOS o gesto vai inteiro no soltar (cada `axe` é um processo)
  }
}
const ANDROID_KEYS: Record<string, string> = { backspace: "KEY_BACKSPACE", enter: "KEY_ENTER", tab: "KEY_TAB", escape: "KEY_ESC", home: "KEY_HOMEPAGE", back: "KEY_BACK", lock: "KEY_POWER", recents: "KEY_APPSELECT" };
const keyPress = (k: string) => `event send EV_KEY:${k}:1 EV_KEY:${k}:0`;
/** Android → linhas do CONSOLE do emulador (pixels do aparelho). Arrastar é AO VIVO: down/move com botão 1, up com 0. */
export function androidConsoleLines(ev: InputEv, s: Screen): string[] {
  const at = (x: number, y: number, b: 0 | 1) => { const p = toDevice(s, "android", x, y); return `event mouse ${p.x} ${p.y} 0 ${b}`; };
  switch (ev.t) {
    case "tap": return [at(ev.x, ev.y, 1), at(ev.x, ev.y, 0)];
    case "down": case "move": return [at(ev.x, ev.y, 1)];
    case "up": return [at(ev.x, ev.y, 0)];
    case "swipe": {
      const n = Math.max(4, Math.min(30, Math.round((ev.ms ?? 300) / 16)));
      const out: string[] = [];
      for (let i = 0; i <= n; i++) out.push(at(ev.x + ((ev.x2 - ev.x) * i) / n, ev.y + ((ev.y2 - ev.y) * i) / n, 1));
      out.push(at(ev.x2, ev.y2, 0));
      return out;
    }
    // espaço no `event text` some; o resto é mapeado pelo teclado do aparelho
    case "text": return ev.text.split(/( )/).filter(Boolean).map((p) => (p === " " ? keyPress("KEY_SPACE") : `event text ${p}`));
    case "key": return [keyPress(ANDROID_KEYS[ev.key])];
    case "button": return [keyPress(ANDROID_KEYS[ev.name])];
  }
}
/** Aspas simples POSIX pro shell do aparelho (`adb shell` junta e re-interpreta os argumentos). */
export const shQuote = (t: string) => `'${String(t).replace(/'/g, `'\\''`)}'`;
const ADB_KEYS: Record<string, string> = { backspace: "67", enter: "66", tab: "61", escape: "111", home: "3", back: "4", lock: "26", recents: "187" };
/** Android pelo `adb shell input` (coordenadas LÓGICAS, já com a rotação): aparelho físico ou emulador GIRADO — o
 * `event mouse` do console fala em coordenadas da posição natural. Arrasto vira um `swipe` só no soltar. */
export function androidAdbInput(ev: InputEv, s: Screen, dragStart?: { x: number; y: number; at: number }, now = Date.now()): string[][] {
  const P = (x: number, y: number) => { const p = toDevice(s, "android", x, y); return [String(p.x), String(p.y)]; };
  const sh = shQuote;
  switch (ev.t) {
    case "tap": return [["shell", "input", "tap", ...P(ev.x, ev.y)]];
    case "swipe": return [["shell", "input", "swipe", ...P(ev.x, ev.y), ...P(ev.x2, ev.y2), String(ev.ms ?? 300)]];
    case "down": case "move": return [];
    case "up": {
      if (!dragStart) return [["shell", "input", "tap", ...P(ev.x, ev.y)]];
      const far = Math.hypot(ev.x - dragStart.x, ev.y - dragStart.y) >= 0.012;
      return far ? [["shell", "input", "swipe", ...P(dragStart.x, dragStart.y), ...P(ev.x, ev.y), String(Math.max(80, Math.min(2000, now - dragStart.at)))]] : [["shell", "input", "tap", ...P(ev.x, ev.y)]];
    }
    case "text": return [["shell", "input", "text", sh(ev.text.replace(/ /g, "%s"))]];
    case "key": return [["shell", "input", "keyevent", ADB_KEYS[ev.key]]];
    case "button": return [["shell", "input", "keyevent", ADB_KEYS[ev.name]]];
  }
}
/** Porta do console a partir do serial (`emulator-5584` → 5584). Aparelho físico → null. */
export const consolePort = (serial: string) => { const m = /^emulator-(\d+)$/.exec(serial); return m ? Number(m[1]) : null; };

// ---------------------------------------------------------------- H.264 Annex-B → access units
export interface AU { data: Buffer; key: boolean }
/** Junta NALs em access units (SPS/PPS/SEI vão junto do próximo slice). O screenrecord do emulador manda 1 slice por
 * quadro; um NAL só é dado como completo quando o próximo começo de NAL chega, ou no `flush()` (o servidor chama
 * quando o pipe fica ~15 ms parado — o último quadro de uma tela que parou não fica preso). */
export class AnnexB {
  private buf: Buffer = Buffer.alloc(0);
  private pend: Buffer[] = [];
  push(chunk: Buffer): AU[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const starts: number[] = [];
    for (let i = 0; i + 3 <= this.buf.length; i++) {
      if (this.buf[i] === 0 && this.buf[i + 1] === 0 && (this.buf[i + 2] === 1 || (this.buf[i + 2] === 0 && this.buf[i + 3] === 1))) {
        starts.push(i);
        i += this.buf[i + 2] === 1 ? 2 : 3;
      }
    }
    const out: AU[] = [];
    if (starts.length < 2) return out;
    for (let k = 0; k < starts.length - 1; k++) this.nal(this.buf.subarray(starts[k], starts[k + 1]), out);
    this.buf = Buffer.from(this.buf.subarray(starts[starts.length - 1]));
    return out;
  }
  flush(): AU[] {
    const out: AU[] = [];
    if (this.buf.length) { this.nal(this.buf, out); this.buf = Buffer.alloc(0); }
    return out;
  }
  private nal(n: Buffer, out: AU[]) {
    const hdr = n[2] === 1 ? 3 : 4;
    const type = (n[hdr] ?? 0) & 31;
    this.pend.push(Buffer.from(n));
    if (type === 1 || type === 5) {
      const data = Buffer.concat(this.pend);
      this.pend = [];
      out.push({ data, key: type === 5 });
    }
  }
}
/** Um pedaço do /stream. */
export function frame(kind: 0 | 1 | 2 | 3, data: Buffer): Buffer {
  const h = Buffer.alloc(5);
  h[0] = kind;
  h.writeUInt32BE(data.length, 1);
  return Buffer.concat([h, data]);
}

// ---------------------------------------------------------------- sfsim (framebuffer do Simulador iOS)
/** Fonte do helper — compilada NA MÁQUINA (clang do Xcode) no 1º uso. Lê a IOSurface da tela principal pelo
 * CoreSimulator (o mesmo caminho do idb), sem permissão de gravação de tela; codifica JPEG pela GPU só quando há
 * "damage"; sai quando o stdin fecha. Saída: [u32 tamanho][u32 largura][u32 altura][JPEG]. 1ª linha do stderr = meta. */
export const SFSIM_SRC = String.raw`#import <Foundation/Foundation.h>
#import <CoreImage/CoreImage.h>
#import <IOSurface/IOSurface.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#include <unistd.h>
#include <signal.h>
#include <arpa/inet.h>
#define MSG(T, ...) ((T(*)(id, SEL, ##__VA_ARGS__))objc_msgSend)
static id gSurface; static volatile int gDirty = 1; static IOSurfaceRef gIOS = NULL;
static void writeAll(const void *b, size_t n){ const char *p=b; while(n){ ssize_t w=write(1,p,n); if(w<=0) exit(0); p+=w; n-=w; } }
int main(int argc, char **argv){ @autoreleasepool {
  if(argc < 3){ fprintf(stderr, "uso: sfsim <udid> <developerDir> [fps] [escala] [qualidade]\n"); return 2; }
  signal(SIGPIPE, SIG_DFL);
  NSString *udid=@(argv[1]), *dev=@(argv[2]);
  double fps = argc>3 ? atof(argv[3]) : 30, scale = argc>4 ? atof(argv[4]) : 0.5, q = argc>5 ? atof(argv[5]) : 0.7;
  if(fps<1) fps=1; if(fps>60) fps=60; if(scale<0.1||scale>1) scale=0.5; if(q<0.1||q>1) q=0.7;
  if(!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)){ fprintf(stderr,"{\"error\":\"CoreSimulator ausente\"}\n"); return 3; }
  dlopen([[dev stringByAppendingString:@"/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"] UTF8String], RTLD_NOW);
  NSError *err=nil;
  id sc=MSG(id, id, NSError**)(NSClassFromString(@"SimServiceContext"), NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"), dev, &err);
  id set=sc?MSG(id, NSError**)(sc, NSSelectorFromString(@"defaultDeviceSetWithError:"), &err):nil;
  id device=nil; for(id d in [set valueForKey:@"devices"]) if([[[d valueForKey:@"UDID"] UUIDString] isEqualToString:udid]) device=d;
  if(!device){ fprintf(stderr,"{\"error\":\"simulador não encontrado\"}\n"); return 4; }
  double ptScale=1; @try { ptScale=[[device valueForKeyPath:@"deviceType.mainScreenScale"] doubleValue]; } @catch(id e){ }
  id io=[device valueForKey:@"io"];
  Protocol *pSurf=objc_getProtocol("SimDisplayIOSurfaceRenderable"), *pRend=objc_getProtocol("SimDisplayRenderable");
  for(id port in MSG(id)(io, NSSelectorFromString(@"ioPorts"))){
    id d=MSG(id)(port, NSSelectorFromString(@"descriptor"));
    if(![d conformsToProtocol:pSurf] || ![d conformsToProtocol:pRend]) continue;
    unsigned short cls=0; @try { id st=MSG(id)(d, NSSelectorFromString(@"state")); cls=MSG(unsigned short)(st, NSSelectorFromString(@"displayClass")); } @catch(id e){ }
    if(cls!=0) continue;
    gSurface=d; break;
  }
  if(!gSurface){ fprintf(stderr,"{\"error\":\"tela do simulador indisponível (ligado?)\"}\n"); return 5; }
  NSUUID *uid=[NSUUID UUID];
  dispatch_queue_t qq=dispatch_queue_create("sfsim", DISPATCH_QUEUE_SERIAL);
  void (^setSurf)(id)=^(id s){ dispatch_async(qq, ^{ if(gIOS) CFRelease(gIOS); gIOS = s ? (IOSurfaceRef)CFRetain((__bridge CFTypeRef)s) : NULL; gDirty=1; }); };
  setSurf(MSG(id)(gSurface, NSSelectorFromString(@"framebufferSurface")));
  MSG(void, id, id)(gSurface, NSSelectorFromString(@"registerCallbackWithUUID:ioSurfacesChangeCallback:"), uid, ^(id a, id b){ setSurf(a ?: b); });
  MSG(void, id, id)(gSurface, NSSelectorFromString(@"registerCallbackWithUUID:damageRectanglesCallback:"), uid, ^(NSArray *r){ gDirty=1; });
  dispatch_async(dispatch_get_global_queue(0,0), ^{ char b[64]; while(read(0,b,sizeof b)>0){} exit(0); });
  CIContext *ctx=[CIContext contextWithOptions:@{kCIContextCacheIntermediates:@NO}];
  CGColorSpaceRef cs=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  __block int announced=0;
  dispatch_source_t t=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,qq);
  dispatch_source_set_timer(t, DISPATCH_TIME_NOW, (uint64_t)(NSEC_PER_SEC/fps), NSEC_PER_MSEC*2);
  dispatch_source_set_event_handler(t, ^{ @autoreleasepool {
    if(!gDirty || !gIOS) return;
    gDirty=0;
    size_t w=IOSurfaceGetWidth(gIOS), h=IOSurfaceGetHeight(gIOS);
    if(!announced){ fprintf(stderr,"{\"w\":%zu,\"h\":%zu,\"pointScale\":%g}\n", w, h, ptScale); fflush(stderr); announced=1; }
    CIImage *img=[CIImage imageWithIOSurface:gIOS];
    if(scale<0.999) img=[img imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
    NSData *jpg=[ctx JPEGRepresentationOfImage:img colorSpace:cs options:@{(id)kCGImageDestinationLossyCompressionQuality:@(q)}];
    if(!jpg.length) return;
    uint32_t hdr[3]={ htonl((uint32_t)jpg.length), htonl((uint32_t)w), htonl((uint32_t)h) };
    writeAll(hdr, sizeof hdr); writeAll(jpg.bytes, jpg.length);
  }});
  dispatch_resume(t);
  dispatch_main();
}}
`;
const sfsimHash = () => createHash("sha1").update(SFSIM_SRC).digest("hex").slice(0, 10);
export const sfsimPath = (d: Pick<MobileDeps, "home">) => join(d.home, ".constellation", "mobile", "bin", `sfsim-${sfsimHash()}`);
/** Compila o sfsim se ainda não existe (uma vez por versão da fonte). Falhou → null (o espelho cai pros prints). */
export async function ensureSfsim(d: MobileDeps): Promise<string | null> {
  if (d.platform !== "darwin") return null;
  const bin = sfsimPath(d);
  if (existsSync(bin)) return bin;
  // falhou há pouco (sem Xcode, clang quebrado): não recompila a cada conexão — tenta de novo em 10 min
  const failMark = `${bin}.falhou`;
  try { if (Date.now() - Number(readFileSync(failMark, "utf8")) < 10 * 60_000) return null; } catch { /* sem marca */ }
  const dir = join(bin, "..");
  mkdirSync(dir, { recursive: true });
  const src = join(dir, `sfsim-${sfsimHash()}.${process.pid}.${randomBytes(4).toString("hex")}.m`);
  writeFileSync(src, SFSIM_SRC);
  const tmp = `${bin}.${process.pid}.tmp`;
  const r = await d.exec("xcrun", ["clang", "-fobjc-arc", "-O2", "-w", "-framework", "Foundation", "-framework", "CoreImage", "-framework", "IOSurface",
    "-framework", "CoreGraphics", "-framework", "ImageIO", "-o", tmp, src], { env: xcodeEnv(d), timeoutMs: 120_000 });
  try { rmSync(src, { force: true }); } catch { /* ok */ }
  if (r.code !== 0 || !existsSync(tmp)) { try { rmSync(tmp, { force: true }); writeFileSync(failMark, String(Date.now())); } catch { /* ok */ } return null; }
  renameSync(tmp, bin);
  return bin;
}

// ---------------------------------------------------------------- info pro painel (abre rápido; nada pesado)
export interface DeviceInfo {
  mobile: boolean;
  label: string;
  platforms: Platform[];
  ios: { up: boolean; udid?: string; device?: string; runtime?: string; deviceType?: string; options: Array<{ id: string; runtime: string; label: string }>; touch: boolean; touchFix: string } | null;
  android: { up: boolean; serial?: string; avd?: string; options: Array<{ id: string; label: string }>; busyBy: string | null } | null;
}
export async function deviceInfo(c: MobileCtx): Promise<DeviceInfo> {
  const d = c.deps;
  const p = detectMobileProject(c.cwd);
  const mobile = isMobileProject(p);
  const st = loadState(d, c.taskId);
  const wantsIos = p.iosNative || p.expo || p.reactNative || p.flutter || p.capacitor;
  const wantsAnd = p.androidNative || p.expo || p.reactNative || p.flutter || p.capacitor;
  const platforms: Platform[] = [];
  let ios: DeviceInfo["ios"] = null, android: DeviceInfo["android"] = null;
  const jobs: Promise<void>[] = [];
  if (mobile && wantsIos && d.platform === "darwin") {
    platforms.push("ios");
    jobs.push((async () => {
      const r = await d.exec("xcrun", ["simctl", "list", "-j", "runtimes"], { env: xcodeEnv(d), timeoutMs: 15_000 });
      const models = r.code === 0 ? iosModels(r.stdout) : [];
      const newest = models[0]?.runtime;
      const options = curateIosOptions(models.filter((m) => m.runtime === newest), st.ios?.device);
      let up = false;
      if (st.ios) {
        const dv = await d.exec("xcrun", ["simctl", "list", "-j", "devices"], { env: xcodeEnv(d), timeoutMs: 15_000 });
        up = dv.code === 0 && listSims(dv.stdout).some((x) => x.udid === st.ios!.udid && x.state === "Booted");
      }
      const axe = axeBin(d);
      const deviceType = st.ios?.deviceType ?? options.find((o) => st.ios && o.label.startsWith(st.ios.device + " ·"))?.id;
      ios = { up, udid: st.ios?.udid, device: st.ios?.device, runtime: st.ios?.runtime, deviceType, options, touch: !!axe, touchFix: axe ? "" : "pra tocar, instale o AXe: brew install cameroncooke/axe/axe" };
    })());
  }
  if (mobile && wantsAnd) {
    platforms.push("android");
    jobs.push((async () => {
      const emu = emulatorBin(d);
      const avds = emu ? (await d.exec(emu, ["-list-avds"], { env: toolEnv(d), timeoutMs: 15_000 })).stdout.split("\n").map((s) => s.trim()).filter((s) => s && !/^INFO|^WARNING/.test(s)) : [];
      let up = false;
      const adb = adbBin(d);
      if (st.android && adb) {
        // "ligado" = boot COMPLETO (o `get-state` já diz "device" no meio do boot → o painel ficava tentando conectar)
        const r = await d.exec(adb, ["-s", st.android.serial, "shell", "getprop", "sys.boot_completed"], { env: toolEnv(d), timeoutMs: 8000 });
        up = r.code === 0 && r.stdout.trim() === "1";
      }
      const h = await androidLockHolder(d);
      android = { up, serial: st.android?.serial, avd: st.android?.avd ?? (st.android ? undefined : ANDROID_AVD), options: avds.map((a) => ({ id: a, label: a })), busyBy: h && !h.mine ? (h.taskId === c.taskId ? "o agente desta tarefa" : `o agente da tarefa ${h.taskId}`) : null };
    })());
  }
  await Promise.all(jobs);
  return { mobile, label: p.label, platforms, ios, android };
}

/** Seletor enxuto: iPhones das 2 gerações mais novas (o padrão primeiro), o Air, os iPads mais novos e o aparelho
 * atual da tarefa (mesmo se for antigo) — a lista inteira do Xcode tem ~60 modelos. */
export function curateIosOptions(models: Array<{ runtime: string; runtimeName: string; deviceType: string; deviceName: string }>, current?: string): Array<{ id: string; runtime: string; label: string }> {
  const num = (n: string) => Number((/^iPhone (\d+)/.exec(n) || [])[1] || 0);
  const top = Math.max(0, ...models.map((m) => num(m.deviceName)));
  const rank = (n: string) => (/^iPhone \d+$/.test(n) ? 0 : / Pro$/.test(n) ? 1 : / Pro Max$/.test(n) ? 2 : / Plus$/.test(n) ? 3 : 4);
  const phones = models.filter((m) => (num(m.deviceName) >= top - 1 && top > 0) || /^iPhone Air/.test(m.deviceName))
    .sort((a, b) => num(b.deviceName) - num(a.deviceName) || rank(a.deviceName) - rank(b.deviceName));
  const pads = models.filter((m) => /^iPad/.test(m.deviceName)).slice(0, 4);
  const cur = current ? models.filter((m) => m.deviceName === current) : [];
  const seen = new Set<string>();
  return [...phones, ...pads, ...cur].filter((m) => !seen.has(m.deviceType) && seen.add(m.deviceType)).map((m) => ({ id: m.deviceType, runtime: m.runtime, label: `${m.deviceName} · ${m.runtimeName}` }));
}

// ---------------------------------------------------------------- captura
interface Capture { stop(): void; screen(): Screen | null }
type Sink = (kind: 0 | 1 | 2 | 3, data: Buffer) => void;

function iosSfsimCapture(c: MobileCtx, bin: string, udid: string, sink: Sink, onEnd: (why: string) => void): Capture {
  const dev = xcodeEnv(c.deps).DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer";
  const cp = spawn(bin, [udid, dev, "60", "0.5", "0.7"], { stdio: ["pipe", "pipe", "pipe"] });
  let scr: Screen | null = null, buf: Buffer = Buffer.alloc(0), errBuf = "", errLine = "";
  cp.stderr.on("data", (b) => {
    errBuf += String(b);
    let nl: number;
    while ((nl = errBuf.indexOf("\n")) >= 0) {
      const line = errBuf.slice(0, nl); errBuf = errBuf.slice(nl + 1);
      try {
        const j = JSON.parse(line) as { w?: number; h?: number; pointScale?: number; error?: string };
        if (j.error) { errLine = j.error; continue; } // a saída do processo reporta (uma vez só)
        if (j.w && j.h) { scr = { w: j.w, h: j.h, ptScale: j.pointScale || 1 }; sink(0, Buffer.from(JSON.stringify({ plat: "ios", ...scr, codec: "image", via: "framebuffer" }))); }
      } catch { /* log solto */ }
    }
  });
  cp.stdout.on("data", (b: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, b]) : b;
    while (buf.length >= 12) {
      const n = buf.readUInt32BE(0);
      if (buf.length < 12 + n) break;
      sink(1, Buffer.from(buf.subarray(12, 12 + n)));
      buf = buf.subarray(12 + n);
    }
  });
  let ended = false;
  const end = (why: string) => { if (ended) return; ended = true; onEnd(why); };
  cp.on("exit", (code) => end(errLine || (code ? `o espelho do simulador parou (código ${code})` : "saiu")));
  cp.on("error", (e) => end(e.message));
  return { stop: () => { try { cp.stdin.end(); } catch { /* ok */ } setTimeout(() => { try { cp.kill("SIGTERM"); } catch { /* ok */ } }, 500); }, screen: () => scr };
}

/** Fallback de prints (iOS sem o helper; Android sem WebCodecs no front): ~2 fps, só enquanto há cliente. */
function shotLoopCapture(c: MobileCtx, plat: Platform, target: string, sink: Sink, intervalMs = 500): Capture {
  let on = true, scr: Screen | null = null, last = "";
  const tmp = join(c.deps.home, ".constellation", "mobile", "rec", c.taskId, `mirror-${process.pid}.${plat === "ios" ? "jpg" : "png"}`);
  mkdirSync(join(tmp, ".."), { recursive: true });
  (async () => {
    while (on) {
      const t0 = Date.now();
      const r = plat === "ios"
        ? await c.deps.exec("xcrun", ["simctl", "io", target, "screenshot", "--type=jpeg", tmp], { env: xcodeEnv(c.deps), timeoutMs: 15_000 })
        : await c.deps.execToFile(adbBin(c.deps) ?? "adb", ["-s", target, "exec-out", "screencap", "-p"], tmp, { env: toolEnv(c.deps), timeoutMs: 15_000 });
      if (!on) break;
      if (r.code === 0) {
        let img: Buffer | null = null;
        try { img = readFileSync(tmp); } catch { img = null; }
        if (img && img.length > 100) {
          const sig = createHash("sha1").update(img).digest("hex");
          if (!scr) {
            const wh = imageSize(img);
            if (wh) { scr = { ...wh, ptScale: plat === "ios" ? iosPointScale(wh.w, wh.h) : 1 }; sink(0, Buffer.from(JSON.stringify({ plat, ...scr, codec: "image", via: "screenshot" }))); }
          }
          if (sig !== last) { last = sig; sink(1, img); } // tela parada → nada novo
        }
      }
      await c.deps.sleep(Math.max(50, intervalMs - (Date.now() - t0)));
    }
    try { rmSync(tmp, { force: true }); } catch { /* ok */ }
  })();
  return { stop: () => { on = false; }, screen: () => scr };
}
/** Largura/altura de um PNG ou JPEG (cabeçalho). */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Escala de pontos do iOS só pelo tamanho em pixels (fallback sem o sfsim): iPhone alto e largo = 3x; SE/iPad = 2x. */
export function iosPointScale(w: number, h: number): number {
  const lo = Math.min(w, h), hi = Math.max(w, h);
  return lo > 1000 && hi / lo > 1.9 ? 3 : 2;
}
/** Tamanho ATUAL da tela do Android (com a rotação): `dumpsys window displays` (cur=WxH) › `wm size` + SurfaceOrientation. */
export function parseAndroidScreen(wmSize: string, dumpsysInput: string): Screen | null {
  // Android 13+: `dumpsys window displays` traz o tamanho lógico ATUAL já girado ("cur=2400x1080")
  const cur = /\bcur=(\d+)x(\d+)/.exec(dumpsysInput);
  if (cur) {
    const init = /\binit=(\d+)x(\d+)/.exec(dumpsysInput);
    const w = Number(cur[1]), h = Number(cur[2]);
    return { w, h, ptScale: 1, ...(init && Number(init[1]) === h && Number(init[2]) === w && w !== h ? { rotated: true } : {}) };
  }
  const m = /Override size:\s*(\d+)x(\d+)/.exec(wmSize) ?? /Physical size:\s*(\d+)x(\d+)/.exec(wmSize);
  if (!m) return null;
  let w = Number(m[1]), h = Number(m[2]);
  const o = Number((/SurfaceOrientation:\s*(\d)/.exec(dumpsysInput) || [])[1] || 0);
  if (o === 1 || o === 3) [w, h] = [h, w];
  return { w, h, ptScale: 1, ...(o === 1 || o === 3 ? { rotated: true } : {}) };
}
/** Tamanho do vídeo do espelho: metade da tela, par (o codificador exige), no máximo 1280 no lado maior. */
export function mirrorSize(s: Screen): { w: number; h: number } {
  let k = 0.5;
  if (Math.max(s.w, s.h) * k > 1280) k = 1280 / Math.max(s.w, s.h);
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { w: even(s.w), h: even(s.h) };
}

async function androidScreen(c: MobileCtx, serial: string): Promise<Screen | null> {
  const adb = adbBin(c.deps); if (!adb) return null;
  const env = toolEnv(c.deps);
  const [a, b] = await Promise.all([
    c.deps.exec(adb, ["-s", serial, "shell", "wm", "size"], { env, timeoutMs: 10_000 }),
    c.deps.exec(adb, ["-s", serial, "shell", "dumpsys", "window", "displays"], { env, timeoutMs: 10_000 }),
  ]);
  return parseAndroidScreen(a.stdout, b.stdout);
}

/** Assinatura do NOSSO screenrecord no aparelho (taxa de bits única) — pra matar SÓ ele (nunca o `rec` do agente). */
export const MIRROR_BITRATE = "4000123";
function killRemoteMirror(c: MobileCtx, serial: string) {
  c.deps.exec(adbBin(c.deps) ?? "adb", ["-s", serial, "shell", "pkill", "-f", `bit-rate ${MIRROR_BITRATE}`], { env: toolEnv(c.deps), timeoutMs: 8000 }).catch(() => null);
}
function androidH264Capture(c: MobileCtx, serial: string, scr: Screen, sink: Sink, onEnd: (why: string) => void): Capture {
  let on = true, cp: ChildProcess | null = null;
  const size = mirrorSize(scr);
  sink(0, Buffer.from(JSON.stringify({ plat: "android", ...scr, codec: "h264", vw: size.w, vh: size.h, via: "screenrecord" })));
  const run = () => {
    if (!on) return;
    const parser = new AnnexB();
    let idle: NodeJS.Timeout | null = null;
    const emit = (aus: AU[]) => { for (const au of aus) sink(au.key ? 3 : 2, au.data); };
    // o screenrecord para sozinho em 3 min (limite do Android) → recomeça (novo quadro-chave)
    const t0 = Date.now();
    cp = spawn(adbBin(c.deps) ?? "adb", ["-s", serial, "exec-out", "screenrecord", "--output-format=h264", "--size", `${size.w}x${size.h}`, "--bit-rate", MIRROR_BITRATE, "-"], { env: toolEnv(c.deps), stdio: ["ignore", "pipe", "pipe"] });
    cp.stdout!.on("data", (b: Buffer) => {
      emit(parser.push(b));
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => emit(parser.flush()), 15);
    });
    cp.on("exit", () => {
      if (idle) clearTimeout(idle);
      if (!on) return;
      // saiu logo (aparelho offline/sem permissão/sem codificador): não fica recomeçando pra sempre
      fastExits = Date.now() - t0 < 3000 ? fastExits + 1 : 0;
      if (fastExits >= 3) { on = false; onEnd("o vídeo do emulador não começa (screenrecord saiu 3× seguidas)"); return; }
      setTimeout(run, 300);
    });
    cp.on("error", (e) => { on = false; onEnd(e.message); });
  };
  let fastExits = 0;
  killRemoteMirror(c, serial); // sobra de uma conexão anterior (tela parada não mata o screenrecord do aparelho)
  run();
  return { stop: () => { on = false; try { cp?.kill("SIGTERM"); } catch { /* ok */ } killRemoteMirror(c, serial); }, screen: () => scr };
}

// ---------------------------------------------------------------- console do emulador (toque ao vivo)
class EmuConsole {
  private sock: net.Socket | null = null;
  private ready: Promise<net.Socket> | null = null;
  private port: number;
  private home: string;
  lastErr = "";
  constructor(port: number, home: string) { this.port = port; this.home = home; }
  private connect(): Promise<net.Socket> {
    if (this.ready) return this.ready;
    this.ready = new Promise((res, rej) => {
      const s = net.createConnection({ host: "127.0.0.1", port: this.port });
      const tm = setTimeout(() => { s.destroy(); rej(new Error("console do emulador não respondeu")); }, 4000);
      s.on("connect", () => {
        clearTimeout(tm);
        let tok = "";
        try { tok = readFileSync(join(this.home, ".emulator_console_auth_token"), "utf8").trim(); } catch { /* sem token = console aberto */ }
        if (tok) s.write(`auth ${tok}\r\n`);
        this.sock = s;
        res(s);
      });
      // "OK" é descartado; "KO: …" (token errado, comando recusado) vira erro no próximo envio
      s.on("data", (b) => { const m = /KO:\s*([^\r\n]*)/.exec(String(b)); if (m) this.lastErr = m[1].trim() || "recusado"; });
      s.on("error", (e) => { clearTimeout(tm); this.sock = null; this.ready = null; rej(e); });
      s.on("close", () => { this.sock = null; this.ready = null; });
    });
    return this.ready;
  }
  async send(lines: string[]) {
    if (this.lastErr) { const e = this.lastErr; this.lastErr = ""; throw new MobileError(`o console do emulador recusou: ${e}`, "confira ~/.emulator_console_auth_token (o emulador recria esse arquivo ao ligar)"); }
    const s = await this.connect();
    s.write(lines.map((l) => l + "\r\n").join(""));
  }
  close() { try { this.sock?.destroy(); } catch { /* ok */ } }
}

// ---------------------------------------------------------------- servidor do espelho
export interface MirrorHandle { port: number; token: string; close(): void }
export interface MirrorOpts { idleExitMs?: number; captureGraceMs?: number; onExit?: () => void }

const tokenOk = (got: string | null, want: string) => {
  if (!got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};
const readBody = (req: http.IncomingMessage, max = 64 * 1024): Promise<string> =>
  new Promise((res, rej) => {
    let s = "";
    req.on("data", (b) => { s += String(b); if (s.length > max) { rej(new Error("corpo grande demais")); req.destroy(); } });
    req.on("end", () => res(s));
    req.on("error", rej);
  });

export async function startMirror(c: MobileCtx, plat: Platform, opts: MirrorOpts = {}): Promise<MirrorHandle> {
  const d = c.deps;
  const token = randomBytes(18).toString("hex");
  const idleExitMs = opts.idleExitMs ?? 60_000, grace = opts.captureGraceMs ?? 3000;
  let lastHit = Date.now();
  let client: http.ServerResponse | null = null, clientCodec = "h264";
  let cap: Capture | null = null, capTimer: NodeJS.Timeout | null = null, lastMeta: Buffer | null = null;
  let consoleConn: EmuConsole | null = null;
  let screenCache: Screen | null = null;
  let dragStart: { x: number; y: number; at: number } | null = null;
  let lastImg: Buffer | null = null;
  let inputQ: Promise<unknown> = Promise.resolve(); // toques EM ORDEM (um "up" não pode passar o último "move")
  const state = () => loadState(d, c.taskId);
  const target = (): string => {
    const st = state();
    if (plat === "ios") { if (!st.ios) throw new MobileError("o simulador iOS desta tarefa está desligado", "ligue no botão de energia do painel"); return st.ios.udid; }
    if (!st.android) throw new MobileError("o emulador Android desta tarefa está desligado", "ligue no botão de energia do painel");
    return st.android.serial;
  };
  const sink: Sink = (kind, data) => {
    if (kind === 0) {
      lastMeta = data;
      // a última tela conhecida fica guardada: toque depois que a captura parou (painel escondido) ainda mapeia certo
      try { const m = JSON.parse(String(data)) as { w?: number; h?: number; ptScale?: number; rotated?: boolean }; if (m.w && m.h) screenCache = { w: m.w, h: m.h, ptScale: m.ptScale || 1, ...(m.rotated ? { rotated: true } : {}) }; } catch { /* ok */ }
    }
    if (kind === 1) lastImg = data;
    if (!client || client.writableEnded) return;
    // espectador lento: não acumula na memória — imagem é descartável (vem outra); H.264 não pode perder quadro →
    // derruba a conexão e o front reconecta (vídeo recomeça do quadro-chave)
    if (client.writableLength > 4 * 1024 * 1024) { if (kind === 2 || kind === 3) client.end(); return; }
    client.write(frame(kind, data));
  };
  const failStream = (why: string) => {
    stopCapture();
    if (client && !client.writableEnded) { client.write(frame(0, Buffer.from(JSON.stringify({ error: why })))); client.end(); }
  };
  const stopCapture = () => { if (cap) { cap.stop(); cap = null; } };
  const startCapture = async () => {
    stopCapture();
    lastMeta = null;
    const tgt = target();
    if (plat === "ios") {
      const bin = await ensureSfsim(d);
      // o helper saiu (simulador desligou/reiniciou, API privada mudou): cai pros prints, sem ficar "conectando" pra sempre
      const fallback = () => { if (client && cap === sfs) cap = shotLoopCapture(c, "ios", target(), sink); };
      const sfs: Capture | null = bin ? iosSfsimCapture(c, bin, tgt, sink, () => { try { fallback(); } catch (e) { failStream((e as Error).message); } }) : null;
      cap = sfs ?? shotLoopCapture(c, "ios", tgt, sink);
    } else {
      const scr = await androidScreen(c, tgt);
      if (!scr) throw new MobileError("não consegui ler a tela do emulador", "o emulador terminou de ligar? tente de novo");
      screenCache = scr;
      cap = clientCodec === "image" ? shotLoopCapture(c, "android", tgt, sink) : androidH264Capture(c, tgt, scr, sink, failStream);
    }
  };
  const screen = (): Screen | null => screenCache ?? cap?.screen() ?? null;
  const busy = async (): Promise<string | null> => {
    if (plat !== "android") return null;
    const h = await androidLockHolder(d);
    return h && !h.mine ? (h.taskId === c.taskId ? "o agente desta tarefa está usando o emulador — só visualização" : `o agente da tarefa ${h.taskId} está usando o emulador — só visualização`) : null;
  };
  const ctxV: MobileCtx = { ...c, viewer: true, waitMs: 0, log: () => {} };

  async function doInput(ev: InputEv): Promise<void> {
    const why = await busy();
    if (why) throw new MobileError(why, "espere o agente terminar o turno");
    const s = screen() ?? (await probeScreen());
    if (!s) throw new MobileError("a tela ainda não chegou", "espere o primeiro quadro");
    const tgt = target();
    if (plat === "ios") {
      const axe = axeBin(d);
      if (!axe) throw new MobileError("tocar no simulador precisa do AXe", "brew install cameroncooke/axe/axe");
      const cmds = iosAxeArgs(ev, tgt, s);
      if (!cmds) return; // gesto que não existe no iOS (ou parte do arrasto — vai no soltar)
      for (const a of cmds) {
        // logo depois do boot o AXe não acha a "tradução" de acessibilidade (ele sonda a orientação a cada gesto):
        // tenta de novo por alguns segundos antes de desistir
        let r = await d.exec(axe, a, { env: xcodeEnv(d), timeoutMs: 20_000 });
        for (let i = 0; i < 6 && r.code !== 0 && /No translation object/i.test(r.stderr + r.stdout); i++) {
          await d.sleep(1500);
          r = await d.exec(axe, a, { env: xcodeEnv(d), timeoutMs: 20_000 });
        }
        if (r.code !== 0) {
          const warming = /No translation object/i.test(r.stderr + r.stdout);
          throw new MobileError(warming ? "o simulador ainda está terminando de ligar — o toque não pegou" : `o toque falhou: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, warming ? "tente de novo em alguns segundos" : "o simulador está ligado?");
        }
      }
      return;
    }
    const port = consolePort(tgt);
    if (port && !s.rotated) {
      consoleConn ??= new EmuConsole(port, d.home);
      await consoleConn.send(androidConsoleLines(ev, s));
      return;
    }
    // aparelho físico ou emulador girado: `adb shell input` (sobe uma JVM no aparelho por comando — mais lento)
    if (ev.t === "down") { dragStart = { x: ev.x, y: ev.y, at: Date.now() }; return; }
    const cmds = androidAdbInput(ev, s, ev.t === "up" ? dragStart ?? undefined : undefined);
    if (ev.t === "up") dragStart = null;
    for (const a of cmds) await d.exec(adbBin(d) ?? "adb", ["-s", tgt, ...a], { env: toolEnv(d), timeoutMs: 20_000 });
  }

  async function doAction(name: string, value: string): Promise<{ ok: true; text?: string; file?: string }> {
    const tgt = target();
    const env = plat === "ios" ? xcodeEnv(d) : toolEnv(d);
    const simctl = (args: string[], ms = 20_000) => d.exec("xcrun", ["simctl", ...args], { env, timeoutMs: ms });
    const adb = (args: string[], ms = 20_000) => d.exec(adbBin(d) ?? "adb", ["-s", tgt, ...args], { env, timeoutMs: ms });
    const must = (r: { code: number; stderr: string; stdout: string }, what: string) => { if (r.code !== 0) throw new MobileError(`${what} falhou: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, "o aparelho está ligado?"); };
    switch (name) {
      case "shot": { const f = await mobileShot(ctxV, plat); return { ok: true, file: basename(f) }; }
      case "rec": {
        if (plat === "android") {
          if (value === "stop") {
            try { const f = await mobileRec(ctxV, plat, "stop"); return { ok: true, file: basename(f) }; } finally { releaseAndroidLockOf(d, c.taskId); }
          }
          // gravação começada pelo painel SEGURA a trava enquanto este espelho vive (um agente não pega o emulador no
          // meio do vídeo); o `rec stop` solta. Agente usando agora → recusa na hora.
          const why = await busy();
          if (why) throw new MobileError(why, "espere o agente terminar o turno");
          await acquireAndroidLock({ ...c, viewer: false, waitMs: 0, ownerPid: process.pid, log: () => {} });
          try { const f = await mobileRec(ctxV, plat, "start"); return { ok: true, file: basename(f) }; } catch (e) { releaseAndroidLockOf(d, c.taskId); throw e; }
        }
        const f = await mobileRec(ctxV, plat, value === "stop" ? "stop" : "start"); return { ok: true, file: basename(f) };
      }
      case "appearance":
        if (plat === "ios") must(await simctl(["ui", tgt, "appearance", value === "dark" ? "dark" : "light"]), "trocar o tema");
        else { if (await busy()) throw new MobileError((await busy())!, ""); must(await adb(["shell", "cmd", "uimode", "night", value === "dark" ? "yes" : "no"]), "trocar o tema"); }
        return { ok: true };
      case "statusbar":
        if (plat !== "ios") throw new MobileError("barra de status limpa é do iOS", "");
        must(await simctl(value === "off" ? ["status_bar", tgt, "clear"] : ["status_bar", tgt, "override", "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100", "--cellularBars", "4", "--wifiBars", "3"]), "barra de status");
        return { ok: true };
      case "shake":
        if (plat !== "ios") throw new MobileError("chacoalhar é do iOS", "no Android, o menu de desenvolvedor do React Native abre com a tecla de menu");
        must(await simctl(["notify_post", tgt, "com.apple.UIKit.SimulatorShake"]), "chacoalhar");
        return { ok: true };
      case "rotate": {
        if (plat === "ios") throw new MobileError("girar o Simulador iOS não é possível por linha de comando (nem simctl nem AXe)", "gire pelo Simulator.app (⌘→) se precisar");
        if (await busy()) throw new MobileError((await busy())!, "");
        const port = consolePort(tgt);
        if (!port) throw new MobileError("girar só no emulador", "");
        consoleConn ??= new EmuConsole(port, d.home);
        const before = await androidScreen(c, tgt);
        await consoleConn.send(["rotate"]);
        for (let i = 0; i < 12; i++) { // espera a tela virar de verdade (até ~3 s) antes de recomeçar o vídeo
          await d.sleep(250);
          const now = await androidScreen(c, tgt);
          if (now && before && now.w !== before.w) { screenCache = now; break; }
        }
        if (client) await startCapture(); // tamanho novo → recomeça o vídeo com a orientação nova
        return { ok: true };
      }
      case "openurl": {
        if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) throw new MobileError("URL inválida", "ex.: exp://127.0.0.1:8081 ou meuapp://tela");
        if (plat === "ios") must(await simctl(["openurl", tgt, value]), "abrir a URL");
        // o `adb shell` junta os argumentos e o shell do APARELHO interpreta: a URL vai entre aspas simples (sem ; & | $)
        else { if (await busy()) throw new MobileError((await busy())!, ""); must(await adb(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", shQuote(value)]), "abrir a URL"); }
        return { ok: true };
      }
      case "logs": {
        const r = plat === "ios"
          ? await simctl(["spawn", tgt, "log", "show", "--last", "2m", "--style", "compact", "--predicate", "messageType == error OR messageType == fault OR subsystem CONTAINS[c] \"react\" OR process CONTAINS[c] \"Expo\""], 30_000)
          : await adb(["logcat", "-d", "-t", "300", "*:W"], 30_000);
        return { ok: true, text: (r.stdout || r.stderr).split("\n").slice(-300).join("\n") };
      }
      default: throw new MobileError(`ação desconhecida: ${name}`, "");
    }
  }

  /** Tamanho da tela sem quadro nenhum ainda (toque antes do 1º quadro / painel escondido desde o início). */
  async function probeScreen(): Promise<Screen | null> {
    try {
      if (plat === "android") { screenCache = await androidScreen(c, target()); return screenCache; }
      const wh = imageSize(await snapshot());
      if (wh) screenCache = { ...wh, ptScale: iosPointScale(wh.w, wh.h) };
      return screenCache;
    } catch { return null; }
  }
  async function snapshot(): Promise<Buffer> {
    const tgt = target();
    const f = join(d.home, ".constellation", "mobile", "rec", c.taskId, `snap-${process.pid}.png`);
    mkdirSync(join(f, ".."), { recursive: true });
    const r = plat === "ios"
      ? await d.exec("xcrun", ["simctl", "io", tgt, "screenshot", "--type=png", f], { env: xcodeEnv(d), timeoutMs: 20_000 })
      : await d.execToFile(adbBin(d) ?? "adb", ["-s", tgt, "exec-out", "screencap", "-p"], f, { env: toolEnv(d), timeoutMs: 20_000 });
    if (r.code !== 0) throw new MobileError("não consegui capturar a tela", "o aparelho está ligado?");
    const b = readFileSync(f);
    try { rmSync(f, { force: true }); } catch { /* ok */ }
    return b;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("Access-Control-Allow-Origin", "*"); // o token na URL é a proteção (a origem do app varia: tauri://, http://tauri.localhost)
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    // DNS rebinding: só aceita o próprio endereço de loopback no Host
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host ?? ""))) { res.writeHead(403); res.end("host"); return; }
    if (!tokenOk(url.searchParams.get("t"), token)) { res.writeHead(403); res.end("token"); return; }
    lastHit = Date.now(); // só pedido AUTENTICADO mantém o espelho vivo
    const json = (code: number, v: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
    const fail = (e: unknown) => json(e instanceof MobileError ? 409 : 500, { error: (e as Error)?.message ?? String(e), fix: e instanceof MobileError ? e.fix : "" });
    try {
      if (url.pathname === "/stream" && req.method === "GET") {
        // UM espectador por aparelho: o novo substitui o anterior (aba reaberta)
        if (client && !client.writableEnded) client.end();
        if (capTimer) { clearTimeout(capTimer); capTimer = null; }
        clientCodec = url.searchParams.get("codec") === "image" ? "image" : "h264";
        res.writeHead(200, { "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff" });
        res.flushHeaders();
        const me = res;
        client = res;
        res.on("close", () => { // conexão do espectador caiu/fechou (aba escondida, painel fechado, app saiu)
          if (client !== me) return;
          client = null;
          // sem espectador: a captura para depois de um respiro (troca rápida de aba não recomeça tudo)
          capTimer = setTimeout(() => { if (!client) stopCapture(); }, grace);
        });
        try {
          // Android H.264: começa SEMPRE do zero (o decodificador precisa do quadro-chave); iOS: reaproveita se já roda
          if (!cap || plat === "android") await startCapture();
          else { if (lastMeta) res.write(frame(0, lastMeta)); if (lastImg) res.write(frame(1, lastImg)); } // volta rápida: a tela atual já
          // Android H.264: o screenrecord só manda quadro quando a tela MUDA e o decodificador do WebKit/Chromium
          // segura o 1º quadro até chegar outro → com a tela parada o painel ficava preto. Um print agora mostra a
          // tela atual na hora; o vídeo assume no primeiro movimento.
          if (plat === "android" && clientCodec === "h264") snapshot().then((png) => { if (client === me) sink(1, png); }, () => {});
        } catch (e) {
          res.write(frame(0, Buffer.from(JSON.stringify({ error: (e as Error).message, fix: e instanceof MobileError ? e.fix : "" }))));
          res.end();
        }
        return;
      }
      if (url.pathname === "/state" && req.method === "GET") {
        const st = state();
        return json(200, { plat, up: plat === "ios" ? !!st.ios : !!st.android, busy: await busy(), touch: plat === "ios" ? !!axeBin(d) : true, liveDrag: plat === "android", rotate: plat === "android", back: plat === "android", shake: plat === "ios", rec: st.rec ? { plat: st.rec.plat, startedAt: st.rec.startedAt } : null, screen: screen() });
      }
      const body = async <T>(fallback: T): Promise<T | null> => { try { return JSON.parse((await readBody(req)) || "null") ?? fallback; } catch { return null; } };
      if (url.pathname === "/input" && req.method === "POST") {
        const ev = parseInput(await body(null));
        if (!ev) return json(400, { error: "entrada inválida" });
        // fila: cada toque espera o anterior (sem isso um "up" passava o último "move" e o dedo ficava "apertado")
        const run = inputQ.then(() => doInput(ev));
        inputQ = run.catch(() => {});
        await run;
        return json(200, { ok: true });
      }
      if (url.pathname === "/action" && req.method === "POST") {
        const b = await body({} as { name?: string; value?: string });
        if (!b) return json(400, { error: "pedido inválido" });
        return json(200, await doAction(String(b.name ?? ""), String(b.value ?? "")));
      }
      if (url.pathname === "/snapshot" && req.method === "GET") {
        const png = await snapshot();
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(png);
        return;
      }
      json(404, { error: "não existe" });
    } catch (e) { if (!res.headersSent) fail(e); else res.end(); }
  });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", () => res()); });
  const port = (server.address() as net.AddressInfo).port;
  const close = () => {
    stopCapture();
    consoleConn?.close();
    try { client?.end(); } catch { /* ok */ }
    server.close();
    server.closeAllConnections?.();
    clearInterval(watch);
    opts.onExit?.();
  };
  // sem ninguém olhando (nem pedido) por um tempo → sai sozinho
  const watch = setInterval(() => { if (!client && Date.now() - lastHit > idleExitMs) close(); }, Math.min(5000, idleExitMs));
  watch.unref?.();
  return { port, token, close };
}

/** CLI `cardume mobile mirror`: sobe o servidor, imprime a 1ª linha e vive até o stdin fechar / ficar ocioso. */
export async function runMirror(c: MobileCtx, plat: Platform, out: (s: string) => void): Promise<void> {
  // confere já que o aparelho está de pé (erro humano na 1ª linha, sem servidor à toa)
  const st = loadState(c.deps, c.taskId);
  if (plat === "ios" ? !st.ios : !st.android) throw new MobileError(plat === "ios" ? "o simulador iOS desta tarefa está desligado" : "o emulador Android desta tarefa está desligado", "ligue no botão de energia do painel");
  await new Promise<void>((resolve) => {
    startMirror(c, plat, { onExit: () => resolve() }).then((h) => {
      out(JSON.stringify({ port: h.port, token: h.token, plat }));
      process.stdin.on("end", () => h.close());
      process.stdin.on("error", () => h.close());
      process.stdin.resume();
    }, (e) => { out(JSON.stringify({ error: (e as Error).message })); resolve(); });
  });
  process.exit(0);
}
