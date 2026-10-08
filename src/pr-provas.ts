// PROVAS NO PR — os prints/vídeos de prova da tarefa (.cardume/artifacts/) aparecem no PR do GitHub.
//
// Como: os arquivos sobem para um branch ÓRFÃO do próprio repositório (`starfork-provas`, pasta `<tarefa>/`), com
// git puro (plumbing: índice temporário + hash-object/update-index/write-tree/commit-tree + push do sha). NUNCA no
// branch da tarefa — o código e o diff do PR ficam limpos — e sem mexer na worktree nem no índice de ninguém.
// O Relatório Starfork aponta pra `https://github.com/<dono>/<repo>/blob/starfork-provas/<tarefa>/<arq>?raw=true`, que
// funciona em repositório privado pra quem tem acesso a ele.
//
// Repositório PÚBLICO: prints podem mostrar dados — sem decisão gravada no projeto, NÃO sobe; o app pergunta uma vez
// (askYes) e grava `starfork.provasNoPr` (on|off) no .git/config do projeto. Falha nunca bloqueia o PR: o relatório
// volta pra lista de nomes e diz "não consegui anexar as provas (motivo)".
//
// Limpeza: o branch NÃO é apagado ao integrar/fechar a tarefa — o PR mergeado continua apontando pras imagens.
// Pra limpar de vez: `git push origin --delete starfork-provas` (as miniaturas dos PRs antigos quebram).
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghBin, netEnv, netTimeoutMs, run } from "./util/run.ts";

export const PROVAS_BRANCH = "starfork-provas";
/** ref LOCAL (fora de refs/heads: não aparece como branch) com a ponta conhecida do branch remoto */
export const PROVAS_LOCAL_REF = "refs/starfork/provas";
/** chave do .git/config do projeto: on | off (ausente = padrão: liga em privado, pergunta em público) */
export const PROVAS_SETTING_KEY = "starfork.provasNoPr";
export const PROVA_MAX_BYTES = 8 * 1024 * 1024;
export const PROVAS_MAX_TOTAL = 40 * 1024 * 1024;
/** acima disso um png/jpg é reduzido (lado maior 1600px) quando há como, sem dependência nova (sips no macOS) */
const SHRINK_ABOVE = 1_500_000;
/** autor dos commits do branch de provas: nunca o e-mail da pessoa (o repo pode ser público) */
const PROVAS_AUTHOR = { GIT_AUTHOR_NAME: "Starfork", GIT_AUTHOR_EMAIL: "provas@starfork.invalid", GIT_COMMITTER_NAME: "Starfork", GIT_COMMITTER_EMAIL: "provas@starfork.invalid" };

export type ProofKind = "img" | "video";
export interface ProofLink { url: string; kind: ProofKind }
/** nome da evidência (como está no requirements.json) → link no GitHub */
export type ProofLinks = Record<string, ProofLink>;
export interface ProofFile { name: string; path: string }
export type ProofSetting = "on" | "off" | "";

/** Imagem vira miniatura; vídeo vira link; o resto (testes, .md) segue só como nome. */
export function proofKind(name: string): ProofKind | null {
  const n = String(name ?? "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp)$/.test(n)) return "img";
  if (/\.(mp4|mov)$/.test(n)) return "video";
  return null;
}

/** Um trecho de caminho seguro (sem "/", "..", espaço estranho): letras, números, ".", "_", "-". */
export function safeSeg(s: string): string {
  const v = String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 100);
  return v || "x";
}
/** Caminho dentro do branch de provas: `<prefixo>/<arquivo>` (subpastas da evidência viram "__"). */
export function proofRelPath(prefix: string, name: string): string {
  const parts = String(name ?? "").replace(/^(\.\/)?(\.cardume\/artifacts\/)?/, "").split(/[\\/]+/).filter((p) => p && p !== "." && p !== "..");
  return `${safeSeg(prefix)}/${parts.map(safeSeg).join("__") || "x"}`;
}
/** Link do arquivo no GitHub: imagem com `?raw=true` (renderiza no markdown, inclusive em repo privado). */
export function proofUrl(slug: string, relPath: string, kind: ProofKind): string {
  const p = relPath.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${slug}/blob/${PROVAS_BRANCH}/${p}${kind === "img" ? "?raw=true" : ""}`;
}

export function readProofSetting(dir: string): ProofSetting {
  try {
    const v = execFileSync("git", ["-C", dir, "config", "--get", PROVAS_SETTING_KEY], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return v === "on" || v === "off" ? v : "";
  } catch { return ""; }
}
export function writeProofSetting(dir: string, v: "on" | "off"): void {
  execFileSync("git", ["-C", dir, "config", PROVAS_SETTING_KEY, v], { timeout: 5000, stdio: "ignore" });
}

/** dono/repo e visibilidade pelo gh (a conta do projeto vem no env). */
export async function ghRepoInfo(dir: string, env?: NodeJS.ProcessEnv): Promise<{ slug: string; visibility: string }> {
  const { stdout } = await run(ghBin(), ["repo", "view", "--json", "nameWithOwner,visibility"], { cwd: dir, env: env ?? netEnv(), timeout: Math.min(netTimeoutMs(), 30_000) });
  const j = JSON.parse(stdout || "{}") as { nameWithOwner?: string; visibility?: string };
  const slug = String(j.nameWithOwner ?? "").trim();
  return { slug: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) ? slug : "", visibility: String(j.visibility ?? "").toUpperCase() };
}

/** Sobe? on → sim; off → não; sem decisão: privado/interno → sim, público ou desconhecido → perguntar. */
export function proofDecision(setting: ProofSetting, visibility: string): "upload" | "off" | "ask" {
  if (setting === "off") return "off";
  if (setting === "on") return "upload";
  return visibility === "PRIVATE" || visibility === "INTERNAL" ? "upload" : "ask";
}

const short = (e: unknown) => String((e as { stderr?: string })?.stderr || (e as Error)?.message || e).replace(/\s+/g, " ").trim().slice(0, 160);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;

/** png/jpg grande → cópia reduzida (lado maior 1600px) via `sips` (macOS). Sem como reduzir → o original. */
async function shrink(path: string, size: number, tmp: string, i: number): Promise<{ path: string; size: number }> {
  if (size <= SHRINK_ABOVE || process.platform !== "darwin" || !/\.(png|jpe?g)$/i.test(path)) return { path, size };
  const out = join(tmp, `r${i}${path.slice(path.lastIndexOf(".")).toLowerCase()}`);
  try {
    await run("/usr/bin/sips", ["-Z", "1600", path, "--out", out], { timeout: 30_000 });
    const s = (await stat(out)).size;
    return s > 0 && s < size ? { path: out, size: s } : { path, size };
  } catch { return { path, size }; }
}

/**
 * Sobe as provas pro branch órfão e devolve os links. Idempotente: mesmo conteúdo = mesma árvore = sem commit/push.
 * Concorrência (2 tarefas subindo juntas): push recusado → busca a ponta nova e refaz (até 3x). Lança em erro de git/rede.
 */
export async function pushProofs(o: { dir: string; prefix: string; files: ProofFile[]; slug: string; env?: NodeJS.ProcessEnv; remote?: string }): Promise<{ links: ProofLinks; skipped: { name: string; why: string }[]; pushed: boolean }> {
  const remote = o.remote ?? "origin";
  const env = o.env ?? netEnv();
  const links: ProofLinks = {};
  const skipped: { name: string; why: string }[] = [];
  const tmp = await mkdtemp(join(tmpdir(), "starfork-provas-"));
  try {
    const pick: { name: string; path: string; rel: string; kind: ProofKind }[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const [i, f] of o.files.entries()) {
      const kind = proofKind(f.name);
      if (!kind || seen.has(f.name)) continue;
      seen.add(f.name);
      let size = 0;
      try { size = (await stat(f.path)).size; } catch { skipped.push({ name: f.name, why: "arquivo não encontrado" }); continue; }
      const s = kind === "img" ? await shrink(f.path, size, tmp, i) : { path: f.path, size };
      if (s.size > PROVA_MAX_BYTES) { skipped.push({ name: f.name, why: `grande demais (${mb(s.size)}; limite ${mb(PROVA_MAX_BYTES)})` }); continue; }
      if (total + s.size > PROVAS_MAX_TOTAL) { skipped.push({ name: f.name, why: `passou do total de ${mb(PROVAS_MAX_TOTAL)} por tarefa` }); continue; }
      total += s.size;
      pick.push({ name: f.name, path: s.path, rel: proofRelPath(o.prefix, f.name), kind });
    }
    if (!pick.length) return { links, skipped, pushed: false };
    const git = async (args: string[], extra: NodeJS.ProcessEnv = {}, net = false) =>
      (await run("git", ["-C", o.dir, ...args], { env: { ...env, ...extra }, timeout: net ? netTimeoutMs() : 60_000 })).stdout.trim();
    const idx = { GIT_INDEX_FILE: join(tmp, "index") };
    let pushed = false;
    for (let attempt = 0; ; attempt++) {
      let parent = "";
      try {
        await git(["fetch", "--no-tags", "--quiet", remote, `+refs/heads/${PROVAS_BRANCH}:${PROVAS_LOCAL_REF}`], {}, true);
        parent = await git(["rev-parse", "--verify", "--quiet", `${PROVAS_LOCAL_REF}^{commit}`]);
      } catch (e) {
        if (!/couldn't find remote ref|could not find remote ref|no such ref/i.test(short(e))) throw e;
        try { await git(["update-ref", "-d", PROVAS_LOCAL_REF]); } catch { /* não existia */ }
      }
      await git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], idx);
      for (const p of pick) {
        const sha = await git(["hash-object", "-w", "--", p.path]);
        await git(["update-index", "--add", "--cacheinfo", `100644,${sha},${p.rel}`], idx);
      }
      const tree = await git(["write-tree"], idx);
      if (parent && tree === await git(["rev-parse", `${parent}^{tree}`])) break; // já estava tudo lá
      const commit = await git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `starfork: provas de ${safeSeg(o.prefix)}`], PROVAS_AUTHOR);
      try {
        await git(["push", "--quiet", remote, `${commit}:refs/heads/${PROVAS_BRANCH}`], {}, true);
        await git(["update-ref", PROVAS_LOCAL_REF, commit]);
        pushed = true;
        break;
      } catch (e) {
        if (attempt < 2 && /non-fast-forward|fetch first|rejected|stale info/i.test(short(e))) continue;
        throw e;
      }
    }
    for (const p of pick) links[p.name] = { url: proofUrl(o.slug, p.rel, p.kind), kind: p.kind };
    return { links, skipped, pushed };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export interface AttachResult {
  links: ProofLinks;
  /** vai no relatório (em itálico): por que não anexou, ou o que ficou de fora */
  note: string;
  /** público (ou visibilidade desconhecida) sem decisão no projeto: perguntar antes de subir */
  needConfirm?: boolean;
  visibility?: string;
  setting?: ProofSetting;
  pushed?: boolean;
}

/**
 * A porta única: decide (opção do projeto × visibilidade), sobe e devolve links + nota. Nunca lança — falha vira
 * nota "não consegui anexar as provas (motivo)" e o relatório cai pra lista de nomes.
 * `decide` grava a escolha do projeto ANTES (resposta do askYes do app).
 */
export async function attachProofs(o: { dir: string; prefix: string; files: ProofFile[]; ghEnv?: NodeJS.ProcessEnv; gitEnv?: NodeJS.ProcessEnv; decide?: "on" | "off" }): Promise<AttachResult> {
  try {
    if (o.decide) writeProofSetting(o.dir, o.decide);
    const setting = readProofSetting(o.dir);
    const media = o.files.filter((f) => proofKind(f.name));
    if (!media.length) return { links: {}, note: "", setting };
    if (setting === "off") return { links: {}, note: "", setting };
    let info: { slug: string; visibility: string };
    try { info = await ghRepoInfo(o.dir, o.ghEnv); }
    catch (e) { return { links: {}, setting, note: `não consegui anexar as provas (não consegui ler o repositório no GitHub: ${short(e)})` }; }
    if (!info.slug) return { links: {}, setting, note: "não consegui anexar as provas (o projeto não está num repositório do GitHub)" };
    const dec = proofDecision(setting, info.visibility);
    if (dec === "ask") {
      return {
        links: {}, setting, visibility: info.visibility, needConfirm: true,
        note: info.visibility === "PUBLIC"
          ? "provas não anexadas: o repositório é PÚBLICO e prints podem mostrar dados — confirme no Starfork (aba PR) para publicar as imagens"
          : "provas não anexadas: não deu pra confirmar se o repositório é privado — confirme no Starfork (aba PR) para publicar as imagens",
      };
    }
    const r = await pushProofs({ dir: o.dir, prefix: o.prefix, files: media, slug: info.slug, env: o.gitEnv });
    const left = r.skipped.length ? `fora do PR: ${r.skipped.map((s) => `${s.name} — ${s.why}`).join("; ")}` : "";
    return { links: r.links, setting, visibility: info.visibility, pushed: r.pushed, note: left };
  } catch (e) {
    return { links: {}, note: `não consegui anexar as provas (${short(e)})` };
  }
}

/**
 * Troca a seção "## Relatório Starfork" de um corpo de PR pela nova (até o próximo "## ", o rodapé "_Aberto…"/
 * "_Rascunho…" ou o fim). Sem seção → acrescenta no fim. A linha de auditoria "**Aprovado sem prova**" da seção
 * antiga é mantida se a nova não tiver (o relatório do motor não sabe o motivo dado no app).
 */
export function replaceReport(body: string, report: string): string {
  const b = String(body ?? "");
  const rep = String(report ?? "").trim();
  const i = b.indexOf("## Relatório Starfork");
  if (i < 0) return (b.trimEnd() ? b.trimEnd() + "\n\n" : "") + rep + "\n";
  const rest = b.slice(i + 1);
  const m = rest.match(/\n(## |_Aberto |_Rascunho )/);
  const j = m ? i + 1 + (m.index ?? 0) : b.length;
  const old = b.slice(i, j);
  let next = rep;
  const audit = old.split("\n").find((l) => l.startsWith("**Aprovado sem prova**"));
  if (audit && !next.includes("**Aprovado sem prova**")) {
    const L = next.split("\n");
    const at = L.findIndex((l, k) => k > 0 && l.startsWith("**") && !l.startsWith("**Requisitos"));
    L.splice(at < 0 ? L.length : at, 0, audit, "");
    next = L.join("\n");
  }
  return b.slice(0, i) + next.trimEnd() + "\n" + (j < b.length ? "\n" + b.slice(j).replace(/^\n+/, "") : "");
}
