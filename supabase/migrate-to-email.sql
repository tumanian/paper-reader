-- Migrate from auth.users / user_id schema → owner_email schema
-- Run once in Supabase SQL Editor if you already created the old tables.

alter table documents add column if not exists owner_email text;
alter table discussions add column if not exists owner_email text;
alter table messages add column if not exists owner_email text;
alter table read_later add column if not exists owner_email text;

alter table documents alter column user_id drop not null;
alter table discussions alter column user_id drop not null;
alter table messages alter column user_id drop not null;
alter table read_later alter column user_id drop not null;

drop policy if exists "documents_own" on documents;
drop policy if exists "discussions_own" on discussions;
drop policy if exists "messages_own" on messages;
drop policy if exists "read_later_own" on read_later;

create policy "documents_open" on documents for all using (true) with check (true);
create policy "discussions_open" on discussions for all using (true) with check (true);
create policy "messages_open" on messages for all using (true) with check (true);
create policy "read_later_open" on read_later for all using (true) with check (true);

drop policy if exists "pdfs_select_own" on storage.objects;
drop policy if exists "pdfs_insert_own" on storage.objects;
drop policy if exists "pdfs_update_own" on storage.objects;
drop policy if exists "pdfs_delete_own" on storage.objects;

create policy "pdfs_open" on storage.objects
  for all using (bucket_id = 'pdfs') with check (bucket_id = 'pdfs');

create index if not exists documents_email_updated_idx
  on documents (owner_email, updated_at desc);

create index if not exists read_later_email_added_idx
  on read_later (owner_email, added_at desc);

-- Optional: claim anonymous-era rows for your email so they show up on load.
-- Replace with your address, run once:
--
-- update documents   set owner_email = 'you@example.com' where owner_email is null;
-- update discussions set owner_email = 'you@example.com' where owner_email is null;
-- update messages    set owner_email = 'you@example.com' where owner_email is null;
-- update read_later  set owner_email = 'you@example.com' where owner_email is null;
