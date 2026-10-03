// Mapa requisito → trechos (Revisão por requisito): `node --test src/req-map.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCode, cleanTests, mergeReqMap, normFile, normLines } from "./req-map.ts";

test("normLines aceita faixa, linha única e lista; recusa lixo", () => {
  assert.equal(normLines("12-30"), "12-30");
  assert.equal(normLines("12 – 30"), "12-30");
  assert.equal(normLines("7"), "7");
  assert.equal(normLines([3, 9]), "3-9");
  assert.equal(normLines(""), "");
  assert.equal(normLines(undefined), "");
  assert.equal(normLines("30-12"), null, "fim antes do início");
  assert.equal(normLines("linhas 3 a 9"), null);
});
test("normFile tira ./ e recusa absoluto e ..", () => {
  assert.equal(normFile("./src/a.ts"), "src/a.ts");
  assert.equal(normFile("/etc/passwd"), null);
  assert.equal(normFile("src/../../x"), null);
  assert.deepEqual(cleanCode([{ file: "./a.ts", lines: "1-2" }, { file: "b.ts" }, { file: "/x" }, { file: "c.ts", lines: "zz" }]), [{ file: "a.ts", lines: "1-2" }, { file: "b.ts" }]);
  assert.deepEqual(cleanTests([{ name: " t1 ", status: "pass" }, { name: "t2", status: "??" }, { name: "" }]), [{ name: "t1", status: "pass" }, { name: "t2", status: "missing" }]);
});
test("mergeReqMap casa pelo texto e não mexe na prova", () => {
  const cur = [{ req: "Botão remarcar em cada aula", status: "done", evidence: ["p.png"], note: "ok" }];
  const { list, entry } = mergeReqMap(cur, { req: "botão REMARCAR em cada aula", did: "pus o botão", code: [{ file: "src/A.tsx", lines: "84-88" }], tests: [{ name: "a › b", status: "pass" }] });
  assert.equal(list.length, 1);
  assert.equal(entry.status, "done");
  assert.deepEqual(entry.evidence, ["p.png"]);
  assert.equal(entry.did, "pus o botão");
  assert.deepEqual(entry.code, [{ file: "src/A.tsx", lines: "84-88" }]);
  // requisito ainda não listado entra como "pending" (sem prova — o portão continua cobrando)
  const r2 = mergeReqMap(list, { req: "Aviso de confirmação", code: [] });
  assert.equal(r2.list.length, 2);
  assert.equal(r2.entry.status, "pending");
  assert.deepEqual(r2.entry.evidence, []);
  // arquivo lixo vira lista vazia, não quebra
  assert.deepEqual(mergeReqMap("lixo", { req: "x", code: [{ file: "a" }] }).list.length, 1);
});
