-- ============================================================
-- Rent-to-Buy V2 -- economic model RPCs.
-- ============================================================
-- Companion to 20260821183555_rtb_v2_schema.sql. Widens the existing
-- Phase 5 RTB RPC set (possession/ownership/default/return/commission)
-- to the full V2 model: possession != ownership; merchant-defined
-- possession trigger; deposit-funded-before-handover; real evidence-
-- backed handover/receipt confirmation; 100%-paid is a distinct event
-- from ownership finalization (mandatory completion/inspection window);
-- formal default is irreversible (cure retired); rental/use settlement
-- capped at held purchase escrow; RENTAL commission (never sale), based
-- on actual possession period; late-return deposit forfeiture; bilateral
-- amendments; mutual early termination.
--
-- All SECURITY DEFINER, service-role-only, matching the existing Phase 5
-- RTB RPC file's own conventions exactly.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ------------------------------------------------------------
-- POSSESSION ELIGIBILITY -- merchant-defined trigger (Rule 4) +
-- deposit-funded gate (Rule 12: full deposit must be funded BEFORE
-- handover). Called after every installment payment and after deposit
-- payment; a no-op once possession has moved past 'not_delivered'.
-- ------------------------------------------------------------
create or replace function public._rent_to_buy_check_possession_eligibility(p_agreement_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_paid_count int;
  v_paid_sum numeric(12,2);
  v_trigger_met boolean;
begin
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null or v_agreement.possession_status <> 'not_delivered' then
    return;
  end if;

  select count(*), coalesce(sum(principal_amount), 0) into v_paid_count, v_paid_sum
  from public.rent_to_buy_installments where agreement_id = p_agreement_id and status = 'paid';

  v_trigger_met := case v_agreement.possession_trigger_type
    when 'first_payment' then v_paid_count >= 1
    when 'installment_count' then v_paid_count >= coalesce(v_agreement.possession_trigger_value, 1)
    when 'percentage' then v_paid_sum >= round(v_agreement.total_purchase_price * coalesce(v_agreement.possession_trigger_value, 100) / 100, 2)
    when 'full_payment' then v_paid_sum >= v_agreement.total_purchase_price
    else false
  end;

  if v_trigger_met and (v_agreement.security_deposit_amount is null or v_agreement.deposit_funded_at is not null) then
    update public.rent_to_buy_agreements set possession_status = 'possession_eligible', possession_eligible_at = now() where id = p_agreement_id;
    perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'possession_eligible', 'not_delivered', 'possession_eligible');
  end if;
end;
$$;
revoke all on function public._rent_to_buy_check_possession_eligibility(uuid) from public, anon, authenticated;
grant execute on function public._rent_to_buy_check_possession_eligibility(uuid) to service_role;

-- ------------------------------------------------------------
-- DEFAULT ELIGIBILITY -- purely computed, never stored/cron-written
-- (Rule 17: "Unity must NOT automatically terminate the agreement
-- merely because a cron observes an overdue installment").
-- ------------------------------------------------------------
create or replace function public._rent_to_buy_default_eligibility(p_agreement public.rent_to_buy_agreements)
returns boolean
language sql stable
as $$
  select exists (
    select 1 from public.rent_to_buy_installments
    where agreement_id = p_agreement.id
      and status = 'scheduled'
      and (due_date::timestamptz + (p_agreement.grace_period_days || ' days')::interval) <= now()
  );
$$;

-- ------------------------------------------------------------
-- RENTAL/USE AMOUNT -- exact daily-equivalent proration of the
-- merchant-defined rate over the given period (never whole-unit
-- rounding, never derived from the listing's ordinary rental price).
-- Fractional days count as full days (rounds in the customer's favor
-- for the platform's own liability, never invents a punitive rule).
-- ------------------------------------------------------------
create or replace function public._rent_to_buy_rental_use_amount(
  p_agreement public.rent_to_buy_agreements,
  p_period_start timestamptz,
  p_period_end timestamptz
)
returns numeric
language plpgsql stable
as $$
declare
  v_days numeric;
  v_per_day numeric;
begin
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    return 0;
  end if;

  v_days := ceil(extract(epoch from (p_period_end - p_period_start)) / 86400.0);

  v_per_day := case p_agreement.rental_use_rate_unit
    when 'daily' then p_agreement.rental_use_rate_amount
    when 'weekly' then p_agreement.rental_use_rate_amount / 7
    else p_agreement.rental_use_rate_amount / 30
  end;

  return round(v_per_day * v_days, 2);
end;
$$;

-- ------------------------------------------------------------
-- ESCROW SETTLEMENT SPLIT -- releases whole funded escrow rows to the
-- merchant (oldest first) until the release budget is exhausted, then
-- refunds every remaining row in full to the customer. This is a
-- disclosed engineering simplification of Rule 27's recovery cap: a row
-- straddling the cap boundary is refunded in full rather than split,
-- so actual merchant recovery can land slightly under the calculated
-- cap but never over it -- the one direction Rule 27 requires ("never
-- create unsecured customer debt"). Bypasses the public release/refund
-- RPCs' own dispute/completion gates deliberately -- this helper is
-- only ever invoked from within an RTB settlement flow that has already
-- performed its own authoritative validation once, at the top.
-- ------------------------------------------------------------
create or replace function public._rent_to_buy_settle_escrow(
  p_agreement_id uuid,
  p_release_amount_to_merchant numeric,
  p_released_to uuid,
  p_actor_type text,
  p_actor_id uuid,
  p_reason text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_row public.escrow_transactions;
  v_remaining numeric := coalesce(p_release_amount_to_merchant, 0);
begin
  for v_row in
    select * from public.escrow_transactions
    where rent_to_buy_agreement_id = p_agreement_id and status = 'funded'
    order by created_at asc
    for update
  loop
    if v_remaining >= v_row.principal_amount then
      perform public._escrow_transaction_transition(
        v_row.id, 'released', array['funded']::escrow_status[],
        p_actor_type, p_actor_id, 'released', p_reason, null, p_released_to, null, null, null
      );
      v_remaining := v_remaining - v_row.principal_amount;
    else
      perform public._escrow_transaction_transition(
        v_row.id, 'refunded', array['funded']::escrow_status[],
        p_actor_type, p_actor_id, 'refunded', p_reason, null, null, v_row.principal_amount, null, null
      );
    end if;
  end loop;
end;
$$;
revoke all on function public._rent_to_buy_settle_escrow(uuid, numeric, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public._rent_to_buy_settle_escrow(uuid, numeric, uuid, text, uuid, text) to service_role;

-- ------------------------------------------------------------
-- SAVE LISTING TERMS -- widened with the new V2 merchant-defined fields
-- (possession trigger, rental/use rate, wear/damage standard, grace/
-- return windows). Genuine signature change (new params) -- DROP the
-- exact old signature first. New params default to the same values as
-- the schema's own column defaults for safety, but the route always
-- supplies them explicitly (zod requires them on every save).
-- ------------------------------------------------------------
drop function if exists public.save_rent_to_buy_listing_terms(uuid, uuid, boolean, text, numeric, numeric, public.rent_to_buy_frequency, int, numeric, boolean, jsonb, boolean, jsonb);

create or replace function public.save_rent_to_buy_listing_terms(
  p_merchant_id uuid,
  p_listing_id uuid,
  p_enabled boolean,
  p_currency text,
  p_total_purchase_price numeric,
  p_installment_amount numeric,
  p_payment_frequency public.rent_to_buy_frequency,
  p_installment_count int,
  p_security_deposit_amount numeric default null,
  p_early_payoff_allowed boolean default false,
  p_early_payoff_policy jsonb default null,
  p_default_cure_allowed boolean default false,
  p_cure_policy jsonb default null,
  p_possession_trigger_type public.rent_to_buy_possession_trigger_type default 'first_payment',
  p_possession_trigger_value numeric default null,
  p_rental_use_rate_amount numeric default 0,
  p_rental_use_rate_unit public.rent_to_buy_rate_unit default 'monthly',
  p_wear_damage_standard text default null,
  p_grace_period_days int default 7,
  p_return_window_days int default 14
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_listing record;
  v_existing record;
  v_terms_id uuid;
  v_version int;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_merchant_id is null then raise exception 'not authenticated'; end if;

  select id, merchant_id into v_listing from public.listings where id = p_listing_id;
  if v_listing.id is null then raise exception 'listing not found'; end if;
  if v_listing.merchant_id <> p_merchant_id then raise exception 'not the owner of this listing'; end if;

  if p_installment_amount <= 0 or p_total_purchase_price <= 0 then
    raise exception 'invalid terms: amounts must be positive';
  end if;
  if p_installment_count <= 0 then raise exception 'invalid terms: installment_count must be positive'; end if;
  if p_grace_period_days < 0 or p_return_window_days < 0 then
    raise exception 'invalid terms: grace_period_days and return_window_days must not be negative';
  end if;

  select * into v_existing from public.rent_to_buy_listing_terms where listing_id = p_listing_id;
  v_version := coalesce(v_existing.terms_version, 0) + 1;

  insert into public.rent_to_buy_listing_terms (
    listing_id, merchant_id, enabled, currency, total_purchase_price, installment_amount, payment_frequency,
    installment_count, security_deposit_amount, early_payoff_allowed, early_payoff_policy, default_cure_allowed, cure_policy, terms_version,
    possession_trigger_type, possession_trigger_value, rental_use_rate_amount, rental_use_rate_unit,
    wear_damage_standard, grace_period_days, return_window_days
  ) values (
    p_listing_id, p_merchant_id, p_enabled, coalesce(p_currency, 'ZAR'), p_total_purchase_price, p_installment_amount, p_payment_frequency,
    p_installment_count, p_security_deposit_amount, coalesce(p_early_payoff_allowed, false), p_early_payoff_policy, coalesce(p_default_cure_allowed, false), p_cure_policy, v_version,
    p_possession_trigger_type, p_possession_trigger_value, coalesce(p_rental_use_rate_amount, 0), p_rental_use_rate_unit,
    p_wear_damage_standard, coalesce(p_grace_period_days, 7), coalesce(p_return_window_days, 14)
  )
  on conflict (listing_id) do update set
    enabled = excluded.enabled, currency = excluded.currency, total_purchase_price = excluded.total_purchase_price,
    installment_amount = excluded.installment_amount, payment_frequency = excluded.payment_frequency,
    installment_count = excluded.installment_count, security_deposit_amount = excluded.security_deposit_amount,
    early_payoff_allowed = excluded.early_payoff_allowed, early_payoff_policy = excluded.early_payoff_policy,
    default_cure_allowed = excluded.default_cure_allowed, cure_policy = excluded.cure_policy, terms_version = excluded.terms_version,
    possession_trigger_type = excluded.possession_trigger_type, possession_trigger_value = excluded.possession_trigger_value,
    rental_use_rate_amount = excluded.rental_use_rate_amount, rental_use_rate_unit = excluded.rental_use_rate_unit,
    wear_damage_standard = excluded.wear_damage_standard, grace_period_days = excluded.grace_period_days, return_window_days = excluded.return_window_days
  returning id into v_terms_id;

  return jsonb_build_object('terms_id', v_terms_id, 'enabled', p_enabled, 'terms_version', v_version);
end;
$$;
revoke all on function public.save_rent_to_buy_listing_terms(uuid, uuid, boolean, text, numeric, numeric, public.rent_to_buy_frequency, int, numeric, boolean, jsonb, boolean, jsonb, public.rent_to_buy_possession_trigger_type, numeric, numeric, public.rent_to_buy_rate_unit, text, int, int) from public, anon, authenticated;
grant execute on function public.save_rent_to_buy_listing_terms(uuid, uuid, boolean, text, numeric, numeric, public.rent_to_buy_frequency, int, numeric, boolean, jsonb, boolean, jsonb, public.rent_to_buy_possession_trigger_type, numeric, numeric, public.rent_to_buy_rate_unit, text, int, int) to service_role;

-- ------------------------------------------------------------
-- CREATE REQUEST -- widened to snapshot the new merchant-defined V2
-- terms (possession trigger, rental/use rate, wear/damage standard,
-- grace/return windows) alongside the existing purchase-schedule
-- snapshot. Same signature -- v_terms now carries the new columns via
-- schema widening, no parameter change needed here.
-- ------------------------------------------------------------
create or replace function public.create_rent_to_buy_request(
  p_customer_id uuid,
  p_listing_id uuid,
  p_request_id uuid default null,
  p_offer_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_terms record;
  v_listing record;
  v_agreement_id uuid;
  v_seq int;
  v_running_total numeric(12,2);
  v_this_amount numeric(12,2);
  v_due date;
  v_interval interval;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_customer_id is null then raise exception 'not authenticated'; end if;

  select id, merchant_id, status, is_test into v_listing from public.listings where id = p_listing_id;
  if v_listing.id is null then raise exception 'listing not found'; end if;
  if v_listing.merchant_id = p_customer_id then raise exception 'cannot enter a rent-to-buy agreement on your own listing'; end if;
  if v_listing.status <> 'active' then raise exception 'listing is not currently active'; end if;

  select * into v_terms from public.rent_to_buy_listing_terms where listing_id = p_listing_id and enabled = true;
  if v_terms.id is null then raise exception 'this listing does not have rent-to-buy enabled'; end if;

  perform public._rent_to_buy_assert_parties_verified(v_listing.merchant_id, p_customer_id);

  v_request_hash := md5(coalesce(p_listing_id::text, '') || '|' || coalesce(p_customer_id::text, '') || '|' || coalesce(v_terms.terms_version::text, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem from public.idempotency_keys
    where merchant_id = p_customer_id and operation = 'create_rent_to_buy_request' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then raise exception 'idempotency key already used with a different request'; end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.rent_to_buy_agreements (
    listing_id, merchant_id, customer_id, request_id, offer_id, status, possession_status, ownership_status,
    currency, total_purchase_price, installment_amount, payment_frequency, installment_count,
    security_deposit_amount, early_payoff_allowed, early_payoff_policy, cure_allowed, cure_policy, terms_version,
    possession_trigger_type, possession_trigger_value, rental_use_rate_amount, rental_use_rate_unit,
    wear_damage_standard, grace_period_days, return_window_days,
    is_test
  ) values (
    p_listing_id, v_listing.merchant_id, p_customer_id, p_request_id, p_offer_id, 'pending_merchant_acceptance', 'not_delivered', 'merchant_owned',
    v_terms.currency, v_terms.total_purchase_price, v_terms.installment_amount, v_terms.payment_frequency, v_terms.installment_count,
    v_terms.security_deposit_amount, v_terms.early_payoff_allowed, v_terms.early_payoff_policy, v_terms.default_cure_allowed, v_terms.cure_policy, v_terms.terms_version,
    v_terms.possession_trigger_type, v_terms.possession_trigger_value, v_terms.rental_use_rate_amount, v_terms.rental_use_rate_unit,
    v_terms.wear_damage_standard, v_terms.grace_period_days, v_terms.return_window_days,
    coalesce(v_listing.is_test, false)
  ) returning id into v_agreement_id;

  v_interval := case v_terms.payment_frequency
    when 'weekly' then interval '7 days'
    when 'biweekly' then interval '14 days'
    else interval '1 month'
  end;

  v_due := current_date + v_interval;
  v_running_total := 0;
  for v_seq in 1..v_terms.installment_count loop
    if v_seq = v_terms.installment_count then
      v_this_amount := v_terms.total_purchase_price - v_running_total;
    else
      v_this_amount := round(v_terms.total_purchase_price / v_terms.installment_count, 2);
    end if;
    v_running_total := v_running_total + v_this_amount;

    insert into public.rent_to_buy_installments (agreement_id, sequence, due_date, principal_amount, status)
    values (v_agreement_id, v_seq, v_due, v_this_amount, 'scheduled');

    if v_seq = 1 then
      update public.rent_to_buy_agreements set first_due_date = v_due where id = v_agreement_id;
    end if;
    if v_seq = v_terms.installment_count then
      update public.rent_to_buy_agreements set final_due_date = v_due where id = v_agreement_id;
    end if;

    v_due := v_due + v_interval;
  end loop;

  perform public._rent_to_buy_history(v_agreement_id, 'customer', p_customer_id, 'requested', null, 'pending_merchant_acceptance');

  v_result := jsonb_build_object('agreement_id', v_agreement_id, 'status', 'pending_merchant_acceptance');
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_customer_id, 'create_rent_to_buy_request', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;
revoke all on function public.create_rent_to_buy_request(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_rent_to_buy_request(uuid, uuid, uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- ACCEPT REQUEST -- widened to snapshot the applicable RENTAL
-- commission rate + plan at acceptance (Rule 29 -- a later subscription
-- upgrade/downgrade never rewrites an already-accepted agreement).
-- ------------------------------------------------------------
create or replace function public.accept_rent_to_buy_request(
  p_merchant_id uuid, p_agreement_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_plan_id text;
  v_plan record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.merchant_id <> p_merchant_id then raise exception 'not the merchant of this agreement'; end if;
  if v_agreement.status <> 'pending_merchant_acceptance' then
    raise exception 'agreement is in status % and cannot be accepted from here', v_agreement.status;
  end if;

  perform public._rent_to_buy_assert_parties_verified(v_agreement.merchant_id, v_agreement.customer_id);

  v_plan_id := public._get_effective_merchant_plan_id(v_agreement.merchant_id);
  select id, rental_commission_bps, commercial_version into v_plan from public.merchant_subscription_plans where id = v_plan_id;
  if v_plan.id is null then
    raise exception 'merchant_subscription_plans is missing an entry for resolved plan id %', v_plan_id;
  end if;

  update public.rent_to_buy_agreements
  set status = 'awaiting_first_payment', accepted_at = now(),
      rental_commission_rate_bps = v_plan.rental_commission_bps,
      commission_merchant_plan_id = v_plan.id,
      commission_plan_commercial_version = v_plan.commercial_version
  where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'merchant', p_merchant_id, 'accepted', 'pending_merchant_acceptance', 'awaiting_first_payment');

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'awaiting_first_payment');
  return v_result;
end;
$$;
revoke all on function public.accept_rent_to_buy_request(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_rent_to_buy_request(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- MARK HANDED OVER -- merchant-only. Requires possession_eligible
-- (threshold + deposit already satisfied, Rule 4/12) and at least one
-- real pre-handover evidence upload (Rule 5 -- reuses the genuinely
-- real dispute_evidence-shaped rent_to_buy_evidence architecture, never
-- the fake booking media-upload stub).
-- ------------------------------------------------------------
create or replace function public.mark_rent_to_buy_handed_over(
  p_merchant_id uuid, p_agreement_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_has_pre_handover_evidence boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.merchant_id <> p_merchant_id then raise exception 'not the merchant of this agreement'; end if;
  if v_agreement.possession_status <> 'possession_eligible' then
    raise exception 'possession is in status % and is not eligible for handover', v_agreement.possession_status;
  end if;
  if v_agreement.handed_over_at is not null then
    return jsonb_build_object('agreement_id', p_agreement_id, 'handed_over', true, 'already_handed_over', true);
  end if;

  select exists (select 1 from public.rent_to_buy_evidence where agreement_id = p_agreement_id and evidence_type = 'pre_handover') into v_has_pre_handover_evidence;
  if not v_has_pre_handover_evidence then
    raise exception 'at least one pre-handover condition evidence upload is required before marking this agreement handed over';
  end if;

  update public.rent_to_buy_agreements set handed_over_at = now() where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'merchant', p_merchant_id, 'handed_over', null, null);

  return jsonb_build_object('agreement_id', p_agreement_id, 'handed_over', true, 'already_handed_over', false);
end;
$$;
revoke all on function public.mark_rent_to_buy_handed_over(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_rent_to_buy_handed_over(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- CONFIRM POSSESSION -- Rule 6: authoritative possession start must come
-- from actual confirmed receipt, never merely a payment/threshold
-- timestamp. Now customer-only (the party actually taking possession),
-- requires handed_over_at set and at least one real receipt/condition
-- evidence upload.
-- ------------------------------------------------------------
create or replace function public.confirm_rent_to_buy_possession(
  p_actor_user_id uuid, p_agreement_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_has_receipt_evidence boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.customer_id <> p_actor_user_id then raise exception 'only the customer can confirm receipt of possession'; end if;
  if v_agreement.possession_status <> 'possession_eligible' then
    raise exception 'possession is in status % and cannot be confirmed from here', v_agreement.possession_status;
  end if;
  if v_agreement.handed_over_at is null then
    raise exception 'the merchant has not yet marked this agreement as handed over';
  end if;

  select exists (select 1 from public.rent_to_buy_evidence where agreement_id = p_agreement_id and evidence_type = 'post_handover_receipt') into v_has_receipt_evidence;
  if not v_has_receipt_evidence then
    raise exception 'at least one receipt/condition evidence upload is required before confirming possession';
  end if;

  update public.rent_to_buy_agreements set possession_status = 'customer_in_possession', possession_confirmed_at = now() where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'customer', p_actor_user_id, 'possession_confirmed', 'possession_eligible', 'customer_in_possession');
  return jsonb_build_object('agreement_id', p_agreement_id, 'possession_status', 'customer_in_possession');
end;
$$;
revoke all on function public.confirm_rent_to_buy_possession(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_rent_to_buy_possession(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- RECORD INSTALMENT PAYMENT -- widened: no longer sets possession
-- eligibility directly (delegated to the merchant-trigger-aware helper)
-- and no longer transfers ownership inline on 100%-paid. 100%-paid now
-- only sets fully_paid_at + opens the mandatory completion/inspection
-- window (Rule 7/8 -- "FULLY PAID -- AWAITING HANDOVER" is a computed
-- UI label from fully_paid_at + ownership_status, never a stored
-- status). Actual ownership finalization is finalize_rent_to_buy_
-- ownership() below, requiring possession to have ALSO been genuinely
-- confirmed and the window to have elapsed.
-- ------------------------------------------------------------
create or replace function public.record_rent_to_buy_installment_payment(
  p_agreement_id uuid, p_sequence int, p_payment_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_installment record;
  v_paid_sum numeric(12,2);
  v_dispute_open boolean;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.status = 'disputed' then raise exception 'agreement is disputed and cannot accept a payment right now'; end if;
  if v_agreement.status = 'cancelled' then raise exception 'agreement is cancelled'; end if;

  select * into v_installment from public.rent_to_buy_installments where agreement_id = p_agreement_id and sequence = p_sequence for update;
  if v_installment.id is null then raise exception 'installment not found'; end if;
  if v_installment.status = 'paid' then
    return jsonb_build_object('agreement_id', p_agreement_id, 'installment_id', v_installment.id, 'status', 'paid', 'already_paid', true);
  end if;

  update public.rent_to_buy_installments set status = 'paid', payment_id = p_payment_id, paid_at = now() where id = v_installment.id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'installment_paid', 'scheduled', 'paid', jsonb_build_object('sequence', p_sequence, 'payment_id', p_payment_id));

  if p_sequence = 1 and v_agreement.status = 'awaiting_first_payment' then
    update public.rent_to_buy_agreements set status = 'active', first_payment_settled_at = now() where id = p_agreement_id;
    perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'first_payment_settled', 'awaiting_first_payment', 'active');
  end if;

  perform public._rent_to_buy_check_possession_eligibility(p_agreement_id);

  select coalesce(sum(principal_amount), 0) into v_paid_sum from public.rent_to_buy_installments where agreement_id = p_agreement_id and status = 'paid';
  select exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_agreement_id and status not in ('resolved', 'closed', 'cancelled')) into v_dispute_open;

  if v_paid_sum >= v_agreement.total_purchase_price and not v_dispute_open and v_agreement.status not in ('cancelled', 'defaulted') then
    update public.rent_to_buy_agreements
    set fully_paid_at = now(), completion_window_ends_at = now() + interval '72 hours'
    where id = p_agreement_id and fully_paid_at is null;
    if found then
      perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'fully_paid', null, null, jsonb_build_object('paid_sum', v_paid_sum, 'total_purchase_price', v_agreement.total_purchase_price));
    end if;
  end if;

  select jsonb_build_object('agreement_id', p_agreement_id, 'installment_id', v_installment.id, 'status', 'paid', 'already_paid', false) into v_result;
  return v_result;
end;
$$;
revoke all on function public.record_rent_to_buy_installment_payment(uuid, int, uuid, text) from public, anon, authenticated;
grant execute on function public.record_rent_to_buy_installment_payment(uuid, int, uuid, text) to service_role;

-- ------------------------------------------------------------
-- RECORD DEPOSIT PAYMENT -- widened to set deposit_funded_at (the
-- Rule 12 gate) and re-check possession eligibility (deposit may be the
-- LAST condition needed, if the threshold was already met earlier).
-- ------------------------------------------------------------
create or replace function public.record_rent_to_buy_deposit_payment(
  p_agreement_id uuid, p_payment_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.security_deposit_amount is null then raise exception 'this agreement has no security deposit configured'; end if;

  if v_agreement.deposit_funded_at is not null then
    return jsonb_build_object('agreement_id', p_agreement_id, 'deposit_paid', true, 'already_paid', true);
  end if;

  update public.rent_to_buy_agreements set deposit_funded_at = now() where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'deposit_paid', null, null, jsonb_build_object('payment_id', p_payment_id));

  perform public._rent_to_buy_check_possession_eligibility(p_agreement_id);

  return jsonb_build_object('agreement_id', p_agreement_id, 'deposit_paid', true, 'already_paid', false);
end;
$$;
revoke all on function public.record_rent_to_buy_deposit_payment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_rent_to_buy_deposit_payment(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- EARLY PAYOFF -- widened: no longer instantly transfers ownership
-- (Rule 9 -- "must not bypass handover evidence/possession/disputes/
-- final protection window/escrow authority"). Now behaves exactly like
-- reaching 100% paid on schedule: sets fully_paid_at + opens the
-- completion window; finalize_rent_to_buy_ownership() still requires
-- genuine confirmed possession and the window to elapse.
-- ------------------------------------------------------------
create or replace function public.payoff_rent_to_buy_agreement(
  p_actor_user_id uuid, p_agreement_id uuid, p_payment_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_remaining numeric(12,2);
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.customer_id <> p_actor_user_id then raise exception 'not the customer of this agreement'; end if;
  if not v_agreement.early_payoff_allowed then raise exception 'early payoff is not allowed under this agreement''s accepted terms'; end if;
  if v_agreement.status <> 'active' then raise exception 'agreement is in status % and is not eligible for payoff', v_agreement.status; end if;

  select coalesce(sum(principal_amount), 0) into v_remaining from public.rent_to_buy_installments where agreement_id = p_agreement_id and status = 'scheduled';
  if v_remaining <= 0 then raise exception 'there is no remaining balance to pay off'; end if;

  update public.rent_to_buy_installments set status = 'paid', payment_id = p_payment_id, paid_at = now()
  where agreement_id = p_agreement_id and status = 'scheduled';

  perform public._rent_to_buy_history(p_agreement_id, 'customer', p_actor_user_id, 'paid_off', null, null, jsonb_build_object('remaining_balance', v_remaining, 'payment_id', p_payment_id));

  perform public._rent_to_buy_check_possession_eligibility(p_agreement_id);

  update public.rent_to_buy_agreements
  set fully_paid_at = now(), completion_window_ends_at = now() + interval '72 hours'
  where id = p_agreement_id and fully_paid_at is null;
  if found then
    perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'fully_paid', null, null, jsonb_build_object('via', 'early_payoff'));
  end if;

  return jsonb_build_object('agreement_id', p_agreement_id, 'amount_paid', v_remaining, 'fully_paid', true);
end;
$$;
revoke all on function public.payoff_rent_to_buy_agreement(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.payoff_rent_to_buy_agreement(uuid, uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- FINALIZE OWNERSHIP -- system-only, the sole path that can ever set
-- ownership_status = 'customer_owned' (Rule 7/8). Requires ALL of:
-- fully_paid_at set, genuinely confirmed possession (Rule 6), the
-- completion/inspection window elapsed, and no unresolved dispute.
-- Idempotent via the row lock + early-return on already-customer_owned
-- (Rule 66 concurrency: two finalize calls, one payout). Called from a
-- scheduled internal route once the window elapses (mirrors
-- subscriptions' own already-approved apply-due cron pattern -- never a
-- default-like automatic termination, purely a "time window elapsed,
-- proceed with an already-earned outcome" trigger).
-- ------------------------------------------------------------
create or replace function public.finalize_rent_to_buy_ownership(
  p_agreement_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_dispute_open boolean;
  v_eligible_base numeric(12,2);
  v_calc record;
  v_commission_amount numeric(12,2) := 0;
  v_commission_id uuid;
  v_payout_amount numeric(12,2);
  v_payout_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;

  if v_agreement.ownership_status = 'customer_owned' then
    return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', true, 'already_finalized', true);
  end if;
  if v_agreement.fully_paid_at is null then
    return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', false, 'reason', 'not_fully_paid');
  end if;
  if v_agreement.status <> 'active' then
    return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', false, 'reason', 'agreement_not_active');
  end if;
  if v_agreement.possession_status <> 'customer_in_possession' then
    return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', false, 'reason', 'possession_not_confirmed');
  end if;
  if v_agreement.completion_window_ends_at is null or v_agreement.completion_window_ends_at > now() then
    return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', false, 'reason', 'completion_window_open');
  end if;

  select exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_agreement_id and status not in ('resolved', 'closed', 'cancelled')) into v_dispute_open;
  if v_dispute_open then
    return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', false, 'reason', 'unresolved_dispute');
  end if;

  update public.rent_to_buy_agreements
  set ownership_status = 'customer_owned', status = 'completed', ownership_transferred_at = now()
  where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'ownership_transferred', 'active', 'completed');

  -- Rule 30: commission base is the RENTAL/USE rate applied over the
  -- ACTUAL possession period, never the purchase price. Rule 29: RENTAL
  -- commission rate, snapshotted at acceptance -- never sale commission.
  v_eligible_base := public._rent_to_buy_rental_use_amount(v_agreement, v_agreement.possession_confirmed_at, now());

  if v_agreement.rental_commission_rate_bps is not null and v_agreement.commission_merchant_plan_id is not null then
    select * into v_calc from public._calculate_unity_commission('rental', v_eligible_base, v_agreement.rental_commission_rate_bps);
    v_commission_amount := v_calc.commission_amount;

    insert into public.unity_commissions (
      transaction_type, rent_to_buy_agreement_id, payment_id, listing_id, merchant_id,
      merchant_plan_id, plan_commercial_version, eligible_base,
      standard_rate_bps, standard_rate_base, excess_rate_bps, excess_base,
      commission_amount, currency, calculation_version, status
    ) values (
      'rent_to_buy', p_agreement_id, null, v_agreement.listing_id, v_agreement.merchant_id,
      v_agreement.commission_merchant_plan_id, v_agreement.commission_plan_commercial_version, v_eligible_base,
      v_agreement.rental_commission_rate_bps, v_calc.standard_rate_base, 0, 0,
      v_commission_amount, v_agreement.currency, 1, 'pending'
    )
    on conflict (rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null do nothing
    returning id into v_commission_id;

    if v_commission_id is not null then
      insert into public.unity_commission_history (commission_id, previous_status, new_status, actor_type, reason, calculation_snapshot)
      values (v_commission_id, null, 'pending', 'system', 'rent-to-buy ownership completed',
        jsonb_build_object('eligible_base', v_eligible_base, 'rate_bps', v_agreement.rental_commission_rate_bps, 'commission_amount', v_commission_amount));
    end if;
  end if;

  v_payout_amount := greatest(v_agreement.total_purchase_price - coalesce(v_commission_amount, 0), 0);

  perform public._rent_to_buy_settle_escrow(p_agreement_id, v_agreement.total_purchase_price, v_agreement.merchant_id, 'system', null, 'rent-to-buy completed: ownership transferred');

  if v_payout_amount > 0 then
    v_payout_result := public.create_merchant_payout(v_agreement.merchant_id, null, v_payout_amount, null, p_agreement_id);
  end if;

  if v_agreement.security_deposit_amount is not null and v_agreement.deposit_funded_at is not null
     and v_agreement.deposit_forfeited_at is null and v_agreement.deposit_refunded_at is null then
    update public.rent_to_buy_agreements set deposit_refunded_at = now() where id = p_agreement_id;
  end if;

  update public.rent_to_buy_agreements set settled_at = now() where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'settled_completed', 'completed', 'completed', jsonb_build_object('commission_amount', coalesce(v_commission_amount, 0), 'payout_amount', v_payout_amount));

  return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', true, 'commission_amount', coalesce(v_commission_amount, 0), 'payout_id', v_payout_result->>'payout_id');
end;
$$;
revoke all on function public.finalize_rent_to_buy_ownership(uuid, text) from public, anon, authenticated;
grant execute on function public.finalize_rent_to_buy_ownership(uuid, text) to service_role;

-- ------------------------------------------------------------
-- CURE -- retired. Formal default is now irreversible (Rule 18: "no
-- cure" once explicitly initiated). Same signature, no DROP needed --
-- always rejects with a clear, permanent error rather than leaving a
-- live capability that could violate the new invariant. "Catching up"
-- during the grace period is just paying -- status never left 'active'
-- for that case, so no RPC is needed for it at all.
-- ------------------------------------------------------------
create or replace function public.cure_rent_to_buy_default(
  p_actor_user_id uuid, p_agreement_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  raise exception 'formal_default_irreversible: a formally defaulted rent-to-buy agreement cannot be cured or reactivated -- this is a permanent, one-way outcome under the current commercial model';
end;
$$;
revoke all on function public.cure_rent_to_buy_default(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cure_rent_to_buy_default(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- SETTLE DEFAULT BEFORE POSSESSION -- Rule 25: item never received =>
-- R0 rental/use, no commission, full refund of held purchase funds,
-- ownership stays merchant's, no payout.
-- ------------------------------------------------------------
create or replace function public._rent_to_buy_settle_default_before_possession(p_agreement_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
begin
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.settled_at is not null then return; end if;

  perform public._rent_to_buy_settle_escrow(p_agreement_id, 0, null, 'system', null, 'rent-to-buy ended before possession: full refund, R0 rental/use');

  if v_agreement.security_deposit_amount is not null and v_agreement.deposit_funded_at is not null
     and v_agreement.deposit_forfeited_at is null and v_agreement.deposit_refunded_at is null then
    update public.rent_to_buy_agreements set deposit_refunded_at = now() where id = p_agreement_id;
  end if;

  update public.rent_to_buy_agreements set settled_at = now(), default_reconciliation_pending = false where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'settled_before_possession', null, null, jsonb_build_object('rental_use_amount', 0, 'commission_amount', 0));
end;
$$;
revoke all on function public._rent_to_buy_settle_default_before_possession(uuid) from public, anon, authenticated;
grant execute on function public._rent_to_buy_settle_default_before_possession(uuid) to service_role;

-- ------------------------------------------------------------
-- SETTLE DEFAULT/TERMINATION AFTER POSSESSION -- Rule 26-28, 37: rental/
-- use for the ACTUAL possession period (confirmed start -> actual
-- return), snapshotted rate, capped at held purchase escrow, RENTAL
-- commission on the recovered amount only, remainder refunded, late-
-- return deposit forfeiture handled independently (never feeds the
-- rental/use base or vice versa). Reused for both formal default and
-- mutual-termination-with-possession outcomes (both are "ended before
-- ownership, after possession" economically).
-- ------------------------------------------------------------
create or replace function public._rent_to_buy_settle_default_after_possession(p_agreement_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_rental_use_amount numeric(12,2);
  v_held_total numeric(12,2);
  v_recovered_amount numeric(12,2);
  v_calc record;
  v_commission_amount numeric(12,2) := 0;
  v_commission_id uuid;
  v_late boolean;
begin
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.settled_at is not null then return; end if;

  v_rental_use_amount := public._rent_to_buy_rental_use_amount(v_agreement, v_agreement.possession_confirmed_at, coalesce(v_agreement.actual_returned_at, now()));

  select coalesce(sum(principal_amount), 0) into v_held_total from public.rent_to_buy_installments where agreement_id = p_agreement_id and status = 'paid';

  v_recovered_amount := least(v_rental_use_amount, v_held_total);

  if v_recovered_amount > 0 and v_agreement.rental_commission_rate_bps is not null and v_agreement.commission_merchant_plan_id is not null then
    select * into v_calc from public._calculate_unity_commission('rental', v_recovered_amount, v_agreement.rental_commission_rate_bps);
    v_commission_amount := v_calc.commission_amount;

    insert into public.unity_commissions (
      transaction_type, rent_to_buy_agreement_id, payment_id, listing_id, merchant_id,
      merchant_plan_id, plan_commercial_version, eligible_base,
      standard_rate_bps, standard_rate_base, excess_rate_bps, excess_base,
      commission_amount, currency, calculation_version, status
    ) values (
      'rent_to_buy', p_agreement_id, null, v_agreement.listing_id, v_agreement.merchant_id,
      v_agreement.commission_merchant_plan_id, v_agreement.commission_plan_commercial_version, v_recovered_amount,
      v_agreement.rental_commission_rate_bps, v_calc.standard_rate_base, 0, 0,
      v_commission_amount, v_agreement.currency, 1, 'pending'
    )
    on conflict (rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null do nothing
    returning id into v_commission_id;

    if v_commission_id is not null then
      insert into public.unity_commission_history (commission_id, previous_status, new_status, actor_type, reason, calculation_snapshot)
      values (v_commission_id, null, 'pending', 'system', 'rent-to-buy default/termination settlement',
        jsonb_build_object('rental_use_amount', v_rental_use_amount, 'held_total', v_held_total, 'recovered_amount', v_recovered_amount, 'commission_amount', v_commission_amount));
    end if;
  end if;

  perform public._rent_to_buy_settle_escrow(p_agreement_id, v_recovered_amount, v_agreement.merchant_id, 'system', null, 'rent-to-buy default/termination settlement: capped rental/use recovery');

  if v_recovered_amount - coalesce(v_commission_amount, 0) > 0 then
    perform public.create_merchant_payout(v_agreement.merchant_id, null, v_recovered_amount - v_commission_amount, null, p_agreement_id);
  end if;

  -- Rule 24: late-return forfeiture is triggered specifically by missing
  -- the agreed return deadline -- never by default/termination alone.
  v_late := v_agreement.return_deadline_at is not null and coalesce(v_agreement.actual_returned_at, now()) > v_agreement.return_deadline_at;

  if v_agreement.security_deposit_amount is not null and v_agreement.deposit_funded_at is not null
     and v_agreement.deposit_forfeited_at is null and v_agreement.deposit_refunded_at is null then
    if v_late then
      update public.rent_to_buy_agreements set deposit_forfeited_at = now(), deposit_forfeiture_reason = 'late return: the item was not returned by the agreed return deadline' where id = p_agreement_id;
      perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'deposit_forfeited', null, null, jsonb_build_object('reason', 'late_return'));
    else
      update public.rent_to_buy_agreements set deposit_refunded_at = now() where id = p_agreement_id;
    end if;
  end if;

  update public.rent_to_buy_agreements set settled_at = now(), default_reconciliation_pending = false where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'settled_after_possession', null, null,
    jsonb_build_object('rental_use_amount', v_rental_use_amount, 'recovered_amount', v_recovered_amount, 'commission_amount', v_commission_amount, 'late_return', v_late));
end;
$$;
revoke all on function public._rent_to_buy_settle_default_after_possession(uuid) from public, anon, authenticated;
grant execute on function public._rent_to_buy_settle_default_after_possession(uuid) to service_role;

-- ------------------------------------------------------------
-- INITIATE DEFAULT -- merchant-facing, FORMAL, irreversible (Rule 17/18).
-- Requires the live-computed grace-period eligibility check to actually
-- be true right now -- never merchant discretion alone. If the item was
-- never received, settlement (R0 rental, full refund) runs immediately;
-- otherwise settlement is deferred until actual return/recovery
-- confirmation (Rule 26/37 -- "only after outcome is final enough").
-- ------------------------------------------------------------
create or replace function public.initiate_rent_to_buy_default(
  p_merchant_id uuid, p_agreement_id uuid, p_reason text, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_new_possession public.rent_to_buy_possession_status;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'a reason is required'; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.merchant_id <> p_merchant_id then raise exception 'not the merchant of this agreement'; end if;
  if v_agreement.status <> 'active' then raise exception 'agreement is in status % and cannot be defaulted from here', v_agreement.status; end if;
  if v_agreement.ownership_status = 'customer_owned' then raise exception 'ownership has already transferred -- this agreement cannot default'; end if;
  if not public._rent_to_buy_default_eligibility(v_agreement) then
    raise exception 'default_not_eligible: no installment is currently past its grace period';
  end if;

  v_request_hash := md5(coalesce(p_agreement_id::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'initiate_rent_to_buy_default' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then raise exception 'idempotency key already used with a different request'; end if;
      return v_idem.result;
    end if;
  end if;

  v_new_possession := case when v_agreement.possession_status = 'customer_in_possession' then 'return_required'::public.rent_to_buy_possession_status else v_agreement.possession_status end;

  update public.rent_to_buy_agreements
  set status = 'defaulted', possession_status = v_new_possession, default_at = now(), default_reason = p_reason, default_reconciliation_pending = true,
      return_deadline_at = case when v_new_possession = 'return_required' then now() + (v_agreement.return_window_days || ' days')::interval else return_deadline_at end
  where id = p_agreement_id;

  perform public._rent_to_buy_history(p_agreement_id, 'merchant', p_merchant_id, 'formal_default_initiated', 'active', 'defaulted', jsonb_build_object('reason', p_reason));

  if v_new_possession <> 'return_required' then
    perform public._rent_to_buy_settle_default_before_possession(p_agreement_id);
  end if;

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'defaulted', 'possession_status', v_new_possession);
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'initiate_rent_to_buy_default', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;
revoke all on function public.initiate_rent_to_buy_default(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.initiate_rent_to_buy_default(uuid, uuid, text, text) to service_role;

-- ------------------------------------------------------------
-- MARK DEFAULTED (ADMIN) -- widened with the same settlement wiring as
-- the merchant-facing path above; admin discretion remains exempt from
-- the live grace-period eligibility check (unchanged from Phase 5).
-- ------------------------------------------------------------
create or replace function public.mark_rent_to_buy_agreement_defaulted(
  p_admin_id uuid, p_agreement_id uuid, p_reason text, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_new_possession public.rent_to_buy_possession_status;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'a reason is required'; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.status <> 'active' then raise exception 'agreement is in status % and cannot be marked defaulted from here', v_agreement.status; end if;
  if v_agreement.ownership_status = 'customer_owned' then raise exception 'ownership has already transferred -- this agreement cannot default'; end if;

  v_new_possession := case when v_agreement.possession_status = 'customer_in_possession' then 'return_required'::public.rent_to_buy_possession_status else v_agreement.possession_status end;

  update public.rent_to_buy_agreements
  set status = 'defaulted', possession_status = v_new_possession, default_at = now(), default_reason = p_reason, default_reconciliation_pending = true,
      return_deadline_at = case when v_new_possession = 'return_required' then now() + (v_agreement.return_window_days || ' days')::interval else return_deadline_at end
  where id = p_agreement_id;

  perform public._rent_to_buy_history(p_agreement_id, 'admin', p_admin_id, 'defaulted', 'active', 'defaulted', jsonb_build_object('reason', p_reason));

  if v_new_possession <> 'return_required' then
    perform public._rent_to_buy_settle_default_before_possession(p_agreement_id);
  end if;

  return jsonb_build_object('agreement_id', p_agreement_id, 'status', 'defaulted', 'possession_status', v_new_possession, 'default_reconciliation_pending', v_new_possession = 'return_required');
end;
$$;
revoke all on function public.mark_rent_to_buy_agreement_defaulted(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_rent_to_buy_agreement_defaulted(uuid, uuid, text, text) to service_role;

-- ------------------------------------------------------------
-- CONFIRM RETURN COMPLETED / RECOVERED -- widened to stamp
-- actual_returned_at (Rule 22-23: the authoritative rental/use period
-- ends at ACTUAL confirmed return, never the agreed deadline) and run
-- the after-possession settlement once the underlying agreement is in a
-- terminal-pending-settlement state (defaulted, or cancelled via mutual
-- termination with possession).
-- ------------------------------------------------------------
create or replace function public.confirm_rent_to_buy_return_completed(
  p_admin_id uuid, p_case_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_case record;
  v_agreement record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_case from public.rent_to_buy_return_cases where id = p_case_id for update;
  if v_case.id is null then raise exception 'return case not found'; end if;
  if v_case.status not in ('requested', 'scheduled') then raise exception 'return case is in status % and cannot be confirmed returned from here', v_case.status; end if;

  update public.rent_to_buy_return_cases set status = 'returned', resolved_at = now() where id = p_case_id;

  select * into v_agreement from public.rent_to_buy_agreements where id = v_case.agreement_id for update;
  update public.rent_to_buy_agreements
  set possession_status = 'returned_to_merchant', actual_returned_at = coalesce(actual_returned_at, now())
  where id = v_case.agreement_id;

  perform public._rent_to_buy_history(v_case.agreement_id, 'admin', p_admin_id, 'return_confirmed', v_agreement.possession_status::text, 'returned_to_merchant', jsonb_build_object('case_id', p_case_id));

  if v_agreement.status in ('defaulted', 'cancelled') then
    perform public._rent_to_buy_settle_default_after_possession(v_case.agreement_id);
  end if;

  return jsonb_build_object('case_id', p_case_id, 'agreement_id', v_case.agreement_id, 'possession_status', 'returned_to_merchant');
end;
$$;
revoke all on function public.confirm_rent_to_buy_return_completed(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_rent_to_buy_return_completed(uuid, uuid, text) to service_role;

create or replace function public.confirm_rent_to_buy_recovered(
  p_admin_id uuid, p_case_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_case record;
  v_agreement record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_case from public.rent_to_buy_return_cases where id = p_case_id for update;
  if v_case.id is null then raise exception 'return case not found'; end if;
  if v_case.case_type <> 'recovery' then raise exception 'this case is not a recovery case'; end if;
  if v_case.status <> 'recovery_pending' then raise exception 'recovery case is in status % and cannot be marked recovered from here', v_case.status; end if;

  update public.rent_to_buy_return_cases set status = 'recovered', resolved_at = now() where id = p_case_id;

  select * into v_agreement from public.rent_to_buy_agreements where id = v_case.agreement_id for update;
  update public.rent_to_buy_agreements
  set possession_status = 'recovered', actual_returned_at = coalesce(actual_returned_at, now())
  where id = v_case.agreement_id;

  perform public._rent_to_buy_history(v_case.agreement_id, 'admin', p_admin_id, 'recovery_confirmed', v_agreement.possession_status::text, 'recovered', jsonb_build_object('case_id', p_case_id));

  if v_agreement.status in ('defaulted', 'cancelled') then
    perform public._rent_to_buy_settle_default_after_possession(v_case.agreement_id);
  end if;

  return jsonb_build_object('case_id', p_case_id, 'agreement_id', v_case.agreement_id, 'possession_status', 'recovered');
end;
$$;
revoke all on function public.confirm_rent_to_buy_recovered(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_rent_to_buy_recovered(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- MUTUAL EARLY TERMINATION -- Rule 19-20: no unilateral at-will
-- termination; requires explicit both-party agreement. Tracked via
-- rent_to_buy_history (no new table) -- the most recent qualifying event
-- for an agreement is the authoritative pending-proposal state.
-- ------------------------------------------------------------
create or replace function public.propose_rent_to_buy_mutual_termination(
  p_actor_user_id uuid, p_agreement_id uuid, p_reason text default null, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.merchant_id <> p_actor_user_id and v_agreement.customer_id <> p_actor_user_id then raise exception 'not a party to this agreement'; end if;
  if v_agreement.status <> 'active' then raise exception 'agreement is in status % and cannot propose termination from here', v_agreement.status; end if;

  perform public._rent_to_buy_history(p_agreement_id, case when p_actor_user_id = v_agreement.merchant_id then 'merchant' else 'customer' end, p_actor_user_id, 'mutual_termination_proposed', null, null, jsonb_build_object('reason', p_reason));

  return jsonb_build_object('agreement_id', p_agreement_id, 'proposed', true);
end;
$$;
revoke all on function public.propose_rent_to_buy_mutual_termination(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.propose_rent_to_buy_mutual_termination(uuid, uuid, text, text) to service_role;

create or replace function public.accept_rent_to_buy_mutual_termination(
  p_actor_user_id uuid, p_agreement_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_last_event record;
  v_new_possession public.rent_to_buy_possession_status;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.merchant_id <> p_actor_user_id and v_agreement.customer_id <> p_actor_user_id then raise exception 'not a party to this agreement'; end if;
  if v_agreement.status <> 'active' then raise exception 'agreement is in status % and cannot terminate from here', v_agreement.status; end if;

  select * into v_last_event from public.rent_to_buy_history
  where agreement_id = p_agreement_id and event_type in ('mutual_termination_proposed', 'mutual_termination_accepted', 'mutual_termination_withdrawn')
  order by created_at desc limit 1;

  if v_last_event.id is null or v_last_event.event_type <> 'mutual_termination_proposed' then
    raise exception 'there is no pending mutual termination proposal to accept';
  end if;
  if v_last_event.actor_id = p_actor_user_id then
    raise exception 'the proposing party cannot also accept their own termination proposal';
  end if;

  v_new_possession := case when v_agreement.possession_status = 'customer_in_possession' then 'return_required'::public.rent_to_buy_possession_status else v_agreement.possession_status end;

  update public.rent_to_buy_agreements
  set status = 'cancelled', possession_status = v_new_possession, cancelled_at = now(), cancelled_reason = 'mutual early termination',
      return_deadline_at = case when v_new_possession = 'return_required' then now() + (v_agreement.return_window_days || ' days')::interval else return_deadline_at end
  where id = p_agreement_id;

  perform public._rent_to_buy_history(p_agreement_id, case when p_actor_user_id = v_agreement.merchant_id then 'merchant' else 'customer' end, p_actor_user_id, 'mutual_termination_accepted', 'active', 'cancelled');

  if v_new_possession <> 'return_required' then
    -- Never received the item -- no rental/use charge applies (Rule 20).
    perform public._rent_to_buy_settle_default_before_possession(p_agreement_id);
  end if;

  return jsonb_build_object('agreement_id', p_agreement_id, 'status', 'cancelled', 'possession_status', v_new_possession);
end;
$$;
revoke all on function public.accept_rent_to_buy_mutual_termination(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_rent_to_buy_mutual_termination(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- BILATERAL AMENDMENTS -- Rule 21: merchant proposes, customer must
-- explicitly accept (or vice versa) -- amendable fields are strictly
-- limited to forward-looking schedule fields (still-'scheduled'
-- installments, grace_period_days, return_window_days).
-- total_purchase_price is never amendable -- the safest reading of
-- "merchant cannot unilaterally increase the agreed purchase price" is
-- immutability via amendment, full stop.
-- ------------------------------------------------------------
create or replace function public.propose_rent_to_buy_amendment(
  p_actor_user_id uuid, p_agreement_id uuid, p_proposed_changes jsonb, p_reason text default null, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_snapshot jsonb;
  v_amendment_id uuid;
  v_allowed_keys text[] := array['grace_period_days', 'return_window_days', 'installments'];
  v_key text;
  v_paid_sum numeric(12,2);
  v_new_sum numeric(12,2);
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.merchant_id <> p_actor_user_id and v_agreement.customer_id <> p_actor_user_id then raise exception 'not a party to this agreement'; end if;
  if v_agreement.status <> 'active' then raise exception 'agreement is in status % and cannot be amended from here', v_agreement.status; end if;

  for v_key in select jsonb_object_keys(p_proposed_changes) loop
    if not (v_key = any(v_allowed_keys)) then
      raise exception 'field % is not amendable -- total_purchase_price and other core economics can never be changed via amendment', v_key;
    end if;
  end loop;

  if p_proposed_changes ? 'installments' then
    select coalesce(sum(principal_amount), 0) into v_paid_sum from public.rent_to_buy_installments where agreement_id = p_agreement_id and status = 'paid';
    select coalesce(sum((elem->>'principal_amount')::numeric), 0) into v_new_sum from jsonb_array_elements(p_proposed_changes->'installments') elem;
    if round(v_paid_sum + v_new_sum, 2) <> v_agreement.total_purchase_price then
      raise exception 'amended schedule must reconcile exactly to the agreement''s unchanged total purchase price';
    end if;
  end if;

  v_snapshot := jsonb_build_object(
    'grace_period_days', v_agreement.grace_period_days,
    'return_window_days', v_agreement.return_window_days,
    'installments', (select coalesce(jsonb_agg(jsonb_build_object('sequence', sequence, 'due_date', due_date, 'principal_amount', principal_amount) order by sequence), '[]'::jsonb)
      from public.rent_to_buy_installments where agreement_id = p_agreement_id and status = 'scheduled')
  );

  insert into public.rent_to_buy_amendments (agreement_id, status, proposed_by, proposed_changes, previous_snapshot, reason)
  values (p_agreement_id, 'proposed', p_actor_user_id, p_proposed_changes, v_snapshot, p_reason)
  returning id into v_amendment_id;

  perform public._rent_to_buy_history(p_agreement_id, case when p_actor_user_id = v_agreement.merchant_id then 'merchant' else 'customer' end, p_actor_user_id, 'amendment_proposed', null, null, jsonb_build_object('amendment_id', v_amendment_id));

  return jsonb_build_object('amendment_id', v_amendment_id, 'status', 'proposed');
end;
$$;
revoke all on function public.propose_rent_to_buy_amendment(uuid, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.propose_rent_to_buy_amendment(uuid, uuid, jsonb, text, text) to service_role;

create or replace function public.respond_rent_to_buy_amendment(
  p_actor_user_id uuid, p_amendment_id uuid, p_accept boolean, p_decline_reason text default null, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_amendment record;
  v_agreement record;
  v_elem jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_amendment from public.rent_to_buy_amendments where id = p_amendment_id for update;
  if v_amendment.id is null then raise exception 'amendment not found'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = v_amendment.agreement_id for update;
  if v_agreement.merchant_id <> p_actor_user_id and v_agreement.customer_id <> p_actor_user_id then raise exception 'not a party to this agreement'; end if;
  if v_amendment.proposed_by = p_actor_user_id then raise exception 'the proposing party cannot also respond to their own amendment'; end if;
  if v_amendment.status <> 'proposed' then raise exception 'amendment is in status % and cannot be responded to from here', v_amendment.status; end if;

  if not p_accept then
    update public.rent_to_buy_amendments set status = 'withdrawn', responded_at = now(), responded_by = p_actor_user_id, decline_reason = p_decline_reason where id = p_amendment_id;
    perform public._rent_to_buy_history(v_agreement.id, case when p_actor_user_id = v_agreement.merchant_id then 'merchant' else 'customer' end, p_actor_user_id, 'amendment_declined', null, null, jsonb_build_object('amendment_id', p_amendment_id));
    return jsonb_build_object('amendment_id', p_amendment_id, 'status', 'withdrawn');
  end if;

  if v_amendment.proposed_changes ? 'grace_period_days' then
    update public.rent_to_buy_agreements set grace_period_days = (v_amendment.proposed_changes->>'grace_period_days')::int where id = v_agreement.id;
  end if;
  if v_amendment.proposed_changes ? 'return_window_days' then
    update public.rent_to_buy_agreements set return_window_days = (v_amendment.proposed_changes->>'return_window_days')::int where id = v_agreement.id;
  end if;
  if v_amendment.proposed_changes ? 'installments' then
    delete from public.rent_to_buy_installments where agreement_id = v_agreement.id and status = 'scheduled';
    for v_elem in select * from jsonb_array_elements(v_amendment.proposed_changes->'installments') loop
      insert into public.rent_to_buy_installments (agreement_id, sequence, due_date, principal_amount, status)
      values (v_agreement.id, (v_elem->>'sequence')::int, (v_elem->>'due_date')::date, (v_elem->>'principal_amount')::numeric, 'scheduled');
    end loop;
    update public.rent_to_buy_agreements set final_due_date = (select max(due_date) from public.rent_to_buy_installments where agreement_id = v_agreement.id) where id = v_agreement.id;
  end if;

  update public.rent_to_buy_amendments set status = 'accepted', responded_at = now(), responded_by = p_actor_user_id where id = p_amendment_id;
  perform public._rent_to_buy_history(v_agreement.id, case when p_actor_user_id = v_agreement.merchant_id then 'merchant' else 'customer' end, p_actor_user_id, 'amendment_accepted', null, null, jsonb_build_object('amendment_id', p_amendment_id));

  return jsonb_build_object('amendment_id', p_amendment_id, 'status', 'accepted');
end;
$$;
revoke all on function public.respond_rent_to_buy_amendment(uuid, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.respond_rent_to_buy_amendment(uuid, uuid, boolean, text, text) to service_role;

-- ============================================================
-- ESCROW WIDENING -- rent_to_buy_agreement_id branch.
-- ============================================================

-- Genuine signature change (new trailing defaulted param) -- DROP the
-- exact old signature first (Rule: never a bare CREATE OR REPLACE over
-- a different parameter list, to avoid a live ambiguous duplicate
-- overload reachable via PostgREST).
drop function if exists public.create_escrow_transaction(text, uuid, uuid, uuid, uuid, numeric, numeric, text, text, text, text);

create or replace function public.create_escrow_transaction(
  p_transaction_type text,
  p_order_id uuid,
  p_booking_id uuid,
  p_barter_agreement_id uuid,
  p_payment_id uuid,
  p_principal_amount numeric,
  p_secure_transaction_fee_amount numeric,
  p_currency text,
  p_provider text,
  p_provider_reference text,
  p_idempotency_key text default null,
  p_rent_to_buy_agreement_id uuid default null
)
returns public.escrow_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_escrow public.escrow_transactions;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_payment_id is null then
    raise exception 'payment_id is required';
  end if;

  begin
    insert into public.escrow_transactions (
      transaction_type, order_id, booking_id, barter_agreement_id, rent_to_buy_agreement_id, payment_id,
      principal_amount, secure_transaction_fee_amount, currency, provider, provider_reference, idempotency_key
    ) values (
      p_transaction_type, p_order_id, p_booking_id, p_barter_agreement_id, p_rent_to_buy_agreement_id, p_payment_id,
      p_principal_amount, p_secure_transaction_fee_amount, p_currency, p_provider, p_provider_reference, p_idempotency_key
    )
    returning * into v_escrow;

    insert into public.escrow_transaction_history (
      escrow_transaction_id, previous_status, new_status, actor_type, action, idempotency_key
    ) values (
      v_escrow.id, null, 'pending', 'system', 'created', p_idempotency_key
    );
  exception when unique_violation then
    select * into v_escrow from public.escrow_transactions where payment_id = p_payment_id;
  end;

  return v_escrow;
end;
$$;
revoke all on function public.create_escrow_transaction(text, uuid, uuid, uuid, uuid, numeric, numeric, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_escrow_transaction(text, uuid, uuid, uuid, uuid, numeric, numeric, text, text, text, text, uuid) to service_role;

-- Composite row-type param auto-widens with the new column -- only the
-- body needs a new branch (no DROP/signature change).
create or replace function public._escrow_transaction_dispute_block(p_escrow public.escrow_transactions)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_escrow.booking_id is not null then
    if exists (select 1 from public.bookings where id = p_escrow.booking_id and status = 'disputed') then
      return 'unresolved_dispute';
    end if;
    if exists (select 1 from public.disputes where booking_id = p_escrow.booking_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  elsif p_escrow.order_id is not null then
    if exists (select 1 from public.orders where id = p_escrow.order_id and status = 'disputed') then
      return 'unresolved_dispute';
    end if;
    if exists (select 1 from public.disputes where order_id = p_escrow.order_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  elsif p_escrow.barter_agreement_id is not null then
    if exists (select 1 from public.barter_agreements where id = p_escrow.barter_agreement_id and status = 'disputed') then
      return 'unresolved_dispute';
    end if;
    if exists (select 1 from public.disputes where barter_agreement_id = p_escrow.barter_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  elsif p_escrow.rent_to_buy_agreement_id is not null then
    -- Dual-signal, same as booking -- RTB dispute resolution DOES restore
    -- the agreement's own status (confirmed live in 20260828000002),
    -- unlike order/barter which never restore theirs once disputed.
    if exists (select 1 from public.rent_to_buy_agreements where id = p_escrow.rent_to_buy_agreement_id and status = 'disputed') then
      return 'unresolved_dispute';
    end if;
    if exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_escrow.rent_to_buy_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public._escrow_transaction_dispute_block(public.escrow_transactions) from public, anon, authenticated;
grant execute on function public._escrow_transaction_dispute_block(public.escrow_transactions) to service_role;

-- Same auto-widening composite param. RTB branch only matters for the
-- generic admin-override release/refund path -- the dedicated RTB
-- settlement helpers above bypass this by design (they call
-- _escrow_transaction_transition directly after their own authoritative
-- validation), but an admin manually reaching for the generic release/
-- refund RPCs against an RTB escrow row must still be safely blocked
-- until the agreement has genuinely reached a settled/completed state.
create or replace function public._escrow_transaction_completion_block(p_escrow public.escrow_transactions)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_status text;
  v_order_status text;
  v_barter_status text;
  v_favorable record;
  v_rtb record;
begin
  if p_escrow.booking_id is not null then
    select status::text into v_booking_status from public.bookings where id = p_escrow.booking_id;
    if v_booking_status = 'completed' then
      return null;
    end if;
    return 'transaction_not_completed';

  elsif p_escrow.order_id is not null then
    select status::text into v_order_status from public.orders where id = p_escrow.order_id;
    if v_order_status = 'delivered' then
      return null;
    end if;
    select pre_dispute_status, outcome into v_favorable
    from public.disputes
    where order_id = p_escrow.order_id and outcome = 'favor_respondent' and status in ('resolved', 'closed')
    order by created_at desc
    limit 1;
    if v_favorable.pre_dispute_status = 'delivered' then
      return null;
    end if;
    return 'transaction_not_completed';

  elsif p_escrow.barter_agreement_id is not null then
    select status::text into v_barter_status from public.barter_agreements where id = p_escrow.barter_agreement_id;
    if v_barter_status = 'completed' then
      return null;
    end if;
    select pre_dispute_status, outcome into v_favorable
    from public.disputes
    where barter_agreement_id = p_escrow.barter_agreement_id and outcome = 'favor_respondent' and status in ('resolved', 'closed')
    order by created_at desc
    limit 1;
    if v_favorable.pre_dispute_status = 'completed' then
      return null;
    end if;
    return 'transaction_not_completed';

  elsif p_escrow.rent_to_buy_agreement_id is not null then
    select ownership_status::text as ownership_status, settled_at into v_rtb
    from public.rent_to_buy_agreements where id = p_escrow.rent_to_buy_agreement_id;
    if v_rtb.ownership_status = 'customer_owned' or v_rtb.settled_at is not null then
      return null;
    end if;
    return 'transaction_not_completed';
  end if;

  return 'transaction_not_completed';
end;
$$;
revoke all on function public._escrow_transaction_completion_block(public.escrow_transactions) from public, anon, authenticated;
grant execute on function public._escrow_transaction_completion_block(public.escrow_transactions) to service_role;

-- ============================================================
-- MERCHANT PAYOUT WIDENING -- rent_to_buy_agreement_id branch.
-- ============================================================

drop function if exists public.create_merchant_payout(uuid, uuid, numeric, text);

create or replace function public.create_merchant_payout(
  p_merchant_id uuid,
  p_booking_id uuid,
  p_amount numeric,
  p_idempotency_key text default null,
  p_rent_to_buy_agreement_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_hash text;
  v_idem record;
  v_payout_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid payout amount';
  end if;
  if (p_booking_id is not null and p_rent_to_buy_agreement_id is not null) or (p_booking_id is null and p_rent_to_buy_agreement_id is null) then
    raise exception 'exactly one of booking_id or rent_to_buy_agreement_id is required';
  end if;

  v_request_hash := md5(coalesce(p_merchant_id::text, '') || '|' || coalesce(p_booking_id::text, '') || '|' || coalesce(p_rent_to_buy_agreement_id::text, '') || '|' || coalesce(p_amount::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'create_merchant_payout' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.merchant_payouts (merchant_id, booking_id, rent_to_buy_agreement_id, amount, status, idempotency_key)
  values (p_merchant_id, p_booking_id, p_rent_to_buy_agreement_id, p_amount, 'pending', p_idempotency_key)
  on conflict (rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null do nothing
  returning id into v_payout_id;

  if v_payout_id is null and p_rent_to_buy_agreement_id is not null then
    select id into v_payout_id from public.merchant_payouts where rent_to_buy_agreement_id = p_rent_to_buy_agreement_id;
    v_result := jsonb_build_object('payout_id', v_payout_id, 'status', 'pending', 'already_created', true);
    return v_result;
  end if;

  insert into public.ledger_entries (booking_id, rent_to_buy_agreement_id, payout_id, merchant_id, amount, currency, entry_type, reference)
  values (p_booking_id, p_rent_to_buy_agreement_id, v_payout_id, p_merchant_id, p_amount, 'ZAR', 'merchant_payout', null);

  v_result := jsonb_build_object('payout_id', v_payout_id, 'status', 'pending');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'create_merchant_payout', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
revoke all on function public.create_merchant_payout(uuid, uuid, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.create_merchant_payout(uuid, uuid, numeric, text, uuid) to service_role;

-- Composite row-type params auto-widen -- only bodies need new branches.
create or replace function public._merchant_payout_full_eligibility_block(p_payout public.merchant_payouts)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking record;
  v_rental_payment record;
  v_agreement record;
begin
  if p_payout.rent_to_buy_agreement_id is not null then
    select status::text as status, settled_at into v_agreement from public.rent_to_buy_agreements where id = p_payout.rent_to_buy_agreement_id;
    if v_agreement.status is null then
      return 'source_payment_issue';
    end if;
    if not (
      v_agreement.status = 'completed'
      or (v_agreement.status in ('defaulted', 'cancelled') and v_agreement.settled_at is not null)
    ) then
      return 'source_payment_issue';
    end if;
    if exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'compliance_review';
    end if;
    if exists (select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')) then
      return 'account_restricted';
    end if;
    return null;
  end if;

  if p_payout.booking_id is null then
    return 'source_payment_issue';
  end if;

  select id, status, merchant_id into v_booking from public.bookings where id = p_payout.booking_id;
  if v_booking.id is null or v_booking.status <> 'completed' then
    return 'source_payment_issue';
  end if;

  select id, status into v_rental_payment
  from public.payments
  where booking_id = p_payout.booking_id and payment_type = 'rental_charge';
  if v_rental_payment.id is null or v_rental_payment.status <> 'captured' then
    return 'source_payment_issue';
  end if;

  if exists (
    select 1 from public.disputes
    where booking_id = p_payout.booking_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    return 'compliance_review';
  end if;

  if exists (
    select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')
  ) then
    return 'account_restricted';
  end if;

  return null;
end;
$$;
revoke all on function public._merchant_payout_full_eligibility_block(public.merchant_payouts) from public, anon, authenticated;
grant execute on function public._merchant_payout_full_eligibility_block(public.merchant_payouts) to service_role;

create or replace function public._merchant_payout_still_safe_to_pay_block(p_payout public.merchant_payouts)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rental_payment_status payment_status;
begin
  if p_payout.rent_to_buy_agreement_id is not null then
    if exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'compliance_review';
    end if;
    if exists (select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')) then
      return 'account_restricted';
    end if;
    return null;
  end if;

  if exists (
    select 1 from public.disputes
    where booking_id = p_payout.booking_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    return 'compliance_review';
  end if;

  if exists (
    select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')
  ) then
    return 'account_restricted';
  end if;

  select status into v_rental_payment_status
  from public.payments
  where booking_id = p_payout.booking_id and payment_type = 'rental_charge';
  if v_rental_payment_status in ('refunded', 'partially_refunded', 'chargeback') then
    return 'source_payment_issue';
  end if;

  return null;
end;
$$;
revoke all on function public._merchant_payout_still_safe_to_pay_block(public.merchant_payouts) from public, anon, authenticated;
grant execute on function public._merchant_payout_still_safe_to_pay_block(public.merchant_payouts) to service_role;
