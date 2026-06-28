-- Add rated-response "golden set" capture (run once in Supabase SQL Editor).
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

create index if not exists ratings_email_updated_idx
  on ratings (owner_email, updated_at desc);

alter table ratings enable row level security;
drop policy if exists "ratings_open" on ratings;
create policy "ratings_open" on ratings for all using (true) with check (true);
