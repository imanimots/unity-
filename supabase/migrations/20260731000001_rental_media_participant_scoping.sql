-- ============================================================
-- Rental-media: scope access to genuine booking participants
-- ============================================================
-- Live-verified before this migration: upload was already folder-owner
-- scoped (20260730000003), but read was still open to any authenticated
-- user regardless of booking participation -- confirmed directly against
-- the live database, not assumed from prior migration text.
--
-- No application code uploads to this bucket yet (grepped the full src
-- tree -- zero references), so there is no existing object-path
-- convention specific to this bucket to preserve. The other private
-- buckets (ownership-proofs, avatars) use {uploader_uid}/filename, but
-- that alone cannot express "both the renter AND the merchant of the
-- same booking may read this," which the required security model needs.
-- Smallest change from the existing convention: prepend booking_id as
-- the leading path segment, keep uploader_uid as the second segment for
-- ownership/audit clarity. Path shape: {booking_id}/{uploader_uid}/file.
--
-- Booking participancy is checked by comparing the path's first segment
-- (plain text) against bookings.id::text -- deliberately never casting
-- the path segment itself to uuid, since a malformed/garbage first
-- segment would raise a runtime error during policy evaluation rather
-- than simply evaluating to "no access."
--
-- No delete policy is added for renter/merchant -- rental evidence is
-- exactly the kind of record that should not be deletable by an
-- interested party (undermines its purpose as evidence). Only
-- service_role can delete, via its existing RLS bypass. Admin tooling to
-- manage this is out of scope.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

drop policy if exists "storage rental-media: authenticated read" on storage.objects;
drop policy if exists "storage rental-media: owner upload" on storage.objects;

create policy "storage rental-media: participant read"
  on storage.objects for select
  using (
    bucket_id = 'rental-media'
    and exists (
      select 1 from public.bookings b
      where (storage.foldername(name))[1] = b.id::text
        and (b.renter_id = auth.uid() or b.merchant_id = auth.uid())
    )
  );

create policy "storage rental-media: participant upload"
  on storage.objects for insert
  with check (
    bucket_id = 'rental-media'
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (
      select 1 from public.bookings b
      where (storage.foldername(name))[1] = b.id::text
        and (b.renter_id = auth.uid() or b.merchant_id = auth.uid())
    )
  );
