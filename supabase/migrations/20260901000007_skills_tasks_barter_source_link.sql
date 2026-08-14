-- ============================================================
-- Skills + Tasks under Barter -- Looking-For source linkage.
-- ============================================================
-- source_skill_task_post_id is a DIFFERENT concept from
-- barter_offer_items.skill_task_post_id (added in the contributions
-- migration): this column identifies the Looking-For Skill/Task post
-- an agreement ORIGINATED from (what its owner WANTED); the other
-- identifies reusable Available supply a contributor is OFFERING.
-- The two are never merged. Nullable/additive -- every existing
-- item-only agreement has this NULL, unaffected.
--
-- An "offer against a Looking-For Skill/Task post" IS a
-- propose_barter() call, full stop -- no second financial/
-- transaction system. Multiple independent proposers can each
-- propose_barter() against the same post, each producing its own
-- separate barter_agreements row, exactly like
-- marketplace_request_offers already allows multiple pending offers
-- against one buy/rent/barter/RTB request.
-- ============================================================

alter table public.barter_agreements
  add column source_skill_task_post_id uuid references public.barter_skill_task_posts(id);

create index barter_agreements_source_skill_task_post_idx on public.barter_agreements(source_skill_task_post_id);

-- ============================================================
-- Immutable snapshot of the SOURCE Looking-For request's own public
-- terms, taken once at first propose_barter() against it. Audit
-- context only -- never overrides the accepted contribution
-- snapshot in barter_contribution_details, and never rewritten by a
-- later edit to the still-editable, still-reusable public request.
-- ============================================================

create table public.barter_skill_task_source_snapshots (
  agreement_id              uuid primary key references public.barter_agreements(id) on delete restrict,
  kind                      text not null check (kind in ('skill', 'task')),
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
  desired_exchange_notes    text,
  created_at                timestamptz not null default now()
);

alter table public.barter_skill_task_source_snapshots enable row level security;

create policy "barter_skill_task_source_snapshots: participants read"
  on public.barter_skill_task_source_snapshots for select
  using (exists (
    select 1 from public.barter_agreements ba
    where ba.id = agreement_id and (ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid())
  ));

-- Zero client write policies -- written once by propose_barter().
