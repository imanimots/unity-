-- Payout query scalability (Wave 2C). Two pre-existing infrastructure
-- defects, both caused by the same anti-pattern: collecting an unbounded
-- historical ID list into application memory, then embedding it into a
-- PostgREST GET-request filter (`.in(...)`/`.not(..., 'in', ...)`). That
-- filter is serialized into the request URL/headers, which overflows
-- PostgREST's practical request-size limit once the underlying table
-- grows large enough (confirmed live: ~409-487 rows was already enough).
--
-- Fix: move both joins server-side, where they belong. Neither RPC below
-- changes any payout business rule -- they only replace how the existing
-- reads are shaped. Candidate creation still goes through the existing,
-- unchanged create_merchant_payout() authority; exception detection still
-- reads the same tables with the same conditions, just via a real SQL
-- join instead of a client-collected ID list.

-- ────────────────────────────────────────────────────────────
-- Index: merchant_payouts had no index on booking_id at all (confirmed
-- live via pg_indexes) -- every lookup keyed by booking_id, including the
-- new anti-join below, would otherwise fall back to a sequential scan
-- that grows linearly with total payout history. Partial (booking_id is
-- not null) since RTB-agreement payouts have no booking_id, matching the
-- existing partial-index convention already used on this table for
-- rent_to_buy_agreement_id.
-- ────────────────────────────────────────────────────────────
create index if not exists merchant_payouts_booking_id_idx
  on public.merchant_payouts (booking_id)
  where booking_id is not null;

-- ────────────────────────────────────────────────────────────
-- reconcile-missing candidate discovery. Replaces:
--   SELECT booking_id FROM merchant_payouts WHERE booking_id IS NOT NULL
--   (fetched into Node, joined into a giant `.not('id','in', <list>)`)
-- with a single bounded, indexed, server-side anti-join. A booking that
-- already has ANY payout row (any status -- matching the existing
-- duplicate guard in create-merchant-payout.ts) is excluded by
-- construction; a booking that gets a payout from this batch, or from
-- the best-effort creation at confirm-return, simply falls out of the
-- NOT EXISTS set on the next call -- no offset/keyset pagination state
-- is needed for correctness, since the candidate set is always exactly
-- "still genuinely missing a payout, right now."
-- ────────────────────────────────────────────────────────────
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
  order by b.created_at
  limit p_limit;
$$;

revoke all on function public._payout_reconcile_missing_candidates(int) from public, anon, authenticated;
grant execute on function public._payout_reconcile_missing_candidates(int) to service_role;

-- ────────────────────────────────────────────────────────────
-- Admin payout-exceptions relevant context. Replaces the two
-- `.in('booking_id', allRelevantBookingIds)` calls (against `payments`
-- and `disputes`) in exceptions-service.ts's merchant-payout section with
-- one RPC call. The booking-id list itself still travels from the caller
-- (it's naturally bounded to "payouts currently pending/processing/paid/
-- failed", not "all bookings ever"), but as an RPC JSON body parameter
-- rather than a URL query filter -- sidestepping the ~16KB header/URL
-- limit that specifically broke the GET-based `.in()` filters, while the
-- actual join work (payments lookup, disputes existence check) now
-- happens server-side against indexed columns
-- (payments_booking_type_unique, disputes_booking_idx) instead of a
-- second network round-trip per exception category.
-- ────────────────────────────────────────────────────────────
create or replace function public._merchant_payout_relevant_context(p_booking_ids uuid[])
returns table(booking_id uuid, rental_payment_status text, has_blocking_dispute boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    b.id as booking_id,
    p.status::text as rental_payment_status,
    exists (
      select 1 from public.disputes d
      where d.booking_id = b.id and d.status not in ('resolved', 'closed', 'cancelled')
    ) as has_blocking_dispute
  from unnest(p_booking_ids) as b(id)
  left join public.payments p on p.booking_id = b.id and p.payment_type = 'rental_charge';
$$;

revoke all on function public._merchant_payout_relevant_context(uuid[]) from public, anon, authenticated;
grant execute on function public._merchant_payout_relevant_context(uuid[]) to service_role;
