-- ============================================================
-- E20 -- Escrow webhook intake RPC: search_path defense-in-depth
-- ============================================================
-- public.record_escrow_webhook_event(text, text, boolean, jsonb)
-- (sole authoritative definition: 20260825000004_escrow_webhook_rpc.sql
-- -- confirmed via grep that no later migration ever redefines,
-- alters, or changes its privileges, and that no second overload of
-- this name exists)
-- is SECURITY DEFINER with `set search_path = public`. It was never
-- flagged by the live advisor's function_search_path_mutable check
-- (that check flags a MISSING/mutable search_path, not a fixed-but-
-- non-empty one) and so fell outside E11's own 38-function sweep --
-- this is a separate, stricter hardening pass, not a correction to
-- E11's history.
--
-- A fresh audit of the function's current, unchanged body classifies
-- every object reference it makes:
--   - public.escrow_provider_events (the INSERT/SELECT target) --
--     already schema-qualified.
--   - auth.role() -- already schema-qualified.
--   - jsonb_build_object(...) -- a pg_catalog built-in; pg_catalog (and
--     pg_temp) are always implicitly searched by Postgres ahead of
--     anything configured in search_path, including an empty one, so
--     this resolves identically either way.
--   - unique_violation -- a PL/pgSQL exception CONDITION NAME, not a
--     schema object at all; condition-name matching is handled by the
--     PL/pgSQL interpreter against a fixed internal table, entirely
--     independent of search_path.
--   - uuid / text / boolean / jsonb (parameter and variable type
--     declarations) -- built-in types living in pg_catalog, resolved
--     the same way as the built-in function above.
-- Zero unqualified application-schema objects exist anywhere in the
-- body. This is the same compatibility shape every prior search_path
-- hardening pass in this project (E11) already relied on, applied
-- here to one additional function that pass didn't reach.
--
-- This migration is configuration-only: it does not touch the
-- function's body, return shape, duplicate-detection behavior,
-- security mode, or execute privileges (already service_role-only,
-- unchanged by this statement), and it does not touch
-- escrow_provider_events' schema, policies, or table privileges in
-- any way. No lifecycle/claim/processing machinery is added -- the
-- prior phase's own audit already established none is currently
-- needed, and this migration does not revisit that conclusion.
-- ============================================================

alter function public.record_escrow_webhook_event(
  text,
  text,
  boolean,
  jsonb
)
set search_path = '';
