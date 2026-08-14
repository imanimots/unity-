-- ============================================================
-- Skills + Tasks under Barter -- immutable milestone history.
-- ============================================================
-- Reuses the shared prevent_row_mutation() trigger function, not
-- redefined here -- same convention as barter_history/dispute_history/
-- barter_skill_task_post_history. agreement_id is denormalized onto
-- every row purely so admin/dispute tooling can query by agreement
-- without a join through offer_item -> offer -> agreement.
-- ============================================================

create table public.barter_milestone_history (
  id                uuid primary key default gen_random_uuid(),
  milestone_id      uuid not null references public.barter_contribution_milestones(id),
  agreement_id      uuid not null references public.barter_agreements(id),
  actor_user_id     uuid references public.profiles(id),
  actor_role        text not null check (actor_role in ('party_a', 'party_b', 'system', 'admin')),
  event_type        text not null,
  previous_status   barter_milestone_status,
  new_status        barter_milestone_status not null,
  metadata          jsonb not null default '{}'::jsonb,
  idempotency_key   text,
  created_at        timestamptz not null default now()
);

create index barter_milestone_history_milestone_idx on public.barter_milestone_history(milestone_id, created_at);
create index barter_milestone_history_agreement_idx on public.barter_milestone_history(agreement_id, created_at);

alter table public.barter_milestone_history enable row level security;

create policy "barter_milestone_history: participants read"
  on public.barter_milestone_history for select
  using (exists (
    select 1 from public.barter_agreements ba
    where ba.id = agreement_id and (ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid())
  ));

create trigger prevent_barter_milestone_history_mutation
  before update or delete on public.barter_milestone_history
  for each row execute procedure public.prevent_row_mutation();
