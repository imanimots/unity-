-- ============================================================
-- Fix a profiles/marketplace_requests reverse-lock-order deadlock
-- between erase_account and publish_marketplace_request
-- (P6-POPIA-ERASURE-AND-ANONYMIZATION-F2-R finding, remediated here)
-- ============================================================
-- 20261024000000_fix_publish_marketplace_request_lock_order.sql
-- standardized publish_marketplace_request's resource order as:
--   marketplace_requests row (for update, first statement)
--   -> profile row (for update/for share, later)
--
-- erase_account (20261022000000) independently locks these same two
-- resources in the OPPOSITE order:
--   profile row (for update, first statement)
--   -> marketplace_requests rows belonging to that user
--      (implicit row lock via its closing UPDATE, later)
--
-- Concretely: erase_account(X) holds X's profile FOR UPDATE and later
-- needs to UPDATE (lock) X's own draft request R; concurrently,
-- publish_marketplace_request(X, R) holds R FOR UPDATE and later needs
-- X's profile. Each transaction then waits on the resource the other
-- already holds -- a genuine two-resource deadlock (self-resolving via
-- Postgres's deadlock detector, no corruption, but a real availability
-- defect worth removing before push).
--
-- Fix: erase_account now pre-acquires the user's own candidate
-- marketplace_requests rows (the exact same ones its existing closing
-- UPDATE already targets: status in ('draft','active','offers_received'))
-- BEFORE locking the profile row, in deterministic id-ascending order
-- (`order by id for update`) -- matching publish_marketplace_request's
-- own marketplace_requests-first order exactly, eliminating the
-- reverse-order cycle for every PRE-EXISTING request owned by this
-- user at the moment erasure begins. This pre-lock is a pure,
-- side-effect-free row lock (a `perform 1 from ... for update`, no
-- UPDATE/INSERT/DELETE) -- it changes no persisted state and does not
-- move the actual closing UPDATE (still later, still only reached once
-- every active-obligation check has already passed, exactly as
-- before). On an idempotent replay (account already erased), these
-- rows are already 'closed' and the pre-lock query matches zero rows
-- -- a harmless no-op.
--
-- The profile FOR UPDATE lock (line order: now second, was first)
-- still happens strictly BEFORE every active-obligation check and
-- before every anonymization UPDATE, exactly as before -- only ONE
-- new, earlier, different-table lock was inserted ahead of it. This
-- fully preserves the F1 TOCTOU serialization guarantee: a concurrent
-- transaction-creation RPC's `for share` on the profile row still
-- conflicts with this same `for update` lock in the same relative
-- position within erase_account's own transaction.
--
-- Residual, deliberately accepted, and far narrower than before: a
-- marketplace_request CREATED (not merely pre-existing) for this same
-- user strictly after this pre-lock statement runs but before the
-- function's final closing UPDATE, and then independently published
-- within that same narrow window, would not have been covered by the
-- pre-lock snapshot and could in principle still race. create_marketplace_
-- request has never been account-status-gated by design (see
-- 20260904000006's own comment: "Draft creation ... is deliberately
-- NOT gated"), and gating it is unrelated to this deadlock fix and out
-- of this phase's scope. This residual requires the exact same user to
-- create AND publish a brand-new request within the sub-millisecond-to-
-- low-millisecond span of one erase_account PL/pgSQL invocation --
-- vanishingly unlikely, and already a strict reduction from the
-- original finding (which applied to every pre-existing request, not
-- just ones created in that exact window).
--
-- Every other line of erase_account -- the idempotency contract,
-- every active-obligation check, every anonymization UPDATE, the KYC
-- scrub, the listings/barter_skill_task_posts closures, the audit log
-- inserts, the result shape -- is byte-identical to the live
-- definition in 20261022000000_account_erasure.sql, which is NOT
-- modified by this migration. Only the position of one new pre-lock
-- statement changed.
--
-- CREATE OR REPLACE with the exact existing signature
-- (uuid, uuid, text, text default null) -- Postgres preserves the
-- function's existing grants (service_role only, already revoked from
-- public/anon/authenticated by 20261022000000) across a same-signature
-- CREATE OR REPLACE, so no grant/revoke statement is needed or
-- included here, matching this repository's own established
-- convention for CREATE OR REPLACE-only changes.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.erase_account(
  p_user_id uuid,
  p_actor_id uuid,
  p_request_source text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile record;
  v_already_erased boolean;
  v_blocked text[] := '{}';
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_id is null then
    raise exception 'not authenticated';
  end if;
  if p_request_source not in ('self_service', 'admin') then
    raise exception 'invalid request source';
  end if;
  if p_request_source = 'admin' and p_actor_id = p_user_id then
    raise exception 'use the self-service erasure flow for your own account';
  end if;

  v_request_hash := md5(coalesce(p_user_id::text, '') || '|' || coalesce(p_request_source, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_id and operation = 'erase_account' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  -- Pre-acquire the user's own marketplace_requests rows that the
  -- closing UPDATE below may touch, BEFORE the profile lock, in
  -- deterministic id order -- matching publish_marketplace_request's
  -- marketplace_requests-then-profile order (20261024000000) to
  -- eliminate the reverse-order cross-resource deadlock. Pure lock
  -- acquisition, no mutation.
  perform 1 from public.marketplace_requests
  where requester_id = p_user_id and status in ('draft', 'active', 'offers_received')
  order by id
  for update;

  select id, account_status into v_profile from public.profiles where id = p_user_id for update;
  if v_profile.id is null then
    raise exception 'user not found';
  end if;

  v_already_erased := (v_profile.account_status::text = 'erased');

  if not v_already_erased then
    if exists (
      select 1 from public.bookings
      where (renter_id = p_user_id or merchant_id = p_user_id)
        and status in ('requested', 'accepted', 'active', 'return_pending')
    ) then
      v_blocked := array_append(v_blocked, 'active_booking');
    end if;

    if exists (
      select 1 from public.disputes d
      where d.status in ('open', 'evidence', 'under_review', 'escalated')
        and (
          d.raised_by = p_user_id
          or exists (select 1 from public.bookings b where b.id = d.booking_id and (b.renter_id = p_user_id or b.merchant_id = p_user_id))
          or exists (select 1 from public.orders o where o.id = d.order_id and (o.buyer_id = p_user_id or o.seller_id = p_user_id))
          or exists (select 1 from public.barter_agreements ba where ba.id = d.barter_agreement_id and (ba.party_a_id = p_user_id or ba.party_b_id = p_user_id))
        )
    ) then
      v_blocked := array_append(v_blocked, 'open_dispute');
    end if;

    if exists (
      select 1 from public.orders
      where (buyer_id = p_user_id or seller_id = p_user_id)
        and status in ('pending', 'paid', 'shipped', 'disputed')
    ) then
      v_blocked := array_append(v_blocked, 'unsettled_order');
    end if;

    if exists (
      select 1 from public.rent_to_buy_agreements
      where (merchant_id = p_user_id or customer_id = p_user_id)
        and status in ('pending_merchant_acceptance', 'awaiting_first_payment', 'active', 'defaulted', 'return_required', 'disputed')
    ) then
      v_blocked := array_append(v_blocked, 'active_rent_to_buy');
    end if;

    if exists (
      select 1 from public.barter_agreements
      where (party_a_id = p_user_id or party_b_id = p_user_id)
        and status in ('accepted', 'preparing', 'in_transit', 'awaiting_confirmation', 'disputed')
    ) then
      v_blocked := array_append(v_blocked, 'active_barter');
    end if;

    if exists (
      select 1 from public.merchant_payouts
      where merchant_id = p_user_id and status in ('pending', 'processing', 'failed')
    ) then
      v_blocked := array_append(v_blocked, 'unpaid_merchant_payout');
    end if;

    if exists (
      select 1 from public.refunds r
      join public.payments p on p.id = r.payment_id
      where (p.renter_id = p_user_id or p.merchant_id = p_user_id)
        and r.status in ('pending', 'processing')
    ) then
      v_blocked := array_append(v_blocked, 'pending_refund');
    end if;

    if array_length(v_blocked, 1) > 0 then
      insert into public.account_erasure_log (user_id, requested_by, request_source, outcome, blocked_categories, completed_at)
      values (p_user_id, p_actor_id, p_request_source, 'blocked', v_blocked, null);

      v_result := jsonb_build_object('user_id', p_user_id, 'status', v_profile.account_status, 'blocked', true, 'blocked_categories', v_blocked);

      if p_idempotency_key is not null then
        insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
        values (p_actor_id, 'erase_account', p_idempotency_key, v_request_hash, v_result);
      end if;

      return v_result;
    end if;

    update public.profiles set
      full_name = 'Deleted User',
      display_name = 'Deleted User',
      business_name = null,
      phone = null,
      avatar_url = null,
      account_status = 'erased',
      status_reason = 'account_erased',
      status_changed_at = now(),
      status_changed_by = p_actor_id
    where id = p_user_id;

    update public.identity_verifications set
      legal_first_name = null,
      legal_surname = null,
      date_of_birth = null,
      id_reference_number = null,
      nationality = null,
      country_of_residence = null,
      residential_address = null,
      provider_reference = null
    where user_id = p_user_id;

    update public.email_deliveries set recipient_email = null where recipient_user_id = p_user_id;

    update public.listings set status = 'suspended'
    where merchant_id = p_user_id and status in ('draft', 'pending', 'active', 'paused');

    update public.marketplace_requests set status = 'closed'
    where requester_id = p_user_id and status in ('draft', 'active', 'offers_received');

    update public.barter_skill_task_posts set status = 'closed'
    where owner_id = p_user_id and status in ('draft', 'active', 'offers_received', 'paused');

    insert into public.account_erasure_log (user_id, requested_by, request_source, outcome, blocked_categories, completed_at)
    values (p_user_id, p_actor_id, p_request_source, 'completed', '{}', now());
  end if;

  v_result := jsonb_build_object('user_id', p_user_id, 'status', 'erased', 'blocked', false, 'already_erased', v_already_erased);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_id, 'erase_account', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
