-- ============================================================
-- Step 11 Phase 2 -- dispute_evidence
-- ============================================================
-- Mirrors barter_offer_media's exact shape (table columns, bucket
-- config, path-prefix storage policies -- see
-- 20260810000004_barter_offer_media.sql), substituting
-- is_dispute_participant() for the inline 3-way join. No update/delete
-- client policy anywhere -- immutable, append-only, matches the
-- barter_offer_media precedent (and the brief's explicit "no
-- overwrite" requirement) exactly.
--
-- Path convention: {dispute_id}/{uploader_uid}/{filename} -- simpler
-- than barter_offer_media's 3-segment path since evidence attaches
-- directly to the dispute, not to a versioned sub-resource like an
-- offer.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table if not exists public.dispute_evidence (
  id uuid primary key default uuid_generate_v4(),
  dispute_id uuid not null references public.disputes(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id),
  storage_path text not null,
  file_type text not null check (file_type in ('image', 'pdf', 'document')),
  display_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists dispute_evidence_dispute_idx on public.dispute_evidence(dispute_id);

alter table public.dispute_evidence enable row level security;

create policy "dispute_evidence: parties read"
  on public.dispute_evidence for select
  using (public.is_dispute_participant(dispute_id, auth.uid()));

create policy "dispute_evidence: admin read"
  on public.dispute_evidence for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client INSERT/UPDATE/DELETE policy -- rows are written only by the
-- API route via a service-role client (same as barter_offer_media).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'dispute-evidence', 'dispute-evidence', false,
  10485760, -- 10MB
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

-- Path segment is compared as text (d.id::text = ...), never cast to
-- uuid -- casting a malformed/arbitrary path segment to uuid throws a
-- hard runtime error rather than just failing the policy check, the
-- same pitfall barter_offer_media's own storage RLS avoids.
create policy "storage dispute-evidence: participant read"
  on storage.objects for select
  using (
    bucket_id = 'dispute-evidence'
    and exists (
      select 1 from public.disputes d
      left join public.bookings b on b.id = d.booking_id
      left join public.orders o on o.id = d.order_id
      left join public.barter_agreements ba on ba.id = d.barter_agreement_id
      where d.id::text = (storage.foldername(name))[1]
        and (
          d.raised_by = auth.uid()
          or b.renter_id = auth.uid() or b.merchant_id = auth.uid()
          or o.buyer_id = auth.uid() or o.seller_id = auth.uid()
          or ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid()
        )
    )
  );

create policy "storage dispute-evidence: participant upload"
  on storage.objects for insert
  with check (
    bucket_id = 'dispute-evidence'
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (
      select 1 from public.disputes d
      left join public.bookings b on b.id = d.booking_id
      left join public.orders o on o.id = d.order_id
      left join public.barter_agreements ba on ba.id = d.barter_agreement_id
      where d.id::text = (storage.foldername(name))[1]
        and (
          d.raised_by = auth.uid()
          or b.renter_id = auth.uid() or b.merchant_id = auth.uid()
          or o.buyer_id = auth.uid() or o.seller_id = auth.uid()
          or ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid()
        )
    )
  );

create policy "storage dispute-evidence: admin read"
  on storage.objects for select
  using (
    bucket_id = 'dispute-evidence'
    and exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

-- No delete policy for anyone but service_role, by design (immutable).
