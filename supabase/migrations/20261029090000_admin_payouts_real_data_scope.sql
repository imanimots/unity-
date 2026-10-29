-- D3-E-F1/F2: Merchant Payout admin list -- Real Data provenance.
--
-- Independent review of D3-E (ADMIN-CONTROL-CENTRE-BATCH-D3-E-INDEPENDENT-
-- REVIEW) confirmed _admin_list_merchant_payouts (20260904000022) has zero
-- data_classification/is_test awareness: a test or unknown merchant's
-- payout, or a payout linked to a booking whose renter is test/unknown or
-- whose listing is is_test=true, is returned unchanged in the ordinary
-- Admin Merchant Payouts list -- the exact same class of gap
-- 20261028090000_admin_orders_real_data_scope.sql fixed for
-- _admin_list_orders_page.
--
-- D3-E-F2 correction: the F1 version of this file treated
-- `booking_id IS NULL` as "no transaction parent, merchant-real alone is
-- sufficient". The focused independent re-review proved this false by
-- reading schema directly: merchant_payouts was widened by
-- 20260821183555_rtb_v2_schema.sql with its own rent_to_buy_agreement_id
-- column, and merchant_payouts_one_transaction_chk requires EXACTLY one
-- of booking_id/rent_to_buy_agreement_id -- there is no legitimate
-- "neither" state. create_merchant_payout() (20260821183600_rtb_v2_rpcs.sql)
-- is a live RPC that creates exactly these RTB-linked rows. So
-- `booking_id IS NULL` always means RTB-linked, and this fix now proves
-- the complete RTB provenance rule for that branch instead of merchant-
-- real alone.
--
-- Fix: CREATE OR REPLACE the existing RPC, byte-identical in name,
-- argument signature (including defaults), return shape, language,
-- stability, security-definer behavior, and search_path. Every existing
-- filter (status/failed-only/overdue/dispute-related/restricted-merchant/
-- date range/search/ordering/limit) is preserved verbatim. The only
-- change is new internal `base` CTE columns (never added to the final
-- projected column list, so the function's return shape is unchanged)
-- and a rewritten two-branch WHERE predicate.
--
-- Provenance rule -- exactly two parent families, no unparented fallback:
--   (booking_id IS NOT NULL
--     AND merchant_classification = 'real'
--     AND renter_classification = 'real'
--     AND listing_is_test = false)
--   OR
--   (rent_to_buy_agreement_id IS NOT NULL
--     AND rtb_is_test = false
--     AND rtb_merchant_classification = 'real'
--     AND rtb_customer_classification = 'real')
-- The booking branch mirrors the booking "COMPLETE booking rule" already
-- established for payout detail in src/lib/admin/payouts-service.ts. The
-- RTB branch mirrors the exact rule already established in
-- src/lib/admin/rent-to-buy-service.ts -- never a payout-specific
-- reimplementation. The RTB merchant check is resolved via its OWN
-- LEFT JOIN on rent_to_buy_agreements.merchant_id (rtb_merchant), not by
-- reusing the payout's own merchant_id/pr join -- payout.merchant_id and
-- rtb.merchant_id are expected identical by the creating RPC, but this
-- fix proves it from the actual RTB agreement row rather than relying on
-- that invariant alone. Every join (pr/b/l/rp/rtb/rtb_merchant/
-- rtb_customer) is a LEFT JOIN (never INNER), so a missing/unresolved
-- merchant, renter, listing, or RTB agreement/participant row fails this
-- WHERE closed via NULL-vs-'real'/NULL-vs-false three-valued logic,
-- never promoted to real -- the same fail-closed design already used by
-- the Orders RPC fix.
--
-- This migration is created as a reviewed SOURCE FILE only. It is NOT
-- applied here -- per this phase's explicit instruction, no database
-- migration/mutation of any kind occurs in this remediation.
create or replace function public._admin_list_merchant_payouts(
  p_search text default null,
  p_status text default null,
  p_failed_only boolean default false,
  p_overdue_only boolean default false,
  p_dispute_related boolean default false,
  p_restricted_merchant boolean default false,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_limit int default 100
)
returns table(
  id uuid,
  payout_reference text,
  merchant_id uuid,
  merchant_name text,
  booking_id uuid,
  booking_reference text,
  listing_title text,
  amount numeric,
  status text,
  created_at timestamptz,
  processing_started_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  failure_category text,
  attempt_count int,
  has_unresolved_dispute boolean,
  merchant_restricted boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with search_pattern as (
    select case
      when nullif(trim(p_search), '') is not null then
        -- Escape backslash first, then the two ILIKE wildcard
        -- characters, so a literal '%' or '_' in the search term
        -- matches literally rather than acting as a wildcard.
        '%' || replace(replace(replace(trim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      else null
    end as pattern
  ),
  base as (
    select
      mp.id,
      mp.provider_reference as payout_reference,
      mp.merchant_id,
      coalesce(pr.full_name, pr.display_name) as merchant_name,
      mp.booking_id,
      b.booking_reference,
      l.title as listing_title,
      mp.amount,
      mp.status::text as status,
      mp.created_at,
      mp.processing_started_at,
      mp.paid_at,
      mp.failed_at,
      mp.failure_category,
      mp.attempt_count,
      exists (
        select 1 from public.disputes d
        where d.booking_id = mp.booking_id and d.status not in ('resolved', 'closed', 'cancelled')
      ) as has_unresolved_dispute,
      (pr.account_status in ('suspended', 'restricted')) as merchant_restricted,
      -- Mirrors the existing 48-hour overdue threshold already used
      -- elsewhere in this codebase (e.g. 20260820000004's overview
      -- stats) -- same literal, not a new convention.
      (
        (mp.status = 'pending' and mp.created_at < now() - interval '48 hours')
        or (mp.status = 'processing' and mp.processing_started_at is not null and mp.processing_started_at < now() - interval '48 hours')
      ) as is_overdue,
      -- D3-E-F1/F2: Real Data provenance -- positive proof only. LEFT
      -- JOINs mean a missing/unresolved participant or parent row
      -- yields NULL here, never 'real'/false.
      mp.rent_to_buy_agreement_id,
      pr.data_classification as merchant_classification,
      rp.data_classification as renter_classification,
      l.is_test as listing_is_test,
      rtb.is_test as rtb_is_test,
      rtb_merchant.data_classification as rtb_merchant_classification,
      rtb_customer.data_classification as rtb_customer_classification
    from public.merchant_payouts mp
    left join public.profiles pr on pr.id = mp.merchant_id
    left join public.bookings b on b.id = mp.booking_id
    left join public.listings l on l.id = b.listing_id
    left join public.profiles rp on rp.id = b.renter_id
    left join public.rent_to_buy_agreements rtb on rtb.id = mp.rent_to_buy_agreement_id
    left join public.profiles rtb_merchant on rtb_merchant.id = rtb.merchant_id
    left join public.profiles rtb_customer on rtb_customer.id = rtb.customer_id
  )
  select
    base.id, base.payout_reference, base.merchant_id, base.merchant_name,
    base.booking_id, base.booking_reference, base.listing_title, base.amount,
    base.status, base.created_at, base.processing_started_at, base.paid_at,
    base.failed_at, base.failure_category, base.attempt_count,
    base.has_unresolved_dispute, base.merchant_restricted
  from base, search_pattern
  where
    (p_status is null or p_status = 'all' or base.status = p_status)
    and (not p_failed_only or base.status = 'failed')
    and (p_date_from is null or base.created_at >= p_date_from)
    and (p_date_to is null or base.created_at <= p_date_to)
    and (not p_overdue_only or base.is_overdue)
    and (not p_dispute_related or base.has_unresolved_dispute)
    and (not p_restricted_merchant or base.merchant_restricted)
    and (
      search_pattern.pattern is null
      or coalesce(base.merchant_name, '') ilike search_pattern.pattern escape '\'
      or coalesce(base.listing_title, '') ilike search_pattern.pattern escape '\'
      or coalesce(base.booking_reference, '') ilike search_pattern.pattern escape '\'
      or coalesce(base.payout_reference, '') ilike search_pattern.pattern escape '\'
    )
    -- D3-E-F2: Real Data provenance -- exactly two parent families, no
    -- unparented fallback (merchant_payouts_one_transaction_chk
    -- guarantees exactly one of booking_id/rent_to_buy_agreement_id is
    -- set on every row). A booking-linked payout requires the COMPLETE
    -- booking rule (merchant real AND renter real AND listing not
    -- test); an RTB-linked payout requires the COMPLETE RTB rule
    -- (agreement not test AND RTB merchant real AND RTB customer
    -- real) -- never merchant-real alone for either branch.
    and (
      (base.booking_id is not null and base.merchant_classification = 'real' and base.renter_classification = 'real' and base.listing_is_test = false)
      or
      (base.rent_to_buy_agreement_id is not null and base.rtb_is_test = false and base.rtb_merchant_classification = 'real' and base.rtb_customer_classification = 'real')
    )
  order by base.created_at desc, base.id desc
  limit p_limit;
$$;

revoke all on function public._admin_list_merchant_payouts(text, text, boolean, boolean, boolean, boolean, timestamptz, timestamptz, int) from public, anon, authenticated;
grant execute on function public._admin_list_merchant_payouts(text, text, boolean, boolean, boolean, boolean, timestamptz, timestamptz, int) to service_role;
