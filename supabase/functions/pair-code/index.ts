// Código de pareamento pro celular: o MAC (logado) pede um OTP de 6 dígitos
// da própria conta; o iPhone digita o código e troca por sessão (verifyOtp).
// Sem senha no celular, sem e-mail no meio. Deploy normal (com JWT).
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPA_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const asUser = createClient(SUPA_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user?.email) return json({ error: "não autenticado" }, 401);
    const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: user.email });
    if (error) return json({ error: error.message }, 500);
    // email_otp: 6 dígitos que o verifyOtp(type=email) aceita — validade curta
    return json({ email: user.email, code: data.properties?.email_otp ?? null });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
