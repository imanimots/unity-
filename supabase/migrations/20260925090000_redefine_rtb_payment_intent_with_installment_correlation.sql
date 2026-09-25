-- ============================================================
-- Unity -- RTB Payment Intent: Durable Installment Correlation (P5D-M2)
-- ============================================================
-- P5D-B.2-A/D found that an RTB installment payment has no durable
-- link to its specific `rent_to_buy_installments` row/sequence before
-- asynchronous provider handoff -- record_rent_to_buy_installment_payment
-- (20260827000005_rtb_rpcs.sql) is the ONLY thing that ever writes
-- rent_to_buy_installments.payment_id, so there is no safe reverse
-- lookup for an in-flight (not-yet-recorded) payment. Two candidate
-- fixes were audited and rejected before landing on this one:
--   - pre-linking rent_to_buy_installments.payment_id at intent
--     creation: UNSAFE. chargeRentToBuyInstallment() has no
--     existing-payment check (unlike chargeRentToBuyDeposit(), which
--     does) -- every retry for a not-yet-paid installment with no/a
--     different idempotency key creates a genuinely NEW payments row.
--     A single shared pointer on the installment would have to be
--     overwritten per attempt, risking a stale, out-of-order webhook
--     for an abandoned earlier attempt clobbering a newer one's link.
--   - deriving sequence from Peach metadata or the idempotency-key
--     string: rejected outright -- provider metadata is supporting
--     evidence only, never authoritative Unity-owned correlation, and
--     an idempotency key is an optional, caller-controlled string with
--     no durable-contract guarantee.
--
-- This migration instead scopes correlation to the SPECIFIC payment
-- row via the existing, previously-unused payments.metadata jsonb
-- column (present since 20260801000002_payment_schema.sql, written by
-- zero callers anywhere in this codebase until now) -- no new table,
-- column, index, or constraint. Correlation is 1:1 with the payment
-- row itself, so multiple independent attempts for the same
-- installment each carry their own correct, independent, immutable
-- correlation value -- no shared pointer, no overwrite risk.
--
-- Deliberately a narrow, typed p_installment_sequence integer, not a
-- generic p_metadata jsonb parameter -- this RPC constructs the
-- permitted metadata shape itself; no caller can submit arbitrary JSON
-- through it.
--
-- Source-only this phase -- NOT applied to any database.
-- ============================================================

-- ------------------------------------------------------------
-- The existing 8-parameter signature is a genuinely different
-- PostgreSQL function identity from the corrected 9-parameter one
-- below -- CREATE OR REPLACE alone would leave both callable
-- simultaneously as separate overloads. No object in this codebase
-- depends on the old signature (confirmed: it is referenced only in
-- its own defining migration, 20260827000007_rtb_payment_intent.sql --
-- no COMMENT ON FUNCTION, no view, no other SQL object; application
-- callers invoke it by name via PostgREST at runtime, which carries no
-- hard schema-level dependency), so a plain DROP (no CASCADE) is safe.
-- ------------------------------------------------------------
drop function if exists public.create_rent_to_buy_payment_intent(uuid, uuid, uuid, text, numeric, text, text, text);

-- ------------------------------------------------------------
-- CREATE_RENT_TO_BUY_PAYMENT_INTENT -- corrected signature.
--
-- p_installment_sequence is optional/defaulted (null) so the currently
-- deployed application code (which does not yet pass it) keeps working
-- unchanged through this migration's own rollout -- STATE 1 in the
-- phase report's deployment-compatibility analysis: this migration may
-- be applied before the application code that starts passing the
-- sequence is deployed, and nothing breaks in between. The reverse
-- ordering (new application code depending on this signature, deployed
-- before this migration exists) is never valid and is not this
-- migration's concern to prevent -- it is a deployment-sequencing rule
-- for the next phase.
--
-- Validation: a supplied sequence must be a positive integer, and is
-- only ever meaningful for 'rent_to_buy_installment' -- supplying one
-- for any other payment_type (in particular 'rent_to_buy_deposit',
-- which has no installment concept at all) is rejected outright rather
-- than silently stored on an unrelated payment.
--
-- Idempotency: p_installment_sequence is folded into v_request_hash
-- alongside every other request-identity field already hashed here.
-- This is what makes the existing idempotency-key mechanism -- entirely
-- unchanged in its own logic -- automatically produce the three
-- required safe states for a replayed request with the same
-- idempotency key:
--   - same sequence  -> same hash -> returns the cached result
--     (idempotent success; the original insert already wrote the
--     correlation, so there is nothing left to backfill)
--   - different sequence -> different hash -> the EXISTING
--     'idempotency key already used with a different request'
--     exception fires -- a controlled conflict, never a silent
--     overwrite, never a silent return as though the row belonged to
--     the new sequence
-- A backfill path for "existing row found, correlation missing" was
-- considered and found NOT NEEDED: this RPC's only replay mechanism is
-- the idempotency-key cache-hit, which returns the previously-computed
-- result verbatim without re-executing the insert -- there is no
-- reachable state where a row exists via this RPC without its
-- correlation (or intentional absence of one, for non-installment
-- payments) already correctly set in the same original transaction.
-- A caller retrying with NO idempotency key at all does not hit this
-- path either way -- it creates an independent new payment row with
-- its own independently-correct correlation, exactly the multiple-
-- payment-intents-per-installment scenario this design already
-- tolerates by scoping correlation per-row rather than per-installment.
-- ------------------------------------------------------------
create or replace function public.create_rent_to_buy_payment_intent(
  p_rent_to_buy_agreement_id uuid,
  p_payer_id uuid,
  p_counterparty_id uuid,
  p_payment_type text,
  p_amount numeric,
  p_currency text default 'ZAR',
  p_provider text default 'mock',
  p_idempotency_key text default null,
  p_installment_sequence integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_hash text;
  v_idem record;
  v_payment_id uuid;
  v_result jsonb;
  v_metadata jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_payment_type not in ('rent_to_buy_installment', 'rent_to_buy_deposit') then
    raise exception 'invalid payment type for a rent-to-buy payment intent';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount';
  end if;
  if p_installment_sequence is not null then
    if p_installment_sequence <= 0 then
      raise exception 'installment sequence must be a positive integer';
    end if;
    if p_payment_type <> 'rent_to_buy_installment' then
      raise exception 'installment sequence is only valid for rent_to_buy_installment payments';
    end if;
  end if;

  v_request_hash := md5(
    coalesce(p_rent_to_buy_agreement_id::text, '') || '|' || coalesce(p_payment_type, '') || '|' ||
    coalesce(p_amount::text, '') || '|' || coalesce(p_currency, '') || '|' || coalesce(p_provider, '') || '|' ||
    coalesce(p_installment_sequence::text, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_payer_id and operation = 'create_rent_to_buy_payment_intent' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  -- Server-constructed only -- the caller supplies a typed integer,
  -- never arbitrary JSON. Non-installment payments (and installment
  -- payments with no sequence supplied) get the column's own existing
  -- default shape, byte-for-byte unchanged from before this migration.
  v_metadata := case when p_installment_sequence is not null
    then jsonb_build_object('rent_to_buy_installment_sequence', p_installment_sequence)
    else '{}'::jsonb
  end;

  insert into public.payments (rent_to_buy_agreement_id, renter_id, merchant_id, payment_type, status, amount, currency, provider, idempotency_key, metadata)
  values (p_rent_to_buy_agreement_id, p_payer_id, p_counterparty_id, p_payment_type::payment_type, 'pending', p_amount, coalesce(p_currency, 'ZAR'), coalesce(p_provider, 'mock'), p_idempotency_key, v_metadata)
  returning id into v_payment_id;

  insert into public.payment_events (payment_id, actor_type, event_type, previous_status, new_status, idempotency_key)
  values (v_payment_id, 'system', 'payment_intent_created', null, 'pending', p_idempotency_key);

  -- Return contract unchanged from before this migration -- callers
  -- never need to parse anything new to get the benefit of durable
  -- correlation; it is read later, directly from payments.metadata,
  -- not from this RPC's own response.
  v_result := jsonb_build_object('payment_id', v_payment_id);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_payer_id, 'create_rent_to_buy_payment_intent', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.create_rent_to_buy_payment_intent(uuid, uuid, uuid, text, numeric, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.create_rent_to_buy_payment_intent(uuid, uuid, uuid, text, numeric, text, text, text, integer) to service_role;
