// Webhook da Stripe → mantém a tabela billing (fonte da verdade do app).
// Deploy com --no-verify-jwt. Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "");
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ts = (n: number | null | undefined) => (n ? new Date(n * 1000).toISOString() : null);

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body, sig!, Deno.env.get("STRIPE_WEBHOOK_SECRET")!, undefined, cryptoProvider,
    );
  } catch (e) {
    return new Response(`assinatura inválida: ${e}`, { status: 400 });
  }

  if (event.type.startsWith("customer.subscription.")) {
    const s = event.data.object as Stripe.Subscription;
    const md = s.metadata ?? {};
    let userId = md.user_id;
    if (!userId) { // fallback: acha pelo customer
      const { data } = await admin.from("billing").select("user_id")
        .eq("stripe_customer_id", String(s.customer)).maybeSingle();
      userId = data?.user_id;
    }
    if (userId) {
      await admin.from("billing").upsert({
        user_id: userId,
        stripe_customer_id: String(s.customer),
        stripe_subscription_id: s.id,
        plan: md.plan ?? null,
        interval: md.interval ?? null,
        seats: parseInt(md.seats ?? "1", 10) || 1,
        team_id: md.team_id || null,
        status: event.type === "customer.subscription.deleted" ? "canceled" : s.status,
        trial_end: ts(s.trial_end),
        current_period_end: ts(s.items?.data?.[0]?.current_period_end ?? (s as unknown as { current_period_end?: number }).current_period_end),
        cancel_at_period_end: !!s.cancel_at_period_end,
        updated_at: new Date().toISOString(),
      });
    }
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
