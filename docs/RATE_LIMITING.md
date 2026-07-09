# Rate limiting & abuse protection

The chat proxy (`/api/chat`) spends your Anthropic budget, and the fetch proxies
(`/api/fetch`, `/api/fetch-pdf`, `/api/fetch-image`) are open by design so the
signed-out experience keeps working. Protection is layered:

| Layer | Where | Stops |
|---|---|---|
| Per-request caps (model allow-list, `max_tokens` ≤ 4096, ≤ 2 MB body) | `handler.js` (code) | one request being made expensive |
| **Per-IP / per-user rate limit** | `handler.js` + Upstash (code) | scripted floods per IP (and per signed-in user) |
| **JWT auth + anonymous quota** | `handler.js` + Supabase (code) | invalid tokens; higher limits for signed-in users |
| **Kill switch** | Upstash key `chat_enabled` (code) | emergency chat shutdown without redeploy |
| **Global daily ceiling** | `handler.js` + Supabase (code) | runaway *total* spend from any source |
| **Per-IP rate limit** | Cloudflare edge (config) | casual scripted floods |
| Bot Fight Mode | Cloudflare edge (config) | obvious automated traffic |
| **Hard spend cap** | Anthropic console (config) | the absolute worst case, in dollars |

The code layers ship in this repo. The Cloudflare and Anthropic config layers below are
dashboard setup you do once.

---

## 1. Per-IP rate limit + kill switch (code — Upstash)

When `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set (Vercel Marketplace → Upstash,
or the `UPSTASH_REDIS_REST_*` aliases), every `/api/chat` call runs an Upstash
pipeline before the model is contacted. If those env vars are **unset**, the guard is
skipped entirely (local dev unchanged).

**Limits (defaults):**

| Bucket | Tasks | Anonymous | Signed-in |
|---|---|---|---|
| **Expensive** | default chat, `citation-preview-claude` | 10/min, 100/day per IP | 20/min, 300/day per user |
| **Cheap** | classify, summarize, citation-match/preview/detect, bibliography | 60/min, 1000/day per IP | 200/min, 2000/day per user |

Override any tier with env vars, e.g. `RATE_LIMIT_EXPENSIVE_ANON_PER_MIN`,
`RATE_LIMIT_CHEAP_AUTH_PER_DAY`.

**Behavior:**
- Invalid `Authorization: Bearer …` → `401 { error: "invalid_token" }` (model not called).
- No token → anonymous limits (still allowed).
- Supabase auth verify unreachable → degrade to anonymous (request still allowed if under limit).
- Over limit → `429 { error: "rate_limited", retry_after_seconds }` + `Retry-After` header.
- Upstash errors → **fail-closed** (`429`, same shape).
- Kill switch → `503 { error: "chat_temporarily_unavailable" }`.

**Kill switch (emergency off):**
```bash
curl -sS -X POST "$KV_REST_API_URL/set/chat_enabled/0" \
  -H "Authorization: Bearer $KV_REST_API_TOKEN"
```
Re-enable: set value to `1` (or `DEL chat_enabled` — missing key means enabled).

**Structured logging:** each `/api/chat` attempt emits one `console.info` JSON line
(`evt: "chat_request"`) with IP, user id, task, bucket, outcome, and token usage — no
message content.

The browser sends the Supabase session token via `chatFetch()` in `js/api.js` whenever
the user is signed in.

---

## 2. Global daily ceiling (code — already implemented)

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

## 3. Per-IP rate limit (Cloudflare edge)

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
> the global ceiling (section 2) and the Anthropic spend cap (section 5) backstop. If
> IP-rotation abuse ever shows up, add Cloudflare **Turnstile** (proof-of-browser)
> in front of `/api/chat`; the code seam for verifying a token is straightforward
> to add later.

If you later read the client IP in code, trust **`CF-Connecting-IP`**, not
`X-Forwarded-For` (which a client can spoof when not behind a trusted proxy).

## 4. Bot Fight Mode (Cloudflare edge)

**Security → Bots → Bot Fight Mode: On.** Free, drops known-bot traffic before it
costs you anything.

## 5. Hard spend cap (Anthropic — do this regardless)

The ultimate circuit-breaker, independent of all the above. In the Anthropic
Console → **Billing / Limits**, set a **monthly spend limit** and usage alert. Even
if every other layer is bypassed, this caps the damage at a known dollar figure.
Five minutes; do it before launch.
