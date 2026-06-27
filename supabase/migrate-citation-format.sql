-- Add per-paper citation format patterns (run once in Supabase SQL Editor)
alter table documents add column if not exists citation_format jsonb;
