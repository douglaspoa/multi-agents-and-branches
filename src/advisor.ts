/**
 * CONSELHEIRO — o "advisor tool" do Claude Code (experimental; code.claude.com/docs/en/advisor, conferido em 07/10/2026).
 * O modelo principal consulta um modelo mais forte em momentos-chave (antes do plano, erro que se repete, antes de
 * terminar); cada consulta é cobrada à parte (conta no limite do plano). Só na API da Anthropic.
 *
 * COMO LIGA (Claude Code 2.1.280): `--settings '{"advisorModel":"opus"}'` — a setting `advisorModel` é documentada e
 * vale só pra sessão quando vem pelo --settings. A flag `--advisor <m>` EXISTE (oculta do --help), mas ENCERRA o
 * claude na largada quando o par não é aceito ou o Fable ainda não tem o consentimento de créditos — a tarefa morreria.
 * Pela setting o Claude Code só deixa de anexar o conselheiro (doc: "sends requests without the advisor").
 *
 * Mesma regra do front: app/src/js/29-ia-picker.js (@advisor-puro) — o teste app/tests/advisor.test.mjs compara os dois.
 */
import { spawnSync } from "node:child_process";

export type Advisor = "opus" | "fable";
/** Versão mínima do Claude Code (a doc cita 2.1.260 pro /advisor fora do terminal, o caso do `claude -p`). */
export const ADVISOR_MIN_CLI = "2.1.260";
export const ADVISOR_NAME: Record<Advisor, string> = { opus: "Opus", fable: "Fable" };

export function advisorNorm(v: unknown): Advisor | null {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "opus" || s === "fable" ? s : null;
}

/** Família e versão de um id/alias do Claude ("claude-opus-4-8" → opus 4.8; "sonnet" → sonnet sem versão = o mais novo). */
export function modelFamily(model: string | null | undefined): { fam: string; ver: number | null } {
  const m = String(model ?? "").toLowerCase().match(/(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d{1,2})(?!\d))?)?/);
  if (!m) return { fam: "", ver: null };
  return { fam: m[1], ver: m[2] ? Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0) : null };
}

/**
 * O par (modelo principal × conselheiro) é aceito? Tabela da doc: o conselheiro precisa ser pelo menos tão capaz quanto
 * o principal; com Fable no principal só Fable aconselha; modelo principal anterior ao Opus/Sonnet 4.6 não aceita.
 * Modelo vazio = o padrão do plano (não dá pra saber aqui → aceito; o Claude Code confere de novo).
 */
export function advisorPair(engine: string | null | undefined, model: string | null | undefined, advisor: unknown): { ok: boolean; why: string } {
  const adv = advisorNorm(advisor);
  const e = String(engine ?? "claude").trim().toLowerCase() || "claude";
  if (e.startsWith("deepseek") || /^dsh\b/.test(e)) return { ok: !adv, why: "o DeepSeek roda dentro do Claude Code com outro endereço — o conselheiro só existe na API da Anthropic" };
  if (e !== "claude") return { ok: !adv, why: "o conselheiro é um recurso do Claude Code" };
  if (!adv) return { ok: true, why: "" };
  const { fam, ver } = modelFamily(model);
  if (fam === "fable" && adv === "opus") return { ok: false, why: "com Fable como modelo principal, só o Fable pode aconselhar" };
  const mainOk = !fam || ver == null || fam === "fable" || ((fam === "opus" || fam === "sonnet") && ver >= 4.6) || (fam === "haiku" && (ver === 4.5 || ver >= 5.5));
  if (!mainOk) return { ok: false, why: "este modelo não aceita conselheiro — use Opus/Sonnet 4.6 ou mais novo, Haiku 4.5 ou Fable" };
  return { ok: true, why: "" };
}

/** "2.1.280 (Claude Code)" ≥ mínimo? null = não sei (sem versão) — aí não bloqueia. */
export function cliVersionOk(version: string | null | undefined, min = ADVISOR_MIN_CLI): boolean | null {
  const m = String(version ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const a = [Number(m[1]), Number(m[2]), Number(m[3])], b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

const verCache = new Map<string, string | null>();
/** `claude --version` (só a versão; não chama IA) — uma vez por binário por processo. */
export function claudeCliVersion(bin: string): string | null {
  if (verCache.has(bin)) return verCache.get(bin)!;
  let v: string | null = null;
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    v = r.status === 0 ? (String(r.stdout).match(/\d+\.\d+\.\d+/)?.[0] ?? null) : null;
  } catch { v = null; }
  verCache.set(bin, v);
  return v;
}

/**
 * Args do `claude` pro conselheiro (terminal, `-p` e retomada usam o MESMO): `--settings {"advisorModel":…}` ou nada.
 * `note`: por que ficou desligado (vai pro histórico da tarefa) — vazio quando nem foi pedido.
 */
export function advisorArgs(o: { engine?: string | null; model?: string | null; advisor?: unknown; cliVersion?: string | null; viaGateway?: boolean }): { args: string[]; on: Advisor | null; note: string } {
  const adv = advisorNorm(o.advisor);
  if (!adv) return { args: [], on: null, note: "" };
  const off = (why: string) => ({ args: [], on: null, note: `Conselheiro (${ADVISOR_NAME[adv]}) desligado: ${why}.` });
  const pair = advisorPair(o.engine, o.model, adv);
  if (!pair.ok) return off(pair.why);
  if (o.viaGateway) return off("este turno roda numa IA alternativa (gateway) — o conselheiro só existe na API da Anthropic");
  if (cliVersionOk(o.cliVersion) === false) return off(`precisa atualizar o Claude Code (instalado ${o.cliVersion}, mínimo ${ADVISOR_MIN_CLI})`);
  return { args: ["--settings", JSON.stringify({ advisorModel: adv })], on: adv, note: "" };
}

/** Bloco do stream-json do Claude Code que é uma consulta ao conselheiro (server_tool_use "advisor") ou o resultado dela. */
export function advisorEventOf(block: any): string | null {
  if (!block || typeof block !== "object") return null;
  if (block.type === "server_tool_use" && block.name === "advisor") return "Conselheiro consultado";
  if (block.type === "advisor_tool_result") {
    const c = block.content;
    if (c?.type === "advisor_tool_result_error") return `Conselheiro indisponível${c.error_code ? ` (${c.error_code})` : ""}`;
    if (c?.stop_reason === "refusal") return "Conselheiro preferiu não opinar neste ponto";
    return null; // orientação recebida: o "consultado" já foi registrado
  }
  return null;
}

/**
 * Parte do conselheiro no custo, pelo `modelUsage` do `result` (o Claude Code soma as consultas no modelo do conselheiro,
 * por id). Só dá pra separar quando o conselheiro é de outra família que o principal (Opus aconselhando Opus = uma
 * linha só). Acumulado da SESSÃO (como o total_cost_usd). null = não separável.
 */
export function advisorCostOf(modelUsage: any, advisor: unknown, mainModel: string | null | undefined): number | null {
  const adv = advisorNorm(advisor);
  if (!adv || !modelUsage || typeof modelUsage !== "object") return null;
  const main = modelFamily(mainModel).fam;
  if (!main || main === adv) return null;
  let usd = 0, seen = false;
  for (const [id, u] of Object.entries(modelUsage)) {
    if (modelFamily(id).fam !== adv) continue;
    const c = Number((u as any)?.costUSD);
    if (Number.isFinite(c)) { usd += c; seen = true; }
  }
  return seen ? Math.round(usd * 1e6) / 1e6 : null;
}
