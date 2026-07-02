-- Paper Reader — schema. IMPORTANT: since the Google sign-in change, the
-- owner_email column carries the AUTHENTICATED SUPABASE USER ID (a UUID from
-- Supabase Auth / Google OAuth), not an email. The column name is historical;
-- no migration was run because pre-auth data was disposable (drop-and-rebuild).
-- Optional cosmetic rename: supabase/migrate-to-user-id.sql. See docs/AUTH_SETUP.md.
--
-- Run in Supabase SQL Editor.

-- ── Tables ────────────────────────────────────────────────────────────────

create table if not exists documents (
  id                    text primary key,
  owner_email           text not null,
  name                  text not null,
  mode                  text not null check (mode in ('pdf', 'web')),
  badge                 text,
  url                   text,
  conversation_summary  text,
  summary_message_count int not null default 0,
  citation_format       jsonb,
  updated_at            timestamptz not null default now(),
  created_at            timestamptz not null default now()
);

create table if not exists discussions (
  id            bigint primary key,
  document_id   text not null references documents(id) on delete cascade,
  owner_email   text not null,
  txt           text not null default '',
  mode          text,
  page_num      int,
  color         jsonb,
  rel_rects     jsonb not null default '[]'::jsonb,
  citation_meta jsonb,
  math          jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists messages (
  id              bigserial primary key,
  discussion_id   bigint not null references discussions(id) on delete cascade,
  owner_email     text not null,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null default '',
  hidden          boolean not null default false,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now()
);

create table if not exists read_later (
  id            text primary key,
  owner_email   text not null,
  title         text not null,
  url           text,
  mode          text,
  doc_id        text,
  citation_text text,
  source_doc    text,
  ref_text      text,
  added_at      timestamptz not null default now()
);

create table if not exists ratings (
  id                 text primary key,
  owner_email        text not null,
  rating             text not null check (rating in ('up', 'down')),
  reason             text,
  selected_text      text,
  selected_text_kind text,
  math_kind          text,
  question           text,
  response           text,
  model              text,
  doc_id             text,
  paper_title        text,
  paper_url          text,
  discussion_id      bigint,
  message_index      int,
  citation_meta      jsonb,
  session_id         text,
  user_id            text,
  schema_version     int not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists documents_email_updated_idx
  on documents (owner_email, updated_at desc);

create index if not exists ratings_email_updated_idx
  on ratings (owner_email, updated_at desc);

create index if not exists discussions_document_idx
  on discussions (document_id);

create index if not exists messages_discussion_order_idx
  on messages (discussion_id, sort_order);

create index if not exists read_later_email_added_idx
  on read_later (owner_email, added_at desc);

-- ── Row Level Security (prototype: app filters by owner_email) ────────────
-- Not verified server-side — fine for personal use, not for public multi-tenant.

alter table documents   enable row level security;
alter table discussions enable row level security;
alter table messages    enable row level security;
alter table read_later  enable row level security;
alter table ratings     enable row level security;

drop policy if exists "documents_own" on documents;
drop policy if exists "discussions_own" on discussions;
drop policy if exists "messages_own" on messages;
drop policy if exists "read_later_own" on read_later;
drop policy if exists "documents_open" on documents;
drop policy if exists "discussions_open" on discussions;
drop policy if exists "messages_open" on messages;
drop policy if exists "read_later_open" on read_later;
drop policy if exists "ratings_open" on ratings;

create policy "documents_open" on documents for all using (true) with check (true);
create policy "discussions_open" on discussions for all using (true) with check (true);
create policy "messages_open" on messages for all using (true) with check (true);
create policy "read_later_open" on read_later for all using (true) with check (true);
create policy "ratings_open" on ratings for all using (true) with check (true);

-- ── Storage (PDFs) ────────────────────────────────────────────────────────
-- Create bucket "pdfs" in Dashboard → Storage → New bucket (private).

drop policy if exists "pdfs_select_own" on storage.objects;
drop policy if exists "pdfs_insert_own" on storage.objects;
drop policy if exists "pdfs_update_own" on storage.objects;
drop policy if exists "pdfs_delete_own" on storage.objects;
drop policy if exists "pdfs_open" on storage.objects;

create policy "pdfs_open" on storage.objects
  for all using (bucket_id = 'pdfs') with check (bucket_id = 'pdfs');
