-- Platform improvement programme, Phase 2 (Search): the audit found
-- ListingFilters.location was declared but never read anywhere in the
-- search path, and search had no availability/date-range filter at
-- all -- a renter could only discover a booking conflict after
-- clicking into a listing. This migration adds both directly to
-- search_listings, reusing this codebase's own established patterns
-- rather than inventing new ones:
--
--   - province/city: merchant-entered free text (create-listing-flow.tsx
--     has no canonical province/city picker either), so both use
--     case-insensitive matching (ilike) rather than strict equality --
--     province as a whole-value match (it's chosen from the SA_PROVINCES
--     list on the search UI side), city as a partial match (it's a
--     free-text field on both the listing and the search side).
--   - availability: the exact same half-open-interval overlap checks
--     create_booking_request already uses against listing_availability
--     (merchant-blocked dates) and bookings (status in
--     ('accepted','active')) at booking-creation time
--     (20260730000007_booking_rpcs.sql:118-133) -- never a new
--     convention. A listing with no rows in either table (e.g. a
--     sale-only listing) is simply never excluded by these checks,
--     so no mode-specific special-casing is needed.
--
-- This remains a non-authoritative, discovery-time filter only --
-- create_booking_request's own overlap checks remain the sole
-- authority at actual booking time (defense-in-depth, not a
-- duplicated source of truth); a search result is a "likely available"
-- signal, never a guaranteed hold.
create or replace function public.search_listings(
  p_query text default null,
  p_mode text default null,
  p_category text default null,
  p_country_id text default null,
  p_price_min numeric default null,
  p_price_max numeric default null,
  p_sort text default 'newest',
  p_cursor_tier int default null,
  p_cursor_score numeric default null,
  p_cursor_price numeric default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit int default 24,
  -- New trailing parameters, all defaulted -- appended after p_limit
  -- (never inserted earlier in the list) so every existing positional
  -- type in the function's signature is byte-identical to before,
  -- which is what makes a bare CREATE OR REPLACE a safe, clean
  -- replace rather than an accidental new overload (the existing
  -- REVOKE/GRANT statements in 20260902000004_search_ranking_rpcs.sql
  -- reference the old 13-parameter signature explicitly).
  p_province text default null,
  p_city text default null,
  p_start_date date default null,
  p_end_date date default null
)
returns table (
  id uuid,
  match_tier int,
  match_score numeric,
  price numeric,
  created_at timestamptz
)
language sql
security invoker
stable
set search_path = public
as $$
  with normalized as (
    select
      nullif(trim(coalesce(p_query, '')), '') as q,
      lower(regexp_replace(trim(coalesce(p_query, '')), '\s+', ' ', 'g')) as q_exact,
      tsvector_to_array(to_tsvector('english', coalesce(p_query, ''))) as q_lexemes
  ),
  eligible as (
    select
      l.id,
      l.created_at,
      coalesce(l.daily_rate, l.sale_price) as price,
      l.search_vector,
      l.title,
      lower(regexp_replace(trim(l.title), '\s+', ' ', 'g')) as title_exact
    from public.listings l
    where l.status = 'active'
      and l.is_test = false
      and l.direction = 'available'
      and (p_category is null or l.category = p_category)
      and (p_country_id is null or l.country_id = p_country_id)
      and (p_price_min is null or coalesce(l.daily_rate, l.sale_price) >= p_price_min)
      and (p_price_max is null or coalesce(l.daily_rate, l.sale_price) <= p_price_max)
      and (p_province is null or l.province ilike p_province)
      and (p_city is null or l.city ilike '%' || p_city || '%')
      and (p_mode is distinct from 'buy' or l.listing_type in ('sale', 'both'))
      and (
        p_mode is distinct from 'rent'
        or l.listing_type in ('rental', 'both')
        or exists (
          select 1
          from public.rent_to_buy_listing_terms t
          where t.listing_id = l.id and t.enabled = true
        )
      )
      and (
        p_mode is distinct from 'rent_to_buy'
        or exists (
          select 1
          from public.rent_to_buy_listing_terms t
          where t.listing_id = l.id and t.enabled = true
        )
      )
      and not exists (select 1 from public.barter_locked_listings bl where bl.listing_id = l.id)
      and (
        p_start_date is null or p_end_date is null
        or not exists (
          select 1 from public.listing_availability la
          where la.listing_id = l.id
            and la.start_date < p_end_date
            and la.end_date > p_start_date
        )
      )
      and (
        p_start_date is null or p_end_date is null
        or not exists (
          select 1 from public.bookings b
          where b.listing_id = l.id
            and b.status in ('accepted', 'active')
            and tstzrange(b.start_at, b.end_at, '[)') && tstzrange(p_start_date::timestamptz, (p_end_date + 1)::timestamptz, '[)')
        )
      )
  ),
  tiered as (
    select
      e.id, e.created_at, e.price,
      case
        when n.q is null then 0
        when e.title_exact = n.q_exact then 3
        when e.search_vector @@ websearch_to_tsquery('english', n.q) then 2
        when similarity(e.title, n.q) >= 0.3 then 1
        else null
      end as match_tier,
      case
        when n.q is null then 0::numeric(9, 6)
        when e.title_exact = n.q_exact then 1::numeric(9, 6)
        when e.search_vector @@ websearch_to_tsquery('english', n.q) then public._search_tier2_coverage_score(e.title, e.search_vector, n.q_lexemes)
        else round(similarity(e.title, n.q)::numeric, 6)
      end as match_score
    from eligible e cross join normalized n
  )
  select t.id, t.match_tier, t.match_score, t.price, t.created_at
  from tiered t
  where t.match_tier is not null
    and (
      p_cursor_id is null
      or (p_sort = 'relevance' and (
        t.match_tier < p_cursor_tier
        or (t.match_tier = p_cursor_tier and t.match_score < p_cursor_score)
        or (t.match_tier = p_cursor_tier and t.match_score = p_cursor_score and t.created_at < p_cursor_created_at)
        or (t.match_tier = p_cursor_tier and t.match_score = p_cursor_score and t.created_at = p_cursor_created_at and t.id > p_cursor_id)
      ))
      or (p_sort = 'price_asc' and (
        (p_cursor_price is not null and (
          t.price is null
          or t.price > p_cursor_price
          or (t.price = p_cursor_price and t.created_at < p_cursor_created_at)
          or (t.price = p_cursor_price and t.created_at = p_cursor_created_at and t.id > p_cursor_id)
        ))
        or (p_cursor_price is null and t.price is null and (
          t.created_at < p_cursor_created_at
          or (t.created_at = p_cursor_created_at and t.id > p_cursor_id)
        ))
      ))
      or (p_sort = 'price_desc' and (
        (p_cursor_price is not null and (
          t.price is null
          or t.price < p_cursor_price
          or (t.price = p_cursor_price and t.created_at < p_cursor_created_at)
          or (t.price = p_cursor_price and t.created_at = p_cursor_created_at and t.id > p_cursor_id)
        ))
        or (p_cursor_price is null and t.price is null and (
          t.created_at < p_cursor_created_at
          or (t.created_at = p_cursor_created_at and t.id > p_cursor_id)
        ))
      ))
      or (p_sort not in ('relevance', 'price_asc', 'price_desc') and (
        t.created_at < p_cursor_created_at
        or (t.created_at = p_cursor_created_at and t.id > p_cursor_id)
      ))
    )
  order by
    case when p_sort = 'price_asc' then t.price end asc nulls last,
    case when p_sort = 'price_desc' then t.price end desc nulls last,
    case when p_sort = 'relevance' then t.match_tier end desc,
    case when p_sort = 'relevance' then t.match_score end desc,
    t.created_at desc,
    t.id asc
  limit greatest(p_limit, 0);
$$;
-- CREATE OR REPLACE with new trailing parameters (all with defaults) is
-- additive -- every existing positional/named caller remains valid.
