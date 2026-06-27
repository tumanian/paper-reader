-- Add per-discussion math metadata for "Explain math" / "To code" threads
-- (run once in Supabase SQL Editor). Stores { kind: 'explain'|'code', tex: string|null }.
alter table discussions add column if not exists math jsonb;
