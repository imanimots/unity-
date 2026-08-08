-- ============================================================
-- Unity Phase 2 -- Commission Framework
-- Overview stats extension (additive, byte-identical to the current
-- live version plus new keys) and email_deliveries entity widening,
-- both matching every prior phase's exact pattern.
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

    'proposed_barter_agreements', (select count(*) from public.barter_agreements where status in ('proposed', 'countered')),
    'accepted_barter_agreements', (select count(*) from public.barter_agreements where status = 'accepted'),
    'in_progress_barter_agreements', (select count(*) from public.barter_agreements where status in ('preparing', 'in_transit', 'awaiting_confirmation')),
    'disputed_barter_agreements', (select count(*) from public.barter_agreements where status = 'disputed'),
    'admin_held_barter_agreements', (select count(*) from public.barter_agreements where admin_hold = true),

    'orders_awaiting_payment', (select count(*) from public.orders where status = 'pending'),
    'orders_paid_awaiting_shipment', (select count(*) from public.orders where status = 'paid'),
    'orders_shipped_awaiting_delivery', (select count(*) from public.orders where status = 'shipped'),
    'orders_disputed', (select count(*) from public.orders where status = 'disputed'),
    'orders_payment_failed', (
      select count(*) from public.orders o
      where o.status = 'pending'
        and exists (
          select 1 from public.payments p
          where p.order_id = o.id and p.payment_type = 'order_payment' and p.status = 'failed'
        )
    ),

    -- Step 11 Phase 7: affiliate commission operational counts.
    'affiliate_commissions_pending', (select count(*) from public.affiliate_commissions where status = 'pending'),
    'affiliate_commissions_held', (select count(*) from public.affiliate_commissions where status = 'held'),
    'affiliate_commissions_payout_queued', (select count(*) from public.affiliate_commissions where status = 'payout_queued'),
    'affiliate_commissions_failed', (select count(*) from public.affiliate_commissions where status = 'failed'),
    'active_affiliates', (select count(*) from public.profiles where is_affiliate = true),

    -- Step 11 Phase 8: merchant payout operational counts.
    'merchant_payouts_pending', (select count(*) from public.merchant_payouts where status = 'pending'),
    'merchant_payouts_processing', (select count(*) from public.merchant_payouts where status = 'processing'),
    'merchant_payouts_failed', (select count(*) from public.merchant_payouts where status = 'failed'),
    'merchant_payouts_pending_overdue', (select count(*) from public.merchant_payouts where status = 'pending' and created_at < now() - interval '48 hours'),
    'merchant_payouts_processing_overdue', (select count(*) from public.merchant_payouts where status = 'processing' and processing_started_at < now() - interval '48 hours'),

    -- Unity Phase 1: merchant subscription counts.
    'merchant_subscriptions_pro', (select count(*) from public.merchant_subscriptions where current_plan_id = 'pro'),
    'merchant_subscriptions_elite', (select count(*) from public.merchant_subscriptions where current_plan_id = 'elite'),
    'merchant_subscriptions_pending_change', (select count(*) from public.merchant_subscriptions where status = 'pending_change'),
    'merchant_subscriptions_cancelled', (select count(*) from public.merchant_subscriptions where status = 'cancelled'),
    'merchant_subscriptions_due_for_reversion', (
      select count(*) from public.merchant_subscriptions
      where status in ('pending_change', 'cancelled') and pending_plan_effective_at <= now()
    ),

    -- Unity Phase 2: Unity commission operational counts.
    'unity_commissions_pending', (select count(*) from public.unity_commissions where status = 'pending'),
    'unity_commissions_held', (select count(*) from public.unity_commissions where status = 'held'),
    'unity_commissions_earned', (select count(*) from public.unity_commissions where status = 'earned'),
    'unity_commissions_voided', (select count(*) from public.unity_commissions where status = 'voided'),
    'unity_commissions_high_value_sales', (select count(*) from public.unity_commissions where transaction_type = 'sale' and excess_base > 0),

    'generated_at', now()
  ) into v_result;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- email_deliveries.related_entity_type widening
-- ─────────────────────────────────────────
alter table public.email_deliveries drop constraint email_deliveries_related_entity_type_check;

alter table public.email_deliveries add constraint email_deliveries_related_entity_type_check check (
  related_entity_type = any (array['booking', 'listing', 'identity_verification', 'order', 'barter_agreement', 'affiliate_commission', 'profile', 'merchant_payout', 'merchant_subscription', 'unity_commission'])
);
