#!/usr/bin/env node
// Servidor MCP do COMANDO do Starfork (stdio, sem dependências). Dá ao agente do chat as ferramentas pra procurar, ler
// e agir. Cada chamada vira um pedido na PONTE (uma pasta): o app executa com as MESMAS funções das telas e devolve o
// resultado. Assim o agente enxerga e mexe em tudo o que a pessoa vê, sem um segundo caminho de regras.
import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const PONTE = process.env.STARFORK_PONTE; if (!PONTE) { console.error("STARFORK_PONTE não definido"); process.exit(2); }
mkdirSync(PONTE, { recursive: true });
const ACOES = process.env.STARFORK_ACOES || "";
const VER = ["geral", "tarefa", "issue", "fila_issues", "epicos", "epico", "plano", "provas", "arquivos", "pr_ci", "porque_parou", "o_que_foi_feito", "links", "time", "entregas", "uso", "prontas_pra_aprovar", "conflitos", "esperando_voce"];
const TOOLS = [
  { name: "buscar", description: "Procura por SENTIDO em tudo: tarefas (abertas e encerradas), issues do painel e cartões do time. Use SEMPRE que a pessoa descrever algo sem dar o código (\"a do frete\", \"aquela issue do login\"). Aceita pedaço de título, de descrição, número ou palavras soltas. Devolve os mais parecidos com código, título, situação e um trecho.",
    inputSchema: { type: "object", properties: { texto: { type: "string", description: "o que procurar, com as palavras da pessoa" } }, required: ["texto"] } },
  { name: "ver", description: "Lê o estado REAL de algo no Starfork e devolve em texto. o_que: geral (todas as tarefas abertas com os fatos) | tarefa (estado completo: requisitos com prova, plano, PR, última fala do agente, pergunta aberta) | issue (descrição e requisitos) | fila_issues | epicos | epico | plano (o plano que espera aprovação) | provas | arquivos (o que a tarefa alterou) | pr_ci (PR, checagens, revisão) | porque_parou | o_que_foi_feito | links | time (quem está com o quê) | entregas | uso (gasto com IA) | prontas_pra_aprovar | conflitos | esperando_voce. alvo = código da tarefa/issue ou nome do épico/pessoa quando fizer sentido. mostrar=true também desenha o cartão no chat pra pessoa (use quando ela pediu pra VER; deixe false quando você só está conferindo algo pra decidir).",
    inputSchema: { type: "object", properties: { o_que: { type: "string", enum: VER }, alvo: { type: "string" }, periodo: { type: "string", description: "hoje | ontem | esta semana | semana passada | este mês (pra entregas e uso)" }, mostrar: { type: "boolean" } }, required: ["o_que"] } },
  { name: "agir", description: "Executa UMA ação no Starfork e devolve o que aconteceu de verdade. Ações:\n" + ACOES + "\nCampos: tarefas = códigos das tarefas alvo; alvo, texto, titulo, requisitos conforme a ação. Ações que não têm volta fácil pedem a confirmação da pessoa na tela antes de rodar — se ela recusar, o resultado diz isso e você NÃO insiste.",
    inputSchema: { type: "object", properties: { acao: { type: "string" }, tarefas: { type: "array", items: { type: "string" } }, alvo: { type: "string" }, texto: { type: "string" }, titulo: { type: "string" }, requisitos: { type: "array", items: { type: "string" } } }, required: ["acao"] } },
  { name: "perguntar_agente", description: "Pergunta ao PORTA-VOZ de uma tarefa (o segundo agente dela: lê a sessão e o código da branch e responde sem interromper quem trabalha) e devolve a resposta dele. Use pra saber o que o agente fez, por que decidiu algo ou como está de verdade quando os fatos não bastam. Leva de 20 s a alguns minutos.",
    inputSchema: { type: "object", properties: { tarefa: { type: "string", description: "código da tarefa" }, pergunta: { type: "string" } }, required: ["tarefa", "pergunta"] } },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ponte(tool, args) {
  const id = Date.now().toString(36) + "-" + randomBytes(4).toString("hex"), tmp = join(PONTE, id + ".tmp"), req = join(PONTE, id + ".req.json"), res = join(PONTE, id + ".res.json");
  writeFileSync(tmp, JSON.stringify({ id, tool, args, at: Date.now() })); renameSync(tmp, req);
  const teto = Date.now() + (+process.env.STARFORK_PONTE_MS || 15 * 60000);
  while (Date.now() < teto) {
    if (existsSync(res)) { let t = ""; try { t = JSON.parse(readFileSync(res, "utf8")).texto || ""; } catch (e) { t = "resposta ilegível do app: " + e.message; } try { unlinkSync(res); } catch (_) { } return t || "(sem conteúdo)"; }
    await sleep(120);
  }
  for (const f of [req, join(PONTE, id + ".run.json")]) { try { unlinkSync(f); } catch (_) { } }
  return "O app não respondeu a tempo. Diga isso à pessoa em vez de supor o resultado.";
}
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) lida(l); } });
process.stdin.on("end", () => process.exit(0));
async function lida(l) {
  let m; try { m = JSON.parse(l); } catch (_) { return; }
  const { id, method, params } = m; if (id === undefined) return; // notificação
  try {
    if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: (params && params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "starfork", version: "1.0.0" } } });
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") { const nome = params && params.name; if (!TOOLS.some((t) => t.name === nome)) return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ferramenta desconhecida: " + nome }], isError: true } });
      const texto = await ponte(nome, (params && params.arguments) || {}); return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(texto).slice(0, 24000) }] } }); }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "método não suportado: " + method } });
  } catch (e) { send({ jsonrpc: "2.0", id, error: { code: -32000, message: String((e && e.message) || e) } }); }
}
