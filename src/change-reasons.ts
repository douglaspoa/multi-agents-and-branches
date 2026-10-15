/**
 * "Por que mudou" POR TRECHO (Código explicado, redesenho "Semana" 14/10 — _bmad-output/redesenho-foco/codigo-explicado.md).
 * O agente chama a tool MCP `register_change_reason` logo depois de editar (ou `starfork porque --json …` no shell, pra
 * qualquer IA): arquivo + faixa de linhas no arquivo NOVO + requisito (R3 / texto / null) + o motivo em 1–2 frases +
 * o teste/prova que cobre. `ts` é preenchido aqui (o agente não escolhe); a "Nª resposta" o app deriva do transcript
 * pelo ts. Grava em `.cardume/artifacts/.starfork/change-reasons.json` (pasta com ponto: não entra na lista de
 * artefatos/entregáveis; o coletor do orquestrador copia a pasta inteira pro repo — persiste depois do merge).
 * Funções puras: testadas em src/change-reasons.test.ts.
 */
import { normFile, normLines, norm } from "./req-map.ts";

export const REASONS_REL = ".cardume/artifacts/.starfork/change-reasons.json";
/** nome pro read_artifact do app (relativo a .cardume/artifacts) */
export const REASONS_ARTIFACT = ".starfork/change-reasons.json";
export const REASON_MIN_WORDS = 4;
export const REASONS_MAX = 400;

export interface ChangeReason { file: string; range: string; requirement: string | null; reason: string; covered_by: string; ts: number; turn?: number | null }

/** "R3" | "r 3" | 3 → "R3"; texto do requisito → "R<n>" se casar com um da tarefa; null/"" → null; lixo → undefined (erro). */
export function normRequirement(v: unknown, known: string[]): string | null | undefined {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^(null|nenhum|nenhuma|none|-)$/i.test(s)) return null;
  const m = s.match(/^r\s*(\d{1,3})$/i) ?? (typeof v === "number" ? [s, s] : null);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && (!known.length || n <= known.length)) return `R${n}`;
    return undefined;
  }
  if (!known.length) return undefined;
  const k = norm(s);
  const i = known.findIndex((x) => norm(x) === k);
  const j = i >= 0 ? i : known.findIndex((x) => { const y = norm(x); return !!y && (y.includes(k) || k.includes(y)); });
  return j >= 0 ? `R${j + 1}` : undefined;
}

/**
 * Valida e limpa o que o agente mandou. known = requisitos da tarefa (TASK.yaml). → { ok, entry } | { ok:false, error }.
 * Motivo genérico demais ("melhoria", "ajuste") é recusado: a tela promete o porquê de cada trecho.
 */
export function cleanReason(args: Record<string, unknown> | null | undefined, known: string[], now: number): { ok: true; entry: ChangeReason } | { ok: false; error: string } {
  const a = args ?? {};
  const file = normFile(a.file);
  if (!file) return { ok: false, error: "file inválido — use o caminho relativo ao repo (ex.: src/carrinho/total.ts)" };
  const range = normLines(a.range ?? a.lines);
  if (range === null || range === "") return { ok: false, error: "range inválido — faixa de linhas no arquivo NOVO, ex.: \"14-15\" ou \"22\"" };
  const requirement = normRequirement(a.requirement ?? a.req, known);
  if (requirement === undefined) return { ok: false, error: `requirement "${String(a.requirement ?? a.req).slice(0, 60)}" não é desta tarefa — use R1…R${known.length || "n"} (ou null se o trecho está fora dos requisitos)` };
  const reason = String(a.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (reason.split(" ").filter((w) => w.length > 1).length < REASON_MIN_WORDS) return { ok: false, error: "reason curto demais — diga em 1–2 frases POR QUE o trecho mudou (o que quebrava, qual regra, qual requisito)" };
  const covered_by = String(a.covered_by ?? a.coveredBy ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return { ok: true, entry: { file, range, requirement, reason, covered_by, ts: now } };
}

/** Funde na lista: mesmo arquivo + mesma faixa = o motivo novo substitui (o agente corrigiu); o resto entra no fim. */
export function mergeReason(list: unknown, e: ChangeReason): ChangeReason[] {
  const arr = (Array.isArray(list) ? list : []).filter((x): x is ChangeReason => !!x && typeof x === "object" && typeof (x as ChangeReason).file === "string");
  const out = arr.filter((x) => !(x.file === e.file && x.range === e.range));
  out.push(e);
  return out.slice(-REASONS_MAX);
}

/** A linha que aparece no terminal (resultado da tool): `starfork · porquê registrado · total.ts:14-15 → R3`. */
export function reasonLine(e: Pick<ChangeReason, "file" | "range" | "requirement">): string {
  const base = e.file.split("/").pop() || e.file;
  return `starfork · porquê registrado · ${base}:${e.range} → ${e.requirement ?? "fora dos requisitos"}`;
}

/** Instrução do prompt da tarefa (Claude: tool MCP; outras IAs: o comando no shell). */
export function reasonRule(viaShell = false): string {
  const how = viaShell ? "`starfork porque --json '{\"file\":\"…\",\"range\":\"14-15\",\"requirement\":\"R3\",\"reason\":\"…\",\"covered_by\":\"…\"}'`" : "a tool register_change_reason (MCP cardume)";
  return `\n\n## Por que cada trecho mudou (Código explicado do Starfork)\n` +
    `Toda edição de código que você MANTIVER precisa de um registro com ${how}, no mesmo turno, logo depois de editar: ` +
    `file (caminho no repo), range (linhas no arquivo NOVO, ex.: "14-15"), requirement ("R3" — o nº do requisito do TASK.yaml — ou null se o trecho está fora dos requisitos), ` +
    `reason (1–2 frases em pt-BR: o que quebrava ou qual regra pediu a mudança — nada de "melhoria"/"ajuste") e covered_by (teste ou prova que cobre, se houver). ` +
    `Se não souber dizer por que um trecho mudou, desfaça o trecho. Quando o humano perguntar sobre um trecho (@arquivo:linhas), responda em 1–3 frases citando arquivo:linha e o requisito, e registre o porquê se ainda não estava registrado.`;
}
