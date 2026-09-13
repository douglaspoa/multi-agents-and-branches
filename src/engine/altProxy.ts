/**
 * ROUTE AI — ponte de tradução Anthropic ⇄ OpenAI.
 *
 * O Claude Code (o binário que roda os agentes) SÓ fala o protocolo da Anthropic
 * (`POST /v1/messages`, streaming SSE próprio). Muitos gateways corporativos —
 * como o da Logcomex (`https://llm.logcomex.ai/v1`, vLLM) — só expõem o protocolo
 * OpenAI (`POST /v1/chat/completions`). Este módulo sobe um shim local que recebe
 * requisições no formato Anthropic e as traduz pro gateway OpenAI (e a resposta
 * de volta), pra o agente conseguir rodar numa IA alternativa sem NENHUM setup
 * externo.
 *
 * Estratégia: chamamos o gateway em modo NÃO-streaming (resposta completa) e
 * sintetizamos a sequência de eventos SSE da Anthropic no fim. Perde-se o
 * "digitar ao vivo" dentro de uma mensagem (irrelevante pro Constellation, que
 * mostra eventos por turno), em troca de uma tradução MUITO mais robusta —
 * sem acumular deltas de tool-use no meio do stream.
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AltConfig {
  baseUrl: string; // ex.: https://llm.logcomex.ai/v1  (a chamada vira baseUrl + /chat/completions)
  key: string; // chave do gateway (vive só no cofre ~/.constellation/llm.env)
  model: string; // id do modelo alvo no gateway, ex.: logcomex-v2
  label: string; // nome amigável pra UI/log
  always: boolean; // usar SEMPRE (modo teste)
  fallback: boolean; // usar quando o Claude bater limite de uso
  keyVar: string; // variável do llm.env que guarda a chave (ALT_AI_KEY ou LGCX_API_KEY)
  models: string[]; // ids de modelo que o gateway oferece (ALT_AI_MODELS, separados por vírgula)
}

/** Lê a config do Route AI do cofre da conta. Retorna null se não configurado. */
export function readAltConfig(): AltConfig | null {
  try {
    const txt = readFileSync(join(homedir(), ".constellation", "llm.env"), "utf8");
    const g = (k: string) => {
      const m = txt.match(new RegExp("^" + k + "\\s*=(.*)$", "m"));
      return m ? m[1].trim() : "";
    };
    // Reaproveita a LGCX_API_KEY / gateway da Logcomex que a conta talvez já tenha
    // (motor "logcomex"), pra o Route AI funcionar só ligando os toggles.
    const baseUrl = (g("ALT_AI_BASE_URL") || "https://llm.logcomex.ai/v1").replace(/\/+$/, "");
    const keyVar = g("ALT_AI_KEY") ? "ALT_AI_KEY" : "LGCX_API_KEY";
    const key = g(keyVar);
    if (!baseUrl || !key) return null;
    const isLgcx = /logcomex/i.test(baseUrl);
    const model = g("ALT_AI_MODEL") || (isLgcx ? "logcomex-v2" : "");
    const models = g("ALT_AI_MODELS").split(",").map((s) => s.trim()).filter(Boolean);
    return {
      baseUrl,
      key,
      model,
      label: g("ALT_AI_LABEL") || (isLgcx ? "Logcomex AI" : "Gateway"),
      always: g("ALT_AI_ALWAYS") === "1",
      fallback: g("ALT_AI_FALLBACK") === "1",
      keyVar,
      models: models.length ? models : model ? [model] : [],
    };
  } catch {
    return null;
  }
}

// ---- tradução ----------------------------------------------------------------

type AnyObj = Record<string, any>;

/** Anthropic Messages request → OpenAI chat.completions request. */
function toOpenAI(a: AnyObj, model: string): AnyObj {
  const msgs: AnyObj[] = [];
  if (a.system) {
    const sys = typeof a.system === "string" ? a.system : (a.system as AnyObj[]).map((b) => b?.text || "").join("\n");
    if (sys) msgs.push({ role: "system", content: sys });
  }
  for (const m of (a.messages || []) as AnyObj[]) {
    if (typeof m.content === "string") {
      msgs.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks: AnyObj[] = Array.isArray(m.content) ? m.content : [];
    if (m.role === "user") {
      // tool_result vira mensagem role:"tool" separada (OpenAI); texto/imagem vira user
      for (const b of blocks.filter((x) => x.type === "tool_result")) {
        let c: any = b.content;
        if (Array.isArray(c)) c = c.map((x: any) => (typeof x === "string" ? x : x?.type === "text" ? x.text : JSON.stringify(x))).join("\n");
        else if (typeof c !== "string") c = JSON.stringify(c ?? "");
        msgs.push({ role: "tool", tool_call_id: b.tool_use_id, content: String(c ?? "") });
      }
      const others = blocks.filter((x) => x.type !== "tool_result");
      const parts: AnyObj[] = [];
      for (const b of others) {
        if (b.type === "text") parts.push({ type: "text", text: b.text });
        else if (b.type === "image" && b.source?.type === "base64")
          parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      }
      if (parts.length) {
        if (parts.every((p) => p.type === "text")) msgs.push({ role: "user", content: parts.map((p) => p.text).join("\n") });
        else msgs.push({ role: "user", content: parts });
      }
    } else {
      // assistant: texto + tool_use → tool_calls
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const tus = blocks.filter((b) => b.type === "tool_use");
      const am: AnyObj = { role: "assistant", content: text || null };
      if (tus.length) am.tool_calls = tus.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input || {}) } }));
      msgs.push(am);
    }
  }
  const out: AnyObj = { model, messages: msgs, max_tokens: a.max_tokens || 4096, stream: false };
  if (a.temperature != null) out.temperature = a.temperature;
  if (Array.isArray(a.stop_sequences) && a.stop_sequences.length) out.stop = a.stop_sequences;
  if (Array.isArray(a.tools) && a.tools.length) {
    out.tools = a.tools.map((t: AnyObj) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } },
    }));
    const tc = a.tool_choice;
    if (tc?.type === "auto") out.tool_choice = "auto";
    else if (tc?.type === "any") out.tool_choice = "required";
    else if (tc?.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
  }
  return out;
}

/** OpenAI chat.completions response → objeto de mensagem Anthropic. */
function fromOpenAI(o: AnyObj, model: string): AnyObj {
  const choice = o.choices?.[0] || {};
  const msg = choice.message || {};
  const content: AnyObj[] = [];
  if (msg.content) content.push({ type: "text", text: String(msg.content) });
  for (const tc of (msg.tool_calls || []) as AnyObj[]) {
    let input: AnyObj = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id || "call_" + Math.random().toString(36).slice(2), name: tc.function?.name, input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const map: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", content_filter: "end_turn" };
  const stop_reason = msg.tool_calls?.length ? "tool_use" : map[choice.finish_reason as string] || "end_turn";
  return {
    id: o.id || "msg_" + Math.random().toString(36).slice(2),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: o.usage?.prompt_tokens || 0, output_tokens: o.usage?.completion_tokens || 0 },
  };
}

/** Escreve a mensagem Anthropic como a sequência de eventos SSE que o Claude Code espera. */
function writeSSE(res: any, msg: AnyObj) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: string, data: AnyObj) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: { ...msg, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: msg.usage.input_tokens, output_tokens: 0 } },
  });
  (msg.content as AnyObj[]).forEach((block, i) => {
    if (block.type === "text") {
      send("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      if (block.text) send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text } });
      send("content_block_stop", { type: "content_block_stop", index: i });
    } else if (block.type === "tool_use") {
      send("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) } });
      send("content_block_stop", { type: "content_block_stop", index: i });
    }
  });
  send("message_delta", { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: msg.usage.output_tokens } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c: Buffer) => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", () => resolve(s));
  });
}

async function handle(req: any, res: any) {
  const url = String(req.url || "");
  // count_tokens: o Claude Code às vezes pergunta o tamanho — devolve uma estimativa.
  if (url.includes("/count_tokens")) {
    const body = await readBody(req);
    const est = Math.ceil(body.length / 4);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: est }));
    return;
  }
  if (!url.includes("/v1/messages")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "route ai shim: só /v1/messages" } }));
    return;
  }
  const cfg = readAltConfig();
  if (!cfg) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Route AI não configurado" } }));
    return;
  }
  let a: AnyObj = {};
  try {
    a = JSON.parse((await readBody(req)) || "{}");
  } catch {
    /* corpo inválido */
  }
  const wantStream = !!a.stream;
  try {
    const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(toOpenAI(a, cfg.model)),
    });
    const raw = await r.text();
    if (!r.ok) {
      const errMsg = `gateway ${cfg.label} HTTP ${r.status}: ${raw.slice(0, 300)}`;
      if (wantStream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: r.status === 429 ? "rate_limit_error" : "api_error", message: errMsg } })}\n\n`);
        res.end();
      } else {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: r.status === 429 ? "rate_limit_error" : "api_error", message: errMsg } }));
      }
      return;
    }
    const o = JSON.parse(raw);
    const msg = fromOpenAI(o, cfg.model);
    if (wantStream) writeSSE(res, msg);
    else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(msg));
    }
  } catch (e) {
    const errMsg = `route ai shim falhou: ${(e as Error).message}`;
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: errMsg } }));
  }
}

// ---- singleton do servidor ---------------------------------------------------

let server: Server | null = null;
let port = 0;

/** Garante o shim de pé e devolve a porta local (127.0.0.1). */
export async function ensureAltProxy(): Promise<number> {
  if (server && port) return port;
  server = createServer((req, res) => {
    handle(req, res).catch(() => {
      try {
        res.writeHead(500);
        res.end();
      } catch {
        /* já respondeu */
      }
    });
  });
  server.on("error", () => {
    server = null;
    port = 0;
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  port = (server!.address() as any).port;
  return port;
}
