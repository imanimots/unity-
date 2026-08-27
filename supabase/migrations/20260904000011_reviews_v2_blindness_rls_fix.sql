-- REVIEWS V2 — blindness RLS fix.
--
-- Corrective, fix-forward (20260904000008 is already applied and left
-- untouched). Found during application-layer wiring: the
-- "reviews: participant read own" policy allowed
-- `auth.uid() = reviewee_id`, which let the REVIEWEE read an
-- UNPUBLISHED incoming review about themselves directly via RLS/any
-- direct PostgREST/RPC call -- the exact retaliation loophole Rule 3
-- forbids ("a party who has not reviewed must not be able to inspect
-- the other party's rating/text before deciding whether to submit"),
-- and Rule 34 requires this hold even against manual API calls, not
-- only hidden in React.
--
-- The reviewee has no legitimate need to read their own not-yet-published
-- incoming review at all -- once published, "reviews: public read
-- published valid" already covers everyone, including the reviewee.
-- The only legitimate "own" read is a REVIEWER checking whether they
-- have already submitted (published or not) -- reviewer_id only.
drop policy if exists "reviews: participant read own" on public.reviews;
create policy "reviews: reviewer read own"
  on public.reviews for select
  using (auth.uid() = reviewer_id);
