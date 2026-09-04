// Cria a sessão de Checkout da Stripe pro usuário logado.
// Deploy com --no-verify-jwt (o GET de retorno não tem token; o POST valida o JWT aqui).
// Secrets: STRIPE_SECRET_KEY (+ SUPABASE_URL/ANON/SERVICE_ROLE já existem no runtime).
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

const PAGE = (title: string, msg: string) => new Response(
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="background:#0b0d0f;color:#e6e9ea;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px"><div style="font-size:40px;margin-bottom:12px">✦</div><h2 style="margin:0 0 8px">${title}</h2><p style="color:#8b9398;font-size:14px">${msg}</p></div></body>`,
  { headers: { "Content-Type": "text/html; charset=utf-8" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  if (req.method === "GET") {
    const d = u.searchParams.get("done");
    if (d === "1") return PAGE("Assinatura ativada!", "Pode fechar esta aba e voltar pro Constellation — ele reconhece a assinatura sozinho em instantes.");
    return PAGE("Checkout cancelado", "Nada foi cobrado. Volte pro Constellation quando quiser assinar.");
  }
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const asUser = createClient(SUPA_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "não autenticado" }, 401);

    const { planId, teamId } = await req.json().catch(() => ({}));
    const { data: plan } = await admin.from("billing_plans").select("*").eq("id", planId).eq("active", true).maybeSingle();
    if (!plan) return json({ error: "plano inexistente" }, 400);
    if (plan.plan === "team" && !teamId) return json({ error: "plano de equipe precisa de um time" }, 400);

    // customer da Stripe amarrado ao user_id
    const { data: bill } = await admin.from("billing").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
    let customer = bill?.stripe_customer_id ?? null;
    if (!customer) {
      const c = await stripe.customers.create({ email: user.email ?? undefined, metadata: { user_id: user.id } });
      customer = c.id;
      await admin.from("billing").upsert({ user_id: user.id, stripe_customer_id: customer });
    }

    const base = `${SUPA_URL}/functions/v1/stripe-checkout`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      subscription_data: {
        trial_period_days: plan.trial_days > 0 ? plan.trial_days : undefined,
        metadata: {
          user_id: user.id, plan: plan.plan, interval: plan.interval,
          seats: String(plan.seats), team_id: teamId ?? "",
        },
      },
      allow_promotion_codes: true,
      success_url: `${base}?done=1`,
      cancel_url: `${base}?done=0`,
    });
    return json({ url: session.url });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
