-- ============================================================
-- E21 -- Escrow SECURITY DEFINER search_path hardening: safe subset
-- ============================================================
-- E20 identified a 9-function escrow-domain backlog still using
-- `set search_path = public`. A fresh, independent audit of each
-- function's current authoritative body (tracing every CREATE OR
-- REPLACE / DROP+CREATE across history to the version that is
-- actually live today, not merely the first one written) splits the
-- nine into exactly two groups:
--
-- SAFE (ALTER-only, hardened by this migration):
--   - public.create_escrow_transaction(text, uuid, uuid, uuid, uuid,
--     numeric, numeric, text, text, text, text, uuid) -- current
--     12-argument form (widened for rent_to_buy_agreement_id).
--   - public._escrow_transaction_dispute_block(public.escrow_transactions)
--   - public._escrow_transaction_completion_block(public.escrow_transactions)
-- Every object each of these three references is already schema-
-- qualified: public.escrow_transactions, public.escrow_transaction_history,
-- public.bookings, public.orders, public.barter_agreements,
-- public.rent_to_buy_agreements, public.disputes, auth.role(). The
-- only other references are pg_catalog built-ins (jsonb_build_object,
-- text/uuid/numeric casts) or PL/pgSQL condition names
-- (unique_violation), neither affected by search_path -- pg_catalog
-- is always implicitly searched ahead of the configured path, empty
-- or not. Zero bare application-schema object or type exists in any
-- of the three bodies.
--
-- NOT SAFE (left untouched, deferred to a future body-qualification
-- phase -- see this phase's final report for the exact backlog):
--   - public.mark_escrow_funded
--   - public.release_escrow_transaction
--   - public.refund_escrow_transaction
--   - public.cancel_escrow_transaction
--   - public._escrow_transaction_transition
--   - public._rent_to_buy_settle_escrow
-- Every one of these six has at least one bare, unqualified reference
-- to the custom enum type `escrow_status` inside its executable body
-- (e.g. `array['funded']::escrow_status[]`, or a bare
-- `v_new_status escrow_status;` / `p_new_status escrow_status`
-- declaration) -- a user-defined type living in the public schema,
-- not a pg_catalog built-in, which would fail to resolve under an
-- empty search_path unless the body itself is qualified
-- (`public.escrow_status`). Changing only the search_path
-- configuration, without a body rewrite, would break these six at
-- their next invocation. This migration does not touch them.
--
-- This migration is configuration-only for the three safe functions:
-- ALTER FUNCTION ... SET search_path = '' only, using each function's
-- exact current identity arguments (schema-qualifying the one custom
-- composite-type argument, public.escrow_transactions, so the ALTER
-- statement itself never depends on the migration session's own
-- search path to resolve it). No function body is redefined, no
-- privilege is changed (all three remain SECURITY DEFINER,
-- service_role-only, exactly as before), and none of the six deferred
-- functions, the escrow webhook intake table/RPC pair already
-- hardened by the prior phase, ledger_entries, or any RLS/policy is
-- touched.
-- ============================================================

alter function public.create_escrow_transaction(
  text, uuid, uuid, uuid, uuid, numeric, numeric, text, text, text, text, uuid
)
set search_path = '';

alter function public._escrow_transaction_dispute_block(
  public.escrow_transactions
)
set search_path = '';

alter function public._escrow_transaction_completion_block(
  public.escrow_transactions
)
set search_path = '';
