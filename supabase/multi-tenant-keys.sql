-- Multi-tenant composite primary keys (run once in the Supabase SQL Editor).
--
-- The app uses content-addressed ids: docIdFor() returns "web::<url>" (identical
-- for every user who opens the same paper), discussion ids are Date.now(), and
-- read-later ids hash the URL. With a single-column primary key those ids are
-- GLOBAL, so the second user to touch a paper collides with a row they don't own
-- and owner-scoped RLS rejects the write (error 42501).
--
-- Fix: make the primary key (owner_email, id) on every per-user table, and carry
-- owner_email into the foreign keys so a child always references its OWN parent.
-- Content ids stay exactly as they are; uniqueness now comes from (owner_email,
-- id). Pair this with supabase/harden-rls.sql (owner-scoped policies).
--
-- PREREQUISITE: legacy cross-owner rows must be gone first, or the new composite
-- foreign keys will fail to validate (a discussion whose owner_email doesn't
-- match its document's owner_email has no valid parent). On a pre-launch/clean
-- database this applies directly. To reset disposable data first:
--
--   truncate messages, discussions, read_later, documents cascade;

-- ── Drop dependent foreign keys, then the single-column primary keys ────────
alter table messages    drop constraint if exists messages_discussion_id_fkey;
alter table discussions drop constraint if exists discussions_document_id_fkey;
-- (also drop the new names so this script is safe to re-run)
alter table messages    drop constraint if exists messages_discussion_fkey;
alter table discussions drop constraint if exists discussions_document_fkey;

alter table documents   drop constraint if exists documents_pkey   cascade;
alter table discussions drop constraint if exists discussions_pkey cascade;
alter table read_later  drop constraint if exists read_later_pkey  cascade;

-- ── Composite primary keys: (owner_email, id) ──────────────────────────────
-- messages keeps its own globally-unique bigserial id; only its FK changes.
alter table documents   add constraint documents_pkey   primary key (owner_email, id);
alter table discussions add constraint discussions_pkey primary key (owner_email, id);
alter table read_later  add constraint read_later_pkey  primary key (owner_email, id);

-- ratings is optional (created only by supabase/migrate-ratings.sql). Guard it
-- so this script applies on databases that never created the table.
do $$
begin
  if to_regclass('public.ratings') is not null then
    alter table ratings drop constraint if exists ratings_pkey cascade;
    alter table ratings add constraint ratings_pkey primary key (owner_email, id);
  else
    raise notice 'skipping ratings (table does not exist)';
  end if;
end $$;

-- ── Foreign keys carrying owner_email ──────────────────────────────────────
alter table discussions
  add constraint discussions_document_fkey
  foreign key (owner_email, document_id)
  references documents (owner_email, id) on delete cascade;

alter table messages
  add constraint messages_discussion_fkey
  foreign key (owner_email, discussion_id)
  references discussions (owner_email, id) on delete cascade;

-- ── Verify ─────────────────────────────────────────────────────────────────
-- 1. Two different accounts can now each save the same paper (same content id)
--    without a 42501 — confirm both rows exist:
--      select owner_email, id from documents order by id;
-- 2. Deleting a document still cascades to that owner's discussions + messages.
