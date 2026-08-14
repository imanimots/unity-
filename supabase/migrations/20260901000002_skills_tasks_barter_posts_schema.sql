-- ============================================================
-- Skills + Tasks under Barter -- public Skill/Task post schema.
-- ============================================================
-- barter_skill_task_posts is the home for BOTH "Available" (I can
-- teach/do this) and "Looking For" (I want someone to teach/do this)
-- Skill/Task marketplace activity -- deliberately NOT a listings row
-- (listings is priced/quantity/physical-inventory shaped -- forcing
-- Skill/Task through it would mean every future listings-wide
-- feature has to remember to no-op for two special listing_type
-- values forever) and NOT a marketplace_requests row (that table is
-- buy/rent/rent_to_buy shaped -- budget_min/max, start/end dates --
-- none of which fits a teaching/work offer). transaction_type is
-- hard-CHECK-constrained to the literal 'barter' -- not a
-- convention, a constraint -- so this can never be mistaken for a
-- new transaction family at the commission/escrow/dispute layer,
-- which already routes purely off `barter_agreement_id IS NOT NULL`.
--
-- Public read access is intentionally NOT granted on this base table
-- (see the view at the bottom of this file) -- only the owner may
-- read their own row via RLS; every other access (public marketplace
-- browsing, matching, profile tabs) goes through the explicit-column
-- view, mirroring the public_profiles mechanism exactly.
-- ============================================================

create table public.barter_skill_task_posts (
  id                        uuid primary key default gen_random_uuid(),
  owner_id                  uuid not null references public.profiles(id),
  kind                      text not null check (kind in ('skill', 'task')),
  direction                 text not null check (direction in ('available', 'looking_for')),
  transaction_type          text not null default 'barter' check (transaction_type = 'barter'),
  status                    barter_skill_task_post_status not null default 'draft',
  -- Captured only on a real non-suspended -> suspended transition;
  -- never overwritten by a repeat suspend call. Cleared on restore.
  pre_suspend_status        barter_skill_task_post_status,
  title                     text,
  description               text,
  category_id               uuid references public.categories(id),
  subcategory_id            uuid references public.subcategories(id),
  delivery_mode             text check (delivery_mode in ('remote', 'in_person', 'either')),
  province                  text,
  city                      text,
  exclusions                text,
  materials_arrangement     text,
  evidence_expectations     text,
  desired_exchange_notes    text,
  wants_item                boolean not null default false,
  wants_skill                boolean not null default false,
  wants_task                boolean not null default false,
  wants_cash_adjustment     boolean not null default false,
  -- Discovery-intent scheduling only -- distinct from the contractual
  -- per-milestone scheduling on barter_contribution_milestones.
  availability_notes        text,
  preferred_start_date      date,
  preferred_start_time      time,
  deadline                  date,
  expected_duration_notes   text,
  reposted_from_post_id     uuid references public.barter_skill_task_posts(id),
  -- Set once, the first time this post ever leaves 'draft'. Never
  -- cleared afterward -- this is what makes kind/direction immutable
  -- post-publish, even if the post is later paused/archived/reused.
  first_published_at        timestamptz,
  is_test                   boolean not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index barter_skill_task_posts_owner_id_idx on public.barter_skill_task_posts(owner_id);
create index barter_skill_task_posts_kind_direction_status_idx on public.barter_skill_task_posts(kind, direction, status);

create or replace function public.touch_barter_skill_task_post_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger barter_skill_task_posts_touch_updated_at
  before update on public.barter_skill_task_posts
  for each row execute procedure public.touch_barter_skill_task_post_updated_at();

alter table public.barter_skill_task_posts enable row level security;

-- Owner-only read on the base table -- no broad public/cross-user
-- SELECT policy exists here at all. Public marketplace access is
-- exclusively through barter_skill_task_public_posts below.
create policy "barter_skill_task_posts: owner read"
  on public.barter_skill_task_posts for select
  using (owner_id = auth.uid());

-- Zero client write policies -- fully RPC-gated, matching
-- barter_agreements/barter_offers' own "no client write policy
-- anywhere" convention.

-- ============================================================
-- Non-binding milestone TEMPLATE -- a discovery-time preview only.
-- Never read at offer-acceptance time; the authoritative milestone
-- set is always created fresh in barter_contribution_milestones at
-- offer time (see the contributions migration).
-- ============================================================

create table public.barter_skill_task_post_milestone_templates (
  id              uuid primary key default gen_random_uuid(),
  post_id         uuid not null references public.barter_skill_task_posts(id) on delete cascade,
  title           text not null,
  description     text,
  sequence        int not null check (sequence > 0),
  weight_percent  numeric(5,2) not null check (weight_percent > 0 and weight_percent <= 100),
  created_at      timestamptz not null default now(),
  unique (post_id, sequence)
);

alter table public.barter_skill_task_post_milestone_templates enable row level security;

create policy "barter_skill_task_post_milestone_templates: owner read"
  on public.barter_skill_task_post_milestone_templates for select
  using (exists (
    select 1 from public.barter_skill_task_posts p
    where p.id = post_id and p.owner_id = auth.uid()
  ));

-- ============================================================
-- Post-level reporting -- distinct from report_profile() (which
-- reports the USER). This identifies exactly which post was
-- reported, so an admin can act on content without necessarily
-- touching the account. Mirrors profile_reports' exact shape.
-- ============================================================

create table public.barter_skill_task_post_reports (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid not null references public.profiles(id),
  post_id       uuid not null references public.barter_skill_task_posts(id),
  reason        text not null check (reason in ('harassment', 'scam_fraud', 'inappropriate_content', 'impersonation', 'spam', 'prohibited_content', 'other')),
  description   text,
  status        text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at    timestamptz not null default now()
);

create index barter_skill_task_post_reports_post_id_idx on public.barter_skill_task_post_reports(post_id);

alter table public.barter_skill_task_post_reports enable row level security;
-- Deliberately zero client read/write policies -- fully RPC-gated,
-- admin visibility via direct service-role query, matching
-- profile_reports' own precedent exactly.

-- ============================================================
-- Immutable, append-only post lifecycle history. Reuses the shared
-- prevent_row_mutation() trigger function (first defined in
-- 20260729000003_listing_declarations_and_history.sql), not
-- redefined here.
-- ============================================================

create table public.barter_skill_task_post_history (
  id                uuid primary key default gen_random_uuid(),
  post_id           uuid not null references public.barter_skill_task_posts(id),
  actor_user_id     uuid references public.profiles(id),
  actor_role        text not null check (actor_role in ('owner', 'system', 'admin')),
  event_type        text not null,
  previous_status   barter_skill_task_post_status,
  new_status        barter_skill_task_post_status not null,
  -- Admin suspend/restore reason is persisted here (never merely
  -- accepted and discarded), never exposed through the public view.
  reason            text,
  metadata          jsonb not null default '{}'::jsonb,
  idempotency_key   text,
  created_at        timestamptz not null default now()
);

create index barter_skill_task_post_history_post_id_idx on public.barter_skill_task_post_history(post_id, created_at);

alter table public.barter_skill_task_post_history enable row level security;

create policy "barter_skill_task_post_history: owner read"
  on public.barter_skill_task_post_history for select
  using (exists (
    select 1 from public.barter_skill_task_posts p
    where p.id = post_id and p.owner_id = auth.uid()
  ));

create trigger prevent_barter_skill_task_post_history_mutation
  before update or delete on public.barter_skill_task_post_history
  for each row execute procedure public.prevent_row_mutation();

-- ============================================================
-- Public marketplace surface -- explicit-column view, exactly
-- mirroring the public_profiles mechanism: created by the
-- migration-applying (privileged) role, so it can read every row
-- despite the tightened base-table RLS above, while its own fixed
-- column list is the hard boundary -- pre_suspend_status, admin
-- reason, moderation metadata, report state, and any future
-- internal/lifecycle column added to the base table are excluded by
-- default, never automatically exposed.
--
-- Public eligibility is direction-aware: an AVAILABLE post is public
-- only while 'active'; a LOOKING_FOR post stays public through
-- 'active' AND 'offers_received' -- an open request receiving its
-- first, second, or Nth offer does not stop being publicly
-- discoverable, only becoming 'matched' does.
-- ============================================================

create view public.barter_skill_task_public_posts as
select
  id, owner_id, kind, direction, title, description, category_id, subcategory_id,
  delivery_mode, province, city, exclusions, materials_arrangement, evidence_expectations,
  desired_exchange_notes, wants_item, wants_skill, wants_task, wants_cash_adjustment,
  availability_notes, preferred_start_date, preferred_start_time, deadline, expected_duration_notes,
  created_at
from public.barter_skill_task_posts
where is_test = false
  and (
    (direction = 'available' and status = 'active')
    or (direction = 'looking_for' and status in ('active', 'offers_received'))
  );

grant select on public.barter_skill_task_public_posts to anon, authenticated;
