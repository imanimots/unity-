-- ============================================================
-- Barter marketplace (Phase 4) — offer-scoped evidence media
-- ============================================================
-- Optional photos/videos attached to a specific offer version (e.g. a
-- close-up of a scratch, an accessory bundle) -- part of the versioned
-- contractual record, distinct from chat (conversational) and distinct
-- from a listing's own public listing_media. Table + storage bucket,
-- mirroring the rental-media bucket's "path-prefix participant scoping"
-- pattern (20260731000001_rental_media_participant_scoping.sql) rather
-- than the single-owner ownership-proofs pattern, since both agreement
-- parties (not just the uploader) need read access.
--
-- No update/delete policy is granted to anyone but service_role, ever --
-- matches the dominant append-only convention elsewhere in this schema
-- and achieves "immutable once superseded/accepted" without a
-- conditional trigger: nothing already uploaded can ever be altered or
-- removed, regardless of the offer's later state.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table public.barter_offer_media (
  id             uuid primary key default uuid_generate_v4(),
  offer_id       uuid not null references public.barter_offers(id) on delete cascade,
  uploaded_by    uuid not null references public.profiles(id),
  storage_path   text not null,
  media_type     text not null check (media_type in ('photo', 'video')),
  display_order  int not null default 0,
  created_at     timestamptz not null default now()
);

create index barter_offer_media_offer_idx on public.barter_offer_media(offer_id);

alter table public.barter_offer_media enable row level security;

create policy "barter_offer_media: parties read"
  on public.barter_offer_media for select
  using (
    exists (
      select 1 from public.barter_offers
      join public.barter_agreements on barter_agreements.id = barter_offers.agreement_id
      where barter_offers.id = barter_offer_media.offer_id
        and (barter_agreements.party_a_id = auth.uid() or barter_agreements.party_b_id = auth.uid())
    )
  );

create policy "barter_offer_media: admin read"
  on public.barter_offer_media for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client insert policy -- rows are written by the API route via the
-- service-role client after filterMessage-equivalent validation (mime/
-- size/count checks in src/lib/barter/offer-media.ts), consistent with
-- how barter_agreements/offers/history are RPC-only. No update/delete
-- policy for anyone but service_role.

-- ─────────────────────────────────────────
-- Storage bucket
-- ─────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'barter-offer-media', 'barter-offer-media', false,
  10485760, -- 10MB, matches the existing listing-media photo limit
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4']
);

-- Path shape: {agreement_id}/{offer_id}/{uploader_uid}/{filename} --
-- mirrors rental-media's {booking_id}/{uploader_uid}/file convention,
-- with an extra offer_id segment since evidence is offer-version-scoped,
-- not agreement-scoped. Participancy is checked against the first path
-- segment as plain text against barter_agreements.id::text, never cast
-- to uuid inside the policy (a malformed segment should evaluate to "no
-- access", not raise a runtime error during policy evaluation).
create policy "storage barter-offer-media: participant read"
  on storage.objects for select
  using (
    bucket_id = 'barter-offer-media'
    and exists (
      select 1 from public.barter_agreements ba
      where (storage.foldername(name))[1] = ba.id::text
        and (ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid())
    )
  );

create policy "storage barter-offer-media: participant upload"
  on storage.objects for insert
  with check (
    bucket_id = 'barter-offer-media'
    and (storage.foldername(name))[3] = auth.uid()::text
    and exists (
      select 1 from public.barter_agreements ba
      where (storage.foldername(name))[1] = ba.id::text
        and (ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid())
    )
  );

create policy "storage barter-offer-media: admin read"
  on storage.objects for select
  using (
    bucket_id = 'barter-offer-media'
    and exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

-- No delete policy for parties or admin, by design -- offer evidence is
-- exactly the kind of record that should not be deletable by an
-- interested party. Only service_role can delete, via its existing RLS
-- bypass.
