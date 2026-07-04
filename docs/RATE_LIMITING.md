# Rate limiting & abuse protection

The chat proxy (`/api/chat`) spends your Anthropic budget, and the fetch proxies
(`/api/fetch`, `/api/fetch-pdf`, `/api/fetch-image`) are open by design so the
signed-out experience keeps working. Protection is layered:

| Layer | Where | Stops |
|---|---|---|
| Per-request caps (model allow-list, `max_tokens` ≤ 4096, ≤ 2 MB body) | `handler.js` (code) | one request being made expensive |
| **Global daily ceiling** | `handler.js` + Supabase (code) | runaway *total* spend from any source |
| **Per-IP rate limit** | Cloudflare edge (config) | casual scripted floods |
| Bot Fight Mode | Cloudflare edge (config) | obvious automated traffic |
| **Hard spend cap** | Anthropic console (config) | the absolute worst case, in dollars |

The two code layers ship in this repo. The three config layers below are dashboard
setup you do once.

---

## 1. Global daily ceiling (code — already implemented)

A single Supabase row counts model calls per day; the proxy returns `429` once it
passes `DAILY_REQUEST_LIMIT`. It's shared across all serverless invocations and
**fails open** if unconfigured or if the counter errors, so it never takes the app
down.

**Enable it:**
1. Run [`supabase/api-usage-ceiling.sql`](../supabase/api-usage-ceiling.sql) in the
   Supabase SQL Editor (creates the `api_usage` table + `bump_api_usage` RPC, locked
   to the service role).
2. Set server env vars (Vercel → Settings → Environment Variables):
   - `SUPABASE_SERVICE_ROLE_KEY` — Settings → API → **service_role** secret.
     **Server-only.** It is never returned by `api/config.js` and never reaches the
     browser. Do not confuse it with the anon key.
   - `DAILY_REQUEST_LIMIT` — optional integer, default `2000`.
3. Redeploy. Inspect usage any time: `select * from api_usage order by day desc;`

Leaving `SUPABASE_SERVICE_ROLE_KEY` unset disables the ceiling (fine for local dev).

---

## 2. Per-IP rate limit (Cloudflare edge)

Cloudflare enforces per-IP limits before requests reach Vercel — no counter to run
in the app. Requires the domain proxied through Cloudflare (orange-cloud DNS in
front of Vercel; set SSL/TLS mode to **Full (strict)**).

**Security → WAF → Rate limiting rules → Create rule:**
- **If** URI Path starts with `/api/`
- **Then** when more than **~20 requests per 1 minute** come from the same IP
- **Action:** Block (or Managed Challenge) for 1–10 minutes

Tune the threshold to real usage (a session opening a paper fires several
citation/preview calls, so don't set it too low). Add a second, stricter rule
scoped to `/api/chat` if you want chat held tighter than the fetch proxies.

> **Caveat:** per-IP limits don't stop an attacker who rotates IPs — that's what
> the global ceiling (layer 1) and the Anthropic spend cap (layer 4) backstop. If
> IP-rotation abuse ever shows up, add Cloudflare **Turnstile** (proof-of-browser)
> in front of `/api/chat`; the code seam for verifying a token is straightforward
> to add later.

If you later read the client IP in code, trust **`CF-Connecting-IP`**, not
`X-Forwarded-For` (which a client can spoof when not behind a trusted proxy).

## 3. Bot Fight Mode (Cloudflare edge)

**Security → Bots → Bot Fight Mode: On.** Free, drops known-bot traffic before it
costs you anything.

## 4. Hard spend cap (Anthropic — do this regardless)

The ultimate circuit-breaker, independent of all the above. In the Anthropic
Console → **Billing / Limits**, set a **monthly spend limit** and usage alert. Even
if every other layer is bypassed, this caps the damage at a known dollar figure.
Five minutes; do it before launch.
