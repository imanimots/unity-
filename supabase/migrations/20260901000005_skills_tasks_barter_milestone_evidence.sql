-- ============================================================
-- Skills + Tasks under Barter -- milestone evidence.
-- ============================================================
-- Mirrors dispute_evidence's exact shape and path convention:
-- {milestone_id}/{uploader_uid}/{filename} -- two folder segments
-- plus filename, identical in shape to dispute_evidence's own path.
-- No update/delete client policy anywhere -- immutable, append-only.
-- Written by the API route via a service-role client after
-- re-validating the path prefix server-side, exactly like
-- dispute_evidence's own route (no RPC layer for either table).
-- ============================================================

create table public.barter_milestone_evidence (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references public.barter_contribution_milestones(id) on delete restrict,
  uploaded_by uuid not null references public.profiles(id),
  storage_path text not null,
  file_type text not null check (file_type in ('image', 'pdf', 'document')),
  display_order int not null default 0,
  created_at timestamptz not null default now()
);

create index barter_milestone_evidence_milestone_idx on public.barter_milestone_evidence(milestone_id);

alter table public.barter_milestone_evidence enable row level security;

create policy "barter_milestone_evidence: participants read"
  on public.barter_milestone_evidence for select
  using (public.is_barter_contribution_participant(
    (select offer_item_id from public.barter_contribution_milestones where id = milestone_id),
    auth.uid()
  ));

create policy "barter_milestone_evidence: admin read"
  on public.barter_milestone_evidence for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client INSERT/UPDATE/DELETE policy -- rows are written only by
-- the API route via a service-role client.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'barter-milestone-evidence', 'barter-milestone-evidence', false,
  10485760, -- 10MB
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

-- Path segment compared as text, never cast to uuid -- avoids a hard
-- runtime error on a malformed/arbitrary path segment, the same
-- pitfall dispute_evidence's own storage RLS avoids.
create policy "storage barter-milestone-evidence: participant read"
  on storage.objects for select
  using (
    bucket_id = 'barter-milestone-evidence'
    and exists (
      select 1
      from public.barter_contribution_milestones m
      join public.barter_offer_items boi on boi.id = m.offer_item_id
      join public.barter_offers bo on bo.id = boi.offer_id
      join public.barter_agreements ba on ba.id = bo.agreement_id
      where m.id::text = (storage.foldername(name))[1]
        and (ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid())
    )
  );

create policy "storage barter-milestone-evidence: participant upload"
  on storage.objects for insert
  with check (
    bucket_id = 'barter-milestone-evidence'
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (
      select 1
      from public.barter_contribution_milestones m
      join public.barter_offer_items boi on boi.id = m.offer_item_id
      join public.barter_offers bo on bo.id = boi.offer_id
      join public.barter_agreements ba on ba.id = bo.agreement_id
      where m.id::text = (storage.foldername(name))[1]
        and (ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid())
    )
  );

create policy "storage barter-milestone-evidence: admin read"
  on storage.objects for select
  using (
    bucket_id = 'barter-milestone-evidence'
    and exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

-- No delete policy for anyone but service_role, by design (immutable).
