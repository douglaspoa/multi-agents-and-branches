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
