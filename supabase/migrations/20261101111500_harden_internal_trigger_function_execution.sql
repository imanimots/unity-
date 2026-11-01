-- ============================================================
-- E10: Internal trigger / guard function RPC surface closure
-- Phase: ADMIN-CONTROL-CENTRE-BATCH-E10-INTERNAL-TRIGGER-GUARD-RPC-SURFACE-CLOSURE
--
-- Live post-E9-F1 advisor baseline:
--   anon_security_definer_function_executable          = 14
--   authenticated_security_definer_function_executable = 19
--
-- These 13 functions are database-internal trigger/auth-hook functions.
-- Every target RETURNS trigger, is SECURITY DEFINER, has a fixed
-- search_path = public, and remains bound to an existing database
-- trigger. None needs direct PostgREST RPC invocation.
--
-- This migration intentionally changes EXECUTE privileges only:
--   * no CREATE OR REPLACE FUNCTION
--   * no trigger changes
--   * no RLS/policy changes
--   * no function-body changes
--   * no service_role grants (there are no direct server RPC callers)
--
-- PostgreSQL checks trigger-function EXECUTE permission when the trigger
-- is created; existing trigger execution is not a reason to leave these
-- functions directly executable by API roles. Removing PUBLIC/anon/
-- authenticated/service_role EXECUTE therefore closes the unnecessary
-- /rest/v1/rpc surface without changing trigger semantics.
-- ============================================================

revoke all on function public.bookings_check_availability_conflict()
  from public, anon, authenticated, service_role;

revoke all on function public.listing_availability_check_booking_conflict()
  from public, anon, authenticated, service_role;

revoke all on function public.compute_listing_risk_tier()
  from public, anon, authenticated, service_role;

revoke all on function public.handle_new_user()
  from public, anon, authenticated, service_role;

revoke all on function public.protect_barter_privileged_fields()
  from public, anon, authenticated, service_role;

revoke all on function public.protect_booking_financial_fields()
  from public, anon, authenticated, service_role;

revoke all on function public.protect_booking_privileged_fields()
  from public, anon, authenticated, service_role;

revoke all on function public.protect_listing_privileged_fields()
  from public, anon, authenticated, service_role;

revoke all on function public.protect_listing_requirements_privileged_fields()
  from public, anon, authenticated, service_role;

revoke all on function public.protect_order_financial_fields()
  from public, anon, authenticated, service_role;

revoke all on function public.protect_order_privileged_fields()
  from public, anon, authenticated, service_role;

revoke all on function public.protect_payment_privileged_fields()
  from public, anon, authenticated, service_role;

revoke all on function public.protect_profile_privileged_fields()
  from public, anon, authenticated, service_role;
