/**
 * Mapa REQUISITO → TRECHOS (Revisão por requisito, 03/10). O agente registra, por requisito, os arquivos + faixas de
 * linhas que mudou por ele e os testes que o cobrem — no MESMO arquivo das provas (`.cardume/artifacts/requirements.json`),
 * pelos campos `did`, `code` e `tests`. Pode escrever direto no arquivo (todos os motores) ou pela tool MCP
 * `map_requirement` (Claude), que chama `mergeReqMap` abaixo. Funções puras: testadas em src/req-map.test.ts.
 */
export interface ReqCode { file: string; lines?: string }
export interface ReqTest { name: string; status: "pass" | "fail" | "missing" }
export interface ReqEntry { req: string; status?: string; evidence?: string[]; note?: string; did?: string; code?: ReqCode[]; tests?: ReqTest[]; [k: string]: unknown }

export const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** "12-30" | "12" | "12–30" | [12, 30] → "12-30" (vazio = o arquivo inteiro). Lixo → null. */
export function normLines(v: unknown): string | null {
  if (v == null || v === "") return "";
  if (Array.isArray(v) && v.length >= 1) { const a = Number(v[0]), b = Number(v[v.length - 1]); return a > 0 && b >= a ? (a === b ? String(a) : `${a}-${b}`) : null; }
  const m = String(v).trim().match(/^(\d+)(?:\s*[-–—:]\s*(\d+))?$/);
  if (!m) return null;
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
  if (!(a > 0) || b < a) return null;
  return a === b ? String(a) : `${a}-${b}`;
}
/** caminho como o agente cita → relativo ao repo ("./src/a.ts" → "src/a.ts"); absoluto/".." → null. */
export function normFile(f: unknown): string | null {
  const s = String(f ?? "").trim().replace(/^(\.\/)+/, "").replace(/\\/g, "/");
  if (!s || s.startsWith("/") || s.split("/").includes("..")) return null;
  return s;
}
export function cleanCode(list: unknown): ReqCode[] {
  const out: ReqCode[] = [];
  for (const c of Array.isArray(list) ? list : []) {
    const file = normFile((c as ReqCode)?.file);
    const lines = normLines((c as ReqCode)?.lines);
    if (!file || lines === null) continue;
    out.push(lines ? { file, lines } : { file });
  }
  return out.slice(0, 60);
}
export function cleanTests(list: unknown): ReqTest[] {
  const ok = ["pass", "fail", "missing"];
  return (Array.isArray(list) ? list : [])
    .map((t) => ({ name: String((t as ReqTest)?.name ?? "").trim().slice(0, 200), status: (ok.includes(String((t as ReqTest)?.status)) ? (t as ReqTest).status : "missing") as ReqTest["status"] }))
    .filter((t) => t.name)
    .slice(0, 30);
}
/**
 * Funde o mapa de UM requisito na lista do requirements.json: casa pelo texto (normalizado); requisito ainda não
 * listado entra com status "pending" (sem prova). Status/evidência existentes NÃO mudam aqui — prova é outra coisa.
 */
export function mergeReqMap(list: unknown, m: { req: string; did?: string; code?: unknown; tests?: unknown }): { list: ReqEntry[]; entry: ReqEntry } {
  const arr: ReqEntry[] = (Array.isArray(list) ? list as ReqEntry[] : []).filter((x) => x && typeof x === "object");
  const key = norm(m.req);
  let e = arr.find((x) => norm(x.req) === key);
  if (!e) { e = { req: String(m.req).trim(), status: "pending", evidence: [] }; arr.push(e); }
  if (m.did != null && String(m.did).trim()) e.did = String(m.did).trim().slice(0, 600);
  if (m.code !== undefined) e.code = cleanCode(m.code);
  if (m.tests !== undefined) e.tests = cleanTests(m.tests);
  return { list: arr, entry: e };
}
