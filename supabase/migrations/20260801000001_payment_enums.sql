-- ============================================================
-- Payment domain enums (Phase 2C)
-- ============================================================
-- Schema only -- no application code exists yet. Separated into its own
-- migration because ALTER TYPE ... ADD VALUE / CREATE TYPE must commit
-- before the new values can be referenced elsewhere in the same session
-- (the same lesson from 20260730000004_booking_status_model.sql).
--
-- payment_status is a dedicated state machine, deliberately never merged
-- with booking_status -- a booking's rental lifecycle and its money
-- movement are tracked independently. See docs/PAYMENT_ARCHITECTURE.md.
--
-- Spelling matches the existing booking_status convention in this schema
-- (British "cancelled", so "authorised" here too, for consistency).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

do $$ begin
  create type payment_status as enum (
    'pending', 'authorised', 'captured', 'partially_captured',
    'released', 'refunded', 'partially_refunded',
    'failed', 'cancelled', 'expired', 'chargeback'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_type as enum ('deposit', 'rental_charge');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ledger_entry_type as enum (
    'rental_charge', 'deposit_hold', 'deposit_release', 'deposit_capture',
    'refund', 'platform_fee', 'merchant_payout'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type payout_status as enum ('pending', 'processing', 'paid', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type refund_status as enum ('pending', 'processing', 'completed', 'failed');
exception when duplicate_object then null; end $$;
