-- ============================================================
-- Skills + Tasks under Barter -- first real review-creation path.
-- ============================================================
-- Confirmed live, immediately before this migration: there is no
-- review-creation code path anywhere in this codebase, for any
-- transaction type. No route, no RPC, no `insert into ... reviews`
-- outside the schema file itself (grepped fresh: zero results). The
-- existing "reviews: reviewer insert" policy -- USING
-- (reviewer_id = auth.uid()), nothing else checked -- lets any
-- authenticated user insert an arbitrary review row for any
-- booking_id/order_id/reviewee_id combination today, with zero
-- verification a real completed transaction occurred. Since nothing
-- legitimate uses that policy (confirmed empty consumer set), it is
-- dropped here rather than left alongside a correct new RPC -- this
-- is the smallest correct fix, not a redesign. Booking/order review
-- creation remains exactly as unbuilt as it is today; only the
-- barter path is added, in the RPC migration.
-- ============================================================

alter table public.reviews
  add column barter_agreement_id uuid references public.barter_agreements(id);

alter table public.reviews
  drop constraint reviews_one_transaction_chk;

alter table public.reviews
  add constraint reviews_one_transaction_chk check (
    (booking_id is not null and order_id is null and barter_agreement_id is null)
    or (booking_id is null and order_id is not null and barter_agreement_id is null)
    or (booking_id is null and order_id is null and barter_agreement_id is not null)
  );

alter table public.reviews
  add constraint reviews_barter_reviewer_unique unique (barter_agreement_id, reviewer_id);

drop policy "reviews: reviewer insert" on public.reviews;

-- "reviews: public read" is untouched -- reviews remain publicly
-- readable, only the unguarded self-claim INSERT path is removed.
-- Zero client write policies remain on reviews after this migration,
-- matching every other RPC-gated table in this codebase.
