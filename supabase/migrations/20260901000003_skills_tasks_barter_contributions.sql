-- ============================================================
-- Skills + Tasks under Barter -- offer contribution widening.
-- ============================================================
-- barter_offer_items is widened in place (additive columns only) to
-- carry item, skill, or task contributions -- not forked into a
-- parallel table. Existing item-only rows (kind defaults 'item',
-- listing_id stays required for that kind) are completely
-- unaffected; the existing 62 item-barter regression checks, which
-- only ever produce kind='item' rows via the unchanged plain-array
-- RPC params, see zero behavior change.
--
-- skill_task_post_id is PROVENANCE ONLY (which reusable Available
-- Skill/Task supply this contribution originated from) -- never
-- authoritative for terms. The full negotiated scope for a
-- skill/task contribution is snapshotted, once, at propose/counter
-- time, into barter_contribution_details -- never re-read from the
-- (editable, reusable) public post afterward by any code path.
-- ============================================================

alter table public.barter_offer_items
  alter column listing_id drop not null,
  add column kind text not null default 'item' check (kind in ('item', 'skill', 'task')),
  add column skill_task_post_id uuid references public.barter_skill_task_posts(id),
  add column contribution_weight_percent numeric(5,2);

alter table public.barter_offer_items
  add constraint barter_offer_items_kind_shape_chk check (
    (kind = 'item' and listing_id is not null and skill_task_post_id is null)
    or (kind in ('skill', 'task') and listing_id is null)
  );

-- Item contributions never carry a performance weight (nothing to
-- weight -- an item is handed over, not performed); skill/task
-- contributions require one, bounded 0-100 exclusive/inclusive.
alter table public.barter_offer_items
  add constraint barter_offer_items_contribution_weight_chk check (
    (kind = 'item' and contribution_weight_percent is null)
    or (kind in ('skill', 'task') and contribution_weight_percent is not null
        and contribution_weight_percent > 0 and contribution_weight_percent <= 100)
  );

create index barter_offer_items_skill_task_post_idx on public.barter_offer_items(skill_task_post_id);

-- ============================================================
-- Immutable, per-offer-version snapshot of a skill/task
-- contribution's full negotiated scope. Populated once, at
-- propose_barter()/counter_barter_offer() time, by copying every
-- field either from the current state of the referenced
-- barter_skill_task_posts row (if skill_task_post_id is set) or
-- directly from the caller-supplied private/custom values (if not)
-- -- identical column shape either way. Never updated afterward by
-- any RPC.
-- ============================================================

create table public.barter_contribution_details (
  offer_item_id             uuid primary key references public.barter_offer_items(id) on delete restrict,
  title                     text not null,
  description               text,
  exclusions                text,
  materials_arrangement     text,
  evidence_expectations     text,
  delivery_mode             text check (delivery_mode in ('remote', 'in_person', 'either')),
  province                  text,
  city                      text,
  availability_notes        text,
  preferred_start_date      date,
  preferred_start_time      time,
  deadline                  date,
  expected_duration_notes   text,
  created_at                timestamptz not null default now()
);

-- ============================================================
-- Milestones -- one table serves both offer-time definition and
-- post-acceptance live progress, since offer rows are never mutated
-- after creation (a revision creates an entirely new offer version
-- with entirely new rows, the pre-existing "each offer version is a
-- full replacement package" convention) and accepted_offer_id
-- freezes which version's rows are authoritative forever.
-- ============================================================

create table public.barter_contribution_milestones (
  id                      uuid primary key default gen_random_uuid(),
  offer_item_id           uuid not null references public.barter_offer_items(id) on delete restrict,
  title                   text not null,
  description             text,
  sequence                int not null check (sequence > 0),
  weight_percent          numeric(5,2) not null check (weight_percent > 0 and weight_percent <= 100),
  delivery_mode           text check (delivery_mode in ('remote', 'in_person', 'either')),
  -- Contractual (post-acceptance) scheduling -- distinct from the
  -- discovery-intent scheduling fields on barter_skill_task_posts.
  scheduled_at            timestamptz,
  scheduled_city          text,
  scheduled_province      text,
  schedule_confirmed_by   uuid[] not null default '{}'::uuid[],
  status                  barter_milestone_status not null default 'pending',
  completed_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  unique (offer_item_id, sequence)
);

-- At most one ACTIVE milestone per contribution, enforced by the
-- database, not merely by RPC discipline -- a partial unique index
-- rather than a full one, since many rows may legitimately be
-- 'pending' or 'completed' simultaneously.
create unique index barter_contribution_milestones_one_active_idx
  on public.barter_contribution_milestones(offer_item_id)
  where status = 'active';

create index barter_contribution_milestones_offer_item_idx on public.barter_contribution_milestones(offer_item_id, sequence);

create or replace function public.touch_barter_contribution_milestone_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger barter_contribution_milestones_touch_updated_at
  before update on public.barter_contribution_milestones
  for each row execute procedure public.touch_barter_contribution_milestone_updated_at();

-- ============================================================
-- Shared participant-check helper, mirroring is_dispute_participant()
-- -- used by RLS on barter_contribution_details/milestones/evidence
-- (evidence added in a later migration) instead of repeating the
-- 3-hop join through barter_offer_items -> barter_offers ->
-- barter_agreements in every policy.
-- ============================================================

create or replace function public.is_barter_contribution_participant(p_offer_item_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.barter_offer_items boi
    join public.barter_offers bo on bo.id = boi.offer_id
    join public.barter_agreements ba on ba.id = bo.agreement_id
    where boi.id = p_offer_item_id
      and (ba.party_a_id = p_user_id or ba.party_b_id = p_user_id)
  );
$$;

alter table public.barter_contribution_details enable row level security;
alter table public.barter_contribution_milestones enable row level security;

create policy "barter_contribution_details: participants read"
  on public.barter_contribution_details for select
  using (public.is_barter_contribution_participant(offer_item_id, auth.uid()));

create policy "barter_contribution_milestones: participants read"
  on public.barter_contribution_milestones for select
  using (public.is_barter_contribution_participant(offer_item_id, auth.uid()));

-- Zero client write policies on either table -- fully RPC-gated,
-- matching every other barter table's convention.
