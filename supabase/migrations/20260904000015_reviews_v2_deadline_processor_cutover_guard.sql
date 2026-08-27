-- REVIEWS V2 — deadline processor cutover guard (corrective, fix-forward).
--
-- Live audit finding, confirmed immediately before this migration: while
-- the incorrect August 1 cutover was live (before 20260904000013
-- corrected it), process_review_deadlines()'s own discovery step
-- created 642 real review_windows rows for transactions that pre-date
-- the CURRENT canonical cutover (public._reviews_v2_cutover_at()).
-- Confirmed unambiguously QA/test-environment data (5 distinct parties
-- total, all @unitytest.internal, 0 outside that domain; 0 corresponding
-- reviews rows exist) -- but that classification is a fact about THIS
-- dev database's specific data, not a guarantee about the CODE. The
-- underlying structural defect is real and domain-independent: steps 2
-- (day-10 reminders) and 3 (deadline resolution) in
-- process_review_deadlines() operate purely on a window's own
-- eligible_at/deadline_at/resolved_at columns, with NO re-check against
-- the current cutover authority. 427 of the 642 stale windows are still
-- unresolved, 3 are already reminder-eligible right now -- meaning an
-- unmodified rerun of this processor would send reminder notifications,
-- and eventually auto-publish/resolve, for transactions that were never
-- legitimately eligible under the corrected cutover. This is a live
-- integrity gap, not merely stale test data.
--
-- Fix: both the reminder loop and the resolution loop now additionally
-- require w.eligible_at >= v_cutover (the same authority already used
-- by step 1's discovery query and by submit_review()) -- a stale window
-- whose eligible_at predates the current cutover is permanently excluded
-- from further reminder/resolution processing, regardless of how it
-- came to exist. True superset of the current live body (fetched fresh
-- via pg_get_functiondef immediately before writing this migration) --
-- the only change is the added `and w.eligible_at >= v_cutover` clause
-- in two places.
CREATE OR REPLACE FUNCTION public.process_review_deadlines(p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cutover timestamptz := public._reviews_v2_cutover_at();
  v_lookback timestamptz := now() - interval '20 days';
  v_new_windows jsonb := '[]'::jsonb;
  v_reminders jsonb := '[]'::jsonb;
  v_resolutions jsonb := '[]'::jsonb;
  v_row record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  -- 1. Discover newly-terminal transactions not yet tracked, per domain,
  --    bounded to a recent lookback window (never a full-history scan).
  for v_row in
    select 'buy' as domain, o.id as transaction_id, o.buyer_id as party_a_id, o.seller_id as party_b_id, o.delivered_at as eligible_at
    from public.orders o
    where o.status = 'delivered' and o.delivered_at >= greatest(v_cutover, v_lookback)
      and not exists (select 1 from public.review_windows w where w.domain = 'buy' and w.transaction_id = o.id)
    union all
    select 'rent', b.id, b.renter_id, b.merchant_id, b.completed_at
    from public.bookings b
    where b.status = 'completed' and b.completed_at >= greatest(v_cutover, v_lookback)
      and not exists (select 1 from public.review_windows w where w.domain = 'rent' and w.transaction_id = b.id)
    union all
    select 'barter', ba.id, ba.party_a_id, ba.party_b_id, ba.completed_at
    from public.barter_agreements ba
    where ba.status = 'completed' and ba.completed_at >= greatest(v_cutover, v_lookback)
      and not exists (select 1 from public.review_windows w where w.domain = 'barter' and w.transaction_id = ba.id)
    union all
    select 'rent_to_buy', r.id, r.customer_id, r.merchant_id, r.settled_at
    from public.rent_to_buy_agreements r
    where r.settled_at is not null and r.settled_at >= greatest(v_cutover, v_lookback)
      and ((r.status = 'completed' and r.ownership_status = 'customer_owned')
        or (r.status in ('defaulted', 'cancelled') and r.possession_confirmed_at is not null and r.possession_status in ('returned_to_merchant', 'recovered')))
      and not exists (select 1 from public.review_windows w where w.domain = 'rent_to_buy' and w.transaction_id = r.id)
    limit p_limit
  loop
    insert into public.review_windows (domain, transaction_id, party_a_id, party_b_id, eligible_at, deadline_at)
    values (v_row.domain, v_row.transaction_id, v_row.party_a_id, v_row.party_b_id, v_row.eligible_at, v_row.eligible_at + interval '14 days')
    on conflict (domain, transaction_id) do nothing;
    if found then
      v_new_windows := v_new_windows || jsonb_build_object('domain', v_row.domain, 'transaction_id', v_row.transaction_id, 'party_a_id', v_row.party_a_id, 'party_b_id', v_row.party_b_id);
    end if;
  end loop;

  -- 2. Day-10 reminders, once each, only for the party who hasn't submitted.
  --    eligible_at >= v_cutover guards against a stale window (created
  --    while an earlier, incorrect cutover was live) ever being reminded.
  for v_row in
    select w.* from public.review_windows w
    where w.resolved_at is null and w.eligible_at >= v_cutover and now() >= w.eligible_at + interval '10 days' and now() < w.deadline_at
      and (w.party_a_reminded_at is null or w.party_b_reminded_at is null)
    limit p_limit
  loop
    declare
      v_a_reviewed boolean;
      v_b_reviewed boolean;
    begin
      v_a_reviewed := public._review_window_party_has_reviewed(v_row.domain, v_row.transaction_id, v_row.party_a_id);
      v_b_reviewed := public._review_window_party_has_reviewed(v_row.domain, v_row.transaction_id, v_row.party_b_id);

      if v_row.party_a_reminded_at is null and not v_a_reviewed then
        update public.review_windows set party_a_reminded_at = now() where id = v_row.id;
        v_reminders := v_reminders || jsonb_build_object('domain', v_row.domain, 'transaction_id', v_row.transaction_id, 'recipient_id', v_row.party_a_id);
      end if;
      if v_row.party_b_reminded_at is null and not v_b_reviewed then
        update public.review_windows set party_b_reminded_at = now() where id = v_row.id;
        v_reminders := v_reminders || jsonb_build_object('domain', v_row.domain, 'transaction_id', v_row.transaction_id, 'recipient_id', v_row.party_b_id);
      end if;
    end;
  end loop;

  -- 3. Deadline resolution: publish a lone review, or expire silently.
  --    Same eligible_at >= v_cutover guard -- a stale window is
  --    permanently excluded from ever being resolved (no reminder, no
  --    publish, no silent-expire mutation) rather than resolved
  --    incorrectly.
  for v_row in
    select w.* from public.review_windows w
    where w.resolved_at is null and w.eligible_at >= v_cutover and now() >= w.deadline_at
    limit p_limit
  loop
    declare
      v_published_count int;
      v_lone_review_id uuid;
      v_lone_reviewer_id uuid;
    begin
      if v_row.domain = 'buy' then
        select count(*) filter (where published_at is not null) into v_published_count from public.reviews where order_id = v_row.transaction_id;
        select id, reviewer_id into v_lone_review_id, v_lone_reviewer_id from public.reviews where order_id = v_row.transaction_id and published_at is null limit 1;
      elsif v_row.domain = 'rent' then
        select count(*) filter (where published_at is not null) into v_published_count from public.reviews where booking_id = v_row.transaction_id;
        select id, reviewer_id into v_lone_review_id, v_lone_reviewer_id from public.reviews where booking_id = v_row.transaction_id and published_at is null limit 1;
      elsif v_row.domain = 'barter' then
        select count(*) filter (where published_at is not null) into v_published_count from public.reviews where barter_agreement_id = v_row.transaction_id;
        select id, reviewer_id into v_lone_review_id, v_lone_reviewer_id from public.reviews where barter_agreement_id = v_row.transaction_id and published_at is null limit 1;
      elsif v_row.domain = 'rent_to_buy' then
        select count(*) filter (where published_at is not null) into v_published_count from public.reviews where rent_to_buy_agreement_id = v_row.transaction_id;
        select id, reviewer_id into v_lone_review_id, v_lone_reviewer_id from public.reviews where rent_to_buy_agreement_id = v_row.transaction_id and published_at is null limit 1;
      end if;

      if v_published_count >= 2 then
        update public.review_windows set resolved_at = now(), resolution = 'both_published' where id = v_row.id;
      elsif v_lone_review_id is not null then
        update public.reviews set published_at = now() where id = v_lone_review_id;
        update public.review_windows set resolved_at = now(), resolution = 'one_published' where id = v_row.id;
        v_resolutions := v_resolutions || jsonb_build_object('domain', v_row.domain, 'transaction_id', v_row.transaction_id, 'party_a_id', v_row.party_a_id, 'party_b_id', v_row.party_b_id, 'resolution', 'one_published');
      else
        update public.review_windows set resolved_at = now(), resolution = 'none_submitted' where id = v_row.id;
      end if;
    end;
  end loop;

  return jsonb_build_object('new_windows', v_new_windows, 'reminders', v_reminders, 'resolutions', v_resolutions);
end;
$function$
;
