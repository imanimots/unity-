-- ============================================================
-- Fix: rental-media storage bucket has no ownership/party scoping
-- ============================================================
-- Discovered during Phase 2A live validation and flagged twice as
-- out-of-scope until an active feature used it. Phase 2B introduces the
-- rental start/return lifecycle, which may eventually attach handover or
-- return evidence to a booking via this bucket, so the gap is closed now
-- rather than carried into an active feature (this migration does not
-- itself add any upload UI or booking-media table -- see
-- docs/BOOKING_LIFECYCLE.md for what is and is not built this phase).
--
-- Before: both read and upload were open to ANY authenticated user,
-- regardless of whether they were a party to any booking at all --
-- strictly worse than the listing-media bug fixed in
-- 20260730000001_fix_listing_media_upload_rls.sql, since that one was
-- upload-only. Object paths in this bucket are expected to be namespaced
-- by uploader id (uid/filename), matching every other private bucket in
-- this schema (ownership-proofs, avatars), so folder-ownership is the
-- correct scope for uploads. Read access is intentionally left open to
-- any authenticated user for now -- narrowing it to booking participants
-- specifically requires a booking-media table that does not exist yet
-- (deferred, see docs/BOOKING_LIFECYCLE.md future extension points) --
-- but upload must not remain unrestricted regardless.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

drop policy if exists "storage rental-media: authenticated upload" on storage.objects;

create policy "storage rental-media: owner upload"
  on storage.objects for insert
  with check (
    bucket_id = 'rental-media'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
