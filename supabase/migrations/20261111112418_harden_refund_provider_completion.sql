-- ============================================================
-- E29 -- Provider-grounded refund completion & dispute disposition closure
-- ============================================================
-- Audit confirmed the core risk: complete_dispute_financial_
-- disposition() (E28/E28-R1) has zero awareness of the linked refund's
-- own state. For a refund_required disposition, an admin calling that
-- RPC immediately closes the disposition and clears the
-- financial_disposition_pending payout block -- with refunds.status
-- still 'pending' and no provider evidence of any kind that the
-- renter was ever actually refunded.
--
-- Separately, and just as important: `refunds.status = 'completed'`
-- was found to have ZERO trustworthy producer anywhere in this
-- codebase. The only thing that has ever set it is
-- scripts/verify-commissions-phase2.mjs's own
-- `admin.from('refunds').update({ status: 'completed' })` -- a raw,
-- unauthenticated, direct table UPDATE via the service-role client
-- that bypasses every RPC. Live inventory confirms all 217 "completed"
-- refunds in this database are exactly that script's own fixture
-- amounts (1000/400) against order_payment payments -- regression-test
-- artifacts, not real financial records, and (critically) NONE of
-- them link to any dispute_financial_dispositions row (that table has
-- zero rows live), so this migration's changes cannot retroactively
-- affect any of them. This migration therefore does NOT gate on the
-- existing `completed` status as if it were already trustworthy --
-- it builds a new, narrow, canonical authority first and makes the
-- disposition-completion path require it.
--
-- Provider architecture audit: public.PaymentProvider (src/lib/
-- payments/provider.ts) already defines refund(input): Promise<
-- RefundResult>, with RefundResult = {providerReference, status:
-- 'completed' | 'failed', failureReason?} -- a SYNCHRONOUS result,
-- not a pending-then-webhook shape. PeachPaymentsProvider throws
-- NotImplementedError on every method including this one (no live
-- provider integration exists); MockProvider implements it fully.
-- Separately, the live payments webhook route already explicitly,
-- permanently defers every refund-type provider event
-- ("refund_event_reconciliation_not_yet_implemented") -- a pre-
-- existing, disclosed, unrelated gap this migration does not touch
-- or attempt to complete. Given this, the only end-to-end-functional
-- completion path available today is the synchronous admin-triggered
-- API call this migration wires up -- not a webhook, not a
-- reconciliation sweep.
--
-- Two new canonical RPCs, mirroring the existing merchant-payout
-- mark_processing/mark_paid two-step pattern exactly (the same reason
-- it exists there: a provider call is a real side effect that must
-- not be re-attempted blindly on retry, and a crash mid-call must
-- leave an honest, visible intermediate state rather than silently
-- reverting to 'pending'):
--
--   start_refund_provider_attempt(): pending -> processing. Called by
--   the new orchestrator function immediately before the provider
--   call. A concurrent/retried call sees 'processing' (not 'pending')
--   and is rejected, rather than re-invoking the provider.
--
--   record_refund_provider_result(): processing -> completed/failed.
--   Called with the provider's own synchronous result. On 'completed':
--   (a) synchronizes payments.status via the EXISTING, reused
--   transition_payment_status() RPC (never a second cap/transition
--   formula -- this migration adds exactly one new computation, the
--   cumulative "completed refunds vs payment.amount" comparison that
--   decides refunded vs partially_refunded), and (b) auto-completes
--   the linked dispute_financial_dispositions row, if any and if still
--   'pending' -- the "preferred" design per the brief this migration
--   implements, since the whole path is atomic and idempotent. On
--   'failed': nothing else changes -- the disposition stays 'pending'
--   (payout stays blocked) and is never auto-converted to a manual
--   settlement.
--
-- Monotonic by construction: both RPCs require an exact starting
-- status (pending-only, processing-only respectively) and raise
-- rather than silently no-op on any other starting state -- a replay
-- with a matching idempotency_key still short-circuits to the cached
-- result first, so a genuine retry of the SAME request is always
-- safe; a stray call without one simply fails rather than regressing
-- or duplicating state. Neither RPC can ever move a disposition from
-- 'completed' back to 'pending'.
--
-- complete_dispute_financial_disposition() (E28) becomes type-aware,
-- its one remaining real purpose being the admin-attestation path for
-- manual_financial_settlement (now additionally requiring non-empty
-- completion notes) -- for refund_required it is hardened into a
-- fail-closed fallback that itself now requires refunds.status =
-- 'completed' (the new canonical authority) before proceeding, rather
-- than ever completing on admin say-so alone. no_financial_adjustment
-- is unaffected -- it is already 'completed' at creation and can never
-- reach this function in a 'pending' state.
--
-- Amount/payment-reference mismatch validation (the brief's own
-- Sections 25/53/54) is moot for this specific, synchronous call
-- shape: RefundResult carries no amount or payment identity at all,
-- and there is no separate inbound "event" to mismatch against --
-- the caller already knows exactly which refund/payment it is acting
-- on from its own prior lookup, the same way every other orchestrator
-- call in this codebase already works. That validation remains
-- necessary and undesigned for a FUTURE webhook-driven async
-- completion path, which this migration does not build (the same,
-- already-disclosed, pre-existing gap noted above).
--
-- E25 preserved: refund_required already cannot be created for a
-- booking with any escrow activity (E28-R1) -- unchanged, unreferenced
-- here. E18 preserved: no ledger_entries row is read, written, or
-- referenced anywhere in this migration -- a refund has never been a
-- ledgered event in this schema, and this migration does not make it
-- one.
--
-- search_path = '' for both new functions -- every reference is
-- already fully schema-qualified (public.refunds, public.payments,
-- public.transition_payment_status, public.dispute_financial_
-- dispositions, public.dispute_history, public.idempotency_keys,
-- and the two enum casts ::public.refund_status / ::public.
-- payment_status), so the strongest hardening form costs nothing.
-- complete_dispute_financial_disposition() keeps its existing
-- search_path = public (E28's own convention) -- CREATE OR REPLACE
-- changes only its body, never its header, for a function this
-- tightly coupled to the rest of E28/E28-R1's own search_path=public
-- family.
-- ============================================================

-- ── start_refund_provider_attempt(): pending -> processing ──
create or replace function public.start_refund_provider_attempt(
  p_admin_id uuid,
  p_refund_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin is required';
  end if;

  v_request_hash := md5(coalesce(p_refund_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'start_refund_provider_attempt' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_refund from public.refunds where id = p_refund_id for update;
  if v_refund.id is null then
    raise exception 'refund not found';
  end if;
  if v_refund.status <> 'pending' then
    raise exception 'refund is not pending a provider attempt';
  end if;

  update public.refunds set status = 'processing'::public.refund_status where id = p_refund_id;

  v_result := jsonb_build_object('refund_id', p_refund_id, 'status', 'processing');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'start_refund_provider_attempt', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
revoke all on function public.start_refund_provider_attempt(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.start_refund_provider_attempt(uuid, uuid, text) to service_role;

-- ── record_refund_provider_result(): processing -> completed/failed ──
create or replace function public.record_refund_provider_result(
  p_admin_id uuid,
  p_refund_id uuid,
  p_provider_status text,
  p_provider_reference text default null,
  p_failure_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund record;
  v_payment record;
  v_already_completed numeric(12,2);
  v_new_payment_status public.payment_status;
  v_disposition record;
  v_disposition_completed boolean := false;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin is required';
  end if;
  if p_provider_status not in ('completed', 'failed') then
    raise exception 'invalid provider status';
  end if;

  v_request_hash := md5(
    coalesce(p_refund_id::text, '') || '|' || coalesce(p_provider_status, '') || '|' ||
    coalesce(p_provider_reference, '') || '|' || coalesce(p_failure_reason, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'record_refund_provider_result' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, payment_id, amount, status into v_refund from public.refunds where id = p_refund_id for update;
  if v_refund.id is null then
    raise exception 'refund not found';
  end if;
  if v_refund.status <> 'processing' then
    raise exception 'refund is not awaiting a provider result';
  end if;

  update public.refunds
  set status = p_provider_status::public.refund_status, provider_reference = coalesce(p_provider_reference, provider_reference)
  where id = p_refund_id;

  if p_provider_status = 'completed' then
    select id, status, amount into v_payment from public.payments where id = v_refund.payment_id for update;

    select coalesce(sum(amount), 0) into v_already_completed
    from public.refunds
    where payment_id = v_refund.payment_id and status = 'completed';

    v_new_payment_status := case when v_already_completed >= v_payment.amount then 'refunded' else 'partially_refunded' end;

    -- Only synchronize payments.status when the payment is still in a
    -- state transition_payment_status() itself already considers valid
    -- for this target (captured/partially_captured/partially_refunded
    -- -> refunded/partially_refunded) -- e.g. a payment that somehow
    -- already carries a chargeback is left exactly as-is, never forced
    -- into an invalid transition.
    if v_payment.status in ('captured', 'partially_captured', 'partially_refunded') then
      perform public.transition_payment_status(v_payment.id, v_new_payment_status, p_provider_reference, null, 'system', null);
    end if;

    select * into v_disposition from public.dispute_financial_dispositions where refund_id = p_refund_id for update;
    if v_disposition.id is not null and v_disposition.status = 'pending' then
      update public.dispute_financial_dispositions
      set status = 'completed', completed_by = p_admin_id, completed_at = now()
      where id = v_disposition.id;

      insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
      values (
        v_disposition.dispute_id, p_admin_id, 'admin', 'financial_disposition_completed', 'pending', 'completed',
        jsonb_build_object('disposition_id', v_disposition.id, 'refund_id', p_refund_id, 'provider_reference', p_provider_reference), p_idempotency_key
      );
      v_disposition_completed := true;
    end if;
  end if;

  v_result := jsonb_build_object('refund_id', p_refund_id, 'status', p_provider_status, 'disposition_completed', v_disposition_completed);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'record_refund_provider_result', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
revoke all on function public.record_refund_provider_result(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_refund_provider_result(uuid, uuid, text, text, text, text) to service_role;

-- ── complete_dispute_financial_disposition(): type-aware hardening ──
create or replace function public.complete_dispute_financial_disposition(
  p_admin_id uuid,
  p_dispute_id uuid,
  p_completion_notes text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_disposition record;
  v_refund_status refund_status;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin is required';
  end if;

  v_request_hash := md5(coalesce(p_dispute_id::text, '') || '|' || coalesce(p_completion_notes, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'complete_dispute_financial_disposition' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_disposition from public.dispute_financial_dispositions where dispute_id = p_dispute_id for update;
  if v_disposition.id is null then
    raise exception 'no financial disposition exists for this dispute';
  end if;
  if v_disposition.status <> 'pending' then
    raise exception 'this financial disposition is not pending completion';
  end if;

  -- E29: type-aware completion authority.
  if v_disposition.disposition_type = 'refund_required' then
    select status into v_refund_status from public.refunds where id = v_disposition.refund_id;
    if v_refund_status is distinct from 'completed' then
      raise exception 'the linked refund has not been authoritatively completed by the payment provider yet';
    end if;
  elsif v_disposition.disposition_type = 'manual_financial_settlement' then
    if p_completion_notes is null or length(trim(p_completion_notes)) = 0 then
      raise exception 'completion notes are required for a manual financial settlement';
    end if;
  end if;

  update public.dispute_financial_dispositions
  set status = 'completed', completed_by = p_admin_id, completed_at = now()
  where id = v_disposition.id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_dispute_id, p_admin_id, 'admin', 'financial_disposition_completed', 'pending', 'completed',
    jsonb_build_object('disposition_id', v_disposition.id, 'completion_notes', p_completion_notes), p_idempotency_key
  );

  v_result := jsonb_build_object('disposition_id', v_disposition.id, 'dispute_id', p_dispute_id, 'status', 'completed');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'complete_dispute_financial_disposition', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
revoke all on function public.complete_dispute_financial_disposition(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_dispute_financial_disposition(uuid, uuid, text, text) to service_role;
