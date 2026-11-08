-- ============================================================
-- E28 -- Booking dispute financial-disposition authority
-- ============================================================
-- A fresh audit (continuing E23's own explicitly-deferred finding)
-- confirmed the exact gap: resolve_dispute() restores a booking to
-- its pre-dispute status for EVERY outcome (favor_raiser,
-- favor_respondent, mutual_agreement, manual_settlement) -- but
-- records no structured financial consequence of that decision.
-- `outcome` is a bare label and `resolution_notes` is free text,
-- neither of which is financial authority. The only existing refund
-- authority, create_refund(), has ZERO real application caller
-- anywhere in this codebase (grepped exhaustively -- the only caller
-- is a regression script) and no provider-execution path exists at
-- all: the payments webhook route explicitly defers every refund
-- event ("no RPC exists yet to transition refunds.status from
-- provider evidence"), so a refunds row can never leave 'pending'.
-- Separately, and more importantly: the booking merchant-payout
-- safety gates never query the `refunds` table at all -- they only
-- check payments.status/escrow_transactions.status, neither of which
-- create_refund() ever touches. Net effect, confirmed live and by
-- direct source read: a booking dispute can be resolved
-- favor_raiser/mutual_agreement/manual_settlement, the booking
-- restored to 'completed', and its merchant payout can reach 'paid'
-- with a dangling, never-executed refund sitting in the dispute's
-- history and zero technical distinction from favor_respondent.
--
-- Outcome and financial disposition are kept as separate concepts.
-- `disputes.outcome` continues to mean exactly what it already means
-- (who/how the dispute was decided) and is NOT touched here. This
-- migration adds one new, narrow, 1:1 record of what money must
-- happen as a *separate*, always-explicit admin decision -- never
-- inferred from the outcome string, and never required to be a
-- refund merely because the raiser was favored (a party can win a
-- dispute without a monetary remedy being appropriate).
--
-- open_dispute() already proves the outcome is relative, not
-- absolute: either booking party may raise a dispute (raised_by =
-- renter_id OR merchant_id), so favor_raiser means "favor whoever
-- raised THIS dispute" -- never "favor the renter". The respondent is
-- computed in open_dispute()'s own body but never persisted (no
-- respondent_id column exists anywhere in the schema, confirmed by
-- grep). This migration does not need to resolve that ambiguity
-- itself, because the new disposition record never derives a favored
-- party from the outcome at all -- an admin enters disposition_type
-- and amount directly, exactly once, as its own explicit decision.
--
-- Three disposition types, chosen after auditing the existing,
-- already-documented product intent (docs/DISPUTE_SYSTEM.md's own
-- "Future payment integration" section already anticipated
-- "mutual_agreement/manual_settlement would need an explicit
-- admin-entered settlement amount" -- not invented here, confirmed
-- pre-existing):
--   no_financial_adjustment    -- no money moves; reason required
--   refund_required            -- a specific amount is refunded from
--                                  the booking's rental_charge payment,
--                                  via create_refund() itself (reused,
--                                  never bypassed -- see Section 38 of
--                                  the brief this migration implements)
--   manual_financial_settlement -- an explicit, admin-entered amount
--                                  settled outside the refund path
--                                  (e.g. mutual_agreement/manual_
--                                  settlement outcomes) -- recorded for
--                                  audit only; this migration never
--                                  invents an execution mechanism for
--                                  it that doesn't already exist.
--
-- Fail-closed by construction: refund_required and
-- manual_financial_settlement are created in status='pending' and
-- can only reach 'completed' through a SEPARATE, explicit admin
-- action (complete_dispute_financial_disposition) -- this is a
-- deliberate design choice, not an oversight: since no provider
-- completion signal exists anywhere in this codebase today (see
-- above), the only honest way to represent "this refund/settlement
-- actually happened" is an explicit admin attestation, exactly
-- mirroring every other "requires manual reconciliation, never
-- auto-resolved" category already established in this codebase (e.g.
-- the payments webhook route's own deferred-refund-event handling,
-- late_successful_provider_event, order_cancelled_with_unresolved_
-- payment). no_financial_adjustment needs no further action and is
-- created already-completed.
--
-- The merchant-payout safety gates (_merchant_payout_full_eligibility_
-- block, _merchant_payout_still_safe_to_pay_block) now block a
-- booking's payout while any of its disputes has a disposition row
-- still 'pending' -- closing the exact race above. This check fires
-- ONLY when a dispute_financial_dispositions row genuinely EXISTS and
-- is pending -- never merely because a resolved dispute has no
-- disposition row at all. This is deliberate: a fresh, read-only,
-- aggregate audit of the 78 live, pre-existing booking disputes with
-- a non-respondent outcome (50 favor_raiser + 14 mutual_agreement + 14
-- manual_settlement) found 35 with a 'pending' merchant_payout and 43
-- with a 'processing' one, zero 'paid', zero refunds rows, zero
-- refunded payments. None of them will ever gain a disposition row
-- (nothing backfills one), so none of their payouts are newly blocked
-- by this migration -- exactly preserving the brief's own "no
-- historical reinterpretation" requirement. Only a booking dispute
-- resolved through the new admin flow going forward can ever produce
-- a 'pending' disposition for the gate to see.
--
-- RTB is untouched: both gate functions' rent_to_buy_agreement_id
-- branches are reproduced byte-for-byte; E24's conservation and E26's
-- optional-escrow compatibility are not read, referenced, or affected.
-- Orders and barter are untouched -- this migration adds no column,
-- table, or check referencing either domain.
--
-- The booking exception-candidate RPC (_merchant_payout_exception_
-- candidates) is widened with the matching context field and
-- predicate so this new blocker is immediately operationally visible
-- to admins -- deliberately not repeating E27's own "canonically
-- blocked but invisible" mistake for a brand-new category on day one.
-- Its RETURNS TABLE shape changes, so DROP + CREATE is required
-- (Postgres does not allow changing a function's return columns via
-- CREATE OR REPLACE) -- every existing field, join, and predicate is
-- reproduced byte-for-byte; only the one new field/predicate is added.
--
-- E18 (ledger immutability), E25 (escrow partial-refund containment)
-- are not referenced by this migration at all. E23's booking branch
-- payment/escrow-refund checks in both gate functions are reproduced
-- byte-for-byte, unchanged, immediately above the new check.
-- ============================================================

-- ── dispute_financial_dispositions ──────────────────────────
-- 1:1 with disputes (enforced by the unique constraint on dispute_id,
-- not a generic financial ledger). Mirrors dispute_history's own RLS
-- shape exactly: participant read + admin read, zero client write
-- policies -- every mutation goes through the two RPCs below.
create table if not exists public.dispute_financial_dispositions (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null unique references public.disputes(id),
  disposition_type text not null check (disposition_type in ('no_financial_adjustment', 'refund_required', 'manual_financial_settlement')),
  amount numeric(12,2) check (amount > 0),
  refund_id uuid references public.refunds(id),
  status text not null default 'pending' check (status in ('pending', 'completed')),
  reason text not null check (length(trim(reason)) > 0),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  completed_by uuid references public.profiles(id),
  completed_at timestamptz,
  constraint dispute_financial_dispositions_amount_chk check (
    (disposition_type = 'no_financial_adjustment' and amount is null)
    or (disposition_type in ('refund_required', 'manual_financial_settlement') and amount is not null)
  ),
  constraint dispute_financial_dispositions_refund_link_chk check (
    refund_id is null or disposition_type = 'refund_required'
  ),
  constraint dispute_financial_dispositions_completion_chk check (
    (status = 'completed') = (completed_at is not null)
  ),
  constraint dispute_financial_dispositions_completed_by_chk check (
    completed_at is null or completed_by is not null
  )
);

create index if not exists dispute_financial_dispositions_dispute_idx on public.dispute_financial_dispositions(dispute_id);
create index if not exists dispute_financial_dispositions_status_idx on public.dispute_financial_dispositions(status);

alter table public.dispute_financial_dispositions enable row level security;

create policy "dispute_financial_dispositions: parties read"
  on public.dispute_financial_dispositions for select
  using (public.is_dispute_participant(dispute_id, auth.uid()));

create policy "dispute_financial_dispositions: admin read"
  on public.dispute_financial_dispositions for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

drop trigger if exists dispute_financial_dispositions_immutable on public.dispute_financial_dispositions;
create trigger dispute_financial_dispositions_immutable
  before delete on public.dispute_financial_dispositions
  for each row execute function public.prevent_row_mutation();

-- ── record_dispute_financial_disposition ────────────────────
-- Admin-only, service_role-reachable, idempotency-keyed (same
-- generic idempotency_keys pattern every other dispute RPC uses).
-- Booking-scoped by construction -- raises if the dispute does not
-- reference a booking, rather than silently widening to order/barter/
-- RTB (explicitly out of scope, per the brief this implements).
create or replace function public.record_dispute_financial_disposition(
  p_admin_id uuid,
  p_dispute_id uuid,
  p_disposition_type text,
  p_amount numeric default null,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute record;
  v_payment record;
  v_request_hash text;
  v_idem record;
  v_disposition_id uuid;
  v_refund_id uuid;
  v_status text;
  v_completed_by uuid;
  v_completed_at timestamptz;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin is required';
  end if;
  if p_disposition_type not in ('no_financial_adjustment', 'refund_required', 'manual_financial_settlement') then
    raise exception 'invalid disposition type';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required';
  end if;
  if p_disposition_type = 'no_financial_adjustment' and p_amount is not null then
    raise exception 'no_financial_adjustment must not carry an amount';
  end if;
  if p_disposition_type in ('refund_required', 'manual_financial_settlement') and (p_amount is null or p_amount <= 0) then
    raise exception 'a positive amount is required for this disposition type';
  end if;

  v_request_hash := md5(coalesce(p_dispute_id::text, '') || '|' || coalesce(p_disposition_type, '') || '|' || coalesce(p_amount::text, '') || '|' || coalesce(p_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'record_dispute_financial_disposition' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, booking_id, status into v_dispute from public.disputes where id = p_dispute_id for update;
  if v_dispute.id is null then
    raise exception 'dispute not found';
  end if;
  if v_dispute.booking_id is null then
    raise exception 'financial disposition is only supported for booking disputes';
  end if;
  if v_dispute.status not in ('resolved', 'closed') then
    raise exception 'a dispute must be resolved before a financial disposition can be recorded';
  end if;
  if exists (select 1 from public.dispute_financial_dispositions where dispute_id = p_dispute_id) then
    raise exception 'a financial disposition has already been recorded for this dispute';
  end if;

  if p_disposition_type = 'refund_required' then
    select id, amount, status into v_payment
    from public.payments
    where booking_id = v_dispute.booking_id and payment_type = 'rental_charge'
    for update;
    if v_payment.id is null then
      raise exception 'no rental charge payment exists for this booking to refund';
    end if;
    if v_payment.status not in ('captured', 'partially_captured', 'partially_refunded') then
      raise exception 'the booking payment is not in a refundable status';
    end if;
    -- Reuses create_refund()'s own cumulative-refund-cap check verbatim
    -- -- never a second, independent refund-cap formula (the brief's
    -- own Section 49).
    select (public.create_refund(v_payment.id, p_amount, p_reason, null)->>'refund_id')::uuid into v_refund_id;
  end if;

  if p_disposition_type = 'no_financial_adjustment' then
    v_status := 'completed';
    v_completed_by := p_admin_id;
    v_completed_at := now();
  else
    v_status := 'pending';
    v_completed_by := null;
    v_completed_at := null;
  end if;

  insert into public.dispute_financial_dispositions (
    dispute_id, disposition_type, amount, refund_id, status, reason, created_by, completed_by, completed_at
  ) values (
    p_dispute_id, p_disposition_type, p_amount, v_refund_id, v_status, p_reason, p_admin_id, v_completed_by, v_completed_at
  )
  returning id into v_disposition_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_dispute_id, p_admin_id, 'admin', 'financial_disposition_recorded', null, v_status,
    jsonb_build_object('disposition_type', p_disposition_type, 'amount', p_amount, 'refund_id', v_refund_id), p_idempotency_key
  );

  v_result := jsonb_build_object(
    'disposition_id', v_disposition_id, 'dispute_id', p_dispute_id, 'disposition_type', p_disposition_type,
    'status', v_status, 'refund_id', v_refund_id
  );

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'record_dispute_financial_disposition', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
revoke all on function public.record_dispute_financial_disposition(uuid, uuid, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.record_dispute_financial_disposition(uuid, uuid, text, numeric, text, text) to service_role;

-- ── complete_dispute_financial_disposition ──────────────────
-- The explicit admin attestation that a pending refund_required or
-- manual_financial_settlement disposition's money has actually moved
-- (verified by the admin outside this system, e.g. via the payment
-- provider dashboard) -- this RPC never calls a provider and never
-- re-derives "did it happen" from any automated signal, because none
-- exists (see this migration's own header). It only records that an
-- admin attests completion, exactly like every other manual-
-- reconciliation category already established in this codebase.
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

-- ── payout fail-closed gate: booking branch only ────────────
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
  v_has_escrow boolean;
  v_released_total numeric;
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

    -- E26: the E24 released-principal backing check is binding only
    -- in ESCROW-PARTICIPATING mode (one or more escrow rows exist, in
    -- any status). An agreement that never had an escrow row has
    -- nothing for this check to measure -- skipping it here restores
    -- the pre-E24 behavior for that case without weakening E24 for
    -- any agreement that genuinely participated in escrow.
    select exists (select 1 from public.escrow_transactions where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id) into v_has_escrow;
    if v_has_escrow then
      select coalesce(sum(principal_amount), 0) into v_released_total
      from public.escrow_transactions
      where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status = 'released';
      if p_payout.amount > v_released_total then
        return 'source_payment_issue';
      end if;
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

  -- E23: the SAME category this payment-status check already returns,
  -- extended to the escrow refund table -- an admin may have already
  -- returned this booking's held escrow principal to the customer
  -- through the separate escrow-refund path, which never touches
  -- public.payments.
  if exists (
    select 1 from public.escrow_transactions
    where booking_id = p_payout.booking_id and status in ('refunded', 'partially_refunded')
  ) then
    return 'source_payment_issue';
  end if;

  -- E28: a RESOLVED/CLOSED dispute whose financial disposition has not
  -- yet been completed must still block payout -- the dispute-open
  -- check just below only catches an OPEN dispute; once resolved, that
  -- check no longer applies, which is exactly the race this closes.
  -- Fires only when a dispute_financial_dispositions row genuinely
  -- exists and is still 'pending' -- never merely because a resolved
  -- dispute has no disposition row at all (see this migration's own
  -- header for why: none of the 78 pre-existing resolved disputes that
  -- predate this contract will ever gain one).
  if exists (
    select 1 from public.disputes d
    join public.dispute_financial_dispositions dfd on dfd.dispute_id = d.id
    where d.booking_id = p_payout.booking_id
      and d.status in ('resolved', 'closed')
      and dfd.status = 'pending'
  ) then
    return 'financial_disposition_pending';
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
  v_has_escrow boolean;
  v_released_total numeric;
begin
  if p_payout.rent_to_buy_agreement_id is not null then
    if exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'compliance_review';
    end if;
    if exists (select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')) then
      return 'account_restricted';
    end if;

    -- E26: same optional-escrow scoping as the full-eligibility block
    -- above, re-proven immediately before the processing -> paid
    -- transition.
    select exists (select 1 from public.escrow_transactions where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id) into v_has_escrow;
    if v_has_escrow then
      select coalesce(sum(principal_amount), 0) into v_released_total
      from public.escrow_transactions
      where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status = 'released';
      if p_payout.amount > v_released_total then
        return 'source_payment_issue';
      end if;
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

  -- E23: same extension as the full-eligibility block above -- an
  -- escrow refund recorded after a payout already reached
  -- 'processing' must still stop it from being marked 'paid'.
  if exists (
    select 1 from public.escrow_transactions
    where booking_id = p_payout.booking_id and status in ('refunded', 'partially_refunded')
  ) then
    return 'source_payment_issue';
  end if;

  -- E28: identical fail-closed re-check as the full-eligibility block
  -- above, re-proven immediately before the processing -> paid
  -- transition.
  if exists (
    select 1 from public.disputes d
    join public.dispute_financial_dispositions dfd on dfd.dispute_id = d.id
    where d.booking_id = p_payout.booking_id
      and d.status in ('resolved', 'closed')
      and dfd.status = 'pending'
  ) then
    return 'financial_disposition_pending';
  end if;

  return null;
end;
$$;
revoke all on function public._merchant_payout_still_safe_to_pay_block(public.merchant_payouts) from public, anon, authenticated;
grant execute on function public._merchant_payout_still_safe_to_pay_block(public.merchant_payouts) to service_role;

-- ── booking exception-candidate RPC: widened for visibility ─
-- RETURNS TABLE shape changes (one new field) -- DROP + CREATE
-- required; every existing field/join/predicate reproduced
-- byte-for-byte, only the one new field and its OR-branch are added.
drop function if exists public._merchant_payout_exception_candidates();

create function public._merchant_payout_exception_candidates()
returns table(
  payout_id uuid,
  booking_id uuid,
  merchant_id uuid,
  status text,
  updated_at timestamptz,
  provider_reference text,
  rental_payment_status text,
  has_blocking_dispute boolean,
  merchant_account_status text,
  has_pending_financial_disposition boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with context as (
    select
      mp.id as payout_id,
      mp.booking_id,
      mp.merchant_id,
      mp.status,
      mp.updated_at,
      mp.provider_reference,
      p.status as rental_payment_status,
      exists (
        select 1 from public.disputes d
        where d.booking_id = mp.booking_id and d.status not in ('resolved', 'closed', 'cancelled')
      ) as has_blocking_dispute,
      pr.account_status as merchant_account_status,
      exists (
        select 1 from public.disputes d
        join public.dispute_financial_dispositions dfd on dfd.dispute_id = d.id
        where d.booking_id = mp.booking_id and d.status in ('resolved', 'closed') and dfd.status = 'pending'
      ) as has_pending_financial_disposition
    from public.merchant_payouts mp
    left join public.payments p on p.booking_id = mp.booking_id and p.payment_type = 'rental_charge'
    left join public.profiles pr on pr.id = mp.merchant_id
    where mp.status in ('pending', 'processing', 'paid')
  )
  select
    payout_id, booking_id, merchant_id, status::text, updated_at, provider_reference,
    rental_payment_status::text, has_blocking_dispute, merchant_account_status::text, has_pending_financial_disposition
  from context
  where
    (status in ('pending', 'processing') and (
      (rental_payment_status is not null and rental_payment_status <> 'captured')
      or has_blocking_dispute
      or merchant_account_status in ('suspended', 'restricted')
      or has_pending_financial_disposition
    ))
    or
    (status = 'paid' and (
      rental_payment_status in ('refunded', 'partially_refunded', 'chargeback')
      or has_blocking_dispute
      or provider_reference is null
      or has_pending_financial_disposition
    ));
$$;

revoke all on function public._merchant_payout_exception_candidates() from public, anon, authenticated;
grant execute on function public._merchant_payout_exception_candidates() to service_role;
