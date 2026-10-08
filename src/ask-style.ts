// Como o agente PERGUNTA ao humano — fonte única do formato (08/10: "a folha está ruim de ler, só um texto gigante").
// A pergunta aparece numa folha pequena por cima do terminal (app/src/js/60-terminal-layout.js): o título é a frase que
// termina em "?", o resto vira contexto recolhível. Esta regra entra no prompt do motor (engine/claude.ts, engine/dsh.ts),
// na regra de conversa (orchestrator.ts), no terminal integrado (CLAUDE/AGENTS.md — terminal-integrado.ts) e na própria
// descrição da tool ask_human (mcp/tools.ts). Perguntas antigas (só question + options) continuam valendo.

/** Regra de formato da pergunta (vai no prompt de todo motor que pergunta ao humano). */
export const ASK_STYLE =
  " COMO PERGUNTAR AO HUMANO (a pergunta aparece numa folha pequena por cima do terminal): " +
  "(a) a pergunta em UMA frase curta terminando em '?' — sem contexto dentro dela; " +
  "(b) o contexto à parte, em até 3–5 tópicos curtos ('- item', uma linha cada), nunca um parágrafo corrido — " +
  "no ask_human use o campo `context`; no AskUserQuestion, escreva os tópicos no texto ANTES de chamar a ferramenta; " +
  "(c) cada opção = rótulo curto (até ~6 palavras) + descrição de 1 linha — no AskUserQuestion, `label` + `description`; " +
  "no ask_human, 'Rótulo — descrição'.";

/** Contexto do ask_human (texto com '- item' por linha, ou lista) → markdown em tópicos; qualquer outro tipo = sem contexto. */
export function askContextText(context: unknown): string {
  const bullet = (x: string) => (/^[-*•]\s/.test(x) ? x : `- ${x}`);
  if (Array.isArray(context)) return context.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).map(bullet).join("\n");
  return typeof context === "string" ? context.trim() : "";
}
/**
 * O que vai pro `pending`: a PERGUNTA primeiro (notificação, celular, nuvem e prévias cortam o começo do texto — a
 * pergunta nunca some), o contexto depois de uma linha em branco; com contexto, `meta.question` diz à folha onde a
 * pergunta termina (sem adivinhar pelo "?"). Sem contexto = exatamente como antes (texto = pergunta, sem meta).
 */
export function askPending(question: string, context?: unknown): { prompt: string; meta?: { src: "ask"; question: string } } {
  const q = String(question ?? "").trim();
  const c = askContextText(context);
  return c ? { prompt: `${q}\n\n${c}`, meta: { src: "ask", question: q } } : { prompt: q };
}
