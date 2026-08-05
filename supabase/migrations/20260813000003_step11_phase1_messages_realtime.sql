-- ============================================================
-- Step 11 Phase 1 -- enable Realtime on messages
-- ============================================================
-- First table in this schema to get Realtime enabled. Needed by
-- Phase 3 (Real Chat)'s postgres_changes subscription -- not consumed
-- by any application code yet in this phase.
--
-- Written idempotently (guarded on pg_publication_tables) so this
-- migration is safe to re-run.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
