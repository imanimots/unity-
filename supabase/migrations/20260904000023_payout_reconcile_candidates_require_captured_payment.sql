-- Fix-forward: closes head-of-line blocking in the bounded missing-payout
-- reconciliation queue.
--
-- PROVEN DEFECT: _payout_reconcile_missing_candidates() (20260904000004)
-- selects any booking with status='completed' and no merchant_payouts row
-- -- but the reconciliation route (and createMerchantPayout() itself)
-- additionally requires a CAPTURED rental_charge payment before a payout
-- can actually be created. A booking that reached 'completed' without one
-- (e.g. a QA/test fixture forced directly to 'completed' for an unrelated
-- purpose, never via checkout) is selected as a "candidate" but can never
-- actually be processed -- it is silently skipped every single sweep,
-- forever, since it will never gain a captured payment on its own.
--
-- Live evidence (diagnosis phase): 72 completed/no-payout bookings exist;
-- 63 have no rental_charge payment at all (all traced to
-- verify-clickable-profiles.mjs's review-testing fixtures, an unrelated
-- suite); only 9 are genuinely payable. Because the queue orders
-- oldest-first and LIMIT 50 < 63 unprocessable rows, the 9 genuinely
-- payable bookings are ALWAYS pushed entirely outside the batch --
-- deterministic total starvation, not a probabilistic edge case.
--
-- FIX: align candidate discovery with execution authority -- a booking
-- only enters the queue if the SAME condition the route/orchestrator
-- already require (an EXISTS check against payments: payment_type =
-- 'rental_charge', status = 'captured', the exact canonical values
-- already used by src/app/api/internal/payouts/reconcile-missing/route.ts
-- and src/lib/payments/orchestrator/create-merchant-payout.ts) is already
-- true. This does not invent a new payment rule -- it moves an existing,
-- already-enforced rule one layer earlier, so the bounded queue only ever
-- contains work the worker can actually do. Every downstream defense
-- layer (route-level captured check, createMerchantPayout()'s own
-- captured check, the existing-payout guard) is left completely
-- untouched -- this is candidate-discovery alignment, not a replacement
-- for defense in depth.
--
-- Historical data: no DML against any existing row. The 63 payment-less
-- QA bookings are not modified or deleted -- they simply stop matching
-- this SELECT-only function's predicate. LIMIT stays 50; ordering stays
-- oldest-first, now evaluated across the correctly-scoped actionable set.
create or replace function public._payout_reconcile_missing_candidates(p_limit int default 50)
returns table(booking_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select b.id
  from public.bookings b
  where b.status = 'completed'
    and not exists (
      select 1 from public.merchant_payouts mp where mp.booking_id = b.id
    )
    and exists (
      select 1 from public.payments p
      where p.booking_id = b.id
        and p.payment_type = 'rental_charge'
        and p.status = 'captured'
    )
  order by b.created_at
  limit p_limit;
$$;

revoke all on function public._payout_reconcile_missing_candidates(int) from public, anon, authenticated;
grant execute on function public._payout_reconcile_missing_candidates(int) to service_role;
