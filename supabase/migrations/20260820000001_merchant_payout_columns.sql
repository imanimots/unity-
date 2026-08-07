-- ============================================================
-- Step 11 Phase 8 -- additive merchant_payouts columns
-- ============================================================
-- merchant_payouts (20260801000002) and create_merchant_payout()
-- (20260801000004) have existed since Phase 2C, correct as far as they
-- go, but nothing has ever built the operational lifecycle on top of
-- them -- payouts have no way to progress past 'pending'. This phase
-- adds exactly the columns the lifecycle needs, nothing else. No column
-- is removed or retyped; all 3 live payout rows (all 'pending', all
-- owned by a QA fixture account) are unaffected by this migration --
-- every new column is nullable or has a safe default.
--
-- provider_reference (already exists) is reused as the "safe payout
-- reference" field for a manually-recorded paid payout -- no duplicate
-- payout_reference column is added.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.merchant_payouts
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_started_by uuid references public.profiles(id),
  add column if not exists paid_at timestamptz,
  add column if not exists paid_by uuid references public.profiles(id),
  add column if not exists failed_at timestamptz,
  add column if not exists failed_by uuid references public.profiles(id),
  add column if not exists failure_category text,
  add column if not exists failure_message_safe text,
  add column if not exists payout_method text,
  add column if not exists attempt_count int not null default 0,
  add column if not exists last_attempt_at timestamptz;

alter table public.merchant_payouts
  add constraint merchant_payouts_payout_method_check
  check (payout_method is null or payout_method in ('manual', 'mock_validation'));

alter table public.merchant_payouts
  add constraint merchant_payouts_failure_category_check
  check (
    failure_category is null or failure_category in (
      'recipient_details_unavailable', 'recipient_details_invalid', 'provider_unavailable',
      'provider_declined', 'compliance_review', 'account_restricted',
      'source_payment_issue', 'internal_consistency_error', 'other'
    )
  );
