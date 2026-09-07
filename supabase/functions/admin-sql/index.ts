// Manutenção do banco SEM senha manual: executa SQL de migração.
// TRAVADA no dono do produto (allowlist de e-mail) + JWT obrigatório.
// Usa o SUPABASE_DB_URL injetado no runtime das Edge Functions.
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3";

const ALLOWED = new Set(["douglas.sobreira@logcomex.com", "dodosobreira@gmail.com"]);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user?.email || !ALLOWED.has(user.email)) return json({ error: "só o dono do produto" }, 403);
    const { sql } = await req.json().catch(() => ({}));
    if (!sql || typeof sql !== "string") return json({ error: "body: {sql}" }, 400);
    const db = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });
    try {
      await db.unsafe(sql);
      return json({ ok: true });
    } finally {
      await db.end();
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
