-- D3-E-F1: Financial Operations admin list -- Real Data provenance.
--
-- Independent review of D3-E (ADMIN-CONTROL-CENTRE-BATCH-D3-E-INDEPENDENT-
-- REVIEW) confirmed the Financial Operations page ("Payments & Deposits")
-- is an ordinary BUSINESS Finance ledger (payment records, captured/
-- settled-like statuses, CSV export), not an operational work queue, and
-- that listFinancialOperations() (src/lib/admin/operations-service.ts)
-- had zero Real Data provenance filtering -- every payment row, test or
-- real, rendered as an ordinary Finance record. It also confirmed
-- `payments` supports FOUR polymorphic parent families (booking_id/
-- order_id/barter_agreement_id/rent_to_buy_agreement_id, enforced
-- exactly-one-of by payments_one_transaction_chk -- verified from
-- 20260801000002_payment_schema.sql + 20260812000002/20260816000002/
-- 20260827000004's widenings), only 2 of which the prior code handled
-- for display at all.
--
-- Why a new RPC rather than a PostgREST-level fix: this page's keyset
-- cursor pagination was already hardened once (the exact defect this
-- function's own header comment documents -- "financial-operations
-- defect was pure boundedness"). Filtering mixed rows AFTER a bounded
-- fetch (fetch page -> classify -> drop test rows) would reintroduce
-- that exact class of bug via short pages / false exhaustion / omitted
-- later real rows. PostgREST also cannot express "whichever of 4
-- different parent tables is set, each needing a different join target"
-- as a single embedded-join filter (the same reason Unity Commissions/
-- Escrow/Advertising Campaigns/Creatives all use an unbounded-fetch-
-- then-classify pattern instead -- but that pattern is unsafe here
-- specifically because of the keyset cursor). A narrowly-scoped RPC
-- applying Real Data provenance INSIDE the query, before the keyset
-- LIMIT, is the only approach that preserves both correctness
-- requirements at once.
--
-- Provenance rules (reusing each parent's own already-established D3
-- rule verbatim -- never a Financial-Operations-specific
-- reimplementation):
--   booking-linked:   booking renter real AND booking merchant real AND
--                      booking listing.is_test = false
--   order-linked:     order buyer real AND order seller real AND
--                      order listing.is_test = false
--   barter-linked:    barter party_a real AND barter party_b real
--                      (no anchor_listing/is_test check -- barter_agreements
--                      has no is_test column of its own; confirmed from
--                      20260810000003_barter_schema.sql and already the
--                      exact rule src/lib/admin/barter-service.ts and
--                      escrow-service.ts both apply)
--   rent_to_buy-linked: agreement.is_test = false AND merchant real AND
--                      customer real (src/lib/admin/rent-to-buy-service.ts's
--                      existing rule)
-- Every join below is a LEFT JOIN (never INNER), so a missing/unresolved
-- participant yields NULL, which fails the positive `= 'real'`/
-- `= false` comparisons closed -- never promoted to real.
--
-- This migration is created as a reviewed SOURCE FILE only. It is NOT
-- applied here -- per this phase's explicit instruction, no database
-- migration/mutation of any kind occurs in this remediation.
create or replace function public._admin_list_financial_operations(
  p_status text default null,
  p_cursor_ts timestamptz default null,
  p_cursor_id uuid default null,
  p_limit int default 50
)
returns table(
  id uuid,
  booking_id uuid,
  booking_reference text,
  order_id uuid,
  order_reference text,
  barter_agreement_id uuid,
  barter_agreement_reference text,
  rent_to_buy_agreement_id uuid,
  payment_type text,
  status text,
  amount numeric,
  currency text,
  failure_reason text,
  requested_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select
      p.id,
      p.booking_id,
      b.booking_reference,
      p.order_id,
      o.order_reference,
      p.barter_agreement_id,
      ba.agreement_reference as barter_agreement_reference,
      p.rent_to_buy_agreement_id,
      p.payment_type::text as payment_type,
      p.status::text as status,
      p.amount,
      p.currency,
      p.failure_reason,
      p.requested_at,
      -- D3-E-F1: Real Data provenance -- positive proof only, one branch
      -- per parent family (payments_one_transaction_chk guarantees
      -- exactly one of the 4 FK columns is set).
      case
        when p.booking_id is not null then
          coalesce(bp_renter.data_classification = 'real' and bp_merchant.data_classification = 'real' and bl.is_test = false, false)
        when p.order_id is not null then
          coalesce(op_buyer.data_classification = 'real' and op_seller.data_classification = 'real' and ol.is_test = false, false)
        when p.barter_agreement_id is not null then
          coalesce(bap_a.data_classification = 'real' and bap_b.data_classification = 'real', false)
        when p.rent_to_buy_agreement_id is not null then
          coalesce(rtb.is_test = false and rtbp_merchant.data_classification = 'real' and rtbp_customer.data_classification = 'real', false)
        else false
      end as is_real
    from public.payments p
    left join public.bookings b on b.id = p.booking_id
    left join public.listings bl on bl.id = b.listing_id
    left join public.profiles bp_renter on bp_renter.id = b.renter_id
    left join public.profiles bp_merchant on bp_merchant.id = b.merchant_id
    left join public.orders o on o.id = p.order_id
    left join public.listings ol on ol.id = o.listing_id
    left join public.profiles op_buyer on op_buyer.id = o.buyer_id
    left join public.profiles op_seller on op_seller.id = o.seller_id
    left join public.barter_agreements ba on ba.id = p.barter_agreement_id
    left join public.profiles bap_a on bap_a.id = ba.party_a_id
    left join public.profiles bap_b on bap_b.id = ba.party_b_id
    left join public.rent_to_buy_agreements rtb on rtb.id = p.rent_to_buy_agreement_id
    left join public.profiles rtbp_merchant on rtbp_merchant.id = rtb.merchant_id
    left join public.profiles rtbp_customer on rtbp_customer.id = rtb.customer_id
  )
  select
    base.id, base.booking_id, base.booking_reference, base.order_id, base.order_reference,
    base.barter_agreement_id, base.barter_agreement_reference, base.rent_to_buy_agreement_id,
    base.payment_type, base.status, base.amount, base.currency, base.failure_reason, base.requested_at
  from base
  where
    base.is_real
    and (p_status is null or p_status = 'all' or base.status = p_status)
    -- Same (ts, id) keyset-pagination predicate the prior PostgREST
    -- `.or(...)` expressed client-side -- now evaluated here, over the
    -- already-Real-Data-filtered population, so a page boundary can
    -- never fall mid-way through a run of excluded test rows and
    -- silently shrink the page or skip a later real row.
    and (
      p_cursor_ts is null or p_cursor_id is null
      or (base.requested_at, base.id) < (p_cursor_ts, p_cursor_id)
    )
  order by base.requested_at desc, base.id desc
  limit p_limit;
$$;

revoke all on function public._admin_list_financial_operations(text, timestamptz, uuid, int) from public, anon, authenticated;
grant execute on function public._admin_list_financial_operations(text, timestamptz, uuid, int) to service_role;
