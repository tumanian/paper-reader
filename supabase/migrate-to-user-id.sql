-- OPTIONAL, cosmetic only — the app works without running this.
--
-- Since the Google sign-in change, the owner_email column stores the Supabase
-- user id (UUID), not an email. This renames the column to owner_id so the
-- schema reads honestly. If you run it, also update store.js ('owner_email' →
-- 'owner_id' in every query/row) in the same change.
--
-- Old email-keyed rows are disposable (drop-and-rebuild decision). To purge
-- them first, uncomment:
--
-- delete from messages    where owner_email like '%@%';
-- delete from discussions where owner_email like '%@%';
-- delete from documents   where owner_email like '%@%';
-- delete from read_later  where owner_email like '%@%';
-- delete from ratings     where owner_email like '%@%';

alter table documents   rename column owner_email to owner_id;
alter table discussions rename column owner_email to owner_id;
alter table messages    rename column owner_email to owner_id;
alter table read_later  rename column owner_email to owner_id;
alter table ratings     rename column owner_email to owner_id;

alter index if exists documents_email_updated_idx  rename to documents_owner_updated_idx;
alter index if exists ratings_email_updated_idx    rename to ratings_owner_updated_idx;
alter index if exists read_later_email_added_idx   rename to read_later_owner_added_idx;
