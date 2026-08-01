-- ============================================================
-- Booking security hardening (Phase 2B)
-- ============================================================
-- Fixes a live, pre-existing gap found during this phase's mandatory
-- audit: "bookings: parties update" (20260613000001_initial_schema) used
-- USING (renter_id = auth.uid() OR merchant_id = auth.uid()) as its ONLY
-- check, with WITH CHECK repeating the exact same condition -- meaning
-- either party could directly update status, merchant_id, renter_id, or
-- any financial column on their own booking via a plain authenticated
-- PostgREST UPDATE, as long as the row still satisfied the same OR
-- condition afterward. Confirmed live: 0 rows exist, so no data was ever
-- exposed by this, but the policy itself was live and exploitable.
--
-- "bookings: renter insert" had the same class of gap: it only checked
-- renter_id = auth.uid(), with no validation that merchant_id actually
-- matches the target listing's real merchant, or that price fields were
-- honest -- a direct insert could set merchant_id/rental_fee/deposit to
-- anything.
--
-- Fix: booking creation and every lifecycle transition go exclusively
-- through the service-role-only RPCs in 20260730000007_booking_rpcs.sql,
-- called from trusted Next.js API routes that derive renter_id/
-- merchant_id/all financial values server-side -- the same pattern
-- already proven for submit_listing_for_review
-- (20260730000002_restrict_submit_to_server.sql). There is no legitimate
-- reason for a direct client INSERT or UPDATE on bookings at all, so
-- both policies are dropped rather than tightened -- SECURITY DEFINER
-- RPCs called via service_role bypass RLS entirely regardless.
--
-- "bookings: parties read" is unaffected -- unchanged, still correct.
--
-- A privileged-field trigger is added as defense-in-depth (same
-- belt-and-suspenders pattern as protect_listing_privileged_fields, see
-- 20260729000006_listing_security_hardening.sql) in case a future
-- migration ever reintroduces a client-facing insert/update policy by
-- mistake.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

drop policy if exists "bookings: renter insert" on public.bookings;
drop policy if exists "bookings: parties update" on public.bookings;

create or replace function public.protect_booking_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    if TG_OP = 'INSERT' then
      raise exception 'bookings must be created via the booking request RPC, not a direct insert';
    else
      new.status := old.status;
      new.renter_id := old.renter_id;
      new.merchant_id := old.merchant_id;
      new.listing_id := old.listing_id;
      new.start_at := old.start_at;
      new.end_at := old.end_at;
      new.currency := old.currency;
      new.rate_amount := old.rate_amount;
      new.rate_unit := old.rate_unit;
      new.duration_units := old.duration_units;
      new.subtotal_amount := old.subtotal_amount;
      new.deposit_amount_snapshot := old.deposit_amount_snapshot;
      new.platform_fee_amount := old.platform_fee_amount;
      new.renter_total_amount := old.renter_total_amount;
      new.merchant_proceeds_estimate := old.merchant_proceeds_estimate;
      new.price_calculation_version := old.price_calculation_version;
      new.terms_snapshot := old.terms_snapshot;
      new.terms_snapshot_version := old.terms_snapshot_version;
      new.requested_at := old.requested_at;
      new.accepted_at := old.accepted_at;
      new.rejected_at := old.rejected_at;
      new.expires_at := old.expires_at;
      new.cancelled_at := old.cancelled_at;
      new.cancelled_by := old.cancelled_by;
      new.rental_started_at := old.rental_started_at;
      new.return_initiated_at := old.return_initiated_at;
      new.returned_at := old.returned_at;
      new.completed_at := old.completed_at;
      new.version := old.version;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_booking_privileged_fields_trg on public.bookings;
create trigger protect_booking_privileged_fields_trg
  before insert or update on public.bookings
  for each row execute procedure public.protect_booking_privileged_fields();
