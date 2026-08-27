-- REVIEWS V2 — RPCs + review_windows tracking table + deadline processor.
--
-- review_windows is added here (not the schema migration) because it is
-- purely a notification/reminder/expiry-processing tracking concept, only
-- meaningful alongside the processor RPC that populates and drains it --
-- kept in the same migration as the logic that owns it end to end.
--
-- Design: submit_review()/submit_review_reply() compute eligibility fresh
-- from the LIVE transaction row every call (never trusts a cached
-- eligibility record) -- review_windows is a separate, best-effort
-- notification-scheduling ledger, not the source of eligibility truth.
-- This means a transaction is always genuinely reviewable/blocked
-- correctly even if the notification sweep has not yet run for it.

create table if not exists public.review_windows (
  id uuid primary key default gen_random_uuid(),
  domain text not null check (domain in ('buy', 'rent', 'barter', 'rent_to_buy')),
  transaction_id uuid not null,
  party_a_id uuid not null references public.profiles(id),
  party_b_id uuid not null references public.profiles(id),
  eligible_at timestamptz not null,
  deadline_at timestamptz not null,
  party_a_reminded_at timestamptz,
  party_b_reminded_at timestamptz,
  resolved_at timestamptz,
  resolution text check (resolution in ('both_published', 'one_published', 'none_submitted')),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  unique (domain, transaction_id)
);

create index if not exists review_windows_pending_reminder_idx on public.review_windows (eligible_at) where resolved_at is null;
create index if not exists review_windows_pending_deadline_idx on public.review_windows (deadline_at) where resolved_at is null;

alter table public.review_windows enable row level security;
-- Deliberately zero client policies -- internal bookkeeping only, never read by the client directly.

-- ─────────────────────────────────────────
-- Helper: dispute-resolution fallback for domains where
-- resolve_dispute()/cancel_dispute() never restore the underlying
-- transaction's own status column (orders, barter_agreements, and
-- rent_to_buy_agreements for outcomes other than favor_respondent -- all
-- confirmed live, pre-existing, documented gaps unrelated to Reviews V2).
-- Returns the timestamp the dispute resolved IF the transaction was
-- genuinely at the expected terminal status when the dispute opened;
-- returns null otherwise (still disputed, or wasn't at that status).
-- ─────────────────────────────────────────
create or replace function public._review_dispute_fallback_eligible_at(p_domain text, p_transaction_id uuid, p_expected_pre_status text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute record;
begin
  if p_domain = 'buy' then
    select * into v_dispute from public.disputes where order_id = p_transaction_id order by created_at desc limit 1;
  elsif p_domain = 'rent' then
    select * into v_dispute from public.disputes where booking_id = p_transaction_id order by created_at desc limit 1;
  elsif p_domain = 'barter' then
    select * into v_dispute from public.disputes where barter_agreement_id = p_transaction_id order by created_at desc limit 1;
  elsif p_domain = 'rent_to_buy' then
    select * into v_dispute from public.disputes where rent_to_buy_agreement_id = p_transaction_id order by created_at desc limit 1;
  end if;

  if v_dispute.id is null then return null; end if;
  if v_dispute.status not in ('resolved', 'closed') then return null; end if;
  if v_dispute.pre_dispute_status is distinct from p_expected_pre_status then return null; end if;
  return coalesce(v_dispute.resolved_at, v_dispute.closed_at, v_dispute.updated_at);
end;
$$;
revoke all on function public._review_dispute_fallback_eligible_at(text, uuid, text) from public, anon, authenticated;
grant execute on function public._review_dispute_fallback_eligible_at(text, uuid, text) to service_role;

-- ─────────────────────────────────────────
-- submit_review — the single review-creation entry point for all 4
-- domains (buy/rent/barter/rent_to_buy). Replaces create_barter_review
-- as the canonical path; create_barter_review is left untouched/unused
-- rather than dropped (no destructive removal of a function another
-- migration or cached client build might still reference).
-- ─────────────────────────────────────────
create or replace function public.submit_review(
  p_actor_user_id uuid,
  p_domain text,
  p_transaction_id uuid,
  p_rating smallint,
  p_comment text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_hash text;
  v_idem record;
  v_cutover timestamptz := '2026-08-25T00:00:00+00'::timestamptz;
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
$$;
revoke all on function public.submit_review(uuid, text, uuid, smallint, text, text) from public, anon, authenticated;
grant execute on function public.submit_review(uuid, text, uuid, smallint, text, text) to service_role;

-- ─────────────────────────────────────────
-- submit_review_reply — exactly one reply, by the reviewee only, within
-- 30 days of the review's publication.
-- ─────────────────────────────────────────
create or replace function public.submit_review_reply(
  p_actor_user_id uuid,
  p_review_id uuid,
  p_reply_text text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review record;
  v_reply_id uuid;
  v_new_version boolean := false;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_actor_user_id is null then raise exception 'not authenticated'; end if;
  if p_reply_text is null or length(trim(p_reply_text)) = 0 then raise exception 'reply text is required'; end if;

  perform public._assert_account_status_permits_transaction(p_actor_user_id, 'self');

  select * into v_review from public.reviews where id = p_review_id for update;
  if v_review.id is null then raise exception 'review not found'; end if;
  if p_actor_user_id <> v_review.reviewee_id then raise exception 'only the reviewed party may reply to this review'; end if;
  if v_review.published_at is null then raise exception 'this review is not yet public'; end if;
  if v_review.invalidated_at is not null then raise exception 'this review is no longer valid'; end if;
  if now() > v_review.published_at + interval '30 days' then raise exception 'the reply window for this review has expired'; end if;

  insert into public.review_replies (review_id, reviewee_id, reply_text, is_test)
  values (p_review_id, p_actor_user_id, p_reply_text, v_review.is_test)
  on conflict (review_id) do nothing
  returning id into v_reply_id;

  if v_reply_id is not null then
    v_new_version := true;
  else
    select id into v_reply_id from public.review_replies where review_id = p_review_id;
  end if;

  return jsonb_build_object('reply_id', v_reply_id, 'reviewer_id_to_notify', case when v_new_version then v_review.reviewer_id end);
end;
$$;
revoke all on function public.submit_review_reply(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.submit_review_reply(uuid, uuid, text, text) to service_role;

-- ─────────────────────────────────────────
-- report_review_content — reviewee reports the review about them,
-- original reviewer reports the reply beneath their review. Ownership
-- verified server-side, never trusted from the client.
-- ─────────────────────────────────────────
create or replace function public.report_review_content(
  p_actor_user_id uuid,
  p_target_type text,
  p_target_id uuid,
  p_reason text,
  p_description text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review record;
  v_reply record;
  v_report_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_actor_user_id is null then raise exception 'not authenticated'; end if;
  if p_target_type not in ('review', 'reply') then raise exception 'invalid report target'; end if;
  if p_reason not in ('harassment', 'scam_fraud', 'inappropriate_content', 'impersonation', 'spam', 'fabricated', 'other') then
    raise exception 'invalid report reason';
  end if;

  if p_target_type = 'review' then
    select * into v_review from public.reviews where id = p_target_id;
    if v_review.id is null then raise exception 'review not found'; end if;
    if p_actor_user_id <> v_review.reviewee_id then raise exception 'only the reviewed party may report this review'; end if;
  else
    select rr.*, r.reviewer_id as original_reviewer_id into v_reply from public.review_replies rr
      join public.reviews r on r.id = rr.review_id where rr.id = p_target_id;
    if v_reply.id is null then raise exception 'reply not found'; end if;
    if p_actor_user_id <> v_reply.original_reviewer_id then raise exception 'only the original reviewer may report this reply'; end if;
  end if;

  if p_idempotency_key is not null then
    if exists (select 1 from public.idempotency_keys where merchant_id = p_actor_user_id and operation = 'report_review_content' and idempotency_key = p_idempotency_key) then
      select (result->>'report_id')::uuid into v_report_id from public.idempotency_keys
        where merchant_id = p_actor_user_id and operation = 'report_review_content' and idempotency_key = p_idempotency_key;
      return jsonb_build_object('report_id', v_report_id);
    end if;
  end if;

  insert into public.review_reports (reporter_id, target_type, target_id, reason, description)
  values (p_actor_user_id, p_target_type, p_target_id, p_reason, p_description)
  returning id into v_report_id;

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'report_review_content', p_idempotency_key, md5(p_target_type || p_target_id::text), jsonb_build_object('report_id', v_report_id));
  end if;

  return jsonb_build_object('report_id', v_report_id);
end;
$$;
revoke all on function public.report_review_content(uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.report_review_content(uuid, text, uuid, text, text, text) to service_role;

-- ─────────────────────────────────────────
-- Admin moderation RPCs. Every action requires a reason, is attributed
-- to an admin actor, and is recorded append-only in
-- review_moderation_history. None of them can alter the rating value or
-- author text on the reviewer's behalf.
-- ─────────────────────────────────────────
create or replace function public.admin_hide_review_text(p_admin_id uuid, p_review_id uuid, p_reason text, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'a reason is required'; end if;
  update public.reviews set text_hidden_at = now(), text_hidden_by = p_admin_id, text_hidden_reason = p_reason
    where id = p_review_id and text_hidden_at is null;
  if found then
    insert into public.review_moderation_history (review_id, action, actor_admin_id, reason) values (p_review_id, 'text_hidden', p_admin_id, p_reason);
  end if;
  return jsonb_build_object('review_id', p_review_id, 'text_hidden', true);
end;
$$;
revoke all on function public.admin_hide_review_text(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_hide_review_text(uuid, uuid, text, text) to service_role;

create or replace function public.admin_unhide_review_text(p_admin_id uuid, p_review_id uuid, p_reason text, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'a reason is required'; end if;
  update public.reviews set text_hidden_at = null, text_hidden_by = null, text_hidden_reason = null
    where id = p_review_id and text_hidden_at is not null;
  if found then
    insert into public.review_moderation_history (review_id, action, actor_admin_id, reason) values (p_review_id, 'text_unhidden', p_admin_id, p_reason);
  end if;
  return jsonb_build_object('review_id', p_review_id, 'text_hidden', false);
end;
$$;
revoke all on function public.admin_unhide_review_text(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_unhide_review_text(uuid, uuid, text, text) to service_role;

create or replace function public.admin_invalidate_review(p_admin_id uuid, p_review_id uuid, p_reason text, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'a reason is required'; end if;
  update public.reviews set invalidated_at = now(), invalidated_by = p_admin_id, invalidated_reason = p_reason
    where id = p_review_id and invalidated_at is null;
  if found then
    insert into public.review_moderation_history (review_id, action, actor_admin_id, reason) values (p_review_id, 'invalidated', p_admin_id, p_reason);
  end if;
  return jsonb_build_object('review_id', p_review_id, 'invalidated', true);
end;
$$;
revoke all on function public.admin_invalidate_review(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_invalidate_review(uuid, uuid, text, text) to service_role;

create or replace function public.admin_hide_review_reply(p_admin_id uuid, p_reply_id uuid, p_reason text, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_review_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'a reason is required'; end if;
  update public.review_replies set hidden_at = now(), hidden_by = p_admin_id, hidden_reason = p_reason
    where id = p_reply_id and hidden_at is null
    returning review_id into v_review_id;
  if v_review_id is not null then
    insert into public.review_moderation_history (review_id, action, actor_admin_id, reason) values (v_review_id, 'reply_hidden', p_admin_id, p_reason);
  end if;
  return jsonb_build_object('reply_id', p_reply_id, 'hidden', true);
end;
$$;
revoke all on function public.admin_hide_review_reply(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_hide_review_reply(uuid, uuid, text, text) to service_role;

create or replace function public.admin_close_review_report(p_admin_id uuid, p_report_id uuid, p_status text, p_resolution_note text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_status not in ('reviewed', 'dismissed') then raise exception 'invalid report status'; end if;
  update public.review_reports set status = p_status, resolved_at = now(), resolved_by = p_admin_id, resolution_note = p_resolution_note
    where id = p_report_id and status = 'open';
  if found and p_status = 'dismissed' then
    insert into public.review_moderation_history (review_id, action, actor_admin_id, reason)
      select target_id, 'report_dismissed', p_admin_id, coalesce(p_resolution_note, 'dismissed') from public.review_reports where id = p_report_id and target_type = 'review';
  end if;
  return jsonb_build_object('report_id', p_report_id, 'status', p_status);
end;
$$;
revoke all on function public.admin_close_review_report(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_close_review_report(uuid, uuid, text, text, text) to service_role;

-- ─────────────────────────────────────────
-- process_review_deadlines — the narrow, bounded, idempotent processor
-- for eligibility discovery, day-10 reminders, and 14-day
-- expiry/early-reveal resolution. Called from a protected internal route
-- (see src/app/api/internal/reviews/process-deadlines/route.ts); the RPC
-- performs all DB state changes and returns exactly which notifications
-- the route must dispatch afterward (this RPC never sends email itself).
-- ─────────────────────────────────────────
create or replace function public.process_review_deadlines(p_limit int default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutover timestamptz := '2026-08-25T00:00:00+00'::timestamptz;
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
        select count(*) filter (where published_at is not null), max(id) filter (where published_at is null), max(reviewer_id) filter (where published_at is null)
          into v_published_count, v_lone_review_id, v_lone_reviewer_id
          from public.reviews where order_id = v_row.transaction_id;
      elsif v_row.domain = 'rent' then
        select count(*) filter (where published_at is not null), max(id) filter (where published_at is null), max(reviewer_id) filter (where published_at is null)
          into v_published_count, v_lone_review_id, v_lone_reviewer_id
          from public.reviews where booking_id = v_row.transaction_id;
      elsif v_row.domain = 'barter' then
        select count(*) filter (where published_at is not null), max(id) filter (where published_at is null), max(reviewer_id) filter (where published_at is null)
          into v_published_count, v_lone_review_id, v_lone_reviewer_id
          from public.reviews where barter_agreement_id = v_row.transaction_id;
      elsif v_row.domain = 'rent_to_buy' then
        select count(*) filter (where published_at is not null), max(id) filter (where published_at is null), max(reviewer_id) filter (where published_at is null)
          into v_published_count, v_lone_review_id, v_lone_reviewer_id
          from public.reviews where rent_to_buy_agreement_id = v_row.transaction_id;
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
$$;
revoke all on function public.process_review_deadlines(int) from public, anon, authenticated;
grant execute on function public.process_review_deadlines(int) to service_role;

create or replace function public._review_window_party_has_reviewed(p_domain text, p_transaction_id uuid, p_party_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_exists boolean;
begin
  if p_domain = 'buy' then
    select exists(select 1 from public.reviews where order_id = p_transaction_id and reviewer_id = p_party_id) into v_exists;
  elsif p_domain = 'rent' then
    select exists(select 1 from public.reviews where booking_id = p_transaction_id and reviewer_id = p_party_id) into v_exists;
  elsif p_domain = 'barter' then
    select exists(select 1 from public.reviews where barter_agreement_id = p_transaction_id and reviewer_id = p_party_id) into v_exists;
  elsif p_domain = 'rent_to_buy' then
    select exists(select 1 from public.reviews where rent_to_buy_agreement_id = p_transaction_id and reviewer_id = p_party_id) into v_exists;
  end if;
  return coalesce(v_exists, false);
end;
$$;
revoke all on function public._review_window_party_has_reviewed(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public._review_window_party_has_reviewed(text, uuid, uuid) to service_role;
