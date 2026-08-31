-- Admin Orders: bounded keyset pagination + relational filtering.
--
-- Proven root cause (diagnosis phase): listAdminOrders() fetched `orders`
-- with `.order(created_at desc).limit(100)`, no cursor -- status/buyerId/
-- sellerId were already genuine relational predicates (PostgREST applies
-- WHERE before LIMIT regardless of JS chaining order), but
-- paymentStatus/disputed/search were applied in Node, in memory, AFTER
-- the 100-row bound -- the classic bounded-fetch-then-filter anti-
-- pattern. Combined with permanently-reused QA fixtures that age out of
-- the top 100 as unrelated real orders accumulate, this produced false
-- negatives indistinguishable from a real defect, and is also a genuine
-- admin-usability defect: rows past #100 are structurally unreachable.
--
-- Fix: one bounded, relational, parameterized RPC mirroring
-- _admin_list_merchant_payouts (20260904000022) exactly -- all filters
-- (including paymentStatus/disputed/search, now moved server-side)
-- applied in the WHERE clause before ORDER BY/LIMIT, plus a (created_at,
-- id) keyset cursor predicate for genuine pagination beyond the first
-- page. No id array of any size crosses into Node; no all-history fetch.
--
-- Filter semantics preserved exactly from the Node code being replaced:
--   - paymentStatus: payments.status for the row's payment_type='order_payment'
--     payment (exactly one such row per order, confirmed via the existing
--     `.single()` lookup pattern elsewhere in this codebase) equals the
--     requested value. Orders with no matching payment row never match a
--     non-null paymentStatus filter (payments.status is being ilike'd for
--     equality, not existence-only).
--   - disputed: true iff ANY row exists in `disputes` for the order,
--     regardless of that dispute's own status (no status exclusion in the
--     Node code being replaced -- a resolved/closed dispute still counts).
--   - search: case-insensitive substring match (matching JS
--     .toLowerCase().includes()) across order_reference, listing title,
--     buyer name, seller name. ILIKE wildcard characters in the user's
--     term are escaped so they match literally, matching .includes()'s
--     literal-substring semantics exactly.
--
-- Search input is a typed function parameter (never interpolated into
-- dynamic SQL / EXECUTE), bound normally by Postgres.
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
