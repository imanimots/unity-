-- REVIEWS V2 — schema.
--
-- Audit findings (confirmed live before writing this migration):
--   - public.reviews already exists, generic across booking/order/barter
--     (booking_id/order_id/barter_agreement_id, each nullable, exactly-one
--     enforced by reviews_one_transaction_chk). No rent_to_buy_agreement_id
--     column exists yet. Zero client write RLS policies (all writes go
--     through create_barter_review, the only review-creation RPC that has
--     ever existed). "reviews: public read" (using (true)) is the only
--     policy.
--   - All 37 existing rows (34 booking-domain, 3 barter-domain) were
--     confirmed, by direct live inspection, to be QA/test fixture data:
--     the 34 booking rows all reference is_test=true listings created by
--     scripts/verify-clickable-profiles.mjs (titles literally prefixed
--     "[QA] ClickableProfiles ReviewBooking ..."); the 3 barter rows are
--     all between the permanent qa-merchant-a/qa-merchant-b/qa-renter-a
--     fixture accounts. Zero genuine reviews exist. There is therefore no
--     genuine historical review provenance to preserve/reconcile --
--     every existing row is backfilled is_test=true below.
--   - Booking (rental) review has never had a real creation RPC -- the
--     existing UI (src/components/trust/review-form.tsx) fakes success
--     via setTimeout and never writes to the database; its two callers
--     are mock-mode-only. Buy/order and Rent-to-Buy review have no
--     creation path or UI at all, dormant or otherwise.
--   - profiles.unity_score is currently, live, fed DIRECTLY by review
--     ratings via a recalc_unity_score trigger -> update_unity_score()
--     (plain avg(reviews.rating) per reviewee, initial_schema.sql). This
--     violates Reviews V2 Rule 8 ("Review Rating != Unity Score") and is
--     severed below -- the trigger and its now-orphaned function are
--     dropped. Nothing else in the Unity Score engine is touched.
--
-- This migration only adds columns/tables/constraints/policies. It does
-- not touch any RPC body belonging to another domain (orders, bookings,
-- barter_agreements, rent_to_buy_agreements are read-only from here).

-- ─────────────────────────────────────────
-- 1. Sever review ratings -> unity_score coupling (Rule 8)
-- ─────────────────────────────────────────
drop trigger if exists recalc_unity_score on public.reviews;
drop function if exists public.update_unity_score();

-- ─────────────────────────────────────────
-- 2. Widen public.reviews
-- ─────────────────────────────────────────
alter table public.reviews
  add column if not exists rent_to_buy_agreement_id uuid references public.rent_to_buy_agreements(id),
  add column if not exists is_test boolean not null default false,
  add column if not exists domain text,
  add column if not exists context_label text,
  add column if not exists reviewer_role text,
  add column if not exists reviewee_role text,
  add column if not exists header_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists eligible_at timestamptz,
  add column if not exists review_deadline_at timestamptz,
  add column if not exists published_at timestamptz,
  add column if not exists invalidated_at timestamptz,
  add column if not exists invalidated_by uuid references public.profiles(id),
  add column if not exists invalidated_reason text,
  add column if not exists text_hidden_at timestamptz,
  add column if not exists text_hidden_by uuid references public.profiles(id),
  add column if not exists text_hidden_reason text;

-- Backfill the 37 confirmed-QA existing rows so the new NOT NULL columns
-- below can be applied. Best-effort role/domain inference from the
-- linked transaction row -- accuracy doesn't matter for correctness
-- since every one of these rows is being marked is_test=true in the same
-- statement and will never enter a real public aggregate.
update public.reviews r set
  is_test = true,
  domain = case when r.booking_id is not null then 'rent' when r.barter_agreement_id is not null then 'barter' else 'rent' end,
  context_label = case when r.booking_id is not null then 'rent' when r.barter_agreement_id is not null then 'barter' else 'rent' end,
  reviewer_role = case
    when r.booking_id is not null then (select case when b.renter_id = r.reviewer_id then 'renter' else 'merchant' end from public.bookings b where b.id = r.booking_id)
    when r.barter_agreement_id is not null then (select case when ba.party_a_id = r.reviewer_id then 'party_a' else 'party_b' end from public.barter_agreements ba where ba.id = r.barter_agreement_id)
  end,
  reviewee_role = case
    when r.booking_id is not null then (select case when b.renter_id = r.reviewee_id then 'renter' else 'merchant' end from public.bookings b where b.id = r.booking_id)
    when r.barter_agreement_id is not null then (select case when ba.party_a_id = r.reviewee_id then 'party_a' else 'party_b' end from public.barter_agreements ba where ba.id = r.barter_agreement_id)
  end,
  header_snapshot = jsonb_build_object('kind', 'historical_qa_fixture', 'title', 'QA regression fixture'),
  eligible_at = r.created_at,
  review_deadline_at = r.created_at + interval '14 days',
  published_at = r.created_at
where r.domain is null;

alter table public.reviews
  alter column domain set not null,
  alter column context_label set not null,
  alter column eligible_at set not null,
  alter column review_deadline_at set not null;

alter table public.reviews
  add constraint reviews_domain_chk check (domain in ('buy', 'rent', 'barter', 'rent_to_buy')),
  add constraint reviews_rating_bounds_chk check (rating between 1 and 5),
  add constraint reviews_reviewer_not_reviewee_chk check (reviewer_id <> reviewee_id);

-- Widen the exactly-one-transaction check to 4-way.
alter table public.reviews drop constraint if exists reviews_one_transaction_chk;
alter table public.reviews add constraint reviews_one_transaction_chk check (
  (booking_id is not null and order_id is null and barter_agreement_id is null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is not null and barter_agreement_id is null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is not null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is null and rent_to_buy_agreement_id is not null)
);

-- One review per reviewer per transaction, for every domain (booking and
-- barter already had this from earlier migrations -- add the two missing
-- ones so no domain is left without a DB-level duplicate guard).
alter table public.reviews add constraint reviews_order_reviewer_unique unique (order_id, reviewer_id);
alter table public.reviews add constraint reviews_rtb_reviewer_unique unique (rent_to_buy_agreement_id, reviewer_id);

-- Performance (Rule 35): reviewee + publication-state lookups (public
-- aggregate/profile-reviews queries), and deadline-processing scans.
create index if not exists reviews_reviewee_published_idx on public.reviews (reviewee_id, published_at) where invalidated_at is null;
create index if not exists reviews_deadline_processing_idx on public.reviews (review_deadline_at) where published_at is null and invalidated_at is null;
create index if not exists reviews_booking_idx on public.reviews (booking_id) where booking_id is not null;
create index if not exists reviews_order_idx on public.reviews (order_id) where order_id is not null;
create index if not exists reviews_rtb_idx on public.reviews (rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null;

-- RLS: still zero client write policies (unchanged posture) -- but public
-- read must now exclude blind (unpublished) and invalidated reviews at
-- the database level, not merely in application code, so blindness holds
-- even against a direct API/RPC/PostgREST call (Rule 34).
drop policy if exists "reviews: public read" on public.reviews;
create policy "reviews: public read published valid"
  on public.reviews for select
  using (published_at is not null and invalidated_at is null and is_test = false);
create policy "reviews: participant read own"
  on public.reviews for select
  using (auth.uid() = reviewer_id or auth.uid() = reviewee_id);

comment on table public.reviews is 'Reviews V2. All writes via submit_review()/moderation RPCs (service_role only) -- see 20260904000009_reviews_v2_rpcs.sql. Blindness (unpublished reviews hidden from the counterpart and from the public) is enforced here at the RLS layer, not only in application code.';

-- ─────────────────────────────────────────
-- 3. review_replies — exactly one reply per review (Rule 6)
-- ─────────────────────────────────────────
create table if not exists public.review_replies (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null unique references public.reviews(id),
  reviewee_id uuid not null references public.profiles(id),
  reply_text text not null,
  is_test boolean not null default false,
  hidden_at timestamptz,
  hidden_by uuid references public.profiles(id),
  hidden_reason text,
  created_at timestamptz not null default now()
);

create index if not exists review_replies_review_idx on public.review_replies (review_id);

alter table public.review_replies enable row level security;

create policy "review_replies: public read of visible parent"
  on public.review_replies for select
  using (
    hidden_at is null
    and exists (
      select 1 from public.reviews r
      where r.id = review_replies.review_id
        and r.published_at is not null
        and r.invalidated_at is null
        and r.is_test = false
    )
  );
create policy "review_replies: participant read own"
  on public.review_replies for select
  using (
    auth.uid() = reviewee_id
    or auth.uid() in (select reviewer_id from public.reviews r where r.id = review_replies.review_id)
  );

comment on table public.review_replies is 'Reviews V2. One reply per review, by the reviewed party only, within 30 days of the review''s publication. Writes via submit_review_reply()/moderation RPCs only.';

-- ─────────────────────────────────────────
-- 4. review_reports — reviewee reports a review, reviewer reports a reply (Rule 16)
-- ─────────────────────────────────────────
create table if not exists public.review_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id),
  target_type text not null check (target_type in ('review', 'reply')),
  target_id uuid not null,
  reason text not null check (reason in ('harassment', 'scam_fraud', 'inappropriate_content', 'impersonation', 'spam', 'fabricated', 'other')),
  description text,
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  resolution_note text,
  created_at timestamptz not null default now()
);

create index if not exists review_reports_target_idx on public.review_reports (target_type, target_id);
create index if not exists review_reports_status_idx on public.review_reports (status) where status = 'open';

alter table public.review_reports enable row level security;
-- Deliberately zero client policies -- admin/service-role visibility only,
-- matching public.profile_reports' own established precedent exactly.

comment on table public.review_reports is 'Reviews V2. Reporting never auto-hides content, never alters rating/aggregates, never reopens a dispute. Ownership (reviewee-only for a review report, original-reviewer-only for a reply report) is verified server-side in report_review_content(), never trusted from the client.';

-- ─────────────────────────────────────────
-- 5. review_moderation_history — append-only audit trail (Rule 15)
-- ─────────────────────────────────────────
create table if not exists public.review_moderation_history (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id),
  action text not null check (action in ('text_hidden', 'text_unhidden', 'invalidated', 'reply_hidden', 'reply_unhidden', 'report_dismissed')),
  actor_admin_id uuid not null references public.profiles(id),
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists review_moderation_history_review_idx on public.review_moderation_history (review_id);

alter table public.review_moderation_history enable row level security;
-- Deliberately zero client policies -- admin/service-role only.

drop trigger if exists review_moderation_history_immutable on public.review_moderation_history;
create trigger review_moderation_history_immutable
  before update or delete on public.review_moderation_history
  for each row execute procedure public.prevent_row_mutation();

comment on table public.review_moderation_history is 'Reviews V2. Append-only (prevent_row_mutation()) -- every moderation/invalidation action is recorded here with actor, reason, and timestamp, and is never deleted or rewritten.';

-- ─────────────────────────────────────────
-- 6. email_deliveries widening -- add 'review' as a valid related_entity_type
--    (Rule 17), following the exact additive-widening precedent already
--    used for every other domain (order/barter_agreement/rent_to_buy_agreement/...).
-- ─────────────────────────────────────────
alter table public.email_deliveries drop constraint if exists email_deliveries_related_entity_type_check;
alter table public.email_deliveries add constraint email_deliveries_related_entity_type_check check (
  related_entity_type = any (array['booking', 'listing', 'identity_verification', 'order', 'barter_agreement', 'affiliate_commission', 'profile', 'merchant_payout', 'merchant_subscription', 'unity_commission', 'escrow_transaction', 'marketplace_request', 'rent_to_buy_agreement', 'review'])
);
