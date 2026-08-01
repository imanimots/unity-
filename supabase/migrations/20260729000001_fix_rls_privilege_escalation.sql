-- ============================================================
-- Fix RLS privilege escalation (Phase 1 foundation)
-- ============================================================
-- The "own row" UPDATE policies on profiles/bookings/orders only ever had a
-- USING clause. Postgres reuses USING as the implicit WITH CHECK for UPDATE
-- when none is given, but that clause only constrains identity columns
-- (`auth.uid() = id`, `renter_id = auth.uid() or merchant_id = auth.uid()`,
-- etc.) — it says nothing about which OTHER columns on the row may change.
-- A user updating their own profile/booking/order therefore could rewrite
-- any column on it, including ones that must never be self-service:
--   - profiles.role                        (privilege escalation to 'admin')
--   - profiles.kyc_status                  (self-approving KYC)
--   - profiles.unity_score                 (self-inflating trust score)
--   - profiles.is_affiliate/affiliate_code (self-granting affiliate status,
--     bypassing src/app/api/affiliate/activate's server-generated code)
--   - bookings/orders financial + party fields (total_amount, rental_fee,
--     deposit_amount, payfast_payment_id, affiliate fields, or even
--     reassigning renter_id/merchant_id/buyer_id/seller_id)
--
-- RLS's WITH CHECK operates on the new row only — it has no way to compare
-- against the row's previous values within the policy expression itself.
-- Column-level "this may not change except via a privileged path" therefore
-- needs a trigger, the same mechanism already used for `listings.risk_tier`
-- (see 20260720000002_risk_engine.sql) to make a column non-client-settable.
-- These triggers follow that exact precedent: silently revert protected
-- columns to their previous value for any caller that isn't the
-- service_role (used by server-side API routes with elevated privileges),
-- rather than rejecting the whole update — an ordinary client updating,
-- say, their own display_name should not have that update fail just
-- because the request also carried an unrelated read-only field.
--
-- Explicit WITH CHECK clauses are also added below, spelling out in the
-- policy itself (not just the trigger) that the row's own identity columns
-- must be preserved — belt-and-braces with the trigger, and self-documenting
-- for anyone reading the policy list in the Supabase dashboard.
-- Apply via: Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- ─────────────────────────────────────────
-- PROFILES — protect role, kyc_status, unity_score
-- ─────────────────────────────────────────
create or replace function public.protect_profile_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    new.role := old.role;
    new.kyc_status := old.kyc_status;

    -- unity_score has one legitimate non-service-role writer: update_unity_score()
    -- (SECURITY DEFINER trigger on `reviews`, defined in 20260613000001_initial_schema.sql)
    -- issues a nested `update profiles set unity_score = ...` after every review
    -- insert/update. SECURITY DEFINER changes whose privileges the function body
    -- runs with, but NOT auth.role() — that still reflects the original caller's
    -- JWT, so a plain reviewer's auth.role() is 'authenticated' both for a direct
    -- profiles update AND for this legitimate cascade. pg_trigger_depth() tells
    -- them apart: a direct client "profiles: own update" call sees depth 1 (this
    -- trigger is the only one on the stack); update_unity_score()'s nested update
    -- sees depth 2 (already one level deep inside the reviews trigger). Only a
    -- role with schema CREATE privileges could fabricate a deeper trigger context
    -- to game this, and that's already a trusted actor outside RLS's threat model
    -- — regular authenticated/anon roles cannot create triggers.
    if pg_trigger_depth() <= 1 then
      new.unity_score := old.unity_score;
    end if;

    -- is_affiliate/affiliate_code are only ever legitimately written by
    -- src/app/api/affiliate/activate, which uses the service-role client —
    -- so this branch (auth.role() <> 'service_role') never needs a carve-out
    -- for them the way unity_score does.
    new.is_affiliate := old.is_affiliate;
    new.affiliate_code := old.affiliate_code;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_privileged_fields_trg on public.profiles;
create trigger protect_profile_privileged_fields_trg
  before update on public.profiles
  for each row execute procedure public.protect_profile_privileged_fields();

drop policy if exists "profiles: own update" on public.profiles;
create policy "profiles: own update"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ─────────────────────────────────────────
-- BOOKINGS — protect financial fields and party identity
-- ─────────────────────────────────────────
-- Self-service via the app is limited to `status` transitions (approve /
-- decline / confirm return) and uploading rental media — never the money
-- fields or who the two parties are.
create or replace function public.protect_booking_financial_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    new.listing_id := old.listing_id;
    new.renter_id := old.renter_id;
    new.merchant_id := old.merchant_id;
    new.start_date := old.start_date;
    new.end_date := old.end_date;
    new.total_days := old.total_days;
    new.rental_fee := old.rental_fee;
    new.deposit_amount := old.deposit_amount;
    new.shipping_fee := old.shipping_fee;
    new.total_amount := old.total_amount;
    new.payfast_payment_id := old.payfast_payment_id;
    new.affiliate_id := old.affiliate_id;
    new.affiliate_commission_amount := old.affiliate_commission_amount;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_booking_financial_fields_trg on public.bookings;
create trigger protect_booking_financial_fields_trg
  before update on public.bookings
  for each row execute procedure public.protect_booking_financial_fields();

drop policy if exists "bookings: parties update" on public.bookings;
create policy "bookings: parties update"
  on public.bookings for update
  using (renter_id = auth.uid() or merchant_id = auth.uid())
  with check (renter_id = auth.uid() or merchant_id = auth.uid());

-- ─────────────────────────────────────────
-- ORDERS — protect financial fields and party identity
-- ─────────────────────────────────────────
create or replace function public.protect_order_financial_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    new.listing_id := old.listing_id;
    new.buyer_id := old.buyer_id;
    new.seller_id := old.seller_id;
    new.quantity := old.quantity;
    new.unit_price := old.unit_price;
    new.shipping_fee := old.shipping_fee;
    new.total_amount := old.total_amount;
    new.payfast_payment_id := old.payfast_payment_id;
    new.affiliate_id := old.affiliate_id;
    new.affiliate_commission_amount := old.affiliate_commission_amount;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_order_financial_fields_trg on public.orders;
create trigger protect_order_financial_fields_trg
  before update on public.orders
  for each row execute procedure public.protect_order_financial_fields();

drop policy if exists "orders: parties update" on public.orders;
create policy "orders: parties update"
  on public.orders for update
  using (buyer_id = auth.uid() or seller_id = auth.uid())
  with check (buyer_id = auth.uid() or seller_id = auth.uid());

-- ─────────────────────────────────────────
-- Minor hardening: pin search_path on update_unity_score(), consistent
-- with the other two SECURITY DEFINER functions (handle_new_user,
-- compute_listing_risk_tier), which both already set it.
-- ─────────────────────────────────────────
alter function public.update_unity_score() set search_path = public;
