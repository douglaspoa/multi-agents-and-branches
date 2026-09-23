// Constellation — admin-api: backend da área /admin do site (constellation-ai-v1).
// TRAVADA no dono do produto (allowlist de e-mail + JWT válido). Roda com service role,
// então enxerga tudo (auth.users, audit log, app_errors, orgs/times, billing, custo).
// Deploy:  supabase functions deploy admin-api --no-verify-jwt --project-ref fivoakrhazlzcdoocgbg
// Env opcional: ADMIN_EMAILS="a@x.com,b@y.com"  SITE_URL="https://constellation-ai-v1.lovable.app"
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3";
import { MIGRATIONS } from "./migrations.ts";

const ALLOWED = new Set(
  ["douglas.sobreira@logcomex.com", "dodosobreira@gmail.com",
    ...(Deno.env.get("ADMIN_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)],
);
const SITE = (Deno.env.get("SITE_URL") ?? "https://constellation-ai-v1.lovable.app").replace(/\/+$/, "");
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

type Sql = ReturnType<typeof postgres>;
type Body = Record<string, unknown>;
const str = (b: Body, k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
const num = (b: Body, k: string, d: number) => (typeof b[k] === "number" && isFinite(b[k] as number) ? (b[k] as number) : d);
const uuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------- ações ----------
const actions: Record<string, (sql: Sql, b: Body, me: { id: string; email: string }) => Promise<unknown>> = {
  async overview(sql) {
    const [tot] = await sql`
      select (select count(*) from auth.users) as users_total,
             (select count(*) from auth.users where created_at > now() - interval '7 days') as users_7d,
             (select count(*) from auth.users where last_sign_in_at > now() - interval '24 hours') as active_24h,
             (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days') as active_7d,
             (select count(*) from auth.audit_log_entries where payload->>'action' = 'login' and created_at > now() - interval '24 hours') as logins_24h,
             (select count(*) from auth.audit_log_entries where payload->>'action' = 'login' and created_at > now() - interval '7 days') as logins_7d,
             (select count(*) from orgs) as orgs,
             (select count(*) from teams) as teams,
             (select count(*) from tasks) as tasks_total,
             (select count(*) from tasks where created_at > now() - interval '30 days') as tasks_30d,
             (select coalesce(sum(cost_usd),0) from tasks where created_at > now() - interval '30 days') as cost_30d_usd,
             (select coalesce(sum(cost_tokens),0) from tasks where created_at > now() - interval '30 days') as tokens_30d,
             (select count(*) from app_errors where at > now() - interval '24 hours') as errors_24h,
             (select count(*) from app_errors where at > now() - interval '7 days') as errors_7d,
             (select count(*) from billing where status in ('trialing','active')) as subs_active,
             (select count(*) from billing where status = 'trialing') as subs_trialing,
             (select count(*) from invites where accepted_at is null and expires_at > now()) as invites_pending`;
    const days = await sql`
      with d as (select generate_series((now() - interval '13 days')::date, now()::date, '1 day')::date as day)
      select to_char(d.day,'YYYY-MM-DD') as day,
        (select count(*) from auth.users u where u.created_at::date = d.day) as signups,
        (select count(*) from auth.audit_log_entries a where a.payload->>'action'='login' and a.created_at::date = d.day) as logins,
        (select count(*) from app_errors e where e.at::date = d.day) as errors,
        (select count(*) from tasks t where t.created_at::date = d.day) as tasks,
        (select coalesce(sum(cost_usd),0) from tasks t where t.created_at::date = d.day) as cost_usd
      from d order by d.day`;
    const recentUsers = await sql`
      select u.id, u.email, p.name, u.created_at, u.last_sign_in_at, u.email_confirmed_at
      from auth.users u left join profiles p on p.user_id = u.id order by u.created_at desc limit 8`;
    const recentErrors = await sql`
      select e.id, e.at, e.source, e.message, e.repo, e.build, p.email
      from app_errors e left join profiles p on p.user_id = e.user_id order by e.at desc limit 8`;
    return { totals: tot, days, recentUsers, recentErrors };
  },

  async "auth.events"(sql, b) {
    const q = str(b, "q"), limit = Math.min(500, num(b, "limit", 200));
    const acts = Array.isArray(b["actions"]) ? (b["actions"] as string[]) : [];
    return await sql`
      select id, created_at, ip_address, payload->>'action' as action, payload->>'actor_username' as email,
             payload->>'actor_id' as actor_id, payload->'traits'->>'provider' as provider,
             coalesce(payload->'traits'->>'user_email', payload->>'actor_username') as target
      from auth.audit_log_entries
      where (${q} = '' or payload::text ilike ${"%" + q + "%"})
        and (${acts.length === 0} or payload->>'action' = any(${acts}))
      order by created_at desc limit ${limit}`;
  },

  async "users.list"(sql, b) {
    const q = str(b, "q"), limit = Math.min(500, num(b, "limit", 200));
    return await sql`
      select u.id, u.email, u.created_at, u.last_sign_in_at, u.email_confirmed_at, u.banned_until,
             u.raw_app_meta_data->'providers' as providers, p.name, p.last_seen_at,
             (select coalesce(json_agg(json_build_object('org_id', o.id, 'org', o.name, 'role', om.role, 'plan', o.plan)), '[]'::json)
                from org_members om join orgs o on o.id = om.org_id where om.user_id = u.id) as orgs,
             (select coalesce(json_agg(json_build_object('team_id', t.id, 'team', t.name, 'role', tm.role)), '[]'::json)
                from team_members tm join teams t on t.id = tm.team_id where tm.user_id = u.id) as teams,
             bl.plan as billing_plan, bl.status as billing_status, bl.seats as billing_seats, bl.trial_end, bl.current_period_end,
             (select count(*) from tasks t where t.created_by = u.id) as tasks,
             (select coalesce(sum(cost_usd),0) from tasks t where t.created_by = u.id) as cost_usd,
             (select count(*) from app_errors e where e.user_id = u.id and e.at > now() - interval '7 days') as errors_7d,
             (select max(created_at) from auth.audit_log_entries a where a.payload->>'action'='login' and a.payload->>'actor_id' = u.id::text) as last_login_event
      from auth.users u
      left join profiles p on p.user_id = u.id
      left join billing bl on bl.user_id = u.id
      where (${q} = '' or u.email ilike ${"%" + q + "%"} or p.name ilike ${"%" + q + "%"} or u.id::text = ${q})
      order by coalesce(u.last_sign_in_at, u.created_at) desc limit ${limit}`;
  },

  async "users.setPassword"(_sql, b) {
    const id = str(b, "user_id"), password = str(b, "password");
    if (!uuid(id) || password.length < 8) throw new Error("user_id e senha (8+ caracteres) obrigatórios");
    const { error } = await admin().auth.admin.updateUserById(id, { password });
    if (error) throw error;
    return { ok: true };
  },

  async "users.confirm"(_sql, b) {
    const id = str(b, "user_id");
    if (!uuid(id)) throw new Error("user_id inválido");
    const { error } = await admin().auth.admin.updateUserById(id, { email_confirm: true });
    if (error) throw error;
    return { ok: true };
  },

  async "users.ban"(_sql, b) {
    const id = str(b, "user_id"), banned = b["banned"] === true;
    if (!uuid(id)) throw new Error("user_id inválido");
    const { error } = await admin().auth.admin.updateUserById(id, { ban_duration: banned ? "876000h" : "none" });
    if (error) throw error;
    return { ok: true };
  },

  async "users.sendRecovery"(_sql, b) {
    const email = str(b, "email").toLowerCase();
    if (!email.includes("@")) throw new Error("e-mail inválido");
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { error } = await anon.auth.resetPasswordForEmail(email, { redirectTo: SITE + "/redefinir-senha" });
    if (error) throw error;
    return { ok: true };
  },

  async "users.create"(_sql, b) {
    const email = str(b, "email").toLowerCase(), password = str(b, "password"), name = str(b, "name");
    if (!email.includes("@") || password.length < 8) throw new Error("e-mail e senha (8+) obrigatórios");
    const { data, error } = await admin().auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: name ? { name } : {},
    });
    if (error) throw error;
    return { ok: true, user_id: data.user?.id };
  },

  async "errors.list"(sql, b) {
    const q = str(b, "q"), hours = num(b, "hours", 24 * 7), limit = Math.min(1000, num(b, "limit", 300));
    return await sql`
      select e.id, e.at, e.user_id, e.team_id, e.source, e.message, e.detail, e.repo, e.build, e.context,
             p.email, p.name, t.name as team
      from app_errors e left join profiles p on p.user_id = e.user_id left join teams t on t.id = e.team_id
      where e.at > now() - make_interval(hours => ${hours})
        and (${q} = '' or e.message ilike ${"%" + q + "%"} or e.detail ilike ${"%" + q + "%"} or p.email ilike ${"%" + q + "%"} or e.source ilike ${"%" + q + "%"})
      order by e.at desc limit ${limit}`;
  },

  async "orgs.list"(sql) {
    const orgs = await sql`
      select o.id, o.name, o.plan, o.seats, o.paid_until, o.created_at,
             (select count(*) from org_members m where m.org_id = o.id) as members,
             (select count(*) from invites i where i.org_id = o.id and i.accepted_at is null and i.expires_at > now()) as invites_pending,
             (select coalesce(json_agg(json_build_object('user_id', m.user_id, 'email', p.email, 'name', p.name, 'role', m.role) order by m.role, p.email), '[]'::json)
                from org_members m left join profiles p on p.user_id = m.user_id where m.org_id = o.id) as member_list,
             (select coalesce(json_agg(json_build_object(
                 'id', t.id, 'name', t.name, 'created_at', t.created_at,
                 'members', (select count(*) from team_members tm where tm.team_id = t.id),
                 'member_list', (select coalesce(json_agg(json_build_object('user_id', tm.user_id, 'email', p2.email, 'name', p2.name, 'role', tm.role) order by tm.role, p2.email), '[]'::json)
                                   from team_members tm left join profiles p2 on p2.user_id = tm.user_id where tm.team_id = t.id),
                 'projects', (select count(*) from projects pr where pr.team_id = t.id),
                 'tasks', (select count(*) from tasks tk where tk.team_id = t.id),
                 'cost_usd', (select coalesce(sum(cost_usd),0) from tasks tk where tk.team_id = t.id),
                 'billing', (select json_build_object('plan', bl.plan, 'status', bl.status, 'seats', bl.seats, 'owner', pb.email)
                               from billing bl left join profiles pb on pb.user_id = bl.user_id where bl.team_id = t.id and bl.status in ('trialing','active') limit 1)
               ) order by t.created_at), '[]'::json)
                from teams t where t.org_id = o.id) as teams
      from orgs o order by o.created_at desc`;
    const invites = await sql`
      select i.id, i.org_id, i.team_id, t.name as team, i.email, i.role, i.expires_at,
             (i.expires_at - interval '14 days') as created_at, pc.email as created_by
      from invites i left join teams t on t.id = i.team_id left join profiles pc on pc.user_id = i.created_by
      where i.accepted_at is null order by i.expires_at desc`;
    return { orgs, invites };
  },

  async "orgs.create"(sql, b, me) {
    const name = str(b, "name"), team = str(b, "team_name") || "Time principal";
    const plan = ["solo", "team", "enterprise"].includes(str(b, "plan")) ? str(b, "plan") : "team";
    const seats = Math.max(1, Math.round(num(b, "seats", 5)));
    const owner = str(b, "owner_email").toLowerCase();
    if (!name) throw new Error("nome da empresa obrigatório");
    const [org] = await sql`insert into orgs (name, plan, seats) values (${name}, ${plan}, ${seats}) returning id, name`;
    const [t] = await sql`insert into teams (org_id, name) values (${org!.id}, ${team}) returning id, name`;
    let ownerStatus = "sem dono";
    if (owner.includes("@")) {
      const [u] = await sql`select id from auth.users where lower(email) = ${owner}`;
      if (u) {
        await sql`insert into org_members (org_id, user_id, role) values (${org!.id}, ${u.id}, 'owner') on conflict do nothing`;
        await sql`insert into team_members (team_id, user_id, role) values (${t!.id}, ${u.id}, 'lead') on conflict do nothing`;
        ownerStatus = "dono adicionado";
      } else {
        await sql`insert into invites (org_id, team_id, email, role, created_by) values (${org!.id}, ${t!.id}, ${owner}, 'lead', ${me.id})`;
        const r = await inviteNewUser(owner);
        ownerStatus = r ? "convite enviado (usuário novo)" : "convite criado";
      }
    }
    return { ok: true, org_id: org!.id, team_id: t!.id, owner: ownerStatus };
  },

  async "orgs.update"(sql, b) {
    const id = str(b, "org_id");
    if (!uuid(id)) throw new Error("org_id inválido");
    const name = str(b, "name") || null;
    const plan = ["solo", "team", "enterprise"].includes(str(b, "plan")) ? str(b, "plan") : null;
    const seats = b["seats"] == null ? null : Math.max(1, Math.round(num(b, "seats", 1)));
    // paid_until: ausente = mantém · null = limpa · string ISO = define
    const touchPaid = "paid_until" in b;
    const paid = touchPaid && typeof b["paid_until"] === "string" && b["paid_until"] ? (b["paid_until"] as string) : null;
    await sql`update orgs set name = coalesce(${name}, name), plan = coalesce(${plan}, plan), seats = coalesce(${seats}, seats) where id = ${id}`;
    if (touchPaid) await sql`update orgs set paid_until = ${paid}::timestamptz where id = ${id}`;
    return { ok: true };
  },

  async "teams.create"(sql, b) {
    const org = str(b, "org_id"), name = str(b, "name");
    if (!uuid(org) || !name) throw new Error("org_id e nome obrigatórios");
    const [t] = await sql`insert into teams (org_id, name) values (${org}, ${name}) returning id`;
    return { ok: true, team_id: t!.id };
  },

  async "invites.create"(sql, b, me) {
    const org = str(b, "org_id"), team = str(b, "team_id"), email = str(b, "email").toLowerCase();
    const role = str(b, "role") === "lead" ? "lead" : "member";
    if (!uuid(org) || !uuid(team) || !email.includes("@")) throw new Error("org_id, team_id e e-mail obrigatórios");
    const [u] = await sql`select id from auth.users where lower(email) = ${email}`;
    if (u) {
      // já tem conta: entra direto (mesmo efeito do accept_pending_invites)
      await sql`insert into org_members (org_id, user_id) values (${org}, ${u.id}) on conflict do nothing`;
      await sql`insert into team_members (team_id, user_id, role) values (${team}, ${u.id}, ${role}) on conflict (team_id, user_id) do update set role = excluded.role`;
      return { ok: true, status: "adicionado direto (já tinha conta)" };
    }
    await sql`insert into invites (org_id, team_id, email, role, created_by) values (${org}, ${team}, ${email}, ${role}, ${me.id})`;
    const sent = await inviteNewUser(email);
    return { ok: true, status: sent ? "convite por e-mail enviado" : "convite criado (e-mail não enviado: " + sent + ")" };
  },

  async "invites.delete"(sql, b) {
    const id = str(b, "id");
    if (!uuid(id)) throw new Error("id inválido");
    await sql`delete from invites where id = ${id}`;
    return { ok: true };
  },

  async "members.remove"(sql, b) {
    const org = str(b, "org_id"), user = str(b, "user_id");
    if (!uuid(org) || !uuid(user)) throw new Error("org_id e user_id obrigatórios");
    await sql`delete from team_members tm using teams t where t.id = tm.team_id and t.org_id = ${org} and tm.user_id = ${user}`;
    await sql`delete from org_members where org_id = ${org} and user_id = ${user}`;
    return { ok: true };
  },

  async usage(sql) {
    const byOrg = await sql`
      select o.id, o.name, o.plan,
             (select count(*) from tasks t join teams tt on tt.id = t.team_id where tt.org_id = o.id) as tasks,
             (select count(*) from tasks t join teams tt on tt.id = t.team_id where tt.org_id = o.id and t.created_at > now() - interval '30 days') as tasks_30d,
             (select coalesce(sum(t.cost_usd),0) from tasks t join teams tt on tt.id = t.team_id where tt.org_id = o.id) as cost_usd,
             (select coalesce(sum(t.cost_usd),0) from tasks t join teams tt on tt.id = t.team_id where tt.org_id = o.id and t.created_at > now() - interval '30 days') as cost_30d_usd,
             (select coalesce(sum(t.cost_tokens),0) from tasks t join teams tt on tt.id = t.team_id where tt.org_id = o.id) as tokens,
             (select count(distinct t.created_by) from tasks t join teams tt on tt.id = t.team_id where tt.org_id = o.id and t.created_at > now() - interval '30 days') as active_users_30d
      from orgs o order by cost_30d_usd desc, tasks desc`;
    const byUser = await sql`
      select u.id, u.email, p.name, count(t.id) as tasks,
             count(t.id) filter (where t.created_at > now() - interval '30 days') as tasks_30d,
             coalesce(sum(t.cost_usd),0) as cost_usd,
             coalesce(sum(t.cost_usd) filter (where t.created_at > now() - interval '30 days'),0) as cost_30d_usd,
             coalesce(sum(t.cost_tokens),0) as tokens, max(t.created_at) as last_task
      from auth.users u left join profiles p on p.user_id = u.id left join tasks t on t.created_by = u.id
      group by u.id, u.email, p.name having count(t.id) > 0 order by cost_30d_usd desc, tasks desc limit 50`;
    const byMonth = await sql`
      select to_char(date_trunc('month', created_at),'YYYY-MM') as month, count(*) as tasks,
             coalesce(sum(cost_usd),0) as cost_usd, coalesce(sum(cost_tokens),0) as tokens, count(distinct created_by) as users
      from tasks where created_at > now() - interval '12 months' group by 1 order by 1`;
    const byStatus = await sql`select status, count(*) as n from tasks group by status order by n desc`;
    return { byOrg, byUser, byMonth, byStatus };
  },

  // Banco: lista tabelas e aplica as migrations FIXAS do repo (migrations.ts) — sem SQL livre.
  async "db.tables"(sql) {
    return await sql`
      select t.table_name,
             (select count(*) from information_schema.columns c where c.table_schema='public' and c.table_name=t.table_name) as columns,
             pg_total_relation_size(('public.'||quote_ident(t.table_name))::regclass) as bytes
      from information_schema.tables t where t.table_schema='public' and t.table_type='BASE TABLE' order by 1`;
  },

  async "db.migrations"(sql) {
    const existing = new Set((await sql`select table_name from information_schema.tables where table_schema='public'`).map((r) => r.table_name as string));
    return MIGRATIONS.map((m) => {
      const tables = [...m.sql.matchAll(/create table if not exists (\w+)/gi)].map((x) => x[1]!);
      return { name: m.name, tables, applied: tables.length > 0 && tables.every((t) => existing.has(t)) };
    });
  },

  async "db.migrate"(sql, b) {
    const only = str(b, "name");
    const done: string[] = [];
    for (const m of MIGRATIONS) {
      if (only && m.name !== only) continue;
      await sql.unsafe(m.sql);
      done.push(m.name);
    }
    return { ok: true, applied: done };
  },

  async "billing.list"(sql) {
    const rows = await sql`
      select bl.user_id, p.email, p.name, bl.plan, bl."interval", bl.status, bl.seats, bl.trial_end, bl.current_period_end,
             bl.cancel_at_period_end, bl.stripe_customer_id, bl.stripe_subscription_id, bl.updated_at, t.name as team, o.name as org
      from billing bl left join profiles p on p.user_id = bl.user_id left join teams t on t.id = bl.team_id left join orgs o on o.id = t.org_id
      order by bl.updated_at desc`;
    const plans = await sql`select id, plan, "interval", amount_cents, currency, seats, trial_days, active, per_seat, stripe_price_id from billing_plans order by plan, "interval"`;
    return { rows, plans };
  },
};

// convida quem ainda não tem conta: e-mail "Invite user" do Supabase → link cai em /redefinir-senha (define a senha)
async function inviteNewUser(email: string): Promise<true | string> {
  const { error } = await admin().auth.admin.inviteUserByEmail(email, { redirectTo: SITE + "/redefinir-senha" });
  return error ? error.message : true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let sql: Sql | null = null;
  try {
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user?.email) return json({ error: "faça login" }, 401);
    if (!ALLOWED.has(user.email.toLowerCase())) return json({ error: "só o dono do produto" }, 403);
    const body = (await req.json().catch(() => ({}))) as Body;
    const action = str(body, "action");
    const fn = actions[action];
    if (!fn) return json({ error: "ação desconhecida: " + action, actions: Object.keys(actions) }, 400);
    sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
    const result = await fn(sql, body, { id: user.id, email: user.email });
    return json({ ok: true, data: result });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  } finally {
    if (sql) await sql.end();
  }
});
