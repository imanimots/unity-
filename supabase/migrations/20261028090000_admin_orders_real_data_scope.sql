-- D3-D-F1: Admin Orders list -- Real Data provenance scope.
--
-- Independently confirmed (D3-D independent review, P1 blocker): the
-- live _admin_list_orders_page() (20260904000026_admin_orders_relational_pagination.sql)
-- already LEFT JOINs profiles bp/sp (buyer/seller) and listings l, but
-- only for display/search context -- its WHERE clause has zero
-- data_classification/is_test awareness. This means the ordinary Admin
-- Orders list can -- and, given the live classification state at the
-- time of this finding (0 confirmed-real profiles, 302 test, 8
-- unknown), currently DOES -- return test/unknown-linked orders as
-- ordinary Real Data, by default, on every page view (no probing of a
-- specific id required).
--
-- Fix: CREATE OR REPLACE with the EXACT existing signature, defaults,
-- return table shape, language, STABLE, SECURITY DEFINER, and
-- search_path -- byte-identical except for the three added provenance
-- predicates. The predicates are placed INSIDE the `base` CTE's own
-- WHERE clause (immediately after its FROM/LEFT JOINs), not in the
-- outer query -- the outer query only ever sees `base`/`search_pattern`
-- and has no visibility into bp/sp/l, so an outer-WHERE predicate
-- referencing those aliases would be invalid SQL. Placing the
-- predicates inside `base` instead means every downstream reference to
-- `base` (search, cursor, ORDER BY, LIMIT) automatically operates over
-- the already-real-scoped population -- the Real Data filter runs
-- BEFORE search/cursor/limit are ever applied, not after.
--
-- bp/sp are LEFT JOINs (not INNER): a genuinely missing profile row
-- (should never happen given buyer_id/seller_id's NOT NULL FKs, but
-- defensively) makes bp.data_classification/sp.data_classification
-- NULL, and `NULL = 'real'` evaluates to NULL (not TRUE) in SQL's
-- three-valued logic -- so a missing participant fails closed without
-- any extra guard needed. Same reasoning for l.is_test (listing_id is
-- NOT NULL on orders, listings.is_test is NOT NULL, so l will always
-- resolve to exactly one row per order in practice).
--
-- No signature change, no return-shape change, no search/filter/
-- cursor/ordering/limit semantics change -- only WHO is now eligible to
-- appear in the base population at all.
create or replace function public._admin_list_orders_page(
  p_status text default null,
  p_buyer_id uuid default null,
  p_seller_id uuid default null,
  p_payment_status text default null,
  p_disputed boolean default null,
  p_search text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit int default 100
)
returns table(
  id uuid,
  order_reference text,
  listing_id uuid,
  buyer_id uuid,
  seller_id uuid,
  status text,
  total_amount numeric,
  created_at timestamptz
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
        -- matches literally rather than acting as a wildcard --
        -- mirrors _admin_list_merchant_payouts' identical escaping.
        '%' || replace(replace(replace(trim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      else null
    end as pattern
  ),
  base as (
    select
      o.id,
      o.order_reference,
      o.listing_id,
      o.buyer_id,
      o.seller_id,
      o.status::text as status,
      o.total_amount,
      o.created_at,
      l.title as listing_title,
      coalesce(bp.full_name, bp.display_name) as buyer_name,
      coalesce(sp.full_name, sp.display_name) as seller_name
    from public.orders o
    left join public.listings l on l.id = o.listing_id
    left join public.profiles bp on bp.id = o.buyer_id
    left join public.profiles sp on sp.id = o.seller_id
    -- D3-D-F1: Real Data provenance -- positive proof only. A missing
    -- bp/sp/l row (NULL via the LEFT JOINs above) fails this WHERE
    -- closed, never promoted to real.
    where
      bp.data_classification = 'real'
      and sp.data_classification = 'real'
      and l.is_test = false
  )
  select
    base.id, base.order_reference, base.listing_id, base.buyer_id, base.seller_id,
    base.status, base.total_amount, base.created_at
  from base, search_pattern
  where
    (p_status is null or p_status = 'all' or base.status = p_status)
    and (p_buyer_id is null or base.buyer_id = p_buyer_id)
    and (p_seller_id is null or base.seller_id = p_seller_id)
    and (
      p_payment_status is null or p_payment_status = 'all' or exists (
        select 1 from public.payments pay
        where pay.order_id = base.id
          and pay.payment_type = 'order_payment'
          and pay.status::text = p_payment_status
      )
    )
    and (
      p_disputed is null
      or exists (select 1 from public.disputes d where d.order_id = base.id) = p_disputed
    )
    and (
      search_pattern.pattern is null
      or base.order_reference ilike search_pattern.pattern escape '\'
      or coalesce(base.listing_title, '') ilike search_pattern.pattern escape '\'
      or coalesce(base.buyer_name, '') ilike search_pattern.pattern escape '\'
      or coalesce(base.seller_name, '') ilike search_pattern.pattern escape '\'
    )
    and (
      p_cursor_created_at is null or p_cursor_id is null
      or (base.created_at, base.id) < (p_cursor_created_at, p_cursor_id)
    )
  order by base.created_at desc, base.id desc
  limit p_limit;
$$;

revoke all on function public._admin_list_orders_page(text, uuid, uuid, text, boolean, text, timestamptz, uuid, int) from public, anon, authenticated;
grant execute on function public._admin_list_orders_page(text, uuid, uuid, text, boolean, text, timestamptz, uuid, int) to service_role;
