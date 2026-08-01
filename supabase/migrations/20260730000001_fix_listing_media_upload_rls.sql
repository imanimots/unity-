-- ============================================================
-- Fix: listing-media storage upload policy missing folder-ownership check
-- ============================================================
-- Discovered live during Phase 2A validation: "storage listing-media:
-- authenticated upload" only checked auth.role() = 'authenticated', with
-- no check that the upload path's first folder segment matches the
-- caller's own uid. Any authenticated user (including a renter) could
-- upload arbitrary files into any OTHER user's listing-media/{uid}/ path.
-- Confirmed exploitable: merchant B successfully wrote a file into
-- merchant A's folder during live testing.
--
-- The "avatars" and "ownership-proofs" bucket policies already use the
-- correct pattern (auth.uid()::text = (storage.foldername(name))[1]) —
-- this brings listing-media in line with that existing pattern. Public
-- read access is unchanged.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

drop policy if exists "storage listing-media: authenticated upload" on storage.objects;

create policy "storage listing-media: owner upload"
  on storage.objects for insert
  with check (
    bucket_id = 'listing-media'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
