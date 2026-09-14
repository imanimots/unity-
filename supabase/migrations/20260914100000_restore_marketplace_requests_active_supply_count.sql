-- ============================================================
-- Fix-forward: restore marketplace_requests to the shared active-
-- publication supply count.
--
-- Active publication supply equals exactly:
--   - active non-test listings
--   - Available-direction, active, non-test Skill/Task posts
--   - active/offers_received, non-test marketplace_requests
-- Nothing else consumes an active publication slot.
--
-- 20260901000009_skills_tasks_barter_posts_rpcs.sql's CREATE OR
-- REPLACE of this function accidentally dropped the marketplace_requests
-- term while narrowing the Skill/Task term to Available-only -- this
-- restores it. No caller, signature, security mode, or grant changes;
-- see docs of Phase A3 (Active-Supply Fix Design) for the full audit.
-- ============================================================

create or replace function public._lock_and_count_active_supply(p_user_id uuid)
returns int
language plpgsql
as $$
declare
  v_count int;
begin
  perform 1
  from public.profiles
  where id = p_user_id
  for update;

  select
    (
      select count(*)
      from public.listings
      where merchant_id = p_user_id
        and status = 'active'
        and is_test = false
    )
    +
    (
      select count(*)
      from public.barter_skill_task_posts
      where owner_id = p_user_id
        and direction = 'available'
        and status = 'active'
        and is_test = false
    )
    +
    (
      select count(*)
      from public.marketplace_requests
      where requester_id = p_user_id
        and status in ('active', 'offers_received')
        and is_test = false
    )
  into v_count;

  return v_count;
end;
$$;

revoke all on function public._lock_and_count_active_supply(uuid) from public, anon, authenticated;
grant execute on function public._lock_and_count_active_supply(uuid) to service_role;
