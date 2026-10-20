-- ============================================================
-- P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I
--
-- Real, durable pre-handover/post-return condition evidence for
-- ORDINARY RENTAL BOOKINGS. Closes the launch-audit-confirmed blocker:
-- src/components/trust/media-upload.tsx previously only simulated a
-- successful upload (setTimeout + toast, no API call, no persistence),
-- reachable only in NEXT_PUBLIC_MOCK_MODE. dispute_evidence and
-- rent_to_buy_evidence are real but are NOT substitutes -- the former
-- is reactive (only exists once a dispute is already open), the latter
-- is a different product (Rent-to-Buy agreements, not ordinary rental
-- bookings).
--
-- Mirrors rent_to_buy_evidence's exact, already-proven architecture
-- (supabase/migrations/20260821183555_rtb_v2_schema.sql): same column
-- shape, same RLS model (parties + admin read, no client
-- insert/update/delete -- rows are written only by the API route via a
-- service-role client), same "no RPC layer, direct insert after
-- revalidation" model, immutable/append-only by construction (no
-- update/delete policy for anyone but service_role).
--
-- Storage: reuses the EXISTING private `rental-media` bucket
-- unchanged -- its storage.objects RLS (supabase/migrations/
-- 20260730000003_fix_rental_media_upload_rls.sql,
-- 20260731000001_rental_media_participant_scoping.sql) already scopes
-- read+upload to genuine booking participants via the exact
-- {booking_id}/{uploader_uid}/{filename} path convention this table's
-- rows will reference -- no new bucket, no new storage policy needed.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'booking_evidence_stage') then
    create type booking_evidence_stage as enum ('pre_handover', 'post_return');
  end if;
end $$;

create table if not exists public.booking_condition_evidence (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references public.bookings(id),
  uploaded_by     uuid not null references public.profiles(id),
  evidence_stage  public.booking_evidence_stage not null,
  storage_path    text not null,
  file_type       text not null check (file_type in ('image', 'video')),
  caption         text,
  display_order   int not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists booking_condition_evidence_booking_stage_idx
  on public.booking_condition_evidence(booking_id, evidence_stage);

alter table public.booking_condition_evidence enable row level security;

create policy "booking_condition_evidence: parties read" on public.booking_condition_evidence
  for select using (
    exists (
      select 1 from public.bookings b
      where b.id = booking_condition_evidence.booking_id
        and (b.renter_id = auth.uid() or b.merchant_id = auth.uid())
    )
  );

create policy "booking_condition_evidence: admin read" on public.booking_condition_evidence
  for select using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client INSERT/UPDATE/DELETE policy -- rows are written only by the
-- API route via a service-role client (same as dispute_evidence /
-- rent_to_buy_evidence). Evidentiary integrity: once created, a row's
-- booking_id/uploaded_by/evidence_stage/storage_path can never be
-- altered by any client-reachable path, and it can never be deleted by
-- a participant -- only service_role's RLS bypass can, and no route in
-- this phase exercises that.
