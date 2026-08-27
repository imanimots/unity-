-- REVIEWS V2 — canonical cutover authority (corrective, fix-forward).
--
-- 20260904000012 moved v_cutover to 2026-08-01, justified as "for
-- testability" -- this was WRONG product authority, not merely a
-- test-convenience shortcut: a live audit immediately before writing
-- this migration found 720 transactions (207 orders + 398 bookings + 10
-- barter agreements + 105 RTB agreements) that became terminal in the
-- window [2026-08-01, now()) -- every one of them would have received a
-- brand-new, wholly retroactive Reviews V2 review entitlement under that
-- cutover, despite having completed before Reviews V2's authority was
-- ever genuinely correct/deployed. This violates the locked rule
-- directly: "a transaction already terminal BEFORE the actual Reviews V2
-- cutover must NOT suddenly receive a new review entitlement."
--
-- Fix: a single canonical, DB-owned cutover authority (this table + the
-- helper below), read by both submit_review() and
-- process_review_deadlines() via the SAME function call -- no magic date
-- literal duplicated across function bodies ever again. The cutover
-- value itself is set to the moment THIS migration applies -- the
-- genuine point Reviews V2's authority becomes correct and active. Every
-- one of the 720 transactions found above (and the 37 pre-existing
-- QA-fixture review rows, already is_test=true and already excluded
-- from every public aggregate regardless) correctly receives NO new
-- entitlement under this value; only transactions reaching their
-- qualifying terminal state from this moment forward are eligible.

create table if not exists public.reviews_v2_config (
  id boolean primary key default true,
  cutover_at timestamptz not null,
  constraint reviews_v2_config_singleton check (id)
);

insert into public.reviews_v2_config (id, cutover_at)
values (true, now())
on conflict (id) do nothing;

alter table public.reviews_v2_config enable row level security;
-- Deliberately zero client policies -- read only via the SECURITY
-- DEFINER helper below (service_role-only), never queried directly by
-- anon/authenticated.

create or replace function public._reviews_v2_cutover_at()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select cutover_at from public.reviews_v2_config limit 1;
$$;
revoke all on function public._reviews_v2_cutover_at() from public, anon, authenticated;
grant execute on function public._reviews_v2_cutover_at() to service_role;

comment on table public.reviews_v2_config is 'Reviews V2. Single-row canonical cutover authority -- read via _reviews_v2_cutover_at() by every function that computes review eligibility, never duplicated as a literal.';

-- ─────────────────────────────────────────
-- submit_review / process_review_deadlines -- true supersets of the
-- current live bodies (fetched fresh via pg_get_functiondef immediately
-- before writing this migration), with the ONLY change being the
-- v_cutover assignment now delegating to the canonical authority above.
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_review(p_actor_user_id uuid, p_domain text, p_transaction_id uuid, p_rating smallint, p_comment text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_request_hash text;
  v_idem record;
  v_cutover timestamptz := public._reviews_v2_cutover_at();
  v_reviewee_id uuid;
  v_reviewer_role text;
  v_reviewee_role text;
  v_eligible_at timestamptz;
  v_header jsonb;
  v_context_label text;
  v_review_id uuid;
  v_new_version boolean := false;
  v_both_published boolean := false;
  v_reviewee_email_notify uuid;
  -- domain-specific scratch records
  v_order record;
  v_booking record;
  v_barter record;
  v_rtb record;
  v_post record;
  v_listing_title text;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_actor_user_id is null then raise exception 'not authenticated'; end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'rating must be between 1 and 5'; end if;
  if p_domain not in ('buy', 'rent', 'barter', 'rent_to_buy') then raise exception 'invalid domain'; end if;

  perform public._assert_account_status_permits_transaction(p_actor_user_id, 'self');

  v_request_hash := md5(coalesce(p_domain,'') || '|' || coalesce(p_transaction_id::text,'') || '|' || coalesce(p_rating::text,'') || '|' || coalesce(p_comment,''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'submit_review' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  -- Lock the underlying transaction row for the duration of this call --
  -- this is the serialization point that makes the "publish both on
  -- second submission" check below race-free against a concurrent
  -- submission by the counterparty.
  if p_domain = 'buy' then
    select * into v_order from public.orders where id = p_transaction_id for update;
    if v_order.id is null then raise exception 'transaction not found'; end if;
    if p_actor_user_id <> v_order.buyer_id and p_actor_user_id <> v_order.seller_id then
      raise exception 'you are not a party to this transaction';
    end if;
    v_reviewee_id := case when p_actor_user_id = v_order.buyer_id then v_order.seller_id else v_order.buyer_id end;
    v_reviewer_role := case when p_actor_user_id = v_order.buyer_id then 'buyer' else 'merchant' end;
    v_reviewee_role := case when p_actor_user_id = v_order.buyer_id then 'merchant' else 'buyer' end;

    if v_order.status = 'delivered' and v_order.delivered_at >= v_cutover then
      v_eligible_at := v_order.delivered_at;
    elsif v_order.status = 'disputed' then
      v_eligible_at := public._review_dispute_fallback_eligible_at('buy', p_transaction_id, 'delivered');
      if v_eligible_at is not null and v_eligible_at < v_cutover then v_eligible_at := null; end if;
    end if;

    select title into v_listing_title from public.listings where id = v_order.listing_id;
    v_context_label := case when v_reviewer_role = 'buyer' then 'buy' else 'sell' end;
    v_header := jsonb_build_object('kind', v_context_label, 'title', coalesce(v_listing_title, 'Item'));

  elsif p_domain = 'rent' then
    select * into v_booking from public.bookings where id = p_transaction_id for update;
    if v_booking.id is null then raise exception 'transaction not found'; end if;
    if p_actor_user_id <> v_booking.renter_id and p_actor_user_id <> v_booking.merchant_id then
      raise exception 'you are not a party to this transaction';
    end if;
    v_reviewee_id := case when p_actor_user_id = v_booking.renter_id then v_booking.merchant_id else v_booking.renter_id end;
    v_reviewer_role := case when p_actor_user_id = v_booking.renter_id then 'renter' else 'merchant' end;
    v_reviewee_role := case when p_actor_user_id = v_booking.renter_id then 'merchant' else 'renter' end;

    -- bookings.status reliably restores to 'completed' post-dispute-resolution
    -- for every outcome (Wave 2B) -- no fallback branch needed here.
    if v_booking.status = 'completed' and v_booking.completed_at >= v_cutover then
      v_eligible_at := v_booking.completed_at;
    end if;

    select title into v_listing_title from public.listings where id = v_booking.listing_id;
    v_context_label := case when v_reviewer_role = 'renter' then 'rent' else 'rent_out' end;
    v_header := jsonb_build_object('kind', v_context_label, 'title', coalesce(v_listing_title, 'Item'));

  elsif p_domain = 'barter' then
    select * into v_barter from public.barter_agreements where id = p_transaction_id for update;
    if v_barter.id is null then raise exception 'transaction not found'; end if;
    if p_actor_user_id <> v_barter.party_a_id and p_actor_user_id <> v_barter.party_b_id then
      raise exception 'you are not a party to this transaction';
    end if;
    v_reviewee_id := case when p_actor_user_id = v_barter.party_a_id then v_barter.party_b_id else v_barter.party_a_id end;
    v_reviewer_role := case when p_actor_user_id = v_barter.party_a_id then 'party_a' else 'party_b' end;
    v_reviewee_role := case when p_actor_user_id = v_barter.party_a_id then 'party_b' else 'party_a' end;

    if v_barter.status = 'completed' and v_barter.completed_at >= v_cutover then
      v_eligible_at := v_barter.completed_at;
    elsif v_barter.status = 'disputed' then
      v_eligible_at := public._review_dispute_fallback_eligible_at('barter', p_transaction_id, 'completed');
      if v_eligible_at is not null and v_eligible_at < v_cutover then v_eligible_at := null; end if;
    end if;

    if coalesce(v_barter.anchor_skill_task_post_id, v_barter.source_skill_task_post_id) is not null then
      select * into v_post from public.barter_skill_task_posts where id = coalesce(v_barter.anchor_skill_task_post_id, v_barter.source_skill_task_post_id);
      v_context_label := coalesce(v_post.kind, 'barter');
      v_header := jsonb_build_object('kind', v_context_label, 'title', coalesce(v_post.title, 'Skill/Task exchange'));
    else
      select title into v_listing_title from public.listings where id = v_barter.anchor_listing_id;
      v_context_label := 'barter';
      v_header := jsonb_build_object('kind', 'barter', 'title', coalesce(v_listing_title, 'Item'));
    end if;

  elsif p_domain = 'rent_to_buy' then
    select * into v_rtb from public.rent_to_buy_agreements where id = p_transaction_id for update;
    if v_rtb.id is null then raise exception 'transaction not found'; end if;
    if p_actor_user_id <> v_rtb.customer_id and p_actor_user_id <> v_rtb.merchant_id then
      raise exception 'you are not a party to this transaction';
    end if;
    v_reviewee_id := case when p_actor_user_id = v_rtb.customer_id then v_rtb.merchant_id else v_rtb.customer_id end;
    v_reviewer_role := case when p_actor_user_id = v_rtb.customer_id then 'customer' else 'merchant' end;
    v_reviewee_role := case when p_actor_user_id = v_rtb.customer_id then 'merchant' else 'customer' end;

    if v_rtb.status = 'completed' and v_rtb.ownership_status = 'customer_owned' and v_rtb.settled_at is not null and v_rtb.settled_at >= v_cutover then
      v_eligible_at := v_rtb.settled_at;
    elsif v_rtb.status in ('defaulted', 'cancelled') and v_rtb.possession_confirmed_at is not null
      and v_rtb.possession_status in ('returned_to_merchant', 'recovered') and v_rtb.settled_at is not null and v_rtb.settled_at >= v_cutover then
      v_eligible_at := v_rtb.settled_at;
    elsif v_rtb.status = 'disputed' then
      v_eligible_at := public._review_dispute_fallback_eligible_at('rent_to_buy', p_transaction_id, 'completed');
      if v_eligible_at is null then
        v_eligible_at := public._review_dispute_fallback_eligible_at('rent_to_buy', p_transaction_id, 'defaulted');
      end if;
      if v_eligible_at is null then
        v_eligible_at := public._review_dispute_fallback_eligible_at('rent_to_buy', p_transaction_id, 'cancelled');
      end if;
      if v_eligible_at is not null and v_eligible_at < v_cutover then v_eligible_at := null; end if;
    end if;

    select title into v_listing_title from public.listings where id = v_rtb.listing_id;
    v_context_label := case when v_reviewer_role = 'customer' then 'rent_to_buy_customer' else 'rent_to_buy_merchant' end;
    v_header := jsonb_build_object('kind', v_context_label, 'title', coalesce(v_listing_title, 'Item'));
  end if;

  if v_eligible_at is null then
    raise exception 'this transaction is not yet eligible for a review';
  end if;
  if now() > v_eligible_at + interval '14 days' then
    raise exception 'the review window for this transaction has expired';
  end if;

  insert into public.reviews (
    booking_id, order_id, barter_agreement_id, rent_to_buy_agreement_id,
    reviewer_id, reviewee_id, rating, comment,
    domain, context_label, reviewer_role, reviewee_role, header_snapshot,
    eligible_at, review_deadline_at
  ) values (
    case when p_domain = 'rent' then p_transaction_id end,
    case when p_domain = 'buy' then p_transaction_id end,
    case when p_domain = 'barter' then p_transaction_id end,
    case when p_domain = 'rent_to_buy' then p_transaction_id end,
    p_actor_user_id, v_reviewee_id, p_rating, p_comment,
    p_domain, v_context_label, v_reviewer_role, v_reviewee_role, v_header,
    v_eligible_at, v_eligible_at + interval '14 days'
  )
  on conflict do nothing
  returning id into v_review_id;

  if v_review_id is not null then
    v_new_version := true;
  else
    -- Idempotent replay path -- find the existing row for this exact
    -- reviewer+transaction rather than raising.
    if p_domain = 'buy' then
      select id into v_review_id from public.reviews where order_id = p_transaction_id and reviewer_id = p_actor_user_id;
    elsif p_domain = 'rent' then
      select id into v_review_id from public.reviews where booking_id = p_transaction_id and reviewer_id = p_actor_user_id;
    elsif p_domain = 'barter' then
      select id into v_review_id from public.reviews where barter_agreement_id = p_transaction_id and reviewer_id = p_actor_user_id;
    elsif p_domain = 'rent_to_buy' then
      select id into v_review_id from public.reviews where rent_to_buy_agreement_id = p_transaction_id and reviewer_id = p_actor_user_id;
    end if;
  end if;

  -- Double-blind reveal: if the counterpart's review for this exact
  -- transaction already exists and is not yet published, and THIS
  -- submission is genuinely new (not a replay), both publish now.
  if v_new_version then
    declare
      v_counterpart_id uuid;
    begin
      if p_domain = 'buy' then
        select id into v_counterpart_id from public.reviews where order_id = p_transaction_id and reviewer_id = v_reviewee_id and published_at is null;
      elsif p_domain = 'rent' then
        select id into v_counterpart_id from public.reviews where booking_id = p_transaction_id and reviewer_id = v_reviewee_id and published_at is null;
      elsif p_domain = 'barter' then
        select id into v_counterpart_id from public.reviews where barter_agreement_id = p_transaction_id and reviewer_id = v_reviewee_id and published_at is null;
      elsif p_domain = 'rent_to_buy' then
        select id into v_counterpart_id from public.reviews where rent_to_buy_agreement_id = p_transaction_id and reviewer_id = v_reviewee_id and published_at is null;
      end if;

      if v_counterpart_id is not null then
        update public.reviews set published_at = now() where id in (v_review_id, v_counterpart_id);
        v_both_published := true;
      end if;
    end;
  end if;

  declare
    v_result jsonb;
  begin
    v_result := jsonb_build_object(
      'review_id', v_review_id,
      'domain', p_domain,
      'reviewee_id', v_reviewee_id,
      'eligible_at', v_eligible_at,
      'review_deadline_at', v_eligible_at + interval '14 days',
      'both_now_published', v_both_published
    );

    if p_idempotency_key is not null and v_new_version then
      insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
      values (p_actor_user_id, 'submit_review', p_idempotency_key, v_request_hash, v_result);
    end if;

    return v_result;
  end;
end;
$function$
;

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
  for v_row in
    select w.* from public.review_windows w
    where w.resolved_at is null and now() >= w.eligible_at + interval '10 days' and now() < w.deadline_at
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
  for v_row in
    select w.* from public.review_windows w
    where w.resolved_at is null and now() >= w.deadline_at
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
