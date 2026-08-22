-- Fix-forward: merchant_pause_listing / merchant_resume_listing take no row
-- lock and their closing UPDATE had no status precondition in its WHERE
-- clause. Two concurrent calls on the SAME listing could both pass the
-- initial guard check (both reading the pre-transition status) and both
-- execute the UPDATE + INSERT INTO listing_history unconditionally --
-- producing two success responses AND two history rows for one conceptual
-- transition (final `status` value was always correct; the duplicate was
-- the redundant history row and the non-deterministic double-200).
--
-- Minimal fix: add the status precondition to the UPDATE's own WHERE
-- clause and gate the history insert on the UPDATE actually having
-- affected a row (via GET DIAGNOSTICS ... ROW_COUNT). The race-loser's
-- UPDATE blocks on the winner's row lock, then re-evaluates its WHERE
-- clause against the now-committed row and affects 0 rows, so it raises
-- the SAME existing domain error the initial guard already raises for a
-- wrong-state listing -- no new error text, no client-visible change,
-- already mapped by mapListingRpcError(). Signatures are unchanged, so a
-- plain CREATE OR REPLACE is sufficient (no DROP FUNCTION needed).

create or replace function public.merchant_pause_listing(
  p_merchant_id uuid,
  p_listing_id uuid,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_listing record;
  v_rows int;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select id, merchant_id, status into v_listing from public.listings where id = p_listing_id;
  if v_listing.id is null then raise exception 'listing not found'; end if;
  if v_listing.merchant_id <> p_merchant_id then raise exception 'you do not own this listing'; end if;
  if v_listing.status <> 'active' then raise exception 'only an active listing can be paused'; end if;

  update public.listings set status = 'paused' where id = p_listing_id and status = 'active';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'only an active listing can be paused';
  end if;

  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (p_listing_id, p_merchant_id, jsonb_build_object('listing_status', 'active'), jsonb_build_object('listing_status', 'paused'), coalesce(p_reason, 'merchant_paused'));

  return jsonb_build_object('listing_id', p_listing_id, 'status', 'paused');
end;
$$;
-- CREATE OR REPLACE preserves the existing grants (service_role only).

create or replace function public.merchant_resume_listing(
  p_merchant_id uuid,
  p_listing_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_listing record;
  v_active_count int;
  v_plan_id text;
  v_publication_limit int;
  v_rows int;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select id, merchant_id, status, is_test into v_listing from public.listings where id = p_listing_id;
  if v_listing.id is null then raise exception 'listing not found'; end if;
  if v_listing.merchant_id <> p_merchant_id then raise exception 'you do not own this listing'; end if;
  if v_listing.status <> 'paused' then raise exception 'only a paused listing can be resumed'; end if;

  perform public._assert_not_publication_frozen(p_merchant_id);

  if not v_listing.is_test then
    v_active_count := public._lock_and_count_active_supply(p_merchant_id);
    v_plan_id := public._get_effective_merchant_plan_id(p_merchant_id);
    select active_publication_limit into v_publication_limit from public.merchant_subscription_plans where id = v_plan_id;
    if v_publication_limit is not null and v_active_count >= v_publication_limit then
      raise exception 'active_publication_limit_reached: the % plan allows up to % active published entities', v_plan_id, v_publication_limit;
    end if;
  end if;

  update public.listings set status = 'active' where id = p_listing_id and status = 'paused';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'only a paused listing can be resumed';
  end if;

  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (p_listing_id, p_merchant_id, jsonb_build_object('listing_status', 'paused'), jsonb_build_object('listing_status', 'active'), 'merchant_resumed');

  return jsonb_build_object('listing_id', p_listing_id, 'status', 'active');
end;
$$;
-- CREATE OR REPLACE preserves the existing grants (service_role only).
