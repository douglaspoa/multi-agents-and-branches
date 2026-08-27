import type { Review, ReviewFunction } from "./types.ts";

interface Pattern {
  re: RegExp;
  kind: string;
  group: number;
}

// Padrões de definição em várias linguagens. Best-effort — cobre o comum.
const PATTERNS: Pattern[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/, kind: "function", group: 1 },
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/, kind: "class", group: 1 },
  { re: /^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_,\s]*)\s*=>/, kind: "const", group: 1 },
  { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/, kind: "fn", group: 1 },
  { re: /^\s*def\s+([A-Za-z0-9_]+)/, kind: "def", group: 1 },
];

const COMMENT = /^\s*(?:\/\/+|#+|\/\*+|\*)\s?(.*\S)?/;

/**
 * Constrói um review humano a partir de um diff unificado (git diff base...HEAD).
 * Extrai: funções/classes criadas (com propósito, quando há comentário logo acima),
 * arquivos alterados com +/- e uma dica de como testar. É FATUAL — sai do código real.
 */
export function buildReview(diff: string, byAgent: string): Review {
  const files: Record<string, { add: number; del: number }> = {};
  const functions: ReviewFunction[] = [];
  let curFile = "";
  let pendingComment = "";

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      curFile = raw.slice(6).trim();
      files[curFile] ??= { add: 0, del: 0 };
      pendingComment = "";
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("@@")) {
      pendingComment = "";
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (curFile) (files[curFile] ??= { add: 0, del: 0 }).add++;
      const line = raw.slice(1);
      const cm = line.match(COMMENT);
      if (cm && cm[1]) {
        pendingComment = cm[1].replace(/\*\/\s*$/, "").trim();
        continue;
      }
      for (const p of PATTERNS) {
        const m = line.match(p.re);
        if (m) {
          functions.push({
            name: m[p.group],
            file: curFile,
            kind: p.kind,
            purpose: pendingComment || derivePurpose(m[p.group]),
          });
          break;
        }
      }
      pendingComment = "";
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      if (curFile) (files[curFile] ??= { add: 0, del: 0 }).del++;
    }
  }

  const isNoise = (p: string) => p.startsWith(".cardume/");
  const fileList = Object.entries(files)
    .filter(([path]) => !isNoise(path))
    .map(([path, s]) => ({ path, add: s.add, del: s.del }));
  const fnList = functions.filter((f) => !isNoise(f.file));
  functions.length = 0;
  functions.push(...fnList);
  const testFiles = fileList.filter((f) => /\.(test|spec)\.|(^|\/)tests?\//.test(f.path));
  const howToTest =
    testFiles.length > 0
      ? `Rode os testes: ${testFiles.map((f) => f.path).join(", ")}.`
      : "Sem testes automatizados detectados — revise manualmente os arquivos alterados e cubra o caminho principal.";

  const summary =
    functions.length > 0
      ? `${functions.length} definição(ões) nova(s) em ${fileList.length} arquivo(s). Principais: ${functions
          .slice(0, 3)
          .map((f) => f.name)
          .join(", ")}.`
      : `${fileList.length} arquivo(s) alterado(s), sem novas funções detectadas.`;

  return { summary, functions, files: fileList, howToTest, byAgent };
}

function derivePurpose(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return `(inferido) ${words}`;
}
