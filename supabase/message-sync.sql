-- Message sync: content-addressed message ids + discussion tombstones.
-- RUN ONCE (not idempotent like harden-rls.sql/multi-tenant-keys.sql — this one
-- backfills+swaps a primary key), AFTER harden-rls.sql + multi-tenant-keys.sql.
-- Wrapped in a single transaction (begin/commit): if anything fails partway,
-- Postgres rolls the whole migration back — no half-migrated state.
--
-- Fixes the silent cross-device history-loss bug: messages had no stable
-- identity, so cloud sync did a blob-level delete-then-reinsert (effectively
-- last-write-wins on the whole discussion), which let a stale device wipe a
-- peer's newer messages. The fix, mirrored in store.js:
--
--   * discussions.id becomes a client-generated, RANDOM id (crypto.randomUUID())
--     instead of Date.now() — two devices can never mint the same one.
--   * messages.id becomes a client-generated, CONTENT-ADDRESSED text id
--     `<discussion_id>:<role>:<sha256(content)[:16]>` — the SAME logical
--     message maps to the SAME id on every device, so cloud writes are
--     idempotent upserts (no delete-replace), and a stale device can only
--     re-assert old content, never delete a peer's newer message.
--   * messages.created_ms (client epoch ms) is the cross-device sort key,
--     independent of message identity (clock skew can reorder display, it can
--     never cause loss — see test/message-sync.test.js "clock-skew" case).
--   * discussions.deleted is a tombstone: deletes UPDATE it to true (monotonic —
--     a save skips deleted discussions, so it can never be resurrected), and it
--     propagates to other devices on their next poll.
--
-- The hash is a STANDARD one on both ends — no hand-rolled algorithm, no
-- cross-language bit-exactness risk: the client uses Web Crypto's
-- crypto.subtle.digest('SHA-256', utf8Bytes) (see store.js messageClientId);
-- here we use Postgres's built-in sha256() (core since PG14 — no pgcrypto
-- extension needed) over the same UTF-8 byte encoding. Both are the same
-- well-defined algorithm over the same bytes, so this is exact by
-- construction, not by verification — unlike a custom hash, there is no
-- Unicode-iteration ambiguity (UTF-8 bytes are unambiguous regardless of how
-- you get to them).
--
-- THIS MIGRATION IS DATA-PRESERVING — it does NOT truncate messages. Existing
-- rows are backfilled with this same id scheme, so a device that already has
-- one of these historical messages cached will upsert cleanly onto the
-- backfilled row instead of duplicating it.
--
-- KNOWN EDGE CASE: if a discussion has two truly identical pre-existing
-- messages (same owner, discussion, role, AND content), they would compute the
-- same id and collide. The backfill below detects this (a window function over
-- owner_email, discussion_id, role, content) and appends a `:2`, `:3`, ...
-- suffix to every occurrence after the first, so ALL historical rows are kept —
-- only the single first occurrence gets the "clean" id a future client save
-- would also compute (matching the accepted collapse behavior for NEW writes).

begin;

-- ── Helper: content-addressed id, standard sha256() built-in ────────────────
create or replace function _pr_message_client_id(discussion_id text, role text, content text)
returns text
language sql
immutable
as $$
  select discussion_id || ':' || (case when role = 'assistant' then 'assistant' else 'user' end)
         || ':' || substr(encode(sha256(convert_to(coalesce(content, ''), 'UTF8')), 'hex'), 1, 16);
$$;

-- ── discussions: id -> text (random UUIDs going forward), + tombstone ───────
alter table messages    drop constraint if exists messages_discussion_fkey;
alter table discussions drop constraint if exists discussions_pkey cascade;

alter table discussions alter column id type text using id::text;
alter table discussions add column if not exists deleted boolean not null default false;

alter table discussions add constraint discussions_pkey primary key (owner_email, id);

-- ── messages.discussion_id: bigint -> text (must match discussions.id) ──────
alter table messages alter column discussion_id type text using discussion_id::text;

-- Optional, for consistency (no FK enforced on this column, so lower risk).
-- ratings is itself optional (supabase/migrate-ratings.sql) — guard it.
do $$
begin
  if to_regclass('public.ratings') is not null then
    alter table ratings alter column discussion_id type text using discussion_id::text;
  else
    raise notice 'skipping ratings (table does not exist)';
  end if;
end $$;

-- ── messages: backfill a content-addressed id, then swap it in as the PK ────
alter table messages add column if not exists new_id text;
alter table messages add column if not exists created_ms bigint;

with ranked as (
  select
    id,
    _pr_message_client_id(discussion_id, role, content) as base_id,
    row_number() over (
      partition by owner_email, discussion_id, role, content
      order by sort_order, created_at, id
    ) as occurrence
  from messages
)
update messages m
set new_id = case when ranked.occurrence = 1 then ranked.base_id
                   else ranked.base_id || ':' || ranked.occurrence end,
    created_ms = coalesce(created_ms, (extract(epoch from m.created_at) * 1000)::bigint)
from ranked
where m.id = ranked.id;

alter table messages drop constraint if exists messages_pkey cascade;
alter table messages drop column id;
alter table messages rename column new_id to id;
alter table messages alter column id set not null;
alter table messages add constraint messages_pkey primary key (owner_email, id);

alter table messages
  add constraint messages_discussion_fkey
  foreign key (owner_email, discussion_id)
  references discussions (owner_email, id) on delete cascade;

commit;

-- ── Verify ─────────────────────────────────────────────────────────────────
-- 1. No message lost:
--      select count(*) from messages;   -- compare to the pre-migration count
-- 2. No duplicate (owner_email, id):
--      select owner_email, id, count(*) from messages group by 1,2 having count(*) > 1;
--      -- should return zero rows
-- 3. Re-saving an existing conversation from a client upserts in place (no
--    duplicate rows) rather than inserting new ones.
-- 4. Deleting a highlight on one device removes it on another after a poll:
--      select id, deleted from discussions where document_id = '<doc>';
