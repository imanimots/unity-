-- ============================================================
-- Step 11 Phase 5 closure -- barter counts in get_admin_overview_stats()
-- ============================================================
-- Absorbs the last outstanding item from the former "Phase 5 (Barter
-- Phase C)" roadmap entry ("barter counts added to
-- get_admin_overview_stats()"). Mirrors the Bookings section's own
-- shape exactly: operationally-focused counts (what needs attention
-- right now), not a full historical breakdown -- the existing Bookings
-- section has no "completed"/"cancelled" count either, for the same
-- reason. Straight CREATE OR REPLACE of the proven function, byte-
-- identical except for the 5 new keys appended to the jsonb_build_object
-- call.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.get_admin_overview_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select jsonb_build_object(
    'total_users', (select count(*) from public.profiles),
    'active_users', (select count(*) from public.profiles where account_status = 'active'),
    'merchants', (select count(*) from public.profiles where role in ('merchant', 'both')),
    'renters', (select count(*) from public.profiles where role in ('renter', 'both')),
    'suspended_users', (select count(*) from public.profiles where account_status = 'suspended'),
    'restricted_users', (select count(*) from public.profiles where account_status = 'restricted'),

    'pending_kyc_reviews', (select count(*) from public.identity_verifications where status in ('pending', 'under_review')),
    'pending_ownership_reviews', (select count(*) from public.listing_ownership_verification where status in ('pending', 'under_review')),
    'pending_listing_moderation', (select count(*) from public.listing_moderation where moderation_status = 'pending'),

    'active_listings', (select count(*) from public.listings where status = 'active'),
    'suspended_listings', (select count(*) from public.listings where status = 'suspended'),

    'requested_bookings', (select count(*) from public.bookings where status = 'requested'),
    'accepted_awaiting_payment_bookings', (
      select count(*) from public.bookings b
      where b.status = 'accepted'
        and not exists (
          select 1 from public.payments p
          where p.booking_id = b.id and p.payment_type = 'rental_charge' and p.status = 'captured'
        )
    ),
    'financially_ready_bookings', (
      select count(*) from public.bookings b
      where b.status = 'accepted'
        and exists (
          select 1 from public.payments p
          where p.booking_id = b.id and p.payment_type = 'rental_charge' and p.status = 'captured'
        )
    ),
    'active_rentals', (select count(*) from public.bookings where status = 'active'),
    'overdue_payment_deadlines', (
      select count(*) from public.bookings
      where status = 'accepted' and payment_due_at is not null and payment_due_at < now() and payment_expired_at is null
    ),

    'failed_financial_workflows', (select count(*) from public.financial_workflows where status in ('failed_retryable', 'failed_terminal')),
    'retryable_email_failures', (select count(*) from public.email_deliveries where status = 'failed_retryable'),

    -- Step 11 Phase 5 closure: barter operational counts.
    'proposed_barter_agreements', (select count(*) from public.barter_agreements where status in ('proposed', 'countered')),
    'accepted_barter_agreements', (select count(*) from public.barter_agreements where status = 'accepted'),
    'in_progress_barter_agreements', (select count(*) from public.barter_agreements where status in ('preparing', 'in_transit', 'awaiting_confirmation')),
    'disputed_barter_agreements', (select count(*) from public.barter_agreements where status = 'disputed'),
    'admin_held_barter_agreements', (select count(*) from public.barter_agreements where admin_hold = true),

    'generated_at', now()
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_admin_overview_stats() from public, anon, authenticated;
grant execute on function public.get_admin_overview_stats() to service_role;
