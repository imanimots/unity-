-- ============================================================
-- Account erasure: cleanup tracking + creation/erasure concurrency fix
-- (P6-POPIA-ERASURE-AND-ANONYMIZATION-R, P2 findings A/B/C)
-- ============================================================
-- Follow-up to 20261022000000_account_erasure.sql -- that migration is
-- already committed and reviewed and is NOT modified here.
--
-- Finding A/B (false total success, no durable cleanup signal): adds
-- account_erasure_cleanup, a small mutable "current state" table (one
-- row per erased user, upserted by the application layer after each
-- cleanup attempt -- storage/auth operations cannot run in SQL, so
-- this table is written directly from TypeScript with the service-role
-- client, the same established pattern as
-- src/lib/payments/orchestrator/*.ts and src/lib/email/service.ts, not
-- through a new RPC). No erased PII is ever stored here -- only the
-- user_id reference (safe for the same reason account_erasure_log's
-- FK is safe: the profiles row is never deleted) and boolean/attempt
-- bookkeeping. Surfaced through the EXISTING admin operational-
-- exceptions list (src/lib/admin/exceptions-service.ts) rather than a
-- new dashboard -- see that file's own change for the actual query.
--
-- Finding C (TOCTOU race): erase_account already takes `for update` on
-- the target profile row before checking active obligations. The
-- creation-side guards it races against
-- (_assert_account_status_permits_creation/_transaction, called by
-- create_booking_request, accept_booking_request, create_order,
-- propose_barter, accept_barter_offer, create_rent_to_buy_request,
-- accept_rent_to_buy_request, publish_marketplace_request,
-- submit_marketplace_offer, counter_barter_offer, submit_review, and
-- every other RPC that calls them) read account_status with a plain,
-- unlocked SELECT -- so a concurrent erase_account and a concurrent
-- transaction-creation call do not serialize against each other at
-- all today.
--
-- Fix: change that plain SELECT to `for share`. `for share` locks
-- acquired by multiple concurrent callers on the SAME row are mutually
-- COMPATIBLE (never block each other), so two ordinary transaction-
-- creation calls that each lock two different users' profile rows
-- (e.g. renter-then-merchant in create_booking_request vs.
-- merchant-then-renter in accept_booking_request) can never deadlock
-- against each other no matter what order they lock in -- this is
-- deliberately NOT the "lock both rows in sorted-UUID order" approach
-- the brief suggested as one option, because that would require
-- rewriting the lock-acquisition order inside seven-plus existing
-- RPCs across bookings/orders/barter/rent-to-buy, a far larger and
-- riskier change than this phase's narrow scope allows. `for share`
-- gives the same deadlock-free guarantee with a one-line change to
-- exactly the two functions already shared by every one of those RPCs.
--
-- `for share` DOES conflict with erase_account's `for update` on the
-- same row, which is exactly the serialization needed:
--   - erase_account locks first -> any concurrent creation call
--     calling the guard blocks until erase_account commits, then
--     correctly sees account_status = 'erased' and fails.
--   - a creation call locks (for share) first -> erase_account's own
--     `for update` blocks until that transaction commits, then
--     erase_account's obligation-check queries run against the now-
--     committed new booking/order/etc. row and correctly block the
--     erasure.
-- Normal marketplace throughput is unaffected: `for share` never
-- blocks concurrent ordinary (non-locking) reads, and erase_account is
-- a rare, single-row-locking admin/self-service action, not a hot path.
--
-- Finding D (public profile tombstone) is a pure TypeScript change
-- (src/lib/data/profiles.ts) -- no schema change required, not part of
-- this migration.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table if not exists public.account_erasure_cleanup (
  user_id                   uuid primary key references public.profiles(id),
  auth_ban_complete         boolean not null default false,
  avatar_cleanup_complete   boolean not null default false,
  kyc_cleanup_complete      boolean not null default false,
  attempt_count             int not null default 0,
  last_attempt_at           timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

alter table public.account_erasure_cleanup enable row level security;

create policy "account_erasure_cleanup: admin read"
  on public.account_erasure_cleanup for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client write policy at all -- only the service-role cleanup code
-- in src/lib/privacy/account-erasure.ts ever writes this table, and
-- service_role bypasses RLS regardless.

create or replace function public._assert_account_status_permits_creation(p_user_id uuid, p_relation text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select account_status::text into v_status from public.profiles where id = p_user_id for share;
  if v_status in ('restricted', 'suspended', 'erased') then
    raise exception 'account_restricted:%', p_relation;
  end if;
end;
$$;

create or replace function public._assert_account_status_permits_transaction(p_user_id uuid, p_relation text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select account_status::text into v_status from public.profiles where id = p_user_id for share;
  if v_status in ('suspended', 'erased') then
    raise exception 'account_suspended:%', p_relation;
  end if;
end;
$$;
