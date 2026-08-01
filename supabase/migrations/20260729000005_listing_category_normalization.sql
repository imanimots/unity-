-- ============================================================
-- Category normalization — schema design (Phase 0, schema only)
-- ============================================================
-- `listings.category` is currently `text not null` with no database-level
-- constraint — validated only client-side against the CATEGORIES const in
-- src/types/index.ts. That's exactly the "raw text / weak enum" case worth
-- normalizing: introduces `categories`/`subcategories` lookup tables.
--
-- `listings.condition`, by contrast, is EXPLICITLY NOT touched here.
-- It's already a real Postgres enum (`item_condition`: new/like_new/good/
-- fair, from the initial schema migration) — not raw text, not weak. It's
-- adequate for the 4 MVP condition values. No `listing_conditions` table
-- is created; this is a deliberate no-op, documented so it isn't mistaken
-- for an oversight.
--
-- Migration safety: `listings.category_id`/`subcategory_id` are added as
-- NEW, NULLABLE, purely additive columns. The existing `category text not
-- null` column is left completely unchanged — no app code has been
-- updated to read/write category_id yet (that's a later pass), so
-- `category` text remains the only column anything currently populates or
-- queries. A future migration backfills category_id from the text column
-- once the data-layer is updated to use it; only after that would a
-- further future migration consider dropping the legacy text column.
-- No subcategories are seeded — none exist in current app data anywhere;
-- the table is structurally ready for future population without another
-- schema change.
-- Apply via: Supabase Dashboard → SQL Editor → Run
-- ============================================================

create table if not exists public.categories (
  id          uuid primary key default uuid_generate_v4(),
  slug        text not null unique,
  name        text not null,
  description text,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.subcategories (
  id          uuid primary key default uuid_generate_v4(),
  category_id uuid not null references public.categories(id) on delete cascade,
  slug        text not null,
  name        text not null,
  description text,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint subcategories_category_slug_uniq unique (category_id, slug)
);

create index if not exists subcategories_category_idx on public.subcategories(category_id);

alter table public.categories enable row level security;
alter table public.subcategories enable row level security;

create policy "categories: public read"
  on public.categories for select using (true);

create policy "subcategories: public read"
  on public.subcategories for select using (true);

-- No insert/update/delete policy on either — management is an admin/
-- service_role concern, not built in this pass (matches the existing
-- `knowledge_base` table's convention: public-read, write path is
-- intentionally left to a privileged connection, not a client policy).

-- Seed the 9 existing MVP categories (src/types/index.ts CATEGORIES),
-- using the existing category ids as `slug` for continuity with the
-- unchanged `listings.category` text column.
insert into public.categories (slug, name, sort_order) values
  ('tech',     'Tech & Electronics',   0),
  ('outdoor',  'Outdoor & Camping',    1),
  ('tools',    'Tools & DIY',          2),
  ('fashion',  'Luxury Fashion',       3),
  ('events',   'Events & Party',       4),
  ('vehicles', 'Vehicles',             5),
  ('music',    'Musical Instruments',  6),
  ('sports',   'Sports & Fitness',     7),
  ('baby',     'Baby & Kids',          8)
on conflict (slug) do nothing;

-- Additive, nullable, unbackfilled this pass — see header.
alter table public.listings
  add column if not exists category_id    uuid references public.categories(id),
  add column if not exists subcategory_id uuid references public.subcategories(id);

create index if not exists listings_category_id_idx on public.listings(category_id);
create index if not exists listings_subcategory_id_idx on public.listings(subcategory_id);
