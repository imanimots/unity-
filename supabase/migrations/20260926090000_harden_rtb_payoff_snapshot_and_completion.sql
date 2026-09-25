-- ============================================================
-- Unity -- RTB Payoff: Durable Snapshot + Idempotent Completion (P5D-M3)
-- ============================================================
-- P5D-B.2-P found that .../payoff/route.ts creates ONE payment covering
-- the SUM of multiple currently-scheduled installments, which the
-- P5D-M2 single p_installment_sequence contract cannot represent, and
-- that payoff_rent_to_buy_agreement() completes by re-querying "whatever
-- is scheduled now" at completion time rather than acting on a frozen
-- snapshot of what the shopper actually paid for -- safe only because
-- the current route is still fully synchronous (query and mutation are
-- adjacent, inside one request); unsafe the moment payoff completion
-- moves to an async webhook, days after intent creation, when the
-- schedule may have changed via another path.
--
-- This migration is SQL/RPC foundation only -- it does not fix the
-- application route's separate, more severe requires_action-treated-as-
-- success defect (P5D-B.2-P critical finding); that is P5D-B.2
-- application work, gated on this migration passing its own read-only
-- review.
--
-- Source-only this phase -- NOT applied to any database.
-- ============================================================

-- ------------------------------------------------------------
-- A. CREATE_RENT_TO_BUY_PAYMENT_INTENT -- adds a payoff snapshot.
--
-- The P5D-M2 9-parameter signature is a genuinely different PostgreSQL
-- function identity from the corrected 10-parameter one below --
-- CREATE OR REPLACE alone would leave both callable as separate
-- overloads. No object in this codebase depends on the 9-arg signature
-- (confirmed: referenced only in its own defining migration,
-- 20260925090000 -- no COMMENT ON FUNCTION, no view, no other SQL
-- object; PostgREST callers invoke by name, carrying no hard
-- schema-level dependency), so a plain DROP (no CASCADE) is safe.
--
-- p_payoff_sequences integer[] default null is the new correlation
-- input, alongside the existing p_installment_sequence integer. Exactly
-- one of the two may be populated for a rent_to_buy_installment payment
-- (LEGACY: neither populated, temporarily accepted for backward
-- compatibility while the old application/route are still being
-- migrated -- see P5D-M2-R/P5D-B.2-P; both populated is rejected
-- outright). Neither may be populated for rent_to_buy_deposit.
--
-- The supplied array is canonicalized (sorted ascending, duplicates
-- rejected rather than silently removed) before it is used for
-- validation, the request hash, or metadata storage, so [4,2,3] and
-- [2,3,4] are the same request identity and the same stored snapshot,
-- while [2,3,5] is a genuinely different one.
--
-- Every supplied sequence is verified, under this same statement, to
-- belong to p_rent_to_buy_agreement_id, to exist, and to currently be
-- 'scheduled' -- a sequence that doesn't exist, belongs to another
-- agreement, or isn't scheduled is rejected outright (no partial
-- snapshot, no silent narrowing). p_amount is then required to equal
-- the EXACT sum of those rows' principal_amount -- this binds the
-- amount the shopper is charged to the exact frozen installment set,
-- so completion never has to fall back to "whatever is still unpaid" as
-- amount authority.
-- ------------------------------------------------------------
drop function if exists public.create_rent_to_buy_payment_intent(uuid, uuid, uuid, text, numeric, text, text, text, integer);

create or replace function public.create_rent_to_buy_payment_intent(
  p_rent_to_buy_agreement_id uuid,
  p_payer_id uuid,
  p_counterparty_id uuid,
  p_payment_type text,
  p_amount numeric,
  p_currency text default 'ZAR',
  p_provider text default 'mock',
  p_idempotency_key text default null,
  p_installment_sequence integer default null,
  p_payoff_sequences integer[] default null
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
  v_canonical_payoff integer[];
  v_supplied_count integer;
  v_matched_count integer;
  v_payoff_sum numeric(12,2);
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

  if p_installment_sequence is not null and p_payoff_sequences is not null then
    raise exception 'a payment cannot carry both a single installment sequence and a payoff sequence set';
  end if;

  if p_installment_sequence is not null then
    if p_installment_sequence <= 0 then
      raise exception 'installment sequence must be a positive integer';
    end if;
    if p_payment_type <> 'rent_to_buy_installment' then
      raise exception 'installment sequence is only valid for rent_to_buy_installment payments';
    end if;
  end if;

  if p_payoff_sequences is not null then
    if p_payment_type <> 'rent_to_buy_installment' then
      raise exception 'payoff sequence set is only valid for rent_to_buy_installment payments';
    end if;
    if array_length(p_payoff_sequences, 1) is null then
      raise exception 'payoff sequence set must not be empty';
    end if;
    if exists (select 1 from unnest(p_payoff_sequences) s where s is null) then
      raise exception 'payoff sequence set must not contain null elements';
    end if;
    if exists (select 1 from unnest(p_payoff_sequences) s where s <= 0) then
      raise exception 'payoff sequence set must contain only positive integers';
    end if;

    select count(*) into v_supplied_count from unnest(p_payoff_sequences) s;
    select array_agg(distinct s order by s) into v_canonical_payoff from unnest(p_payoff_sequences) s;
    if v_supplied_count <> array_length(v_canonical_payoff, 1) then
      raise exception 'payoff sequence set must not contain duplicate sequence values';
    end if;

    select count(*), coalesce(sum(principal_amount), 0)
      into v_matched_count, v_payoff_sum
      from public.rent_to_buy_installments
      where agreement_id = p_rent_to_buy_agreement_id
        and sequence = any(v_canonical_payoff)
        and status = 'scheduled';

    if v_matched_count <> array_length(v_canonical_payoff, 1) then
      raise exception 'one or more payoff sequences do not exist, do not belong to this agreement, or are not currently scheduled';
    end if;

    if p_amount is distinct from v_payoff_sum then
      raise exception 'payoff amount must equal the exact sum of the snapshotted installment principal amounts';
    end if;
  end if;

  v_request_hash := md5(
    coalesce(p_rent_to_buy_agreement_id::text, '') || '|' || coalesce(p_payment_type, '') || '|' ||
    coalesce(p_amount::text, '') || '|' || coalesce(p_currency, '') || '|' || coalesce(p_provider, '') || '|' ||
    coalesce(p_installment_sequence::text, '') || '|' ||
    coalesce(array_to_string(v_canonical_payoff, ','), '')
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

  -- Server-constructed only -- callers supply typed integers, never
  -- arbitrary JSON. Exactly one correlation key is ever stored; a
  -- payment never carries both.
  v_metadata := case
    when v_canonical_payoff is not null then jsonb_build_object('rent_to_buy_payoff_sequences', to_jsonb(v_canonical_payoff))
    when p_installment_sequence is not null then jsonb_build_object('rent_to_buy_installment_sequence', p_installment_sequence)
    else '{}'::jsonb
  end;

  insert into public.payments (rent_to_buy_agreement_id, renter_id, merchant_id, payment_type, status, amount, currency, provider, idempotency_key, metadata)
  values (p_rent_to_buy_agreement_id, p_payer_id, p_counterparty_id, p_payment_type::payment_type, 'pending', p_amount, coalesce(p_currency, 'ZAR'), coalesce(p_provider, 'mock'), p_idempotency_key, v_metadata)
  returning id into v_payment_id;

  insert into public.payment_events (payment_id, actor_type, event_type, previous_status, new_status, idempotency_key)
  values (v_payment_id, 'system', 'payment_intent_created', null, 'pending', p_idempotency_key);

  v_result := jsonb_build_object('payment_id', v_payment_id);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_payer_id, 'create_rent_to_buy_payment_intent', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.create_rent_to_buy_payment_intent(uuid, uuid, uuid, text, numeric, text, text, text, integer, integer[]) from public, anon, authenticated;
grant execute on function public.create_rent_to_buy_payment_intent(uuid, uuid, uuid, text, numeric, text, text, text, integer, integer[]) to service_role;

-- ------------------------------------------------------------
-- B. PAYOFF_RENT_TO_BUY_AGREEMENT -- snapshot-driven, idempotent.
--
-- Signature is UNCHANGED (p_actor_user_id, p_agreement_id, p_payment_id,
-- p_idempotency_key) -- no new input is needed, so this is CREATE OR
-- REPLACE only, no DROP, no overload cleanup required. p_idempotency_key
-- remains accepted but intentionally unused: replay safety is fully
-- solved by re-classifying the persisted payment/installment state on
-- every call (natural, state-based idempotency), which is the narrowest
-- correct strategy -- adding a key-based lookup table here would be
-- complexity for its own sake, not for correctness.
--
-- The completion target is no longer "whatever is currently scheduled
-- for this agreement" -- it is read exclusively from the payment row's
-- own durable payoff snapshot (payments.metadata.rent_to_buy_
-- payoff_sequences), set once, before provider handoff, by
-- create_rent_to_buy_payment_intent above. Every snapshotted sequence
-- is classified before any write:
--   A. still 'scheduled'                    -> eligible to complete
--   B. 'paid' by THIS SAME payment_id        -> already-completed retry
--   C. 'paid' by a DIFFERENT payment_id      -> financial conflict
-- Any category-C row aborts the whole call with a structured
-- payment_conflict result BEFORE any installment or agreement row is
-- touched -- never a partial completion followed by a conflict, never
-- an overwritten payment_id, never a substituted "pay off whatever else
-- is unpaid instead" fallback, never an ownership transfer. No refund,
-- credit, or other correction logic is invented here -- Rule: this
-- indicates a possible duplicate financial payment and is manual-review
-- territory (P5D-B.2-P S26/28).
--
-- The agreement row lock (SELECT ... FOR UPDATE, unchanged from the
-- original) is what makes this safe under concurrency:
-- record_rent_to_buy_installment_payment and this function both lock
-- the SAME agreement row before touching any installment, so two
-- concurrent completions for overlapping installments cannot interleave
-- -- whichever transaction commits first "wins" the affected rows'
-- 'scheduled' status, and the second transaction's own classification
-- query naturally sees the post-commit state, never a stale one.
--
-- A category-A/B-only snapshot additionally requires
-- payments.amount to equal the exact snapshot principal sum before any
-- write -- the payment amount is authoritative, never a recalculated
-- moving balance (P5D-B.2-P S23/27/29).
--
-- Legacy payoff payments (created before this migration, metadata =
-- {}) and any payment whose metadata shape doesn't match a payoff at
-- all (missing rent_to_buy_payoff_sequences, or carrying the single-
-- installment key instead) resolve to a structured invalid_snapshot
-- result -- never inferred from "all currently unpaid installments"
-- (P5D-B.2-P S31: no backfill, no guessing, manual review only).
-- ------------------------------------------------------------
create or replace function public.payoff_rent_to_buy_agreement(
  p_actor_user_id uuid, p_agreement_id uuid, p_payment_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_payment record;
  v_snapshot integer[];
  v_snapshot_count integer;
  v_scheduled_count integer;
  v_same_payment_count integer;
  v_other_payment_count integer;
  v_matched_count integer;
  v_snapshot_sum numeric(12,2);
  v_conflicting_sequences integer[];
  v_conflicting_payment_ids uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.customer_id <> p_actor_user_id then raise exception 'not the customer of this agreement'; end if;
  if not v_agreement.early_payoff_allowed then raise exception 'early payoff is not allowed under this agreement''s accepted terms'; end if;
  if v_agreement.status not in ('active', 'completed') then
    raise exception 'agreement is in status % and is not eligible for payoff', v_agreement.status;
  end if;

  select * into v_payment from public.payments where id = p_payment_id;
  if v_payment.id is null then raise exception 'payment not found'; end if;
  if v_payment.rent_to_buy_agreement_id is distinct from p_agreement_id then raise exception 'payment does not belong to this agreement'; end if;
  if v_payment.payment_type <> 'rent_to_buy_installment' then raise exception 'payment is not a rent-to-buy installment/payoff payment'; end if;
  if v_payment.status <> 'captured' then raise exception 'payment has not been captured'; end if;

  if v_payment.metadata ? 'rent_to_buy_installment_sequence' then
    return jsonb_build_object('agreement_id', p_agreement_id, 'payment_id', p_payment_id, 'status', 'invalid_snapshot', 'reason', 'this payment carries a single-installment correlation, not a payoff snapshot');
  end if;
  if not (v_payment.metadata ? 'rent_to_buy_payoff_sequences') then
    return jsonb_build_object('agreement_id', p_agreement_id, 'payment_id', p_payment_id, 'status', 'invalid_snapshot', 'reason', 'no payoff correlation snapshot found for this payment');
  end if;

  select array_agg(elem::integer order by elem::integer)
    into v_snapshot
    from jsonb_array_elements_text(v_payment.metadata -> 'rent_to_buy_payoff_sequences') as elem;

  v_snapshot_count := coalesce(array_length(v_snapshot, 1), 0);
  if v_snapshot_count = 0 then
    return jsonb_build_object('agreement_id', p_agreement_id, 'payment_id', p_payment_id, 'status', 'invalid_snapshot', 'reason', 'payoff correlation snapshot is empty');
  end if;

  select
    count(*) filter (where status = 'scheduled'),
    count(*) filter (where status = 'paid' and payment_id = p_payment_id),
    count(*) filter (where status = 'paid' and payment_id is distinct from p_payment_id),
    coalesce(sum(principal_amount) filter (where status = 'scheduled'), 0) + coalesce(sum(principal_amount) filter (where status = 'paid' and payment_id = p_payment_id), 0),
    coalesce(array_agg(sequence) filter (where status = 'paid' and payment_id is distinct from p_payment_id), array[]::integer[]),
    coalesce(array_agg(payment_id) filter (where status = 'paid' and payment_id is distinct from p_payment_id), array[]::uuid[])
  into v_scheduled_count, v_same_payment_count, v_other_payment_count, v_snapshot_sum, v_conflicting_sequences, v_conflicting_payment_ids
  from public.rent_to_buy_installments
  where agreement_id = p_agreement_id and sequence = any(v_snapshot);

  v_matched_count := v_scheduled_count + v_same_payment_count + v_other_payment_count;
  if v_matched_count <> v_snapshot_count then
    return jsonb_build_object('agreement_id', p_agreement_id, 'payment_id', p_payment_id, 'status', 'invalid_snapshot', 'reason', 'one or more snapshotted sequences no longer exist or do not belong to this agreement');
  end if;

  if v_other_payment_count > 0 then
    return jsonb_build_object(
      'agreement_id', p_agreement_id, 'payment_id', p_payment_id, 'status', 'payment_conflict',
      'conflicting_sequences', to_jsonb(v_conflicting_sequences), 'conflicting_payment_ids', to_jsonb(v_conflicting_payment_ids)
    );
  end if;

  if v_payment.amount is distinct from v_snapshot_sum then
    return jsonb_build_object('agreement_id', p_agreement_id, 'payment_id', p_payment_id, 'status', 'invalid_snapshot', 'reason', 'payment amount does not match the exact snapshot principal sum');
  end if;

  if v_scheduled_count = 0 then
    -- Every snapshotted row is already 'paid' by THIS SAME payment --
    -- an idempotent retry after a prior successful completion.
    return jsonb_build_object('agreement_id', p_agreement_id, 'payment_id', p_payment_id, 'status', 'already_completed', 'amount_paid', v_snapshot_sum);
  end if;

  update public.rent_to_buy_installments set status = 'paid', payment_id = p_payment_id, paid_at = now()
  where agreement_id = p_agreement_id and sequence = any(v_snapshot) and status = 'scheduled';

  perform public._rent_to_buy_history(p_agreement_id, 'customer', p_actor_user_id, 'paid_off', 'active', 'active', jsonb_build_object('sequences', to_jsonb(v_snapshot), 'payment_id', p_payment_id));

  update public.rent_to_buy_agreements
  set ownership_status = 'customer_owned', status = 'completed', ownership_transferred_at = now()
  where id = p_agreement_id and ownership_status = 'merchant_owned';
  if found then
    perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'ownership_transferred', 'merchant_owned', 'customer_owned', jsonb_build_object('via', 'early_payoff'));
  end if;

  return jsonb_build_object('agreement_id', p_agreement_id, 'payment_id', p_payment_id, 'status', 'completed', 'amount_paid', v_snapshot_sum);
end;
$$;

revoke all on function public.payoff_rent_to_buy_agreement(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.payoff_rent_to_buy_agreement(uuid, uuid, uuid, text) to service_role;
