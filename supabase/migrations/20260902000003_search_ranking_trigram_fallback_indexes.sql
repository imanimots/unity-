-- Search Ranking MVP -- typo-tolerance fallback (Tier 1) must work
-- across all three public entity families, not only listings.
-- `listings_title_trgm_idx` already exists (since the very first
-- schema migration) and is reused as-is. This migration adds the
-- equivalent title-only trigram index for the two tables that don't
-- have one yet. Fallback stays title-only by design (never fuzzy-ranks
-- descriptions -- see the ranking RPCs in the next migration).
create index if not exists marketplace_requests_title_trgm_idx
  on public.marketplace_requests using gin (title gin_trgm_ops);

create index if not exists barter_skill_task_posts_title_trgm_idx
  on public.barter_skill_task_posts using gin (title gin_trgm_ops);
