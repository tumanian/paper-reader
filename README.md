# Paper Reader

Highlight text in a PDF or web article and discuss it in-place with Claude.
Select any passage → it gets highlighted → Claude explains it in the sidebar →
ask follow-ups in a threaded chat. Each highlight keeps its own conversation.

- **PDFs** — drag & drop, rendered with a selectable text layer
- **Web articles** — paste a URL (Anthropic research, transformer-circuits.pub,
  distill.pub, arXiv). arXiv links auto-convert to full HTML via ar5iv.
- **Citations** — select a citation → open the referenced paper and discuss it
- **Read later** — bookmark papers and citations for later
- **Cloud sync** — library, chats, and PDFs sync via Supabase (Postgres + Storage)

Your Anthropic API key stays server-side — it's never in the frontend code.
Haiku handles cheap tasks (library summaries, citation matching/preview); Sonnet
powers highlight chat and citation fallbacks.

---

## Supabase setup (cloud persistence)

1. Create a project at [supabase.com](https://supabase.com)
2. **SQL Editor** → run the contents of `supabase/schema.sql`
3. **Storage** → create a private bucket named `pdfs`
4. **Authentication** → enable the Google provider and configure redirect URLs
   (full walkthrough incl. Google Cloud Console setup: `docs/AUTH_SETUP.md`)
5. Copy **Project URL** and **anon public key** from Settings → API

Add to your environment:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbG...
```

Sign in with Google on the upload screen. Your library, chats, and PDFs are
scoped to your Supabase user id and load on any device where you sign in with
the same Google account. The Google client secret lives in Supabase — only the
anon key is ever client-side.

---

## Run locally

Requires Node 18+.

```bash
cd paper-reader
ANTHROPIC_API_KEY=sk-ant-your-key-here \
SUPABASE_URL=https://xxxx.supabase.co \
SUPABASE_ANON_KEY=eyJhbG... \
node dev-server.js
```

Open **http://localhost:3000**.

No `npm install` needed — the local server has zero dependencies.

Without Supabase keys the app falls back to browser-only storage.

---

## Deploy to Vercel

```bash
cd paper-reader
vercel
```

Environment variables (Vercel dashboard → Settings → Environment Variables):

| Variable | Required |
|---|---|
| `ANTHROPIC_API_KEY` | Yes (chat + summaries + citations) |
| `SUPABASE_URL` | Yes (cloud sync) |
| `SUPABASE_ANON_KEY` | Yes (cloud sync) |

Then `vercel --prod`.

---

## Files

```
index.html        frontend (PDF.js + Readability.js + reader/chat UI)
store.js          Supabase + local persistence layer
handler.js        Anthropic proxy (Sonnet + Haiku)
dev-server.js     local dev server (static + /api/*)
api/chat.js       Vercel — chat proxy
api/config.js     Vercel — public Supabase config
supabase/schema.sql   Postgres tables, RLS, storage policies
vercel.json       Vercel routing config
```

## Notes

- **Full-paper context + caching.** Claude receives the full extracted paper
  (cached on repeat questions). Papers over ~150k tokens fall back to nearby context.
- **Persistence.** Supabase Postgres stores documents, discussions, messages, and
  read-later items. PDF bytes live in Supabase Storage (`pdfs` bucket). A local
  backup in `localStorage` is kept for resilience. Schema migrations run in the
  browser on load; cloud migration runs once per user session.
- Web fetching uses public CORS proxies. If a URL fails, try the PDF.
- Chat model: `claude-sonnet-4-6`. Cheap tasks: `claude-haiku-4-5`.
