-- Search Ranking MVP -- generated tsvector search columns.
--
-- Text search configuration: 'english' (tested live against
-- DEVELOPMENT data before this migration was written -- see the
-- implementation report). Stemming correctly unifies genuine
-- inflections (cameras -> camera, gardening -> garden) and is applied
-- symmetrically to both stored documents and queries, so brand/model
-- tokens that happen to collide with English suffix stripping (e.g.
-- "EOS" internally stemming to "eo") still match correctly since both
-- sides transform identically. True synonyms (fridge/refrigerator) and
-- compound-word variants (haircut/"hair cut") are NOT unified by
-- stemming alone -- this is a known, accepted MVP limitation; no
-- synonym dictionary is built in this phase (no evidence of demand,
-- matches the audit's own "bounded MVP only if justified" conclusion).
--
-- Weighting: listings.brand/model were audited live immediately before
-- writing this migration (`select count(brand), count(model) from
-- listings where status='active'` -> 0 populated of 780 active rows),
-- so per the authorization's own "only include if populated enough"
-- condition, brand/model are EXCLUDED from the weight-A tier for now.
-- title is the sole weight-A field; category is weight B; description
-- is weight C. Revisit brand/model inclusion once those columns are
-- genuinely populated by the listing wizard.
--
-- Generated STORED columns require no application write-path changes
-- and stay correct automatically on every insert/update.

alter table public.listings
  add column search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) stored;

create index listings_search_vector_idx on public.listings using gin (search_vector);

alter table public.marketplace_requests
  add column search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) stored;

create index marketplace_requests_search_vector_idx on public.marketplace_requests using gin (search_vector);

-- Skills/Tasks: title (A) + description (B) only -- no category weight
-- was specified for this entity, and no private/negotiated-agreement
-- text (contribution details, milestones, evidence) is ever included;
-- this generated column reads only base-table columns that are
-- themselves already part of the public view's existing safe column
-- list (title, description), so it introduces no new exposure surface.
alter table public.barter_skill_task_posts
  add column search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) stored;

create index barter_skill_task_posts_search_vector_idx on public.barter_skill_task_posts using gin (search_vector);
