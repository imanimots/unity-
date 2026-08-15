-- Search Ranking MVP -- fix-forward: Tier 3 was implemented as an
-- unqualified substring match (title ILIKE '%query%'), which is not an
-- "exact title" match at all -- it silently promoted "Camera Bag" and
-- "Security Camera" to the same top tier as a literal "Camera" for a
-- query of "camera". Tier 3 is redefined here as a genuinely normalized
-- EXACT title match: normalized(title) = normalized(query), where
-- normalization is trim + collapse-internal-whitespace + lowercase --
-- the same contract src/lib/search/cursor.ts's normalizeSearchQuery()
-- already applies on the query side before it ever reaches this RPC;
-- this migration applies the identical rule to the title side inside
-- SQL too, so the exact-match guarantee holds even for a caller that
-- invokes these RPCs directly (bypassing the TypeScript layer).
--
-- A title that merely CONTAINS the query as a substring, but is not
-- exactly equal to it once normalized, now falls through to Tier 2
-- (full-text) or Tier 1 (trigram) exactly as any other candidate would
-- -- "Camera Bag" for query "camera" now qualifies via FTS (the title
-- tokenizes to include "camera"), not via a false "exact" tier.
--
-- Tier 3's score is now a constant 1 (the strongest possible score) --
-- there is no partial "exactness"; either the normalized title equals
-- the normalized query or it does not. Ties among multiple exact
-- matches still resolve via the existing created_at DESC, id ASC
-- tie-break, unchanged.
--
-- CREATE OR REPLACE only -- every signature below is byte-identical to
-- the one already applied in 20260902000004_search_ranking_rpcs.sql
-- (verified against pg_proc immediately before writing this migration),
-- so this is a safe in-place replacement, never an overload. That
-- migration itself is NOT edited -- fix-forward only.

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
  p_limit int default 24
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
      lower(regexp_replace(trim(coalesce(p_query, '')), '\s+', ' ', 'g')) as q_exact
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
      and (p_mode is distinct from 'buy' or l.listing_type in ('sale', 'both'))
      and (p_mode is distinct from 'rent' or l.listing_type in ('rental', 'both'))
      and (
        p_mode is distinct from 'rent_to_buy'
        or exists (select 1 from public.rent_to_buy_listing_terms t where t.listing_id = l.id and t.enabled = true)
      )
      and not exists (select 1 from public.barter_locked_listings bl where bl.listing_id = l.id)
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
        when e.search_vector @@ websearch_to_tsquery('english', n.q) then round(ts_rank(e.search_vector, websearch_to_tsquery('english', n.q), 2)::numeric, 6)
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

create or replace function public.search_marketplace_requests(
  p_query text default null,
  p_transaction_type text default null,
  p_category text default null,
  p_country_id text default null,
  p_sort text default 'newest',
  p_cursor_tier int default null,
  p_cursor_score numeric default null,
  p_cursor_budget numeric default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit int default 24
)
returns table (
  id uuid,
  match_tier int,
  match_score numeric,
  budget_min numeric,
  budget_max numeric,
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
      lower(regexp_replace(trim(coalesce(p_query, '')), '\s+', ' ', 'g')) as q_exact
  ),
  eligible as (
    select
      r.id, r.created_at, r.budget_min, r.budget_max, r.search_vector, r.title,
      lower(regexp_replace(trim(r.title), '\s+', ' ', 'g')) as title_exact
    from public.marketplace_requests r
    where r.is_test = false
      and r.status in ('active', 'offers_received')
      and (p_transaction_type is null or r.transaction_type = p_transaction_type)
      and (p_category is null or r.category = p_category)
      and (p_country_id is null or r.country_id = p_country_id)
  ),
  tiered as (
    select
      e.id, e.created_at, e.budget_min, e.budget_max,
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
        when e.search_vector @@ websearch_to_tsquery('english', n.q) then round(ts_rank(e.search_vector, websearch_to_tsquery('english', n.q), 2)::numeric, 6)
        else round(similarity(e.title, n.q)::numeric, 6)
      end as match_score
    from eligible e cross join normalized n
  )
  select t.id, t.match_tier, t.match_score, t.budget_min, t.budget_max, t.created_at
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
      or (p_sort = 'budget_asc' and (
        (p_cursor_budget is not null and (
          t.budget_min is null
          or t.budget_min > p_cursor_budget
          or (t.budget_min = p_cursor_budget and t.created_at < p_cursor_created_at)
          or (t.budget_min = p_cursor_budget and t.created_at = p_cursor_created_at and t.id > p_cursor_id)
        ))
        or (p_cursor_budget is null and t.budget_min is null and (
          t.created_at < p_cursor_created_at
          or (t.created_at = p_cursor_created_at and t.id > p_cursor_id)
        ))
      ))
      or (p_sort = 'budget_desc' and (
        (p_cursor_budget is not null and (
          t.budget_max is null
          or t.budget_max < p_cursor_budget
          or (t.budget_max = p_cursor_budget and t.created_at < p_cursor_created_at)
          or (t.budget_max = p_cursor_budget and t.created_at = p_cursor_created_at and t.id > p_cursor_id)
        ))
        or (p_cursor_budget is null and t.budget_max is null and (
          t.created_at < p_cursor_created_at
          or (t.created_at = p_cursor_created_at and t.id > p_cursor_id)
        ))
      ))
      or (p_sort not in ('relevance', 'budget_asc', 'budget_desc') and (
        t.created_at < p_cursor_created_at
        or (t.created_at = p_cursor_created_at and t.id > p_cursor_id)
      ))
    )
  order by
    case when p_sort = 'budget_asc' then t.budget_min end asc nulls last,
    case when p_sort = 'budget_desc' then t.budget_max end desc nulls last,
    case when p_sort = 'relevance' then t.match_tier end desc,
    case when p_sort = 'relevance' then t.match_score end desc,
    t.created_at desc,
    t.id asc
  limit greatest(p_limit, 0);
$$;

create or replace function public.search_skill_task_posts(
  p_query text default null,
  p_kind text default null,
  p_direction text default null,
  p_category_id uuid default null,
  p_sort text default 'newest',
  p_cursor_tier int default null,
  p_cursor_score numeric default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit int default 24
)
returns table (
  id uuid,
  match_tier int,
  match_score numeric,
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
      lower(regexp_replace(trim(coalesce(p_query, '')), '\s+', ' ', 'g')) as q_exact
  ),
  eligible as (
    select
      p.id, p.created_at, p.search_vector, p.title,
      lower(regexp_replace(trim(p.title), '\s+', ' ', 'g')) as title_exact
    from public.barter_skill_task_public_posts p
    where (p_kind is null or p.kind = p_kind)
      and (p_direction is null or p.direction = p_direction)
      and (p_category_id is null or p.category_id = p_category_id)
  ),
  tiered as (
    select
      e.id, e.created_at,
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
        when e.search_vector @@ websearch_to_tsquery('english', n.q) then round(ts_rank(e.search_vector, websearch_to_tsquery('english', n.q), 2)::numeric, 6)
        else round(similarity(e.title, n.q)::numeric, 6)
      end as match_score
    from eligible e cross join normalized n
  )
  select t.id, t.match_tier, t.match_score, t.created_at
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
      or (p_sort <> 'relevance' and (
        t.created_at < p_cursor_created_at
        or (t.created_at = p_cursor_created_at and t.id > p_cursor_id)
      ))
    )
  order by
    case when p_sort = 'relevance' then t.match_tier end desc,
    case when p_sort = 'relevance' then t.match_score end desc,
    t.created_at desc,
    t.id asc
  limit greatest(p_limit, 0);
$$;
