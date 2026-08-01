-- ============================================================
-- Booking status model (Phase 2B)
-- ============================================================
-- Extends the existing booking_status enum (20260613000001_initial_schema)
-- rather than replacing it -- bookings has 0 live rows as of this
-- migration (verified live before writing this), so renaming existing
-- values is safe and loses no data.
--
-- 'pending' -> 'requested' and 'approved' -> 'accepted' to match the
-- vocabulary used throughout the booking RPCs, API routes and docs added
-- this phase. New terminal/intermediate values added for the fuller
-- lifecycle: rejected, cancelled_by_renter, cancelled_by_merchant,
-- expired, return_pending, completed.
--
-- 'cancelled' and 'disputed' are kept but UNUSED by Phase 2B's state
-- machine -- 'cancelled' is reserved for a future privileged/system-
-- initiated cancellation path (admin process, out of scope this phase),
-- 'disputed' is reserved for the pre-existing disputes table's future
-- integration (also out of scope). No RPC or route added this phase
-- transitions a booking into either value -- see
-- docs/BOOKING_LIFECYCLE.md for the full transition table.
--
-- Postgres requires ALTER TYPE ... ADD VALUE to be committed before the
-- new value can be used in the same session -- this migration only
-- changes the enum, nothing else. Everything that references the new
-- values lives in later migrations.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter type booking_status rename value 'pending' to 'requested';
alter type booking_status rename value 'approved' to 'accepted';

alter type booking_status add value if not exists 'rejected' after 'requested';
alter type booking_status add value if not exists 'expired' after 'rejected';
alter type booking_status add value if not exists 'cancelled_by_renter' after 'expired';
alter type booking_status add value if not exists 'cancelled_by_merchant' after 'cancelled_by_renter';
alter type booking_status add value if not exists 'return_pending' after 'active';
alter type booking_status add value if not exists 'completed' after 'returned';
