-- REVIEWS V2 — public aggregate RPCs.
--
-- profiles.unity_score is no longer fed by reviews (severed in
-- 20260904000008_reviews_v2_schema.sql, Rule 8) -- public review
-- reputation must be computed fresh from valid, published,
-- non-invalidated, non-test reviews (Rule 21), never from unity_score.
-- These are read-only, indexable aggregate queries (using
-- reviews_reviewee_published_idx from the schema migration), not
-- client-side full-table averaging.

create or replace function public._review_public_aggregate(p_reviewee_id uuid)
returns table (review_count bigint, average_rating numeric)
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::bigint, round(avg(rating)::numeric, 2)
  from public.reviews
  where reviewee_id = p_reviewee_id
    and published_at is not null
    and invalidated_at is null
    and is_test = false;
$$;
revoke all on function public._review_public_aggregate(uuid) from public, anon, authenticated;
grant execute on function public._review_public_aggregate(uuid) to service_role;

-- Contextual averages (Rule 7): by domain/context_label AND by
-- reviewee_role, visible from the first review, always paired with its
-- own count so a 1-review average is never shown without its sample size.
create or replace function public._review_contextual_aggregates(p_reviewee_id uuid)
returns table (context_label text, reviewee_role text, review_count bigint, average_rating numeric)
language sql
stable
security definer
set search_path = public
as $$
  select context_label, reviewee_role, count(*)::bigint, round(avg(rating)::numeric, 2)
  from public.reviews
  where reviewee_id = p_reviewee_id
    and published_at is not null
    and invalidated_at is null
    and is_test = false
  group by context_label, reviewee_role;
$$;
revoke all on function public._review_contextual_aggregates(uuid) from public, anon, authenticated;
grant execute on function public._review_contextual_aggregates(uuid) to service_role;
