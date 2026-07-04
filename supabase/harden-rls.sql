-- Harden Row Level Security before a public launch (run once in Supabase SQL Editor).
--
-- Replaces the open `using (true)` prototype policies with owner-scoped policies
-- so a visitor can only read/write their OWN rows. Safe for the signed-out
-- experience: signed-out users never touch Supabase (the app is local-only
-- without an authenticated session — see store.js `useCloud`).
--
-- Prerequisite: owner_email carries the Supabase auth user id (auth.uid()), which
-- has been true since the Google sign-in change. See supabase/schema.sql header.
--
-- Tolerant of missing tables: only tables that actually exist are touched, so it
-- works whether or not optional migrations (e.g. migrate-ratings.sql) were run.

-- ── Tables: owner-scoped instead of open ──────────────────────────────────
do $$
declare
  t text;
  tables text[] := array['documents', 'discussions', 'messages', 'read_later', 'ratings'];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is null then
      raise notice 'skipping % (table does not exist)', t;
      continue;
    end if;

    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_open', t);
    execute format('drop policy if exists %I on %I', t || '_own', t);
    execute format(
      'create policy %I on %I for all using (owner_email = auth.uid()::text) with check (owner_email = auth.uid()::text)',
      t || '_own', t
    );
    raise notice 'scoped RLS on %', t;
  end loop;
end $$;

-- ── Storage (pdfs bucket): folder-scoped to the owner ─────────────────────
-- PDF objects are stored at `${userPathKey(userId)}/${docId}` where userPathKey
-- STRIPS hyphens out of the UUID (store.js userPathKey), so the folder segment
-- is the auth uid without hyphens. The policy must strip them too, otherwise it
-- would never match. Also confirm the bucket itself is Private (a public bucket
-- bypasses this policy entirely).
drop policy if exists "pdfs_open" on storage.objects;
drop policy if exists "pdfs_own"  on storage.objects;

create policy "pdfs_own" on storage.objects for all
  using (
    bucket_id = 'pdfs'
    and (storage.foldername(name))[1] = replace(auth.uid()::text, '-', '')
  )
  with check (
    bucket_id = 'pdfs'
    and (storage.foldername(name))[1] = replace(auth.uid()::text, '-', '')
  );

-- ── Verify ────────────────────────────────────────────────────────────────
-- 1. Sign in; confirm your own papers still load, save, and PDFs open.
-- 2. From a second account (or with a different auth.uid()), confirm you canNOT
--    see or download the first account's documents/discussions/PDFs.
