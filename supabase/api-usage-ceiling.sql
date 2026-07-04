-- Global daily usage ceiling for the chat proxy (run once in the SQL Editor).
--
-- Serverless functions are stateless, so the "total model calls today" counter
-- lives here: one row per day, bumped atomically by an RPC the server calls with
-- the SERVICE ROLE key before each Anthropic request. When today's count exceeds
-- DAILY_REQUEST_LIMIT the proxy returns 429. This is a coarse cost circuit-
-- breaker; per-IP throttling is handled at the edge (Cloudflare).
--
-- Security: the table has RLS with NO policies and the RPC's EXECUTE is revoked
-- from anon/authenticated, so the PUBLIC anon key (shipped to browsers) cannot
-- read or inflate the counter. Only the service_role key (server-only) can.

create table if not exists api_usage (
  day   date primary key default current_date,
  count bigint not null default 0
);

alter table api_usage enable row level security;
-- Intentionally NO policies: anon/authenticated get nothing; service_role bypasses RLS.

-- Atomic "increment today's counter, return the new value".
create or replace function bump_api_usage(p_amount int default 1)
returns bigint
language sql
security definer
set search_path = public
as $$
  insert into api_usage (day, count)
  values (current_date, p_amount)
  on conflict (day) do update set count = api_usage.count + excluded.count
  returning count;
$$;

-- Only the server (service_role) may call it — never the public anon key.
revoke all on function bump_api_usage(int) from public, anon, authenticated;
grant execute on function bump_api_usage(int) to service_role;

-- ── Server configuration (Vercel → Settings → Environment Variables) ────────
--   SUPABASE_SERVICE_ROLE_KEY   Settings → API → service_role secret (SERVER ONLY;
--                               never in the browser / never in api/config.js)
--   DAILY_REQUEST_LIMIT         optional, integer; default 2000 model calls/day
-- Without SUPABASE_SERVICE_ROLE_KEY the proxy skips the ceiling (fail-open), so
-- local dev and Supabase-less deploys keep working.

-- ── Inspect / reset ─────────────────────────────────────────────────────────
--   select * from api_usage order by day desc limit 7;
--   delete from api_usage where day = current_date;   -- reset today
