// Portal de cobrança da Stripe (trocar cartão, cancelar, notas fiscais).
// Deploy normal (com JWT). Secrets: STRIPE_SECRET_KEY.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "");
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
    if (!user) return json({ error: "não autenticado" }, 401);
    const { data: bill } = await admin.from("billing").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
    if (!bill?.stripe_customer_id) return json({ error: "sem assinatura" }, 404);
    const session = await stripe.billingPortal.sessions.create({
      customer: bill.stripe_customer_id,
      return_url: `${SUPA_URL}/functions/v1/stripe-checkout?done=1`,
    });
    return json({ url: session.url });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
