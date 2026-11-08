-- ============================================================
-- E25 -- Contain escrow partial-refund residual state (fail-closed)
-- ============================================================
-- A fresh, exhaustive audit (every migration mentioning
-- `partially_refunded`/`refunded_amount`/`supportsPartialRefund`
-- across supabase/migrations, src/, scripts/, and docs/; every
-- current authoritative definition of release_escrow_transaction,
-- refund_escrow_transaction, _escrow_transaction_transition,
-- _rent_to_buy_settle_escrow, releaseEscrowForPayment, and the two
-- payout-safety gates) confirms the `partially_refunded` escrow
-- status is a genuine terminal-state defect, not a hypothetical one:
--
--   - public.refund_escrow_transaction(...) is the ONLY producer of
--     `partially_refunded` anywhere in this codebase -- it accepts
--     any `0 < p_amount <= principal_amount` and sets
--     `partially_refunded` whenever the amount is less than the full
--     principal.
--   - No transition anywhere accepts `partially_refunded` as a
--     source state -- confirmed repo-wide: release_escrow_transaction,
--     refund_escrow_transaction, and _rent_to_buy_settle_escrow all
--     require/select `status = 'funded'` only; a grep across every
--     migration for `partially_refunded` appearing in any
--     `array[...]::escrow_status[]` allowed-from list, or any
--     `where status = 'partially_refunded'`/`status in
--     ('partially_refunded'...)` predicate, returns zero matches.
--   - releaseEscrowForPayment() (src/lib/escrow/orchestrator.ts)
--     early-returns unless `escrow.status === 'funded'`, and when it
--     does run it releases the FULL original `principal_amount`,
--     never `principal_amount - refunded_amount` -- it was never
--     written with a residual-release case in mind.
--   - The admin escrow-actions UI
--     (src/components/admin/escrow-actions.tsx) itself already shows
--     "No actions available" for any status other than `pending`/
--     `funded` -- confirming the product's own UI already treats
--     `partially_refunded` as a dead end today, independent of this
--     migration.
--   - docs/ESCROW_ARCHITECTURE.md mentions `partially_refunded`
--     exactly once, as a bare enum-value listing -- zero business
--     rule exists anywhere (migrations, docs, tests, admin UI) for
--     what a residual balance should do next, for ANY of the 4
--     escrow domains (sale/rental/barter/rent_to_buy). Per this
--     phase's own explicit instruction, a residual-lifecycle formula
--     must not be invented merely because the subtraction
--     `principal_amount - refunded_amount` looks obvious.
--   - public._escrow_transaction_transition's `refunded_amount` is
--     SET, not accumulated (`coalesce(p_refund_amount,
--     refunded_amount)`, never `refunded_amount + p_refund_amount`) --
--     confirming it was only ever designed for a single, one-time
--     refund operation per row, not a repeatable partial-refund
--     sequence.
--   - The orchestrator never checks
--     `provider.capabilities.supportsPartialRefund` before
--     requesting a partial refund, and a real future provider
--     concurrency race (two concurrent partial-refund requests both
--     reaching the provider before either's database transition
--     serializes) is unaddressed.
--
-- Given no business rule defines where residual principal belongs
-- for any domain, and the current field/history model cannot safely
-- represent a second refund operation on the same row even if one
-- were later desired, this phase selects fail-closed containment
-- (classification D) over inventing a lifecycle: a disabled,
-- incomplete financial feature is safer than a state that can strand
-- principal with no defined exit.
--
-- Fix: public.refund_escrow_transaction now requires the refund
-- amount to equal the full currently-held principal while the source
-- status is 'funded' -- the only status it has ever accepted. This
-- makes `partially_refunded` unreachable through the one and only
-- code path that could ever produce it, while leaving full-refund
-- behavior (the only behavior ever exercised by any real caller --
-- confirmed zero production call sites for any refund mechanism
-- other than this admin route) completely unchanged. The now-dead
-- "amount less than principal -> partially_refunded" branch is
-- removed rather than left as unreachable code.
--
-- The `escrow_status` enum value `partially_refunded` and the
-- `escrow_transactions.refunded_amount` column are deliberately NOT
-- dropped -- they remain valid for any historical row and for a
-- possible future migration that completes the residual lifecycle
-- once a business rule exists. No existing row of any status is
-- read, updated, or deleted by this migration. E18 ledger
-- immutability, E23's booking-escrow payout block, and E24's RTB
-- released-backing formula are all unaffected -- none of them is
-- touched, and none of their invariants depended on
-- `partially_refunded` ever becoming reachable again.
--
-- SECURITY DEFINER, search_path = public (unchanged -- not this
-- phase's concern to harden), and the existing service_role-only
-- grants are all preserved; CREATE OR REPLACE restates every existing
-- clause exactly as before except for the one new guard and the
-- simplified status assignment it makes correct.
-- ============================================================

create or replace function public.refund_escrow_transaction(
  p_admin_id uuid,
  p_escrow_id uuid,
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
  v_request_hash text;
  v_idem record;
  v_escrow public.escrow_transactions;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to refund an escrow transaction';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'refund amount must be positive';
  end if;

  v_request_hash := md5(coalesce(p_escrow_id::text, '') || '|' || coalesce(p_amount::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'refund_escrow_transaction' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_escrow from public.escrow_transactions where id = p_escrow_id;
  if v_escrow.id is null then
    raise exception 'escrow transaction not found';
  end if;
  if v_escrow.status <> 'funded' then
    raise exception 'escrow transaction is in status % and cannot be refunded from here', v_escrow.status;
  end if;

  -- E25: partial escrow refunds are not currently supported -- no
  -- transition anywhere accepts 'partially_refunded' as a source, so
  -- any amount less than the full principal would strand the
  -- residual permanently. Require the full principal, always
  -- producing 'refunded', never 'partially_refunded'.
  if p_amount <> v_escrow.principal_amount then
    raise exception 'partial escrow refunds are not currently supported -- the refund amount must equal the full held principal amount';
  end if;

  v_escrow := public._escrow_transaction_transition(
    p_escrow_id, 'refunded', array['funded']::escrow_status[],
    'admin', p_admin_id, 'refunded', p_reason, null, null, p_amount, null, p_idempotency_key
  );

  v_result := jsonb_build_object('escrow_transaction_id', v_escrow.id, 'status', v_escrow.status, 'refunded_at', v_escrow.refunded_at, 'refunded_amount', v_escrow.refunded_amount);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'refund_escrow_transaction', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
revoke all on function public.refund_escrow_transaction(uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.refund_escrow_transaction(uuid, uuid, numeric, text, text) to service_role;
