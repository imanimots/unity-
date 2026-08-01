-- ============================================================
-- Listing moderation — schema design (Phase 0, schema only)
-- ============================================================
-- Moderation is kept entirely separate from `listings.status` (the
-- lifecycle enum: draft/pending/active/paused/rented). Overloading one
-- enum with two concerns — "where is this listing in its lifecycle" and
-- "has Unity reviewed and approved it" — would make both harder to reason
-- about independently. `moderation_status` is the review verdict;
-- `listings.status` transitioning to 'active' will, once a real
-- publishing-completeness service exists, need to check
-- moderation_status = 'approved' where moderation is required — that
-- integration is not built in this pass.
--
-- listing_moderation mixes an internal, admin-only field
-- (moderation_notes) with a merchant-safe one (rejection_reason) in the
-- same row. RLS is row-level, not column-level, so one table-level policy
-- cannot expose one column but not the other to the same caller — hence
-- the base table is admin/service_role-only, and merchants instead read a
-- narrow view (listing_moderation_merchant_view) whose column list simply
-- never includes moderation_notes, so it cannot leak via select('*').
-- No application code has been built against any of this yet.
-- Apply via: Supabase Dashboard → SQL Editor → Run
-- ============================================================

do $$ begin
  create type moderation_status as enum (
    'pending', 'approved', 'rejected', 'requires_review', 'flagged'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.listing_moderation (
  listing_id       uuid primary key references public.listings(id) on delete cascade,
  moderation_status moderation_status not null default 'pending',
  -- Internal only — never exposed to merchants or the public.
  moderation_notes  text,
  moderated_by      uuid references public.profiles(id),
  moderated_at      timestamptz,
  -- Merchant-safe — explanation a merchant is allowed to see for a
  -- rejection, distinct from moderation_notes' internal detail.
  rejection_reason  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists listing_moderation_status_idx on public.listing_moderation(moderation_status);

alter table public.listing_moderation enable row level security;

-- Admin-only base-table access. Same profiles.role='admin' RLS pattern
-- introduced in 20260729000003_listing_declarations_and_history.sql.
create policy "listing_moderation: admin read"
  on public.listing_moderation for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );

create policy "listing_moderation: admin update"
  on public.listing_moderation for update
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );

-- No public policy, no merchant policy (see the view below), no client
-- INSERT policy — the future server-side listing-mutation service creates
-- the initial row (service_role, bypasses RLS) when a listing is
-- submitted for review.

-- Merchant-safe view: deliberately narrow column list (no
-- moderation_notes), with its own auth.uid() filter baked into the query
-- rather than relying on the base table's RLS — this view runs with the
-- privileges of its (privileged) owner, the same pattern Supabase/Postgres
-- uses generally to expose a filtered subset of an otherwise-locked-down
-- table. security_invoker is explicitly set to false so this behavior
-- doesn't silently change if a future Postgres default changes.
create or replace view public.listing_moderation_merchant_view
with (security_invoker = false)
as
select
  lm.listing_id,
  lm.moderation_status,
  lm.rejection_reason,
  lm.moderated_at
from public.listing_moderation lm
join public.listings l on l.id = lm.listing_id
where l.merchant_id = auth.uid();

grant select on public.listing_moderation_merchant_view to authenticated;
