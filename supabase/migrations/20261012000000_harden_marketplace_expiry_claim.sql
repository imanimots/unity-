-- ============================================================
-- Harden expire_marketplace_requests against duplicate/concurrent
-- scheduler delivery (P5D-ROUTE-HARDEN-I).
-- ============================================================
-- Google Cloud Scheduler (and every other scheduler already evaluated
-- for this project) is documented at-least-once, not exactly-once -- a
-- genuinely concurrent duplicate invocation of this sweep is a real,
-- platform-acknowledged possibility, not merely theoretical.
--
-- The prior implementation selected a batch of candidate ids with a
-- plain (unlocked) SELECT, updated them all in one statement, then
-- inserted history by re-reading the ALREADY-UPDATED rows. That meant:
--   (a) two concurrent invocations could both select the same ids
--       before either updates, and both insert a duplicate history row
--       per request; and
--   (b) even in the purely sequential case, previous_status in that
--       history insert was always the POST-update value
--       ('date_passed'), never the true prior status -- the function's
--       own prior comment explicitly (and incorrectly) accepted this
--       as "acceptable for an automated sweep event."
--
-- Fixed by replacing the two-statement batch approach with the same
-- per-row FOR UPDATE SKIP LOCKED claim loop already proven safe
-- elsewhere in this codebase (see expire_unpaid_accepted_bookings(),
-- 20260807000001_transactional_emails.sql): each row is claimed by its
-- own row lock before its update+history pair, so a second concurrent
-- invocation's cursor skips any row already locked by the first rather
-- than reprocessing it, and the true pre-update status is captured
-- directly from the loop variable -- never re-read after the update.
--
-- Return shape is unchanged ({"expired_count": N}) -- no caller-visible
-- contract change, auth/route/cadence untouched.
-- ============================================================

create or replace function public.expire_marketplace_requests(p_limit int default 200)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_row record;
  v_expired_count int := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  for v_row in
    select id, status from public.marketplace_requests
    where status in ('active', 'offers_received') and expires_at is not null and expires_at < now()
    order by expires_at asc
    limit greatest(coalesce(p_limit, 200), 1)
    for update skip locked
  loop
    update public.marketplace_requests set status = 'date_passed' where id = v_row.id;

    insert into public.marketplace_request_history (request_id, actor_role, event_type, previous_status, new_status)
    values (v_row.id, 'system', 'date_passed', v_row.status::text, 'date_passed');

    v_expired_count := v_expired_count + 1;
  end loop;

  return jsonb_build_object('expired_count', v_expired_count);
end;
$$;

revoke all on function public.expire_marketplace_requests(int) from public, anon, authenticated;
grant execute on function public.expire_marketplace_requests(int) to service_role;
