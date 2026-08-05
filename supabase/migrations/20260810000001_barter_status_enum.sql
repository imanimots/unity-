-- ============================================================
-- Barter marketplace (Phase 4) — status enum
-- ============================================================
-- New type, every value created in one shot — nothing references this
-- type yet, so unlike an ADD VALUE on an existing enum, there is no
-- "must be its own migration" restriction to observe here.
--
-- 'draft' is deliberately NOT a value here — barter_agreements rows are
-- always created directly at 'proposed', mirroring how `bookings` rows
-- are created directly at 'requested', never 'draft'. The wizard-style
-- "draft" state a proposer sees while assembling an offer is client-side
-- only (see docs/BARTER_LIFECYCLE.md once written).
-- ============================================================

create type barter_status as enum (
  'proposed',
  'countered',
  'accepted',
  'preparing',
  'in_transit',
  'awaiting_confirmation',
  'completed',
  'rejected',
  'cancelled',
  'expired',
  'disputed'
);
