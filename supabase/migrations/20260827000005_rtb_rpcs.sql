-- ============================================================
-- Phase 5 -- Rent-to-Buy: RPCs.
-- ============================================================
-- All SECURITY DEFINER, service-role-only (auth.role() <> 'service_role'
-- hard-blocked), idempotency-keyed via the existing idempotency_keys
-- table. Every commercial action re-verifies both parties' live
-- kyc_status = 'approved' -- Rule 1 requires verification "before
-- entering an active agreement", so this is checked live at both
-- request-creation and merchant-acceptance time, not only inferred from
-- listing activation (Phase 5's own audit found that a merchant's KYC
-- CAN be revoked after their listing was activated, without the
-- listing being deactivated -- a pre-existing gap in Buy/Rent/Barter,
-- reported separately, not fixed here; RTB is deliberately built
-- stricter given Rule 1's explicit wording).
--
-- RENT_TO_BUY_ENABLED is a JS-layer flag (src/lib/rent-to-buy/config.ts),
-- checked at the route layer before any "create new" RPC below is ever
-- called -- mirroring escrow's own central-chokepoint pattern exactly.
-- No RPC here reads the flag itself; every RPC below remains fully
-- callable for an EXISTING agreement regardless of the flag (Rule M --
-- disabling the feature must never destroy access to active agreements).
--
-- No commission RATE, affiliate rate, payout timing, or escrow release
-- timing is ever computed here (Rules 16-19) -- qualify_rent_to_buy_
-- commission_event() only ever records the qualifying EVENT into
-- rent_to_buy_commission_events with rate_status='policy_pending' and a
-- null commission_amount; nothing calls create_escrow_transaction,
-- create_affiliate_commission, or create_merchant_payout for any RTB
-- payment anywhere in this file.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ------------------------------------------------------------
-- Shared history writer.
-- ------------------------------------------------------------
create or replace function public._rent_to_buy_history(
  p_agreement_id uuid, p_actor_role text, p_actor_id uuid,
  p_event_type text, p_previous_status text, p_new_status text, p_metadata jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.rent_to_buy_history (agreement_id, actor_role, actor_id, event_type, previous_status, new_status, metadata)
  values (p_agreement_id, p_actor_role, p_actor_id, p_event_type, p_previous_status, p_new_status, p_metadata);
end;
$$;
revoke all on function public._rent_to_buy_history(uuid, text, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public._rent_to_buy_history(uuid, text, uuid, text, text, text, jsonb) to service_role;

-- Live re-verification helper -- both parties must be kyc_status =
-- 'approved' right now (Rule 1). Raises 'verification_required: ...' to
-- match the exact substring convention mapMarketplaceRpcError()/a new
-- mapRentToBuyRpcError() already key off.
create or replace function public._rent_to_buy_assert_parties_verified(p_merchant_id uuid, p_customer_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_merchant_kyc text;
  v_customer_kyc text;
begin
  select kyc_status::text into v_merchant_kyc from public.profiles where id = p_merchant_id;
  select kyc_status::text into v_customer_kyc from public.profiles where id = p_customer_id;
  if v_merchant_kyc is distinct from 'approved' then
    raise exception 'verification_required: the merchant must be verified before this rent-to-buy agreement can proceed';
  end if;
  if v_customer_kyc is distinct from 'approved' then
    raise exception 'verification_required: the customer must be verified before this rent-to-buy agreement can proceed';
  end if;
end;
$$;
revoke all on function public._rent_to_buy_assert_parties_verified(uuid, uuid) from public, anon, authenticated;
grant execute on function public._rent_to_buy_assert_parties_verified(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- SAVE LISTING TERMS -- merchant configures/updates their own listing's
-- RTB terms. Bumps terms_version on every change so an agreement's own
-- snapshot (terms_version at acceptance) is always distinguishable from
-- a later edit (Rule C/D -- listing edits never alter an existing
-- agreement's economics).
-- ------------------------------------------------------------
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
  p_cure_policy jsonb default null
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

  select * into v_existing from public.rent_to_buy_listing_terms where listing_id = p_listing_id;
  v_version := coalesce(v_existing.terms_version, 0) + 1;

  insert into public.rent_to_buy_listing_terms (
    listing_id, merchant_id, enabled, currency, total_purchase_price, installment_amount, payment_frequency,
    installment_count, security_deposit_amount, early_payoff_allowed, early_payoff_policy, default_cure_allowed, cure_policy, terms_version
  ) values (
    p_listing_id, p_merchant_id, p_enabled, coalesce(p_currency, 'ZAR'), p_total_purchase_price, p_installment_amount, p_payment_frequency,
    p_installment_count, p_security_deposit_amount, coalesce(p_early_payoff_allowed, false), p_early_payoff_policy, coalesce(p_default_cure_allowed, false), p_cure_policy, v_version
  )
  on conflict (listing_id) do update set
    enabled = excluded.enabled, currency = excluded.currency, total_purchase_price = excluded.total_purchase_price,
    installment_amount = excluded.installment_amount, payment_frequency = excluded.payment_frequency,
    installment_count = excluded.installment_count, security_deposit_amount = excluded.security_deposit_amount,
    early_payoff_allowed = excluded.early_payoff_allowed, early_payoff_policy = excluded.early_payoff_policy,
    default_cure_allowed = excluded.default_cure_allowed, cure_policy = excluded.cure_policy, terms_version = excluded.terms_version
  returning id into v_terms_id;

  return jsonb_build_object('terms_id', v_terms_id, 'enabled', p_enabled, 'terms_version', v_version);
end;
$$;
revoke all on function public.save_rent_to_buy_listing_terms(uuid, uuid, boolean, text, numeric, numeric, public.rent_to_buy_frequency, int, numeric, boolean, jsonb, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.save_rent_to_buy_listing_terms(uuid, uuid, boolean, text, numeric, numeric, public.rent_to_buy_frequency, int, numeric, boolean, jsonb, boolean, jsonb) to service_role;

-- ------------------------------------------------------------
-- CREATE REQUEST -- customer initiates against an RTB-enabled listing
-- (either directly from "Available", or from accept_marketplace_offer's
-- rent_to_buy branch for a "Looking For" match). Snapshots the
-- listing's current terms and generates the full installment schedule
-- with a remainder-correction on the final installment so the schedule
-- always reconciles exactly to total_purchase_price (Rule 9 -- never
-- floating point; numeric(12,2) exact arithmetic throughout).
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
    is_test
  ) values (
    p_listing_id, v_listing.merchant_id, p_customer_id, p_request_id, p_offer_id, 'pending_merchant_acceptance', 'not_delivered', 'merchant_owned',
    v_terms.currency, v_terms.total_purchase_price, v_terms.installment_amount, v_terms.payment_frequency, v_terms.installment_count,
    v_terms.security_deposit_amount, v_terms.early_payoff_allowed, v_terms.early_payoff_policy, v_terms.default_cure_allowed, v_terms.cure_policy, v_terms.terms_version,
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
-- ACCEPT REQUEST -- merchant only. Re-verifies both parties live.
-- ------------------------------------------------------------
create or replace function public.accept_rent_to_buy_request(
  p_merchant_id uuid, p_agreement_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
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

  update public.rent_to_buy_agreements set status = 'awaiting_first_payment', accepted_at = now() where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'merchant', p_merchant_id, 'accepted', 'pending_merchant_acceptance', 'awaiting_first_payment');

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'awaiting_first_payment');
  return v_result;
end;
$$;
revoke all on function public.accept_rent_to_buy_request(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_rent_to_buy_request(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- DECLINE / CANCEL -- before first payment only.
-- ------------------------------------------------------------
create or replace function public.decline_rent_to_buy_request(
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
  if v_agreement.merchant_id <> p_actor_user_id then raise exception 'not the merchant of this agreement'; end if;
  if v_agreement.status <> 'pending_merchant_acceptance' then
    raise exception 'agreement is in status % and cannot be declined from here', v_agreement.status;
  end if;

  update public.rent_to_buy_agreements set status = 'cancelled', cancelled_at = now(), cancelled_reason = p_reason where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'merchant', p_actor_user_id, 'declined', 'pending_merchant_acceptance', 'cancelled', jsonb_build_object('reason', p_reason));
  return jsonb_build_object('agreement_id', p_agreement_id, 'status', 'cancelled');
end;
$$;
revoke all on function public.decline_rent_to_buy_request(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.decline_rent_to_buy_request(uuid, uuid, text, text) to service_role;

create or replace function public.cancel_rent_to_buy_request(
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
  if v_agreement.customer_id <> p_actor_user_id and v_agreement.merchant_id <> p_actor_user_id then
    raise exception 'not a party to this agreement';
  end if;
  if v_agreement.status not in ('pending_merchant_acceptance', 'awaiting_first_payment') then
    raise exception 'agreement is in status % and cannot be cancelled from here', v_agreement.status;
  end if;

  update public.rent_to_buy_agreements set status = 'cancelled', cancelled_at = now(), cancelled_reason = p_reason where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, case when p_actor_user_id = v_agreement.merchant_id then 'merchant' else 'customer' end, p_actor_user_id, 'cancelled', v_agreement.status::text, 'cancelled', jsonb_build_object('reason', p_reason));
  return jsonb_build_object('agreement_id', p_agreement_id, 'status', 'cancelled');
end;
$$;
revoke all on function public.cancel_rent_to_buy_request(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cancel_rent_to_buy_request(uuid, uuid, text, text) to service_role;

-- ------------------------------------------------------------
-- CONFIRM POSSESSION -- a distinct action from payment (Rule 2/E).
-- Only reachable once the first installment has genuinely settled.
-- ------------------------------------------------------------
create or replace function public.confirm_rent_to_buy_possession(
  p_actor_user_id uuid, p_agreement_id uuid, p_idempotency_key text default null
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
  if v_agreement.merchant_id <> p_actor_user_id and v_agreement.customer_id <> p_actor_user_id then
    raise exception 'not a party to this agreement';
  end if;
  if v_agreement.possession_status <> 'possession_eligible' then
    raise exception 'possession is in status % and cannot be confirmed from here', v_agreement.possession_status;
  end if;

  update public.rent_to_buy_agreements set possession_status = 'customer_in_possession', possession_confirmed_at = now() where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, case when p_actor_user_id = v_agreement.merchant_id then 'merchant' else 'customer' end, p_actor_user_id, 'possession_confirmed', 'possession_eligible', 'customer_in_possession');
  return jsonb_build_object('agreement_id', p_agreement_id, 'possession_status', 'customer_in_possession');
end;
$$;
revoke all on function public.confirm_rent_to_buy_possession(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_rent_to_buy_possession(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- RECORD INSTALMENT PAYMENT -- service-role-only, called from the
-- payment orchestrator after a real provider charge succeeds (never
-- client-callable, never client-settable status -- Rule 56). Marks the
-- instalment paid, then:
--   - if this was instalment #1: agreement -> active, possession ->
--     possession_eligible (NOT customer_in_possession -- Rule 2/E, a
--     separate confirm_rent_to_buy_possession() call is required),
--     first_payment_settled_at set.
--   - checks 100% purchase-progress threshold and transfers ownership
--     inline, atomically, in the SAME transaction (Rule 4/18 --
--     idempotent: an already-customer_owned agreement is a no-op here).
-- Deposit payments never call this RPC at all (Rule 14/H -- a deposit
-- is recorded via record_rent_to_buy_deposit_payment below, which never
-- touches purchase progress).
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
    -- Idempotent no-op -- a replayed/duplicate settlement notification
    -- for an already-paid installment never counts twice (Rule 65).
    return jsonb_build_object('agreement_id', p_agreement_id, 'installment_id', v_installment.id, 'status', 'paid', 'already_paid', true);
  end if;

  update public.rent_to_buy_installments set status = 'paid', payment_id = p_payment_id, paid_at = now() where id = v_installment.id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'installment_paid', 'scheduled', 'paid', jsonb_build_object('sequence', p_sequence, 'payment_id', p_payment_id));

  if p_sequence = 1 and v_agreement.status = 'awaiting_first_payment' then
    update public.rent_to_buy_agreements
    set status = 'active', possession_status = 'possession_eligible', first_payment_settled_at = now()
    where id = p_agreement_id;
    perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'first_payment_settled', 'awaiting_first_payment', 'active');
  end if;

  -- Ownership-transfer eligibility check (Rule 4) -- 100% of the
  -- purchase obligation, excluding the security deposit (Rule H/14),
  -- must be paid via genuinely 'paid' installments, no unresolved
  -- blocking dispute, and the agreement must not already be completed
  -- (idempotency, Rule 18/66).
  select coalesce(sum(principal_amount), 0) into v_paid_sum from public.rent_to_buy_installments where agreement_id = p_agreement_id and status = 'paid';
  select exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_agreement_id and status not in ('resolved', 'closed', 'cancelled')) into v_dispute_open;

  if v_paid_sum >= v_agreement.total_purchase_price and not v_dispute_open and v_agreement.ownership_status = 'merchant_owned' and v_agreement.status not in ('cancelled', 'defaulted') then
    update public.rent_to_buy_agreements
    set ownership_status = 'customer_owned', status = 'completed', ownership_transferred_at = now()
    where id = p_agreement_id;
    perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'ownership_transferred', 'merchant_owned', 'customer_owned', jsonb_build_object('paid_sum', v_paid_sum, 'total_purchase_price', v_agreement.total_purchase_price));
  end if;

  select jsonb_build_object('agreement_id', p_agreement_id, 'installment_id', v_installment.id, 'status', 'paid', 'already_paid', false) into v_result;
  return v_result;
end;
$$;
revoke all on function public.record_rent_to_buy_installment_payment(uuid, int, uuid, text) from public, anon, authenticated;
grant execute on function public.record_rent_to_buy_installment_payment(uuid, int, uuid, text) to service_role;

-- ------------------------------------------------------------
-- RECORD DEPOSIT PAYMENT -- never affects purchase progress or
-- ownership (Rule 14/H). No release/refund/retention logic exists here
-- -- that remains REQUIRES BUSINESS APPROVAL (Rule 14/18), architecture
-- only records that a deposit was paid.
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

  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'deposit_paid', null, null, jsonb_build_object('payment_id', p_payment_id));
  return jsonb_build_object('agreement_id', p_agreement_id, 'deposit_paid', true);
end;
$$;
revoke all on function public.record_rent_to_buy_deposit_payment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_rent_to_buy_deposit_payment(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- MARK DEFAULTED -- admin-only, explicit, manual trigger. NO automatic
-- timing exists (Rule 10/11 -- grace period and missed-payment
-- threshold both REQUIRE BUSINESS APPROVAL, so no cron/sweep computes
-- this). Ownership is untouched (already merchant_owned -- Rule 5).
-- Possession moves to return_required only if the customer currently
-- holds the item. No financial reconciliation is computed here (Rule
-- 7/16) -- default_reconciliation_pending is set true purely as an
-- admin-visible marker.
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
  set status = 'defaulted', possession_status = v_new_possession, default_at = now(), default_reason = p_reason, default_reconciliation_pending = true
  where id = p_agreement_id;

  perform public._rent_to_buy_history(p_agreement_id, 'admin', p_admin_id, 'defaulted', 'active', 'defaulted', jsonb_build_object('reason', p_reason));

  return jsonb_build_object('agreement_id', p_agreement_id, 'status', 'defaulted', 'possession_status', v_new_possession, 'default_reconciliation_pending', true);
end;
$$;
revoke all on function public.mark_rent_to_buy_agreement_defaulted(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_rent_to_buy_agreement_defaulted(uuid, uuid, text, text) to service_role;

-- ------------------------------------------------------------
-- CURE -- only if cure_allowed was snapshotted true at acceptance
-- (Rule 12), and only if the item has not reached a terminal
-- return/recovery state. A later listing-terms edit can never affect an
-- already-accepted agreement's cure_allowed (it's a snapshot column,
-- never re-read from rent_to_buy_listing_terms).
-- ------------------------------------------------------------
create or replace function public.cure_rent_to_buy_default(
  p_actor_user_id uuid, p_agreement_id uuid, p_idempotency_key text default null
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
  if not v_agreement.cure_allowed then raise exception 'cure is not allowed under this agreement''s accepted terms'; end if;
  if v_agreement.status <> 'defaulted' then raise exception 'agreement is in status % and is not eligible for cure', v_agreement.status; end if;
  if v_agreement.possession_status in ('returned_to_merchant', 'recovered') then
    raise exception 'the item has already reached a terminal return/recovery state and cannot be cured';
  end if;

  update public.rent_to_buy_agreements
  set status = 'active', possession_status = case when v_agreement.possession_status = 'return_required' then 'customer_in_possession'::public.rent_to_buy_possession_status else v_agreement.possession_status end,
    default_reconciliation_pending = false
  where id = p_agreement_id;

  perform public._rent_to_buy_history(p_agreement_id, case when p_actor_user_id = v_agreement.merchant_id then 'merchant' else 'customer' end, p_actor_user_id, 'cured', 'defaulted', 'active');

  return jsonb_build_object('agreement_id', p_agreement_id, 'status', 'active');
end;
$$;
revoke all on function public.cure_rent_to_buy_default(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cure_rent_to_buy_default(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- EARLY PAYOFF -- only the "remaining contractual balance" flavor
-- (Rule 13 -- no interest rebates/penalties/actuarial math). Marks
-- every still-scheduled installment paid via the one payoff payment
-- reference, then runs the same ownership-transfer check.
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

  perform public._rent_to_buy_history(p_agreement_id, 'customer', p_actor_user_id, 'paid_off', 'active', 'active', jsonb_build_object('remaining_balance', v_remaining, 'payment_id', p_payment_id));

  update public.rent_to_buy_agreements
  set ownership_status = 'customer_owned', status = 'completed', ownership_transferred_at = now()
  where id = p_agreement_id and ownership_status = 'merchant_owned';
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'ownership_transferred', 'merchant_owned', 'customer_owned', jsonb_build_object('via', 'early_payoff'));

  return jsonb_build_object('agreement_id', p_agreement_id, 'status', 'completed', 'amount_paid', v_remaining);
end;
$$;
revoke all on function public.payoff_rent_to_buy_agreement(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.payoff_rent_to_buy_agreement(uuid, uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- RETURN / RECOVERY -- voluntary return can be requested by either
-- party; a recovery case can ONLY be created by an admin (Rule 6/K --
-- "no software authority to seize" -- the only trusted path is an
-- explicit admin action, never automatic). recovery_provider is always
-- 'manual' (the only value the CHECK constraint permits) -- no real
-- recovery-partner integration exists or is ever called.
-- ------------------------------------------------------------
create or replace function public.request_rent_to_buy_voluntary_return(
  p_actor_user_id uuid, p_agreement_id uuid, p_condition_notes text default null, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_case_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.merchant_id <> p_actor_user_id and v_agreement.customer_id <> p_actor_user_id then raise exception 'not a party to this agreement'; end if;
  if v_agreement.possession_status not in ('customer_in_possession', 'return_required') then
    raise exception 'possession is in status % and a return cannot be requested from here', v_agreement.possession_status;
  end if;

  insert into public.rent_to_buy_return_cases (agreement_id, case_type, status, requested_by, condition_notes)
  values (p_agreement_id, 'voluntary_return', 'requested', p_actor_user_id, p_condition_notes)
  returning id into v_case_id;

  update public.rent_to_buy_agreements set possession_status = 'return_in_progress' where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, case when p_actor_user_id = v_agreement.merchant_id then 'merchant' else 'customer' end, p_actor_user_id, 'return_requested', v_agreement.possession_status::text, 'return_in_progress', jsonb_build_object('case_id', v_case_id));

  return jsonb_build_object('case_id', v_case_id, 'agreement_id', p_agreement_id, 'status', 'requested');
end;
$$;
revoke all on function public.request_rent_to_buy_voluntary_return(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.request_rent_to_buy_voluntary_return(uuid, uuid, text, text) to service_role;

create or replace function public.confirm_rent_to_buy_return_completed(
  p_admin_id uuid, p_case_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_case record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_case from public.rent_to_buy_return_cases where id = p_case_id for update;
  if v_case.id is null then raise exception 'return case not found'; end if;
  if v_case.status not in ('requested', 'scheduled') then raise exception 'return case is in status % and cannot be confirmed returned from here', v_case.status; end if;

  update public.rent_to_buy_return_cases set status = 'returned', resolved_at = now() where id = p_case_id;
  update public.rent_to_buy_agreements set possession_status = 'returned_to_merchant' where id = v_case.agreement_id;
  perform public._rent_to_buy_history(v_case.agreement_id, 'admin', p_admin_id, 'return_confirmed', 'return_in_progress', 'returned_to_merchant', jsonb_build_object('case_id', p_case_id));

  return jsonb_build_object('case_id', p_case_id, 'agreement_id', v_case.agreement_id, 'possession_status', 'returned_to_merchant');
end;
$$;
revoke all on function public.confirm_rent_to_buy_return_completed(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_rent_to_buy_return_completed(uuid, uuid, text) to service_role;

-- Trusted, admin-only recovery-case creation. This is the ONLY path
-- that can ever create a 'recovery' case -- there is no client-facing
-- or automatic route to this RPC anywhere in the application layer.
create or replace function public.create_rent_to_buy_recovery_case(
  p_admin_id uuid, p_agreement_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_case_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.possession_status not in ('return_required', 'return_in_progress') then
    raise exception 'possession is in status % and is not eligible for a recovery case', v_agreement.possession_status;
  end if;

  insert into public.rent_to_buy_return_cases (agreement_id, case_type, status, requested_by, recovery_provider)
  values (p_agreement_id, 'recovery', 'recovery_pending', p_admin_id, 'manual')
  returning id into v_case_id;

  update public.rent_to_buy_agreements set possession_status = 'return_required' where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'admin', p_admin_id, 'recovery_case_created', v_agreement.possession_status::text, 'return_required', jsonb_build_object('case_id', v_case_id));

  return jsonb_build_object('case_id', v_case_id, 'agreement_id', p_agreement_id, 'status', 'recovery_pending');
end;
$$;
revoke all on function public.create_rent_to_buy_recovery_case(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_rent_to_buy_recovery_case(uuid, uuid, text) to service_role;

create or replace function public.confirm_rent_to_buy_recovered(
  p_admin_id uuid, p_case_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_case record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_case from public.rent_to_buy_return_cases where id = p_case_id for update;
  if v_case.id is null then raise exception 'return case not found'; end if;
  if v_case.case_type <> 'recovery' then raise exception 'this case is not a recovery case'; end if;
  if v_case.status <> 'recovery_pending' then raise exception 'recovery case is in status % and cannot be marked recovered from here', v_case.status; end if;

  update public.rent_to_buy_return_cases set status = 'recovered', resolved_at = now() where id = p_case_id;
  update public.rent_to_buy_agreements set possession_status = 'recovered' where id = v_case.agreement_id;
  perform public._rent_to_buy_history(v_case.agreement_id, 'admin', p_admin_id, 'recovery_confirmed', 'return_required', 'recovered', jsonb_build_object('case_id', p_case_id));

  return jsonb_build_object('case_id', p_case_id, 'agreement_id', v_case.agreement_id, 'possession_status', 'recovered');
end;
$$;
revoke all on function public.confirm_rent_to_buy_recovered(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_rent_to_buy_recovered(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- COMMISSION EVENT -- records that a settled installment reached the
-- qualification boundary. rate_status is hard-CHECK-constrained to the
-- single literal value 'policy_pending' at the table level (Rule 16) --
-- this RPC cannot write a computed positive commission even if a future
-- caller tried to pass one; there is no parameter for an amount at all.
-- ------------------------------------------------------------
create or replace function public.qualify_rent_to_buy_commission_event(
  p_agreement_id uuid, p_installment_id uuid, p_payment_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_installment record;
  v_event_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  select * into v_installment from public.rent_to_buy_installments where id = p_installment_id and agreement_id = p_agreement_id;
  if v_installment.id is null or v_installment.status <> 'paid' then
    raise exception 'installment must be a genuinely settled installment of this agreement';
  end if;

  insert into public.rent_to_buy_commission_events (agreement_id, installment_id, payment_id, eligible_base, rate_status, commission_amount)
  values (p_agreement_id, p_installment_id, p_payment_id, v_installment.principal_amount, 'policy_pending', null)
  on conflict (installment_id) do nothing
  returning id into v_event_id;

  return jsonb_build_object('agreement_id', p_agreement_id, 'installment_id', p_installment_id, 'rate_status', 'policy_pending', 'event_id', v_event_id);
end;
$$;
revoke all on function public.qualify_rent_to_buy_commission_event(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.qualify_rent_to_buy_commission_event(uuid, uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- accept_marketplace_offer widened -- one new elsif branch. Same
-- signature (accept_marketplace_offer(uuid, uuid, text)) as the current
-- live version (20260826000005) -- a true CREATE OR REPLACE, no DROP
-- needed since no parameter is added. Calls create_rent_to_buy_request
-- then accept_rent_to_buy_request unchanged, exactly mirroring how the
-- rent branch calls create_booking_request then accept_booking_request.
-- ------------------------------------------------------------
create or replace function public.accept_marketplace_offer(
  p_actor_user_id uuid, p_offer_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_request_id uuid;
  v_request record;
  v_offer record;
  v_listing record;
  v_responder_listing_id uuid;
  v_requester_listing_id uuid;
  v_order_result jsonb;
  v_booking_result jsonb;
  v_barter_result jsonb;
  v_rtb_result jsonb;
  v_rtb_accept_result jsonb;
  v_terms jsonb;
  v_result jsonb;
  v_request_hash text;
  v_idem record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_actor_user_id is null then raise exception 'not authenticated'; end if;

  select request_id into v_request_id from public.marketplace_request_offers where id = p_offer_id;
  if v_request_id is null then raise exception 'offer not found'; end if;

  select * into v_request from public.marketplace_requests where id = v_request_id for update;
  select * into v_offer from public.marketplace_request_offers where id = p_offer_id for update;

  if v_request.requester_id <> p_actor_user_id then raise exception 'not the owner of this request'; end if;
  if v_request.status not in ('active', 'offers_received') then
    raise exception 'request is in status % and is no longer accept-able', v_request.status;
  end if;
  if v_offer.status <> 'pending' then
    raise exception 'offer is in status % and can no longer be accepted', v_offer.status;
  end if;
  if v_offer.offer_type = 'message_only' then
    raise exception 'a message-only response cannot be accepted as a transaction';
  end if;

  v_request_hash := md5(coalesce(p_offer_id::text, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'accept_marketplace_offer' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then raise exception 'idempotency key already used with a different request'; end if;
      return v_idem.result;
    end if;
  end if;

  if v_offer.linked_listing_id is not null then
    select id, status into v_listing from public.listings where id = v_offer.linked_listing_id;
    if v_listing.id is null or v_listing.status <> 'active' then
      raise exception 'linked listing is no longer available';
    end if;
    v_responder_listing_id := v_listing.id;
  else
    v_responder_listing_id := public._create_marketplace_backing_listing(
      v_offer.responder_id, v_request.transaction_type, v_request.title, v_request.category, v_request.category_id,
      v_request.country_id, v_request.province, v_request.city, coalesce(v_offer.amount, v_offer.cash_adjustment), v_request.is_test
    );
  end if;

  v_terms := jsonb_build_object(
    'offer_type', v_offer.offer_type, 'responder_listing_id', v_responder_listing_id,
    'amount', v_offer.amount, 'currency', v_offer.currency,
    'rental_start_date', v_offer.rental_start_date, 'rental_end_date', v_offer.rental_end_date,
    'cash_adjustment', v_offer.cash_adjustment
  );

  if v_request.transaction_type = 'buy' then
    v_order_result := public.create_order(v_request.requester_id, v_responder_listing_id, greatest(coalesce(v_request.quantity, 1), 1), null);
    v_terms := v_terms || jsonb_build_object('order_id', v_order_result->>'order_id');

  elsif v_request.transaction_type = 'rent' then
    v_booking_result := public.create_booking_request(
      v_request.requester_id, v_responder_listing_id,
      coalesce(v_offer.rental_start_date, v_request.start_date)::timestamptz,
      coalesce(v_offer.rental_end_date, v_request.end_date)::timestamptz,
      v_offer.message, null
    );
    perform public.accept_booking_request(
      p_merchant_id => v_offer.responder_id,
      p_booking_id => (v_booking_result->>'booking_id')::uuid,
      p_merchant_response_note => 'Accepted via Looking For request match',
      p_idempotency_key => null,
      p_payment_deadline_hours => 24
    );
    v_terms := v_terms || jsonb_build_object('booking_id', v_booking_result->>'booking_id');

  elsif v_request.transaction_type = 'rent_to_buy' then
    -- Note: RENT_TO_BUY_ENABLED is checked at the route layer before
    -- this RPC is ever invoked for a rent_to_buy request (mirrors
    -- escrow's central-chokepoint gating -- Rule M).
    v_rtb_result := public.create_rent_to_buy_request(v_request.requester_id, v_responder_listing_id, v_request_id, p_offer_id, null);
    v_rtb_accept_result := public.accept_rent_to_buy_request(v_offer.responder_id, (v_rtb_result->>'agreement_id')::uuid, null);
    v_terms := v_terms || jsonb_build_object('rent_to_buy_agreement_id', v_rtb_result->>'agreement_id');

  else -- barter
    v_requester_listing_id := public._create_marketplace_backing_listing(
      v_request.requester_id, 'barter', v_request.barter_offer_description, v_request.category, v_request.category_id,
      v_request.country_id, v_request.province, v_request.city, null, v_request.is_test
    );
    v_barter_result := public.propose_barter(
      v_request.requester_id, v_responder_listing_id,
      array[v_responder_listing_id], array[v_requester_listing_id],
      coalesce(v_offer.cash_adjustment, 0), case when coalesce(v_offer.cash_adjustment, 0) > 0 then v_request.requester_id else null end,
      'meet_in_person', null, null, false, null, 'ZAR', null, v_offer.message, 72, null
    );
    perform public.accept_barter_offer(v_offer.responder_id, (v_barter_result->>'agreement_id')::uuid, 'mock', null);
    v_terms := v_terms || jsonb_build_object('barter_agreement_id', v_barter_result->>'agreement_id', 'requester_listing_id', v_requester_listing_id);
  end if;

  update public.marketplace_request_offers set status = 'accepted', accepted_at = now(), terms_snapshot = v_terms where id = p_offer_id;

  update public.marketplace_request_offers
  set status = 'declined', declined_at = now()
  where request_id = v_request_id and id <> p_offer_id and status = 'pending';

  insert into public.marketplace_request_history (request_id, offer_id, actor_role, actor_id, event_type, previous_status, new_status)
  select v_request_id, id, 'system', p_actor_user_id, 'offer_auto_declined_competing', 'pending', 'declined'
  from public.marketplace_request_offers where request_id = v_request_id and id <> p_offer_id and status = 'declined' and declined_at >= now() - interval '5 seconds';

  update public.marketplace_requests set status = 'matched', matched_at = now(), matched_offer_id = p_offer_id where id = v_request_id;

  perform public._marketplace_request_history(v_request_id, p_offer_id, 'requester', p_actor_user_id, 'offer_accepted', 'pending', 'accepted', v_terms);
  perform public._marketplace_request_history(v_request_id, null, 'system', p_actor_user_id, 'request_matched', v_request.status::text, 'matched');

  v_result := jsonb_build_object('offer_id', p_offer_id, 'request_id', v_request_id, 'status', 'accepted', 'terms', v_terms);
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'accept_marketplace_offer', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;
