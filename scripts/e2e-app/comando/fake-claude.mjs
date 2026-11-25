#!/usr/bin/env node
// IA FALSA do e2e do Comando: faz o papel do planejador. Registra o que o APP mandou de verdade (tamanho, se o pedido e
// as regras chegaram inteiros, o que veio nos ACHADOS) e devolve um plano fixo por pedido. Nunca é o `claude` real.
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2), val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ""; };
if (argv.includes("--version")) { console.log("9.9.9 (Claude Code FALSO)"); process.exit(0); }
if (argv.includes("--help")) { console.log("--resume --permission-mode --model --append-system-prompt --mcp-config"); process.exit(0); }
const prompt = val("-p") || "", sys = val("--system-prompt") || "";
const out = (result) => { console.log(JSON.stringify({ type: "result", subtype: "success", result, session_id: "fake", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })); process.exit(0); };
if (!/Comando do Starfork/.test(sys)) out("ok");
// ---------- AGENTE (tem --mcp-config): em vez de um modelo, um roteiro que USA A PONTE de verdade como o servidor MCP usaria
if (argv.includes("--mcp-config")) {
  const { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } = await import("node:fs"); const { join } = await import("node:path");
  const cfg = JSON.parse(readFileSync(val("--mcp-config"), "utf8")), PONTE = cfg.mcpServers.starfork.env.STARFORK_PONTE, acoes = cfg.mcpServers.starfork.env.STARFORK_ACOES || "";
  const pedido = prompt.slice(prompt.lastIndexOf("[/CONTEXTO]") + 11).trim(), resume = val("--resume");
  appendFileSync(process.env.STUB_LOG, JSON.stringify({ agente: true, pedido, resume, temContexto: /\[CONTEXTO DO APP AGORA\]/.test(prompt), sysOk: /COMO VOCÊ TRABALHA/.test(sys), acoesOk: /abrir_pr/.test(acoes) && /criar_issue/.test(acoes), allowed: val("--allowedTools") }) + "\n");
  const linha = (o) => console.log(JSON.stringify(o));
  const falhou = /falha mcp/i.test(pedido);
  linha({ type: "system", subtype: "init", session_id: "fake-ag-1", mcp_servers: [{ name: "starfork", status: falhou ? "failed" : "connected" }] });
  let n = 0;
  const ferramenta = async (tool, args) => { const id = "e2e-" + (++n) + "-" + process.pid, tmp = join(PONTE, id + ".tmp");
    linha({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__starfork__" + tool, input: args }] } });
    writeFileSync(tmp, JSON.stringify({ id, tool, args })); renameSync(tmp, join(PONTE, id + ".req.json"));
    const res = join(PONTE, id + ".res.json"), t0 = Date.now(); while (!existsSync(res) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 100));
    if (!existsSync(res)) return "SEM RESPOSTA DO APP"; const t = JSON.parse(readFileSync(res, "utf8")).texto; unlinkSync(res); return t; };
  let texto = "não sei";
  if (falhou) { await new Promise((r) => setTimeout(r, 3000)); texto = "**agir**(fingindo)"; }
  else if (/^ol[aá]$/i.test(pedido)) texto = "Oi! Tudo certo por aqui.";
  else if (/google/i.test(pedido)) texto = "LIDO: " + await ferramenta("ver", { o_que: "issue", alvo: "entrar com a conta do google", mostrar: true });
  else if (/busca/i.test(pedido)) texto = "ACHEI: " + await ferramenta("buscar", { texto: "carrinho demorando" });
  else if (/como est[aã]o/i.test(pedido)) texto = "GERAL: " + await ferramenta("ver", { o_que: "geral" });
  else if (/encerra/i.test(pedido)) texto = "RES: " + await ferramenta("agir", { acao: "encerrar", tarefas: ["t1"] });
  else if (/dois passos/i.test(pedido)) { const a = await ferramenta("buscar", { texto: "planilha financeiro" }); const b = await ferramenta("ver", { o_que: "issue", alvo: "LW-301" }); texto = "A: " + a.slice(0, 80) + " B: " + b.slice(0, 120); }
  else if (/desconhecida/i.test(pedido)) texto = "RES: " + await ferramenta("agir", { acao: "voar", tarefas: [] });
  linha({ type: "assistant", message: { content: [{ type: "text", text: texto }] } });
  linha({ type: "result", subtype: "success", result: texto, session_id: "fake-ag-1", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}
const pedido = (/PEDIDO DA PESSOA: (.*)/.exec(prompt) || [])[1] || "", ach = (/ACHADOS PELA BUSCA[^\n]*\n([\s\S]*?)\n\n/.exec(prompt + "\n\n") || [])[1] || "";
const codigos = [...ach.matchAll(/\] (LW-\d+)/g)].map((m) => m[1]);
appendFileSync(process.env.STUB_LOG, JSON.stringify({ pedido, promptLen: prompt.length, sysLen: sys.length, temPedido: !!pedido, temRegras: /REGRAS:/.test(sys) && /ACHAR SEM O CÓDIGO/.test(sys), temFormato: /"passos"/.test(sys), achados: codigos }) + "\n");
const plano = (fala, passos, duvida) => out(JSON.stringify({ fala: fala || "", passos: passos || [], duvida: duvida || "" }));
if (!pedido) plano("PEDIDO NÃO CHEGOU");
if (/^ol[aá]$/i.test(pedido.trim())) plano("Oi! Estou por aqui. Quer ver como estão as tarefas?");
if (/conta do google/i.test(pedido)) codigos.includes("LW-302") ? plano("", [{ acao: "issue", alvo: "LW-302" }]) : plano("A LW-302 NÃO VEIO NOS ACHADOS");
if (/carrinho/i.test(pedido)) plano("", [{ acao: "issue", alvo: "carrinho demorando" }]);
if (/rodap/i.test(pedido)) plano("", [{ acao: "issue", alvo: "ajuste de layout do rodapé" }]);
if (/banana/i.test(pedido)) plano("", [{ acao: "issue", alvo: "banana nanica" }]);
plano("não sei");
