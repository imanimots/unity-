-- Search Ranking MVP -- fix-forward: Tier 2 (FTS) previously scored
-- candidates with raw `ts_rank(..., 2)`, which -- despite the length
-- normalization flag -- still rewards RAW TERM FREQUENCY once two
-- documents reach comparable length: a title that repeats one matched
-- query lexeme several times could out-rank a title that genuinely
-- matches more DISTINCT query concepts, or even out-rank an equally
-- short honest document. Live-reproduced before writing this migration
-- (see the closure report): "Canon camera camera camera camera" scored
-- roughly double "Canon camera for sale here" for the query "canon
-- camera", even though both match exactly the same two distinct
-- concepts.
--
-- Fix: Tier 2's score is now a frequency-insensitive DISTINCT-lexeme
-- coverage score, computed by the new _search_tier2_coverage_score()
-- helper below. It answers "how many of the query's distinct lexemes
-- does this document contain, and where" -- never "how many times".
-- Repeating the same query lexeme in a title/description contributes
-- nothing extra, because tsvector_to_array() collapses every lexeme
-- (regardless of how many times it occurs) down to a single set
-- membership test. This also means a REPEATED QUERY ("camera camera
-- camera") normalizes identically to a single-term query ("camera"),
-- since the query's own lexeme set is deduplicated the same way.
--
-- Formula (bounded to [0, 1], deterministic, pure SQL, no procedural
-- loop, no Node-side computation):
--
--   score = (title_matches * 3 + (anywhere_matches - title_matches) * 1)
--           / (n_distinct_query_lexemes * 3)
--
-- where title_matches/anywhere_matches are COUNTS of DISTINCT query
-- lexemes found in the title / anywhere in the weighted search_vector
-- (title+category+description, or title+description for Skill/Task).
-- A lexeme matched in the title contributes 3x a lexeme matched only
-- elsewhere -- preserving "title relevance stronger than description
-- relevance" (the same title(A) > description(C) intent the generated
-- search_vector columns already encode) without depending on ts_rank's
-- own frequency-sensitive internals. Matching MORE distinct query
-- concepts still increases the score (partial coverage of a multi-term
-- query scores lower than full coverage) -- validated empirically
-- against all of Cases A/B/C plus a partial-coverage and a title-vs-
-- description-only scenario before this migration was written.
--
-- The exact/FTS/trigram tier CLASSIFICATION (which tier a row lands in)
-- is unchanged -- Tier 2's gating condition is still exactly
-- `search_vector @@ websearch_to_tsquery('english', query)`; only the
-- SCORE used to order rows within Tier 2 changes. Tier 3 (exact title,
-- from 20260902000005) and Tier 1 (trigram) are untouched entirely.
--
-- CREATE OR REPLACE only for the three RPCs -- every signature below is
-- byte-identical to the one already applied (verified against pg_proc
-- immediately before writing this migration). Neither
-- 20260902000004_search_ranking_rpcs.sql nor
-- 20260902000005_search_ranking_exact_title_tier_fix.sql is edited --
-- fix-forward only.

-- ── Coverage-score helper, shared by all three RPCs. STABLE (not
-- IMMUTABLE) because text-search behavior is formally dictionary-
-- dependent, matching the STABLE marking already used on the RPCs
-- themselves. No table access, no side effects, bounded output. ──
create or replace function public._search_tier2_coverage_score(
  p_title text,
  p_doc_vector tsvector,
  p_query_lexemes text[]
)
returns numeric
language sql
stable
parallel safe
set search_path = public
as $$
  select case
    when p_query_lexemes is null or coalesce(array_length(p_query_lexemes, 1), 0) = 0 then 0::numeric
    else round(
      (
        (select count(*) from unnest(p_query_lexemes) w(lex) where w.lex = any(tsvector_to_array(to_tsvector('english', coalesce(p_title, ''))))) * 3
        + (
          (select count(*) from unnest(p_query_lexemes) w(lex) where w.lex = any(tsvector_to_array(p_doc_vector)))
          - (select count(*) from unnest(p_query_lexemes) w(lex) where w.lex = any(tsvector_to_array(to_tsvector('english', coalesce(p_title, '')))))
        ) * 1
      )::numeric / (array_length(p_query_lexemes, 1) * 3)
    , 6)
  end
$$;

revoke all on function public._search_tier2_coverage_score(text, tsvector, text[]) from public;
grant execute on function public._search_tier2_coverage_score(text, tsvector, text[]) to anon, authenticated, service_role;

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
      lower(regexp_replace(trim(coalesce(p_query, '')), '\s+', ' ', 'g')) as q_exact,
      tsvector_to_array(to_tsvector('english', coalesce(p_query, ''))) as q_lexemes
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
        when e.search_vector @@ websearch_to_tsquery('english', n.q) then public._search_tier2_coverage_score(e.title, e.search_vector, n.q_lexemes)
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
      lower(regexp_replace(trim(coalesce(p_query, '')), '\s+', ' ', 'g')) as q_exact,
      tsvector_to_array(to_tsvector('english', coalesce(p_query, ''))) as q_lexemes
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
        when e.search_vector @@ websearch_to_tsquery('english', n.q) then public._search_tier2_coverage_score(e.title, e.search_vector, n.q_lexemes)
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
