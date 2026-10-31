-- ============================================================
-- E6 -- Support Centre RPC execution hardening
-- ============================================================
-- Supabase's security advisor flagged every Support Centre SECURITY
-- DEFINER RPC (20260726000000_support_centre_schema.sql) as
-- anon/authenticated-executable -- confirmed true by source inspection:
-- that migration never added a single REVOKE/GRANT EXECUTE statement
-- for any of its 9 privileged functions, so each one still carries
-- Postgres's default PUBLIC EXECUTE grant (which anon/authenticated
-- inherit). Each function's own internal `if auth.role() <>
-- 'service_role' then raise exception` guard already prevents a
-- non-service-role caller from completing the call today, but that is
-- a RUNTIME check inside the function body -- it does not stop the
-- call from reaching the function at all, which is exactly what a
-- database-level EXECUTE grant controls. SECURITY DEFINER governs
-- whose privileges a function runs WITH; it does not, by itself,
-- restrict who may invoke it.
--
-- This is a forward migration, not an edit of the already-applied
-- 20261026000000_support_centre_schema.sql -- per this project's own
-- migration-history discipline, an applied migration is never rewritten.
--
-- Trust boundary, traced end-to-end from application code (Part B):
-- every one of the 9 functions below is called from exactly one
-- src/app/api/admin/support/** route, each of which calls
-- requireAdminForRoute() BEFORE the RPC and passes ONLY
-- `gate.requester.userId` (the server-session-derived admin id, never
-- a request-body field) as `p_admin_id`. Every one of those routes
-- constructs its Supabase client via getAdminServiceClient()
-- (service-role). No other caller of any of these 9 functions exists
-- anywhere in the codebase. The database grant below is therefore made
-- to match that exact, already-real architecture -- service_role only.
--
-- Two further non-privileged helper functions in the same migration
-- (generate_support_case_number(), touch_support_case_updated_at())
-- were also advisor-flagged for a mutable search_path. Neither is
-- SECURITY DEFINER (both run with the CALLER's own privileges), and
-- touch_support_case_updated_at() returns the `trigger` pseudo-type, so
-- it cannot be invoked directly via the Data API/RPC at all -- only by
-- Postgres itself during a trigger-firing UPDATE. Still, a fixed
-- search_path is cheap, safe, and removes the advisor warning for both
-- without changing either function's behavior at all.
--
-- No Support Centre business logic, case semantics, or history
-- behavior is changed by this migration -- grants and search_path
-- only. Apply via: GitHub integration only, per standing project rule.
-- ============================================================

-- ─────────────────────────────────────────
-- Non-privileged helper functions -- fixed search_path only, no grant
-- change (neither is a privileged mutation RPC; see header).
-- ─────────────────────────────────────────
alter function public.generate_support_case_number() set search_path = public;
alter function public.touch_support_case_updated_at() set search_path = public;

-- ─────────────────────────────────────────
-- Privileged Support Centre mutation RPCs -- lock EXECUTE to
-- service_role only, matching the real, already-implemented
-- application trust boundary traced above. Exact signatures, copied
-- verbatim from each function's own CREATE OR REPLACE FUNCTION
-- parameter list in 20261026000000_support_centre_schema.sql.
-- ─────────────────────────────────────────

revoke all on function public.create_support_case(
  uuid, text, support_case_category, text, support_case_priority,
  uuid, uuid, support_linked_entity_type, uuid, support_case_source, text
) from public, anon, authenticated;
grant execute on function public.create_support_case(
  uuid, text, support_case_category, text, support_case_priority,
  uuid, uuid, support_linked_entity_type, uuid, support_case_source, text
) to service_role;

revoke all on function public.assign_support_case(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.assign_support_case(uuid, uuid, uuid, text) to service_role;

revoke all on function public.change_support_case_priority(uuid, uuid, support_case_priority, text) from public, anon, authenticated;
grant execute on function public.change_support_case_priority(uuid, uuid, support_case_priority, text) to service_role;

revoke all on function public.update_support_case_status(uuid, uuid, support_case_status, text) from public, anon, authenticated;
grant execute on function public.update_support_case_status(uuid, uuid, support_case_status, text) to service_role;

revoke all on function public.escalate_support_case(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.escalate_support_case(uuid, uuid, text, text) to service_role;

revoke all on function public.resolve_support_case(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.resolve_support_case(uuid, uuid, text, text) to service_role;

revoke all on function public.close_support_case(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.close_support_case(uuid, uuid, text, text) to service_role;

revoke all on function public.reopen_support_case(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.reopen_support_case(uuid, uuid, text, text) to service_role;

revoke all on function public.add_support_case_note(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.add_support_case_note(uuid, uuid, text, text) to service_role;
