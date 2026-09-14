-- Add the paper-level library-card blurb (arXiv summary / abstract / page
-- excerpt) to documents (run once in Supabase SQL Editor). Older clients
-- ignore the column; newer clients fall back to saving without it until this
-- has been applied.
alter table documents add column if not exists description text;
