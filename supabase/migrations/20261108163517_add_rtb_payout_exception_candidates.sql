-- ============================================================
-- E27 -- RTB merchant-payout operational exception visibility
-- ============================================================
-- public._merchant_payout_exception_candidates() (20260904000005) is
-- booking-shaped: its only joins key on `mp.booking_id`, which is
-- always NULL for an RTB payout (merchant_payouts_one_transaction_chk
-- requires exactly one of booking_id/rent_to_buy_agreement_id). A
-- NULL = NULL join predicate is never true in SQL, so neither its
-- rental-payment join nor its dispute join ever produces a row for an
-- RTB payout -- and src/lib/admin/exceptions-service.ts separately,
-- explicitly skips every candidate without a booking_id regardless.
-- Net effect, confirmed by direct code read: an unsafe RTB merchant
-- payout can be correctly BLOCKED by the canonical gates
-- (_merchant_payout_full_eligibility_block /
-- _merchant_payout_still_safe_to_pay_block) while being completely
-- invisible to admin operations, with zero exception surfaced.
--
-- This migration adds one new, narrow, read-only RPC rather than
-- widening the booking RPC: that function's RETURNS TABLE shape is a
-- stable contract its own TypeScript consumer already depends on,
-- RTB's operationally relevant context (escrow participation, released
-- backing, agreement lifecycle) is structurally different from
-- booking's (rental-payment status), and a separate function keeps the
-- booking regression surface this touches at exactly zero.
--
-- This function does NOT reimplement payout eligibility. It calls the
-- same two canonical gate functions every RTB payout mutation path
-- already calls (_merchant_payout_full_eligibility_block for
-- pending/processing, _merchant_payout_still_safe_to_pay_block for
-- paid) and reports their own verdict back -- exactly once per row,
-- as a computed CTE column, never re-invoked per predicate. This is
-- the only way admin exception detection can never drift from what the
-- payout mutation path would actually do: if the gate's answer ever
-- changes (a future phase), this RPC's answer changes with it, with
-- zero code here to update.
--
-- E26's optional-escrow contract is preserved by construction, not by
-- a second encoding of it: has_any_escrow is reported for the admin
-- UI's own context display, but no exception-worthiness decision in
-- this migration or its caller is made from has_any_escrow alone --
-- every blocking decision comes from the canonical gate's own verdict.
-- A healthy no-escrow payout's gate verdict is NULL (proven live, see
-- this phase's own report), which this function's WHERE clause
-- excludes exactly like a healthy escrow-backed payout's NULL verdict.
--
-- Returns only operationally relevant rows -- a currently-blocked
-- payout, or a paid payout missing its provider reference -- never
-- every historical RTB payout, mirroring the booking RPC's own
-- bounded-by-anomaly-count design (this set grows with outstanding
-- problems, not with total payout volume).
--
-- search_path = '' (the strongest hardening form, Classification A/B
-- per the E21 precedent): every table and function reference below is
-- already fully schema-qualified with `public.`, so there is no bare
-- application-object reference this would break; this is a brand-new
-- function with no historical search_path=public convention to match.
-- SECURITY DEFINER matches the sibling booking RPC's own convention --
-- the only caller is service_role, which already holds direct grants
-- on every table referenced here post-E17 and bypasses RLS regardless,
-- so this is consistency/defense-in-depth, not a functional
-- requirement.

create or replace function public._rtb_merchant_payout_exception_candidates()
returns table(
  payout_id uuid,
  rent_to_buy_agreement_id uuid,
  merchant_id uuid,
  status text,
  amount numeric,
  updated_at timestamptz,
  provider_reference text,
  eligibility_block text,
  agreement_status text,
  agreement_settled_at timestamptz,
  has_any_escrow boolean,
  released_escrow_total numeric,
  has_blocking_dispute boolean,
  merchant_account_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  with context as (
    select
      mp.id as payout_id,
      mp.rent_to_buy_agreement_id,
      mp.merchant_id,
      mp.status,
      mp.amount,
      mp.updated_at,
      mp.provider_reference,
      case
        when mp.status in ('pending', 'processing') then public._merchant_payout_full_eligibility_block(mp)
        when mp.status = 'paid' then public._merchant_payout_still_safe_to_pay_block(mp)
        else null
      end as eligibility_block,
      rtb.status::text as agreement_status,
      rtb.settled_at as agreement_settled_at,
      exists (
        select 1 from public.escrow_transactions et
        where et.rent_to_buy_agreement_id = mp.rent_to_buy_agreement_id
      ) as has_any_escrow,
      coalesce((
        select sum(et.principal_amount) from public.escrow_transactions et
        where et.rent_to_buy_agreement_id = mp.rent_to_buy_agreement_id and et.status = 'released'
      ), 0) as released_escrow_total,
      exists (
        select 1 from public.disputes d
        where d.rent_to_buy_agreement_id = mp.rent_to_buy_agreement_id and d.status not in ('resolved', 'closed', 'cancelled')
      ) as has_blocking_dispute,
      pr.account_status::text as merchant_account_status
    from public.merchant_payouts mp
    left join public.rent_to_buy_agreements rtb on rtb.id = mp.rent_to_buy_agreement_id
    left join public.profiles pr on pr.id = mp.merchant_id
    where mp.rent_to_buy_agreement_id is not null
      and mp.status in ('pending', 'processing', 'paid')
  )
  select
    payout_id, rent_to_buy_agreement_id, merchant_id, status::text, amount, updated_at, provider_reference,
    eligibility_block, agreement_status, agreement_settled_at, has_any_escrow, released_escrow_total,
    has_blocking_dispute, merchant_account_status
  from context
  where eligibility_block is not null
     or (status = 'paid' and provider_reference is null);
$$;

revoke all on function public._rtb_merchant_payout_exception_candidates() from public, anon, authenticated;
grant execute on function public._rtb_merchant_payout_exception_candidates() to service_role;
