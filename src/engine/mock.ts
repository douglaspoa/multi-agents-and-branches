import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sleep } from "../util/run.ts";
import { camelId } from "../types.ts";
import type { AgentEngine, AgentEvent, RunInput } from "./types.ts";

/**
 * Motor falso — não chama IA nenhuma. Age conforme o PAPEL (planner/builder/
 * reviewer) e, no builder, escreve funções REAIS com comentário de propósito,
 * para o review humano ter conteúdo verdadeiro extraído do diff.
 */
export class MockEngine implements AgentEngine {
  id = "mock";
  displayName = "Mock (demo, sem IA)";
  private speed: number;

  constructor(opts: { speed?: number } = {}) {
    // CARDUME_MOCK_SPEED acelera o mock nos testes (piloto automático roda várias tarefas)
    this.speed = opts.speed ?? (Number(process.env.CARDUME_MOCK_SPEED) > 0 ? Number(process.env.CARDUME_MOCK_SPEED) : 1);
  }

  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    if (input.role === "planner") {
      yield* this.plan(input);
    } else if (input.role === "reviewer") {
      yield* this.review(input);
    } else {
      yield* this.build(input);
    }
    // custo por PAPEL (testes do teto/ciclo): CARDUME_MOCK_ROLE_COST_USD vale pra todo papel, inclusive revisão
    const per = Number(process.env.CARDUME_MOCK_ROLE_COST_USD);
    if (per > 0) yield { type: "note", text: `custo do turno (mock, ${input.role})`, cost: { usd: per, inTok: 500, outTok: 50 } };
  }

  private async *plan(input: RunInput): AsyncIterable<AgentEvent> {
    const step = 200 / this.speed;
    const { spec, cwd } = input;
    yield { type: "status", text: "planejando a tarefa", status: "thinking" };
    await sleep(step);
    yield { type: "read", text: "lendo objetivo e requisitos" };
    await sleep(step);
    const plan = [
      `# Plano — ${spec.title}`,
      ``,
      `## Objetivo`,
      spec.objective,
      ``,
      `## Passos`,
      ...spec.deliverables.map((d, i) => `${i + 1}. ${d}`),
      ``,
      `## Fora do escopo`,
      ...(spec.scope.offLimits.length ? spec.scope.offLimits.map((o) => `- ${o}`) : ["- (nada)"]),
      ``,
    ].join("\n");
    await mkdir(join(cwd, ".cardume"), { recursive: true });
    await writeFile(join(cwd, ".cardume", "PLAN.md"), plan, "utf8");
    yield { type: "write", text: ".cardume/PLAN.md — plano em " + spec.deliverables.length + " passos", ok: true };
    await sleep(step);
    yield { type: "note", text: "plano pronto · passando para a implementação" };
  }

  private async *build(input: RunInput): AsyncIterable<AgentEvent> {
    const step = 210 / this.speed;
    const { spec, cwd } = input;
    yield { type: "status", text: "worktree pronta · implementando", status: "running" };
    await sleep(step);

    // Reivindica dinamicamente um arquivo compartilhado (dispara o barramento).
    const shared = "src/lib/format.ts";
    yield { type: "claim", text: shared, path: shared, mode: "write" };
    await sleep(step);

    const ownDir = firstOwnedDir(spec.scope.owns);
    const rel = join(ownDir, `${spec.id}.ts`);
    const abs = join(cwd, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, implBody(spec), "utf8");
    yield { type: "edit", text: `${rel} — ${spec.deliverables.length} função(ões)`, ok: true };
    await sleep(step);

    if (spec.autonomy.runTests) {
      const trel = join(ownDir, `${spec.id}.test.ts`);
      await writeFile(join(cwd, trel), testBody(spec), "utf8");
      yield { type: "write", text: `${trel} — testes`, ok: true };
      await sleep(step);
      yield { type: "bash", text: `npm test ${ownDir} — passed`, ok: true };
      await sleep(step);
    }
    // PILOTO AUTOMÁTICO (CARDUME_AUTOPILOT=1): o mock também PROVA os requisitos (requirements.json com
    // evidência real no disco), pro gate do piloto ter o que verificar sem IA. Marcadores no texto do
    // requisito simulam prova que falha: "[mock:falha-N]" reprova as N primeiras tentativas; "[mock:falha-sempre]" nunca passa.
    if (process.env.CARDUME_AUTOPILOT === "1" || process.env.CARDUME_MOCK_PROVE === "1") {
      const art = join(cwd, ".cardume", "artifacts");
      await mkdir(art, { recursive: true });
      const counter = join(cwd, ".cardume", "mock-attempts");
      let attempt = 1;
      try { attempt = (Number((await readFile(counter, "utf8")).trim()) || 0) + 1; } catch { /* 1ª tentativa */ }
      await writeFile(counter, String(attempt), "utf8");
      const ev = `evidence-${spec.id}.md`;
      await writeFile(join(art, ev), `# Prova (mock) — ${spec.title}\n\nTentativa ${attempt}: ${rel} criado.\n`, "utf8");
      const list = (spec.requirements ?? []).map((req) => {
        const m = /\[mock:falha-(\d+|sempre)\]/.exec(req);
        const fails = m ? (m[1] === "sempre" ? true : attempt <= Number(m[1])) : false;
        return fails
          ? { req, status: "blocked", evidence: [], note: `mock: prova falhou na tentativa ${attempt}` }
          : { req, status: "done", evidence: [ev], note: "mock" };
      });
      await writeFile(join(art, "requirements.json"), JSON.stringify(list, null, 2), "utf8");
      // suposição registrada como o piloto manda (bus.ts / ask_human automático) — o relatório lê daqui
      await writeFile(join(art, "ASSUMPTIONS.md"), `- (mock) ${spec.title}: decidi seguir a opção mais simples (tentativa ${attempt})\n`, "utf8");
      yield { type: "write", text: `.cardume/artifacts/requirements.json — ${list.filter((x) => x.status === "done").length}/${list.length} provados`, ok: true };
      const usd = Number(process.env.CARDUME_MOCK_COST_USD);
      if (usd > 0) yield { type: "note", text: "custo do turno (mock)", cost: { usd, inTok: 1000, outTok: 100 } };
    }
    yield { type: "note", text: "implementação concluída · pronta para revisão", status: "review" };
  }

  private async *review(input: RunInput): AsyncIterable<AgentEvent> {
    const step = 200 / this.speed;
    yield { type: "status", text: "revisando o que foi feito", status: "review" };
    await sleep(step);
    yield { type: "read", text: "lendo o diff da branch (git diff base...HEAD)" };
    await sleep(step);
    // VEREDITO (P3): CARDUME_MOCK_VERDICTS="muda,aprova" dá um por rodada (o último se repete); "ilegivel" não escreve
    // linha de veredito. Sem a variável: aprova.
    const list = String(process.env.CARDUME_MOCK_VERDICTS ?? "aprova").split(",").map((x) => x.trim()).filter(Boolean);
    const counter = join(input.cwd, ".cardume", "mock-review-round");
    let n = 0;
    try { n = Number((await readFile(counter, "utf8")).trim()) || 0; } catch { /* 1ª rodada */ }
    await mkdir(join(input.cwd, ".cardume"), { recursive: true });
    await writeFile(counter, String(n + 1), "utf8");
    const v = list[Math.min(n, list.length - 1)] ?? "aprova";
    const body = v === "muda" ? "VEREDITO: muda\n- cobrir o caso de lista vazia\n- nomear melhor a função principal\n"
      : v === "ilegivel" ? "Revisei e parece ok, mas não tenho certeza.\n"
      : "VEREDITO: aprova\n";
    await writeFile(join(input.cwd, ".cardume", "VEREDITO.md"), body, "utf8");
    yield { type: "write", text: `.cardume/VEREDITO.md — ${v}`, ok: true };
    // O Review fatual é montado pelo orquestrador (a partir do diff real).
    yield { type: "note", text: "resumo de revisão gerado · pronto para review humano", status: "review" };
  }
}

function firstOwnedDir(owns: string[]): string {
  const raw = owns[0] ?? "src";
  return raw.replace(/\/\*+.*$/, "").replace(/\/[^/]*\.[a-z]+$/i, "") || "src";
}

/** Gera uma função por entregável, com o comentário de propósito logo acima. */
function implBody(spec: { title: string; agent: string; deliverables: string[]; id: string }): string {
  const header = [
    `// Gerado pelo Starfork (MockEngine) — agente ${spec.agent}`,
    `// Tarefa: ${spec.title}`,
    ``,
  ];
  const fns = spec.deliverables.map((d, i) => {
    const name = camelId(d, `passo${i + 1}`);
    return [`// ${d}`, `export function ${name}(): void {`, `  // TODO: implementar`, `}`, ``].join("\n");
  });
  return header.concat(fns).join("\n") + "\n";
}

function testBody(spec: { id: string; deliverables: string[] }): string {
  const first = camelId(spec.deliverables[0] ?? "passo1", "passo1");
  return `import { ${first} } from "./${spec.id}.ts";\n\ntest("${spec.id} exporta ${first}", () => {\n  expect(typeof ${first}).toBe("function");\n});\n`;
}
