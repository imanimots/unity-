-- ============================================================
-- Step 11 Phase 7 -- affiliate RPCs
-- ============================================================
-- Every RPC: security definer, auth.role() <> 'service_role' hard-
-- blocked, idempotency via the existing idempotency_keys table, actor
-- role/id derived from parameters the CALLING ROUTE has already
-- verified (requireAdminForRoute / requireAuth) -- never a client-
-- claimed role trusted a second time inside the RPC, matching every
-- other domain's established convention.
--
-- Grandfathering (approved): "listing affiliate-enabled" is checked
-- against the LIVE listings.accepts_affiliates value at qualification
-- time, not a historical snapshot -- this is what makes disabling a
-- listing block "future payment qualification... from that point
-- forward" (the approved rule) actually take effect. Attribution can
-- only ever be created while accepts_affiliates is true (checked in
-- open_affiliate_attribution), so a commission already created before
-- a disable is never affected -- only a payment qualifying AFTER a
-- disable is blocked, exactly as approved.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ─────────────────────────────────────────
-- OPEN_AFFILIATE_ATTRIBUTION
-- ─────────────────────────────────────────
create or replace function public.open_affiliate_attribution(
  p_referred_user_id uuid,
  p_listing_id uuid,
  p_referral_code text,
  p_source text default 'cookie',
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_affiliate record;
  v_listing record;
  v_existing record;
  v_attribution_id uuid;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_referred_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_listing_id::text, '') || '|' || coalesce(p_referral_code, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_referred_user_id and operation = 'open_affiliate_attribution' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id into v_affiliate from public.profiles where affiliate_code = p_referral_code and is_affiliate = true;
  if v_affiliate.id is null then
    raise exception 'invalid or inactive affiliate code';
  end if;

  select id, merchant_id, status, listing_type, accepts_affiliates into v_listing
  from public.listings where id = p_listing_id;

  if v_listing.id is null or v_listing.status <> 'active' then
    raise exception 'listing not found or not active';
  end if;
  if not v_listing.accepts_affiliates then
    raise exception 'this listing does not accept affiliate referrals';
  end if;
  if v_listing.listing_type not in ('rental', 'sale', 'both') then
    raise exception 'this listing does not support a commissionable transaction type';
  end if;

  -- Fraud/eligibility hard blocks.
  if v_affiliate.id = p_referred_user_id then
    raise exception 'self-referral is not permitted';
  end if;
  if v_affiliate.id = v_listing.merchant_id then
    raise exception 'a merchant cannot be their own listing''s affiliate';
  end if;
  if p_referred_user_id = v_listing.merchant_id then
    raise exception 'a merchant cannot be referred as a customer for their own listing';
  end if;

  -- First valid referral wins -- a second attempt is a harmless no-op,
  -- not an error, and never overwrites the existing attribution.
  select id into v_existing from public.affiliate_attributions
  where referred_user_id = p_referred_user_id and listing_id = p_listing_id;

  if v_existing.id is not null then
    v_attribution_id := v_existing.id;
    v_result := jsonb_build_object('attribution_id', v_attribution_id, 'status', 'already_attributed');
  else
    insert into public.affiliate_attributions (
      affiliate_id, referred_user_id, listing_id, merchant_id, referral_code,
      attributed_at, expires_at, source, status
    ) values (
      v_affiliate.id, p_referred_user_id, p_listing_id, v_listing.merchant_id, p_referral_code,
      now(), now() + interval '30 days', coalesce(p_source, 'cookie'), 'active'
    )
    -- Race-safe: a concurrent request for the same customer+listing
    -- hits the unique constraint, not a duplicate row.
    on conflict (referred_user_id, listing_id) do nothing
    returning id into v_attribution_id;

    if v_attribution_id is null then
      select id into v_attribution_id from public.affiliate_attributions
      where referred_user_id = p_referred_user_id and listing_id = p_listing_id;
      v_result := jsonb_build_object('attribution_id', v_attribution_id, 'status', 'already_attributed');
    else
      v_result := jsonb_build_object('attribution_id', v_attribution_id, 'status', 'created');
    end if;
  end if;

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_referred_user_id, 'open_affiliate_attribution', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- QUALIFY_SALE_AFFILIATE_COMMISSION -- trusted internal, called from
-- chargeOrderPayment() right after the order payment reaches 'captured'.
-- ─────────────────────────────────────────
create or replace function public.qualify_sale_affiliate_commission(
  p_order_id uuid,
  p_payment_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_payment record;
  v_listing record;
  v_attribution record;
  v_commission_id uuid;
  v_eligible_base numeric(12,2);
  v_commission_amount numeric(12,2);
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  v_request_hash := md5(coalesce(p_order_id::text, '') || '|' || coalesce(p_payment_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_order_id and operation = 'qualify_sale_affiliate_commission' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  -- Idempotent by construction regardless of the check above --
  -- affiliate_commissions.payment_id is unique at the database level.
  select id, status into v_commission_id from public.affiliate_commissions where payment_id = p_payment_id;
  if v_commission_id is not null then
    v_result := jsonb_build_object('qualified', false, 'reason', 'already_qualified', 'commission_id', v_commission_id);
    if p_idempotency_key is not null then
      insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
      values (p_order_id, 'qualify_sale_affiliate_commission', p_idempotency_key, v_request_hash, v_result)
      on conflict do nothing;
    end if;
    return v_result;
  end if;

  select id, listing_id, buyer_id, seller_id, total_amount, shipping_fee, status into v_order
  from public.orders where id = p_order_id;
  if v_order.id is null then
    raise exception 'order not found';
  end if;

  select id, order_id, payment_type, status, amount, currency into v_payment
  from public.payments where id = p_payment_id and order_id = p_order_id;
  if v_payment.id is null or v_payment.payment_type <> 'order_payment' or v_payment.status <> 'captured' then
    v_result := jsonb_build_object('qualified', false, 'reason', 'payment_not_eligible');
    return v_result;
  end if;

  select id, accepts_affiliates, affiliate_commission_rate into v_listing
  from public.listings where id = v_order.listing_id;
  if v_listing.id is null or not v_listing.accepts_affiliates then
    v_result := jsonb_build_object('qualified', false, 'reason', 'listing_not_affiliate_enabled');
    return v_result;
  end if;

  select id, affiliate_id, status, consumed_at into v_attribution
  from public.affiliate_attributions
  where referred_user_id = v_order.buyer_id and listing_id = v_order.listing_id and status in ('active', 'consumed');
  if v_attribution.id is null then
    v_result := jsonb_build_object('qualified', false, 'reason', 'no_attribution');
    return v_result;
  end if;

  -- Unresolved dispute freezes qualification (does not void it).
  if exists (
    select 1 from public.disputes
    where order_id = p_order_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    v_result := jsonb_build_object('qualified', false, 'reason', 'unresolved_dispute');
    return v_result;
  end if;

  v_eligible_base := greatest(v_order.total_amount - coalesce(v_order.shipping_fee, 0), 0);
  v_commission_amount := round(v_eligible_base * v_listing.affiliate_commission_rate / 100, 2);

  insert into public.affiliate_commissions (
    attribution_id, transaction_type, order_id, payment_id, listing_id, merchant_id,
    affiliate_id, referred_user_id, eligible_base, commission_rate, commission_amount,
    currency, calculation_version, status
  ) values (
    v_attribution.id, 'sale', p_order_id, p_payment_id, v_order.listing_id, v_order.seller_id,
    v_attribution.affiliate_id, v_order.buyer_id, v_eligible_base, v_listing.affiliate_commission_rate, v_commission_amount,
    coalesce(v_payment.currency, 'ZAR'), 1, 'pending'
  )
  on conflict (payment_id) do nothing
  returning id into v_commission_id;

  if v_commission_id is null then
    select id into v_commission_id from public.affiliate_commissions where payment_id = p_payment_id;
    v_result := jsonb_build_object('qualified', false, 'reason', 'already_qualified', 'commission_id', v_commission_id);
    return v_result;
  end if;

  if v_attribution.consumed_at is null then
    update public.affiliate_attributions set consumed_at = now(), status = 'consumed' where id = v_attribution.id;
  end if;

  insert into public.affiliate_commission_history (
    commission_id, attribution_id, listing_id, payment_id, previous_status, new_status,
    actor_type, actor_id, reason, calculation_snapshot, idempotency_key
  ) values (
    v_commission_id, v_attribution.id, v_order.listing_id, p_payment_id, null, 'pending',
    'system', null, 'sale payment captured',
    jsonb_build_object('eligible_base', v_eligible_base, 'rate', v_listing.affiliate_commission_rate, 'amount', v_commission_amount),
    p_idempotency_key
  );

  v_result := jsonb_build_object('qualified', true, 'commission_id', v_commission_id, 'commission_amount', v_commission_amount);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_order_id, 'qualify_sale_affiliate_commission', p_idempotency_key, v_request_hash, v_result)
    on conflict do nothing;
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- QUALIFY_RENTAL_PAYMENT_AFFILIATE_COMMISSION -- trusted internal,
-- called from ensureRentalCharged() right after a rental_charge payment
-- reaches 'captured'. Event-based (keyed on payment_id, not booking_id)
-- so a future extension/recurring-payment feature needs zero further
-- affiliate-side changes -- today there is only ever one rental_charge
-- payment per booking, so this naturally produces exactly one commission.
-- ─────────────────────────────────────────
create or replace function public.qualify_rental_payment_affiliate_commission(
  p_booking_id uuid,
  p_payment_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking record;
  v_payment record;
  v_listing record;
  v_attribution record;
  v_commission_id uuid;
  v_eligible_base numeric(12,2);
  v_commission_amount numeric(12,2);
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  v_request_hash := md5(coalesce(p_booking_id::text, '') || '|' || coalesce(p_payment_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_booking_id and operation = 'qualify_rental_payment_affiliate_commission' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_commission_id from public.affiliate_commissions where payment_id = p_payment_id;
  if v_commission_id is not null then
    v_result := jsonb_build_object('qualified', false, 'reason', 'already_qualified', 'commission_id', v_commission_id);
    return v_result;
  end if;

  select id, listing_id, renter_id, merchant_id into v_booking
  from public.bookings where id = p_booking_id;
  if v_booking.id is null then
    raise exception 'booking not found';
  end if;

  -- payment_type = 'rental_charge' only -- a 'deposit' payment is never
  -- the payment being qualified, excluded structurally, not by a
  -- runtime amount check.
  select id, booking_id, payment_type, status, amount, currency into v_payment
  from public.payments where id = p_payment_id and booking_id = p_booking_id;
  if v_payment.id is null or v_payment.payment_type <> 'rental_charge' or v_payment.status not in ('captured', 'partially_captured') then
    v_result := jsonb_build_object('qualified', false, 'reason', 'payment_not_eligible');
    return v_result;
  end if;

  select id, accepts_affiliates, affiliate_commission_rate into v_listing
  from public.listings where id = v_booking.listing_id;
  if v_listing.id is null or not v_listing.accepts_affiliates then
    v_result := jsonb_build_object('qualified', false, 'reason', 'listing_not_affiliate_enabled');
    return v_result;
  end if;

  select id, affiliate_id, status, consumed_at into v_attribution
  from public.affiliate_attributions
  where referred_user_id = v_booking.renter_id and listing_id = v_booking.listing_id and status in ('active', 'consumed');
  if v_attribution.id is null then
    v_result := jsonb_build_object('qualified', false, 'reason', 'no_attribution');
    return v_result;
  end if;

  if exists (
    select 1 from public.disputes
    where booking_id = p_booking_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    v_result := jsonb_build_object('qualified', false, 'reason', 'unresolved_dispute');
    return v_result;
  end if;

  v_eligible_base := v_payment.amount;
  v_commission_amount := round(v_eligible_base * v_listing.affiliate_commission_rate / 100, 2);

  insert into public.affiliate_commissions (
    attribution_id, transaction_type, booking_id, payment_id, listing_id, merchant_id,
    affiliate_id, referred_user_id, eligible_base, commission_rate, commission_amount,
    currency, calculation_version, status
  ) values (
    v_attribution.id, 'rental', p_booking_id, p_payment_id, v_booking.listing_id, v_booking.merchant_id,
    v_attribution.affiliate_id, v_booking.renter_id, v_eligible_base, v_listing.affiliate_commission_rate, v_commission_amount,
    coalesce(v_payment.currency, 'ZAR'), 1, 'pending'
  )
  on conflict (payment_id) do nothing
  returning id into v_commission_id;

  if v_commission_id is null then
    select id into v_commission_id from public.affiliate_commissions where payment_id = p_payment_id;
    v_result := jsonb_build_object('qualified', false, 'reason', 'already_qualified', 'commission_id', v_commission_id);
    return v_result;
  end if;

  if v_attribution.consumed_at is null then
    update public.affiliate_attributions set consumed_at = now(), status = 'consumed' where id = v_attribution.id;
  end if;

  insert into public.affiliate_commission_history (
    commission_id, attribution_id, listing_id, payment_id, previous_status, new_status,
    actor_type, actor_id, reason, calculation_snapshot, idempotency_key
  ) values (
    v_commission_id, v_attribution.id, v_booking.listing_id, p_payment_id, null, 'pending',
    'system', null, 'rental payment captured',
    jsonb_build_object('eligible_base', v_eligible_base, 'rate', v_listing.affiliate_commission_rate, 'amount', v_commission_amount),
    p_idempotency_key
  );

  v_result := jsonb_build_object('qualified', true, 'commission_id', v_commission_id, 'commission_amount', v_commission_amount);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_booking_id, 'qualify_rental_payment_affiliate_commission', p_idempotency_key, v_request_hash, v_result)
    on conflict do nothing;
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- Shared internal helper: writes one history row and updates status.
-- Not exposed to any client -- called only by the RPCs below, all of
-- which are themselves service-role-only.
-- ─────────────────────────────────────────
create or replace function public._affiliate_commission_transition(
  p_commission_id uuid,
  p_new_status public.affiliate_commission_status,
  p_allowed_from public.affiliate_commission_status[],
  p_actor_type text,
  p_actor_id uuid,
  p_reason text default null,
  p_provider_reference text default null,
  p_idempotency_key text default null
)
returns public.affiliate_commissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_commission public.affiliate_commissions;
  v_previous_status public.affiliate_commission_status;
begin
  select * into v_commission from public.affiliate_commissions where id = p_commission_id for update;
  if v_commission.id is null then
    raise exception 'commission not found';
  end if;
  if not (v_commission.status = any(p_allowed_from)) then
    raise exception 'commission is in status % and cannot transition to % from here', v_commission.status, p_new_status;
  end if;
  v_previous_status := v_commission.status;

  update public.affiliate_commissions
  set status = p_new_status,
      hold_reason = case when p_new_status = 'held' then p_reason else hold_reason end,
      void_reason = case when p_new_status = 'voided' then p_reason else void_reason end,
      approved_at = case when p_new_status = 'approved' then now() else approved_at end
  where id = p_commission_id
  returning * into v_commission;

  insert into public.affiliate_commission_history (
    commission_id, attribution_id, listing_id, payment_id, previous_status, new_status,
    actor_type, actor_id, reason, provider_reference, idempotency_key
  ) values (
    v_commission.id, v_commission.attribution_id, v_commission.listing_id, v_commission.payment_id,
    v_previous_status::text, p_new_status::text,
    p_actor_type, p_actor_id, p_reason, p_provider_reference, p_idempotency_key
  );

  return v_commission;
end;
$$;

-- ─────────────────────────────────────────
-- PROGRESS_AFFILIATE_COMMISSION -- pending -> approved (clean) or held
-- (blocking issue found). Called once per commission by the internal
-- review-and-approve cron route, which selects the review-eligible batch.
-- ─────────────────────────────────────────
create or replace function public.progress_affiliate_commission(
  p_commission_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_commission record;
  v_blocked boolean;
  v_result public.affiliate_commissions;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_commission from public.affiliate_commissions where id = p_commission_id;
  if v_commission.id is null then
    raise exception 'commission not found';
  end if;
  if v_commission.status <> 'pending' then
    return jsonb_build_object('progressed', false, 'status', v_commission.status);
  end if;

  v_blocked := exists (
    select 1 from public.payments p where p.id = v_commission.payment_id and p.status in ('refunded', 'partially_refunded', 'chargeback')
  ) or (
    v_commission.order_id is not null and exists (
      select 1 from public.disputes where order_id = v_commission.order_id and status not in ('resolved', 'closed', 'cancelled')
    )
  ) or (
    v_commission.booking_id is not null and exists (
      select 1 from public.disputes where booking_id = v_commission.booking_id and status not in ('resolved', 'closed', 'cancelled')
    )
  );

  if v_blocked then
    v_result := public._affiliate_commission_transition(p_commission_id, 'held', array['pending']::public.affiliate_commission_status[], 'system', null, 'blocking refund or dispute detected', null, p_idempotency_key);
    return jsonb_build_object('progressed', true, 'status', 'held');
  end if;

  v_result := public._affiliate_commission_transition(p_commission_id, 'approved', array['pending']::public.affiliate_commission_status[], 'system', null, 'review period passed, no blocking exception', null, p_idempotency_key);
  return jsonb_build_object('progressed', true, 'status', 'approved');
end;
$$;

-- ─────────────────────────────────────────
-- QUEUE_AFFILIATE_PAYOUT -- approved -> payout_queued.
-- ─────────────────────────────────────────
create or replace function public.queue_affiliate_payout(
  p_commission_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.affiliate_commissions;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  v_result := public._affiliate_commission_transition(p_commission_id, 'payout_queued', array['approved']::public.affiliate_commission_status[], 'system', null, 'approved commission queued for payout', null, p_idempotency_key);
  return jsonb_build_object('commission_id', v_result.id, 'status', v_result.status);
end;
$$;

-- ─────────────────────────────────────────
-- MARK_AFFILIATE_COMMISSION_PROCESSING -- payout_queued -> processing.
-- ─────────────────────────────────────────
create or replace function public.mark_affiliate_commission_processing(
  p_commission_id uuid,
  p_provider text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.affiliate_commissions;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  update public.affiliate_commissions set payout_provider = p_provider, payout_requested_at = now()
  where id = p_commission_id and status = 'payout_queued';
  v_result := public._affiliate_commission_transition(p_commission_id, 'processing', array['payout_queued']::public.affiliate_commission_status[], 'system', null, 'payout provider request started', null, p_idempotency_key);
  return jsonb_build_object('commission_id', v_result.id, 'status', v_result.status);
end;
$$;

-- ─────────────────────────────────────────
-- RECORD_AFFILIATE_PAYOUT_RESULT -- processing -> paid/failed. "Paid"
-- means the provider confirmed success -- never set from anywhere else.
-- ─────────────────────────────────────────
create or replace function public.record_affiliate_payout_result(
  p_commission_id uuid,
  p_status text,
  p_provider_reference text default null,
  p_failure_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.affiliate_commissions;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_status not in ('paid', 'failed') then
    raise exception 'invalid payout result status: %', p_status;
  end if;

  if p_status = 'paid' then
    update public.affiliate_commissions set payout_provider_reference = p_provider_reference, payout_confirmed_at = now()
    where id = p_commission_id and status = 'processing';
  end if;

  v_result := public._affiliate_commission_transition(
    p_commission_id, p_status::public.affiliate_commission_status, array['processing']::public.affiliate_commission_status[],
    'system', null, coalesce(p_failure_reason, 'payout provider confirmed success'), p_provider_reference, p_idempotency_key
  );
  return jsonb_build_object('commission_id', v_result.id, 'status', v_result.status);
end;
$$;

-- ─────────────────────────────────────────
-- RETRY_AFFILIATE_PAYOUT -- admin-only: failed -> payout_queued, so the
-- next process-payouts sweep picks it up again. A distinct RPC from the
-- automatic queue_affiliate_payout() (system actor, approved-only) so
-- the two actor semantics never blur together.
-- ─────────────────────────────────────────
create or replace function public.retry_affiliate_payout(
  p_admin_id uuid,
  p_commission_id uuid,
  p_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.affiliate_commissions;
  v_request_hash text;
  v_idem record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to retry a payout';
  end if;

  v_request_hash := md5(coalesce(p_commission_id::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'retry_affiliate_payout' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  v_result := public._affiliate_commission_transition(
    p_commission_id, 'payout_queued', array['failed']::public.affiliate_commission_status[],
    'admin', p_admin_id, p_reason, null, p_idempotency_key
  );

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'retry_affiliate_payout', p_idempotency_key, v_request_hash, jsonb_build_object('commission_id', v_result.id, 'status', v_result.status));
  end if;

  return jsonb_build_object('commission_id', v_result.id, 'status', v_result.status);
end;
$$;

-- ─────────────────────────────────────────
-- HOLD_AFFILIATE_COMMISSION -- pending/approved/payout_queued -> held.
-- Reachable by the system (automatic, e.g. dispute detection) or an
-- admin (via an admin-gated route only -- this RPC trusts p_actor_id
-- once the route has already verified admin role, same convention as
-- every other admin RPC in this codebase).
-- ─────────────────────────────────────────
create or replace function public.hold_affiliate_commission(
  p_actor_type text,
  p_actor_id uuid,
  p_commission_id uuid,
  p_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.affiliate_commissions;
  v_request_hash text;
  v_idem record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('system', 'admin') then
    raise exception 'invalid actor type';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to hold a commission';
  end if;

  v_request_hash := md5(coalesce(p_commission_id::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null and p_actor_id is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_id and operation = 'hold_affiliate_commission' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  v_result := public._affiliate_commission_transition(
    p_commission_id, 'held', array['pending', 'approved', 'payout_queued']::public.affiliate_commission_status[],
    p_actor_type, p_actor_id, p_reason, null, p_idempotency_key
  );

  if p_idempotency_key is not null and p_actor_id is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_id, 'hold_affiliate_commission', p_idempotency_key, v_request_hash, jsonb_build_object('commission_id', v_result.id, 'status', v_result.status));
  end if;

  return jsonb_build_object('commission_id', v_result.id, 'status', v_result.status);
end;
$$;

-- ─────────────────────────────────────────
-- RELEASE_AFFILIATE_COMMISSION_HOLD -- held -> pending (re-enters the
-- normal automatic review flow; does not auto-approve).
-- ─────────────────────────────────────────
create or replace function public.release_affiliate_commission_hold(
  p_actor_type text,
  p_actor_id uuid,
  p_commission_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.affiliate_commissions;
  v_request_hash text;
  v_idem record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('system', 'admin') then
    raise exception 'invalid actor type';
  end if;

  v_request_hash := md5(coalesce(p_commission_id::text, ''));
  if p_idempotency_key is not null and p_actor_id is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_id and operation = 'release_affiliate_commission_hold' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  v_result := public._affiliate_commission_transition(
    p_commission_id, 'pending', array['held']::public.affiliate_commission_status[],
    p_actor_type, p_actor_id, 'hold released', null, p_idempotency_key
  );

  if p_idempotency_key is not null and p_actor_id is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_id, 'release_affiliate_commission_hold', p_idempotency_key, v_request_hash, jsonb_build_object('commission_id', v_result.id, 'status', v_result.status));
  end if;

  return jsonb_build_object('commission_id', v_result.id, 'status', v_result.status);
end;
$$;

-- ─────────────────────────────────────────
-- VOID_AFFILIATE_COMMISSION -- any non-terminal status -> voided. A
-- 'paid' commission cannot be voided (raises) -- that case needs a
-- reversal adjustment, never a rewrite of the paid row.
-- ─────────────────────────────────────────
create or replace function public.void_affiliate_commission(
  p_actor_type text,
  p_actor_id uuid,
  p_commission_id uuid,
  p_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.affiliate_commissions;
  v_request_hash text;
  v_idem record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('system', 'admin') then
    raise exception 'invalid actor type';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to void a commission';
  end if;

  v_request_hash := md5(coalesce(p_commission_id::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null and p_actor_id is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_id and operation = 'void_affiliate_commission' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  v_result := public._affiliate_commission_transition(
    p_commission_id, 'voided', array['pending', 'held', 'approved', 'payout_queued', 'failed']::public.affiliate_commission_status[],
    p_actor_type, p_actor_id, p_reason, null, p_idempotency_key
  );

  if p_idempotency_key is not null and p_actor_id is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_id, 'void_affiliate_commission', p_idempotency_key, v_request_hash, jsonb_build_object('commission_id', v_result.id, 'status', v_result.status));
  end if;

  return jsonb_build_object('commission_id', v_result.id, 'status', v_result.status);
end;
$$;

-- ─────────────────────────────────────────
-- CREATE_AFFILIATE_COMMISSION_ADJUSTMENT -- append-only correction,
-- never edits the original commission row's financial fields.
-- ─────────────────────────────────────────
create or replace function public.create_affiliate_commission_adjustment(
  p_admin_id uuid,
  p_commission_id uuid,
  p_amount numeric,
  p_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_commission record;
  v_adjustment_id uuid;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required for an adjustment';
  end if;

  select id, attribution_id, listing_id, payment_id, status into v_commission
  from public.affiliate_commissions where id = p_commission_id;
  if v_commission.id is null then
    raise exception 'commission not found';
  end if;

  v_request_hash := md5(coalesce(p_commission_id::text, '') || '|' || coalesce(p_amount::text, '') || '|' || coalesce(p_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'create_affiliate_commission_adjustment' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.affiliate_commission_adjustments (commission_id, amount, reason, created_by, idempotency_key)
  values (p_commission_id, p_amount, p_reason, p_admin_id, p_idempotency_key)
  returning id into v_adjustment_id;

  insert into public.affiliate_commission_history (
    commission_id, attribution_id, listing_id, payment_id, previous_status, new_status,
    actor_type, actor_id, reason, calculation_snapshot, idempotency_key
  ) values (
    p_commission_id, v_commission.attribution_id, v_commission.listing_id, v_commission.payment_id,
    v_commission.status::text, v_commission.status::text,
    'admin', p_admin_id, p_reason, jsonb_build_object('adjustment_id', v_adjustment_id, 'amount', p_amount), p_idempotency_key
  );

  v_result := jsonb_build_object('adjustment_id', v_adjustment_id, 'commission_id', p_commission_id, 'amount', p_amount);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'create_affiliate_commission_adjustment', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- MARK_AFFILIATE_COMMISSION_PAID_MANUALLY -- admin records a legitimate
-- manual payout (outside the automatic provider path).
-- ─────────────────────────────────────────
create or replace function public.mark_affiliate_commission_paid_manually(
  p_admin_id uuid,
  p_commission_id uuid,
  p_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.affiliate_commissions;
  v_request_hash text;
  v_idem record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to record a manual payout';
  end if;

  v_request_hash := md5(coalesce(p_commission_id::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'mark_affiliate_commission_paid_manually' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  update public.affiliate_commissions set payout_provider = 'manual', payout_confirmed_at = now()
  where id = p_commission_id and status in ('approved', 'payout_queued', 'processing', 'failed');

  v_result := public._affiliate_commission_transition(
    p_commission_id, 'paid', array['approved', 'payout_queued', 'processing', 'failed']::public.affiliate_commission_status[],
    'admin', p_admin_id, p_reason, null, p_idempotency_key
  );

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'mark_affiliate_commission_paid_manually', p_idempotency_key, v_request_hash, jsonb_build_object('commission_id', v_result.id, 'status', v_result.status));
  end if;

  return jsonb_build_object('commission_id', v_result.id, 'status', v_result.status);
end;
$$;

-- ─────────────────────────────────────────
-- ENABLE_LISTING_AFFILIATE / DISABLE_LISTING_AFFILIATE -- wraps the
-- existing accepts_affiliates toggle with the new audit columns.
-- Merchant-owner-only, or admin with a reason.
-- ─────────────────────────────────────────
create or replace function public.enable_listing_affiliate(
  p_actor_type text,
  p_actor_id uuid,
  p_listing_id uuid,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('merchant', 'admin') then
    raise exception 'invalid actor type';
  end if;
  if p_actor_type = 'admin' and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'a reason is required for an admin override';
  end if;

  select id, merchant_id into v_listing from public.listings where id = p_listing_id;
  if v_listing.id is null then
    raise exception 'listing not found';
  end if;
  if p_actor_type = 'merchant' and v_listing.merchant_id <> p_actor_id then
    raise exception 'you do not own this listing';
  end if;

  update public.listings
  set accepts_affiliates = true, affiliate_enabled_at = now(), affiliate_enabled_by = p_actor_id, affiliate_disabled_at = null
  where id = p_listing_id;

  return jsonb_build_object('listing_id', p_listing_id, 'accepts_affiliates', true);
end;
$$;

create or replace function public.disable_listing_affiliate(
  p_actor_type text,
  p_actor_id uuid,
  p_listing_id uuid,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('merchant', 'admin') then
    raise exception 'invalid actor type';
  end if;
  if p_actor_type = 'admin' and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'a reason is required for an admin override';
  end if;

  select id, merchant_id into v_listing from public.listings where id = p_listing_id;
  if v_listing.id is null then
    raise exception 'listing not found';
  end if;
  if p_actor_type = 'merchant' and v_listing.merchant_id <> p_actor_id then
    raise exception 'you do not own this listing';
  end if;

  -- Disabling never touches an existing commission row (grandfathering,
  -- approved) -- it only stops new attribution/qualification going
  -- forward, both of which check the live accepts_affiliates value.
  update public.listings
  set accepts_affiliates = false, affiliate_disabled_at = now()
  where id = p_listing_id;

  return jsonb_build_object('listing_id', p_listing_id, 'accepts_affiliates', false);
end;
$$;

-- ─────────────────────────────────────────
-- Grants -- service_role only, matching every RPC in this codebase.
-- ─────────────────────────────────────────
revoke all on function public.open_affiliate_attribution(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.open_affiliate_attribution(uuid, uuid, text, text, text) to service_role;

revoke all on function public.qualify_sale_affiliate_commission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.qualify_sale_affiliate_commission(uuid, uuid, text) to service_role;

revoke all on function public.qualify_rental_payment_affiliate_commission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.qualify_rental_payment_affiliate_commission(uuid, uuid, text) to service_role;

revoke all on function public._affiliate_commission_transition(uuid, public.affiliate_commission_status, public.affiliate_commission_status[], text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public._affiliate_commission_transition(uuid, public.affiliate_commission_status, public.affiliate_commission_status[], text, uuid, text, text, text) to service_role;

revoke all on function public.progress_affiliate_commission(uuid, text) from public, anon, authenticated;
grant execute on function public.progress_affiliate_commission(uuid, text) to service_role;

revoke all on function public.queue_affiliate_payout(uuid, text) from public, anon, authenticated;
grant execute on function public.queue_affiliate_payout(uuid, text) to service_role;

revoke all on function public.mark_affiliate_commission_processing(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_affiliate_commission_processing(uuid, text, text) to service_role;

revoke all on function public.record_affiliate_payout_result(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_affiliate_payout_result(uuid, text, text, text, text) to service_role;

revoke all on function public.retry_affiliate_payout(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.retry_affiliate_payout(uuid, uuid, text, text) to service_role;

revoke all on function public.hold_affiliate_commission(text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.hold_affiliate_commission(text, uuid, uuid, text, text) to service_role;

revoke all on function public.release_affiliate_commission_hold(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.release_affiliate_commission_hold(text, uuid, uuid, text) to service_role;

revoke all on function public.void_affiliate_commission(text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.void_affiliate_commission(text, uuid, uuid, text, text) to service_role;

revoke all on function public.create_affiliate_commission_adjustment(uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.create_affiliate_commission_adjustment(uuid, uuid, numeric, text, text) to service_role;

revoke all on function public.mark_affiliate_commission_paid_manually(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_affiliate_commission_paid_manually(uuid, uuid, text, text) to service_role;

revoke all on function public.enable_listing_affiliate(text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.enable_listing_affiliate(text, uuid, uuid, text, text) to service_role;

revoke all on function public.disable_listing_affiliate(text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.disable_listing_affiliate(text, uuid, uuid, text, text) to service_role;
