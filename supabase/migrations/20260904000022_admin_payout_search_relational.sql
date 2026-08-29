-- Merchant Payout admin search filter -- fix "admin list filtering by
-- search works". Proven root cause: listAdminPayouts() (payouts-service.ts)
-- fetched `merchant_payouts` with `.order(created_at desc).limit(100)`,
-- then applied the search filter afterward, in Node, only against those
-- 100 already-fetched rows. Any payout ranked outside the top 100 by
-- created_at was structurally invisible to search regardless of whether
-- the term matched -- confirmed live: a payout matching the search term
-- exactly, ranked ~#602 of ~605 total rows, returned zero results.
--
-- Fix: one bounded, relational, parameterized RPC -- mirroring the exact
-- style already established for payout scalability
-- (_payout_reconcile_missing_candidates, _merchant_payout_exception_candidates
-- in 20260904000004/20260904000005): search/status/overdue/dispute/
-- restricted-merchant filters are all applied server-side, against the
-- full eligible set, BEFORE the LIMIT -- never after. No id array of any
-- size crosses this boundary; no all-history fetch into Node.
--
-- Search stays scoped to the exact 4 fields already supported: merchant
-- name, listing title, booking reference, payout/provider reference.
-- No new field is added (no email/phone/address/failure-reason/amount).
--
-- Search input is never interpolated into dynamic SQL -- it is a typed
-- function parameter, bound normally by Postgres (this is a plain `sql`
-- function body, not EXECUTE/format). ILIKE wildcard characters (%, _)
-- in the user's search term are escaped so they match literally, exactly
-- matching the current in-memory `.includes()` semantics being replaced
-- (which already treats % and _ as ordinary characters, not wildcards).
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
      ) as is_overdue
    from public.merchant_payouts mp
    left join public.profiles pr on pr.id = mp.merchant_id
    left join public.bookings b on b.id = mp.booking_id
    left join public.listings l on l.id = b.listing_id
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
  order by base.created_at desc, base.id desc
  limit p_limit;
$$;

revoke all on function public._admin_list_merchant_payouts(text, text, boolean, boolean, boolean, boolean, timestamptz, timestamptz, int) from public, anon, authenticated;
grant execute on function public._admin_list_merchant_payouts(text, text, boolean, boolean, boolean, boolean, timestamptz, timestamptz, int) to service_role;
