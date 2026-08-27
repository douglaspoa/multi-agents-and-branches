import { mkdir, writeFile } from "node:fs/promises";
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
    this.speed = opts.speed ?? 1;
  }

  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    if (input.role === "planner") {
      yield* this.plan(input);
    } else if (input.role === "reviewer") {
      yield* this.review(input);
    } else {
      yield* this.build(input);
    }
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
    yield { type: "note", text: "implementação concluída · pronta para revisão", status: "review" };
  }

  private async *review(input: RunInput): AsyncIterable<AgentEvent> {
    const step = 200 / this.speed;
    yield { type: "status", text: "revisando o que foi feito", status: "review" };
    await sleep(step);
    yield { type: "read", text: "lendo o diff da branch (git diff base...HEAD)" };
    await sleep(step);
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
    `// Gerado pelo Cardume (MockEngine) — agente ${spec.agent}`,
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
