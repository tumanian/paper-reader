# Google OAuth / Supabase Auth setup

> Continuity doc: the full picture of the auth setup so any future session can
> pick this up without re-explanation. Keep it updated if the auth setup changes.

## What was done (the change itself)

- Replaced the old email-based session naming ("type your email to name your
  session", stored in `paperReader.email.v1`) with real Google sign-in via
  Supabase Auth: `supabase.auth.signInWithOAuth({ provider: 'google', ... })`.
- Library/data is now keyed by the **authenticated Supabase user id** (stable
  UUID), not the typed email string.
- **No data migration**: existing email-keyed content is disposable and is
  dropped (old localStorage/IndexedDB keys cleared, old cloud rows simply no
  longer queried). Onboarding sample content is curated and reproducible, so it
  is re-seeded for a freshly signed-in user with an empty library — not migrated.
- Detailed implementation plan (files, call sites, checklist) lives in the
  Phase A plan from the auth-improvements session; the executable spec is the
  numbered checklist there.

## Manual console config (done OUTSIDE the codebase — do NOT automate or change)

These were configured by hand in the two dashboards. Agents: never try to
script, "fix", or re-derive these; treat them as fixed external state.

Project values used below:

- Supabase project id: `pmyodrwlvbqbukirecjh` (project URL
  `https://pmyodrwlvbqbukirecjh.supabase.co`, from `SUPABASE_URL` in `.env.local`)
- Local dev port: `3000` (default in `dev-server.js`; overridable via `PORT`)
- Production domain: `https://paper-reader.dev`

### Google Cloud Console

- **OAuth consent screen**: External user type; app name + support email set;
  authorized domains include `paper-reader.dev` and the Supabase project domain
  (`pmyodrwlvbqbukirecjh.supabase.co`); test users added while the app is
  unverified.
- **OAuth client**: type "Web application".
  - Authorized JavaScript origins: `https://paper-reader.dev` and
    `http://localhost:3000`
  - Authorized redirect URIs: the **Supabase callback**,
    `https://pmyodrwlvbqbukirecjh.supabase.co/auth/v1/callback` (NOT the app URL)
- Client ID + Secret generated and stored in Supabase (the secret is shown only
  once by Google).

### Supabase Dashboard

- **Authentication → Providers → Google**: enabled, Client ID + Secret pasted
  in. The Google client secret lives here, server-side — NEVER in the repo.
- **Authentication → URL Configuration**:
  - Site URL: `https://paper-reader.dev`
  - Redirect URLs: `https://paper-reader.dev/**` and `http://localhost:3000/**`

## Two distinct "redirect" fields (do not confuse — this is the #1 breakage)

| Field | Lives in | Value |
|---|---|---|
| "Authorized redirect URIs" | Google Cloud Console | The Supabase callback: `https://pmyodrwlvbqbukirecjh.supabase.co/auth/v1/callback` |
| "Redirect URLs" | Supabase URL Configuration | Where the app receives the user back: `https://paper-reader.dev/**`, `http://localhost:3000/**` |

Google redirects to Supabase; Supabase then redirects to the app. Putting the
app URL in Google's field (or the Supabase callback in Supabase's field) breaks
the flow.

## Secrets / invariants for all future work

- **No secrets in client code.** Only the Supabase anon key (already in use,
  served via `/api/config`) is client-side. Never add the Google client secret,
  or any secret, to the repo or frontend.
- **Don't hand-roll raw Google OAuth**; always go through Supabase Auth.
- **Identity = Supabase user id** for all data scoping (PaperStore keying,
  cloud row filters, PDF storage paths).

## Known gotchas (recorded so we don't re-debug them)

- Sign-in appears to work but no session persists (lands back with a `?code=`
  param, user not logged in): it's a **redirect-URL mismatch** — check both
  consoles agree exactly, including the port.
- Google Cloud console changes aren't always instant; wait + hard-refresh
  before assuming something is broken.
- Localhost needs its dev-port URL in **BOTH** Google's JavaScript origins and
  Supabase's Redirect URLs.
- Consent screen in "testing" mode = only added test users can sign in; publish
  to production before sharing the link publicly.
- If the session drops despite correct URLs, suspect the supabase-js version
  loaded in `index.html` (currently the floating CDN tag
  `@supabase/supabase-js@2` — a known version bug resolved the code exchange
  before persisting the session). Pinning to a specific known-good version is
  the fix.

## Current status (update as things land)

- Console config (Google Cloud + Supabase dashboards): **done** (manually, as
  described above).
- Auth feature implementation: **done** on branch `auth-improvements`
  (identity layer `505ef6f`, UI + docs `3072090`). 137 unit tests green,
  including 18 new auth tests (fake supabase-js client; real OAuth redirect is
  not unit-testable).
- Local verification: **partial** — signed-out gate/onboarding verified in the
  browser on `http://localhost:3000`; clicking sign-in reaches the real Google
  sign-in page with the correct client id, Supabase callback `redirect_uri`,
  and `redirect_to=http://localhost:3000/`. Completing the flow needs a human
  Google login (agent has no credentials).
- Vercel preview: deployed from `3072090`
  (`https://paper-reader-28jeao16q-tumanian-3316s-projects.vercel.app`) but the
  project has Deployment Protection (Vercel SSO) on preview URLs, so it is not
  reachable for automated checks. Also note: `*.vercel.app` is NOT in the
  Supabase Redirect URLs allow-list, so OAuth on previews would bounce to the
  Site URL — verify OAuth on localhost:3000 or production instead.
- TODO: full end-to-end OAuth (sign in → library scoped to user id → sign out
  → second account isolation) once a human completes the Google login.
