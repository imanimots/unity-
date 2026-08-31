-- P1 downgrade-authority correction: a listing's accepts_affiliates=true
-- is grandfathered configuration (intentionally preserved across a
-- Pro/Elite -> Starter downgrade, per docs/AFFILIATE_SYSTEM.md), but that
-- was live-reproduced this phase to ALSO let a Starter merchant's
-- grandfathered listing accept a brand-new attribution and produce a
-- brand-new commission after downgrade -- listing history and current
-- merchant entitlement had been conflated into one flag. This migration
-- adds the missing second condition ("merchant currently entitled to
-- participate") to every path that creates NEW affiliate economic
-- activity, reusing the exact same canonical authority
-- (_get_effective_merchant_plan_id + merchant_subscription_plans.
-- affiliate_enabled) enable_listing_affiliate and save_listing_draft
-- already use -- never a second, independent rule.
--
-- Untouched by design: existing attribution/commission ROWS (never
-- mutated here -- only the INSERT path for brand-new rows is gated),
-- first-valid-wins logic, self-referral rules, dispute-freeze behavior,
-- rate/formula calculation, duplicate prevention, and every commission
-- lifecycle RPC (hold/release/void/retry/adjust/mark-paid) that services
-- an already-created obligation.
--
-- All three parameter lists are byte-identical to their live signatures
-- (confirmed via pg_get_functiondef immediately before writing this) --
-- body-only changes, so a bare CREATE OR REPLACE is safe for all three
-- (no DROP/second-overload risk).

create or replace function public.open_affiliate_attribution(
  p_referred_user_id uuid,
  p_listing_id uuid,
  p_referral_code text,
  p_source text default 'cookie',
  p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- NEW: the listing's own accepts_affiliates flag is necessary but not
  -- sufficient -- a grandfathered listing from a now-downgraded merchant
  -- must not accept a brand-new attribution. Reuses the exact same
  -- entitlement authority enable_listing_affiliate already gates on.
  if not coalesce(
    (select p.affiliate_enabled from public.merchant_subscription_plans p
     where p.id = public._get_effective_merchant_plan_id(v_listing.merchant_id)),
    false
  ) then
    raise exception 'affiliate_requires_pro_or_elite: enabling affiliates requires an active Pro or Elite subscription';
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
$function$;

create or replace function public.qualify_sale_affiliate_commission(
  p_order_id uuid,
  p_payment_id uuid,
  p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  select id, listing_id, buyer_id, seller_id, total_amount, shipping_fee, status into v_order
  from public.orders where id = p_order_id;
  if v_order.id is null then
    raise exception 'order not found';
  end if;

  v_request_hash := md5(coalesce(p_order_id::text, '') || '|' || coalesce(p_payment_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_order.seller_id and operation = 'qualify_sale_affiliate_commission' and idempotency_key = p_idempotency_key;

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
      values (v_order.seller_id, 'qualify_sale_affiliate_commission', p_idempotency_key, v_request_hash, v_result)
      on conflict do nothing;
    end if;
    return v_result;
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

  -- NEW: a NEW commission event additionally requires the merchant's
  -- CURRENT effective plan to permit affiliates -- a grandfathered
  -- listing's flag alone is not enough once the merchant has downgraded.
  -- Pre-existing commission rows and their downstream lifecycle
  -- (hold/release/void/retry/adjust/mark-paid) are entirely untouched --
  -- this only gates the creation of a brand-new row below.
  if not coalesce(
    (select p.affiliate_enabled from public.merchant_subscription_plans p
     where p.id = public._get_effective_merchant_plan_id(v_order.seller_id)),
    false
  ) then
    v_result := jsonb_build_object('qualified', false, 'reason', 'merchant_not_currently_affiliate_entitled');
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
    values (v_order.seller_id, 'qualify_sale_affiliate_commission', p_idempotency_key, v_request_hash, v_result)
    on conflict do nothing;
  end if;

  return v_result;
end;
$function$;

create or replace function public.qualify_rental_payment_affiliate_commission(
  p_booking_id uuid,
  p_payment_id uuid,
  p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  select id, listing_id, renter_id, merchant_id into v_booking
  from public.bookings where id = p_booking_id;
  if v_booking.id is null then
    raise exception 'booking not found';
  end if;

  v_request_hash := md5(coalesce(p_booking_id::text, '') || '|' || coalesce(p_payment_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_booking.merchant_id and operation = 'qualify_rental_payment_affiliate_commission' and idempotency_key = p_idempotency_key;

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
    if p_idempotency_key is not null then
      insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
      values (v_booking.merchant_id, 'qualify_rental_payment_affiliate_commission', p_idempotency_key, v_request_hash, v_result)
      on conflict do nothing;
    end if;
    return v_result;
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

  -- NEW: same current-plan gate as the sale path -- a grandfathered
  -- listing does not entitle a downgraded merchant to a NEW commission.
  if not coalesce(
    (select p.affiliate_enabled from public.merchant_subscription_plans p
     where p.id = public._get_effective_merchant_plan_id(v_booking.merchant_id)),
    false
  ) then
    v_result := jsonb_build_object('qualified', false, 'reason', 'merchant_not_currently_affiliate_entitled');
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
    values (v_booking.merchant_id, 'qualify_rental_payment_affiliate_commission', p_idempotency_key, v_request_hash, v_result)
    on conflict do nothing;
  end if;

  return v_result;
end;
$function$;
