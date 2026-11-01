-- ============================================================
-- E11: Harden mutable function search_path configuration
-- Phase: ADMIN-CONTROL-CENTRE-BATCH-E11-MUTABLE-FUNCTION-SEARCH-PATH-HARDENING
--
-- Reconciled live/static inventory: 38 / 38.
-- All 38 targets are SECURITY INVOKER.
--
-- Configuration-only migration:
--   * 38 ALTER FUNCTION statements
--   * no function body rewrites
--   * no grant changes
--   * no RLS/policy changes
--   * no trigger changes
--
-- 37 functions use an empty search_path.
-- match_knowledge_base is pinned to public because its vector type and
-- <=> operator are provided by the vector extension installed in public.
-- ============================================================

alter function public._ad_campaign_funding_quotes_guard() set search_path = '';
alter function public._assert_not_publication_frozen(uuid) set search_path = '';
alter function public._booking_overlaps_availability_period(timestamptz, timestamptz, date, date) set search_path = '';
alter function public._calculate_unity_commission(text, numeric, integer) set search_path = '';
alter function public._get_effective_merchant_plan_id(uuid) set search_path = '';
alter function public._lock_and_count_active_supply(uuid) set search_path = '';
alter function public._rent_to_buy_default_eligibility(public.rent_to_buy_agreements) set search_path = '';
alter function public._rent_to_buy_rental_use_amount(public.rent_to_buy_agreements, timestamptz, timestamptz) set search_path = '';
alter function public._validate_skill_task_content(text[]) set search_path = '';
alter function public._validate_skill_task_post_transition(public.barter_skill_task_post_status, public.barter_skill_task_post_status, text) set search_path = '';
alter function public.enforce_dispute_message_consistency() set search_path = '';
alter function public.generate_barter_reference() set search_path = '';
alter function public.generate_booking_reference() set search_path = '';
alter function public.generate_order_reference() set search_path = '';
alter function public.match_knowledge_base(public.vector, double precision, integer) set search_path = public;
alter function public.prevent_row_mutation() set search_path = '';
alter function public.sanitize_category_metadata(text, boolean, jsonb) set search_path = '';
alter function public.touch_affiliate_commission_updated_at() set search_path = '';
alter function public.touch_barter_agreement_updated_at() set search_path = '';
alter function public.touch_barter_contribution_milestone_updated_at() set search_path = '';
alter function public.touch_barter_skill_task_post_updated_at() set search_path = '';
alter function public.touch_booking_updated_at() set search_path = '';
alter function public.touch_dispute_updated_at() set search_path = '';
alter function public.touch_email_delivery_updated_at() set search_path = '';
alter function public.touch_escrow_transaction_updated_at() set search_path = '';
alter function public.touch_financial_workflow_updated_at() set search_path = '';
alter function public.touch_marketplace_request_updated_at() set search_path = '';
alter function public.touch_merchant_subscription_plan_updated_at() set search_path = '';
alter function public.touch_merchant_subscription_updated_at() set search_path = '';
alter function public.touch_payment_updated_at() set search_path = '';
alter function public.touch_personalization_settings_updated_at() set search_path = '';
alter function public.touch_rtb_agreement_updated_at() set search_path = '';
alter function public.touch_rtb_installment_updated_at() set search_path = '';
alter function public.touch_rtb_listing_terms_updated_at() set search_path = '';
alter function public.touch_rtb_return_case_updated_at() set search_path = '';
alter function public.touch_search_demand_aggregates_updated_at() set search_path = '';
alter function public.touch_unity_commission_updated_at() set search_path = '';
alter function public.validate_barter_deposit_term_payer() set search_path = '';
