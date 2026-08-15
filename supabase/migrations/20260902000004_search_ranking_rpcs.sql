-- Search Ranking MVP -- deterministic SQL ranking/browse functions.
--
-- One shared ordering model across all three: match_tier (int, DESC)
-- -> match_score (numeric(9,6), DESC) -> created_at (DESC) -> id (ASC)
-- for relevance search; created_at/id only for Newest; the relevant
-- price/budget column + created_at/id for explicit price/budget
-- sorts. Tiers (typed search only):
--   3 = normalized exact/phrase title match (title ILIKE the trimmed query)
--   2 = full-text match (search_vector @@ websearch_to_tsquery('english', query))
--   1 = trigram typo fallback on title only (similarity(title, query) >= 0.3,
--       threshold tested live against representative pairs before this
--       migration was written: typo pairs scored 0.39-0.71, unrelated
--       pairs scored 0-0.05 -- see the implementation report)
-- A candidate is classified into exactly the HIGHEST tier it qualifies
-- for (never duplicated across tiers). Empty/absent query -> every
-- eligible row gets tier 0 / score 0, collapsing the ORDER BY to plain
-- created_at DESC, id ASC (deterministic Newest browse).
--
-- ts_rank uses normalization flag 2 (divide by document length) --
-- tested live to confirm this neutralizes keyword-stuffing (a 5x-
-- repeated single word scored LOWER than one honest mention of the
-- same word in a short title). Repeating QUERY terms does not change
-- ts_rank at all (verified: identical rank whether the query term
-- appears once or three times), so no additional query-side dedup is
-- required, though the TypeScript normalization layer still collapses
-- whitespace defensively.
--
-- These functions return ONLY safe identifiers + ranking/pagination
-- metadata -- never full row data. Callers bulk-fetch display data
-- afterward from the existing safe data layer (getListings-equivalent
-- selects, or the public views), preserving this ordering.
--
-- SECURITY INVOKER throughout: listings/marketplace_requests already
-- have real public RLS policies (the listings policy was just fixed
-- in 20260902000001 to also require is_test=false), so running as the
-- calling role naturally enforces eligibility with zero duplicated
-- logic. The Skill/Task function reads exclusively from the public
-- view (widened below to also expose search_vector, itself derived
-- only from title/description -- both already public view columns),
-- so it never touches the base table and needs no elevated privilege
-- either.

-- ── Widen the Skill/Task public view: search_vector only, derived
-- exclusively from columns the view already exposes (title,
-- description). This does not change the R5-2 eligibility predicate
-- or expose any new base-table column beyond the vector itself. ──
create or replace view public.barter_skill_task_public_posts as
select
  id, owner_id, kind, direction, title, description, category_id, subcategory_id,
  delivery_mode, province, city, exclusions, materials_arrangement, evidence_expectations,
  desired_exchange_notes, wants_item, wants_skill, wants_task, wants_cash_adjustment,
  availability_notes, preferred_start_date, preferred_start_time, deadline, expected_duration_notes,
  created_at, search_vector
from public.barter_skill_task_posts
where is_test = false
  and (
    (direction = 'available' and status = 'active')
    or (direction = 'looking_for' and status in ('active', 'offers_received'))
  );

grant select on public.barter_skill_task_public_posts to anon, authenticated;

-- ══════════════════════════════════════════════════════════════════
-- search_listings
-- ══════════════════════════════════════════════════════════════════
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
    select nullif(trim(coalesce(p_query, '')), '') as q
  ),
  eligible as (
    select
      l.id,
      l.created_at,
      coalesce(l.daily_rate, l.sale_price) as price,
      l.search_vector,
      l.title
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
        when e.title ilike '%' || n.q || '%' then 3
        when e.search_vector @@ websearch_to_tsquery('english', n.q) then 2
        when similarity(e.title, n.q) >= 0.3 then 1
        else null
      end as match_tier,
      case
        when n.q is null then 0::numeric(9, 6)
        when e.title ilike '%' || n.q || '%' then round(least(length(n.q)::numeric / greatest(length(e.title), 1), 1), 6)
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

revoke all on function public.search_listings(text, text, text, text, numeric, numeric, text, int, numeric, numeric, timestamptz, uuid, int) from public;
grant execute on function public.search_listings(text, text, text, text, numeric, numeric, text, int, numeric, numeric, timestamptz, uuid, int) to anon, authenticated;

-- ══════════════════════════════════════════════════════════════════
-- search_marketplace_requests
-- ══════════════════════════════════════════════════════════════════
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
    select nullif(trim(coalesce(p_query, '')), '') as q
  ),
  eligible as (
    select r.id, r.created_at, r.budget_min, r.budget_max, r.search_vector, r.title
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
        when e.title ilike '%' || n.q || '%' then 3
        when e.search_vector @@ websearch_to_tsquery('english', n.q) then 2
        when similarity(e.title, n.q) >= 0.3 then 1
        else null
      end as match_tier,
      case
        when n.q is null then 0::numeric(9, 6)
        when e.title ilike '%' || n.q || '%' then round(least(length(n.q)::numeric / greatest(length(e.title), 1), 1), 6)
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

revoke all on function public.search_marketplace_requests(text, text, text, text, text, int, numeric, numeric, timestamptz, uuid, int) from public;
grant execute on function public.search_marketplace_requests(text, text, text, text, text, int, numeric, numeric, timestamptz, uuid, int) to anon, authenticated;

-- ══════════════════════════════════════════════════════════════════
-- search_skill_task_posts -- no price/budget sort (Skills/Tasks are
-- never monetary), no rating sort (removed from default relevance
-- entirely per this phase's product decision).
-- ══════════════════════════════════════════════════════════════════
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
    select nullif(trim(coalesce(p_query, '')), '') as q
  ),
  eligible as (
    select p.id, p.created_at, p.search_vector, p.title
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
        when e.title ilike '%' || n.q || '%' then 3
        when e.search_vector @@ websearch_to_tsquery('english', n.q) then 2
        when similarity(e.title, n.q) >= 0.3 then 1
        else null
      end as match_tier,
      case
        when n.q is null then 0::numeric(9, 6)
        when e.title ilike '%' || n.q || '%' then round(least(length(n.q)::numeric / greatest(length(e.title), 1), 1), 6)
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

revoke all on function public.search_skill_task_posts(text, text, text, uuid, text, int, numeric, timestamptz, uuid, int) from public;
grant execute on function public.search_skill_task_posts(text, text, text, uuid, text, int, numeric, timestamptz, uuid, int) to anon, authenticated;
