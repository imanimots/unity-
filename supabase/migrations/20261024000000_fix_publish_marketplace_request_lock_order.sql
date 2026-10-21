-- ============================================================
-- Fix a SHARE->UPDATE profile-row lock upgrade in
-- publish_marketplace_request (P6-POPIA-ERASURE-AND-ANONYMIZATION-F1-R
-- finding, remediated narrowly here)
-- ============================================================
-- 20261023000000_account_erasure_cleanup_hardening.sql changed the two
-- shared account-status guards (_assert_account_status_permits_creation/
-- _transaction) to take `for share` on the actor's profile row, so that
-- a concurrent erase_account() (which takes `for update` on the same
-- row) correctly serializes against every transaction-creation RPC.
--
-- publish_marketplace_request is the ONLY function in this codebase
-- that calls one of those two guards AND _lock_and_count_active_supply()
-- (which takes `for update` on the same actor's profile row) within the
-- same transaction -- confirmed by an exhaustive scan of every function
-- that calls either symbol, tracking each function's current live
-- definition across every migration file, not just this one. Every
-- other caller of _lock_and_count_active_supply (listing/skill-task
-- post publish, resume, reactivate; barter offer acceptance) never also
-- calls an account-status guard in the same function, and every other
-- caller of the account-status guards never also calls
-- _lock_and_count_active_supply.
--
-- In publish_marketplace_request's existing call order, the guard (now
-- `for share`) ran BEFORE _lock_and_count_active_supply (`for update`)
-- on the same row -- a lock upgrade within one transaction. If a
-- concurrent erase_account() for the same actor is already queued
-- waiting for `for update` on that row while this transaction holds
-- `for share`, this transaction's later upgrade attempt queues behind
-- that already-waiting request, while erase_account waits for this
-- transaction to release its `for share` lock -- a genuine, if narrow
-- and self-resolving (Postgres's deadlock detector aborts one side),
-- row-lock-upgrade deadlock shape.
--
-- Fix: run the existing _lock_and_count_active_supply call (and the
-- publication-limit check that depends on its result) BEFORE the
-- account-status guard, instead of after. _lock_and_count_active_supply
-- performs no mutation at all (confirmed: it is a pure `for update` row
-- lock plus three read-only counts) -- reordering it earlier changes
-- no persisted state and acquires only a row lock sooner than before.
-- Since `for update` already subsumes `for share` on the same row
-- within one transaction (requesting a weaker lock than you already
-- hold is always a safe no-op, never a second real lock acquisition),
-- the guard's later `for share` call is now a no-op for the
-- non-test-request path, and the test-request path (where
-- _lock_and_count_active_supply is still skipped entirely, per the
-- unchanged `if not v_request.is_test` condition) takes exactly the
-- same single `for share` lock it always did -- no upgrade either way.
--
-- Every other line of this function, and every other check/behavior
-- (KYC approval, publication-frozen check, actor/ownership validation,
-- draft-status validation, the publication-limit error itself, the
-- history row, the returned result shape) is byte-identical to the
-- live definition in 20260904000006_marketplace_request_account_status_
-- hardening.sql -- only the ORDER of two already-existing blocks
-- changed. The one observable edge-case difference: if an actor is
-- BOTH over their plan's active-publication limit AND
-- restricted/suspended (erased accounts always have zero active
-- supply post-erasure, since erase_account already suspends/closes all
-- of it, so this never applies to 'erased'), the error message
-- returned now reports the limit first rather than the account-status
-- restriction first. In both orders the request is equally rejected
-- and never published -- no test in this repository asserts a specific
-- precedence between these two failure modes (confirmed: rpc-errors.
-- test.ts tests the error-message mapping function in isolation, never
-- a live call-order precedence).
--
-- CREATE OR REPLACE with the exact existing signature
-- (uuid, uuid, text default null) -- Postgres preserves the function's
-- existing grants (service_role only, already revoked from
-- public/anon/authenticated by 20260904000006) across a same-signature
-- CREATE OR REPLACE, so no grant/revoke statement is needed or included
-- here, matching this repository's own established convention for
-- CREATE OR REPLACE-only changes.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

CREATE OR REPLACE FUNCTION public.publish_marketplace_request(p_actor_user_id uuid, p_request_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_request record;
  v_kyc text;
  v_active_count int;
  v_plan_id text;
  v_publication_limit int;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_actor_user_id is null then raise exception 'not authenticated'; end if;

  select * into v_request from public.marketplace_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'request not found'; end if;
  if v_request.requester_id <> p_actor_user_id then raise exception 'not the owner of this request'; end if;
  if v_request.status <> 'draft' then raise exception 'request is in status % and cannot be published from here', v_request.status; end if;

  select kyc_status::text into v_kyc from public.profiles where id = p_actor_user_id;
  if v_kyc is distinct from 'approved' then
    raise exception 'verification_required: KYC approval is required to publish a request';
  end if;

  perform public._assert_not_publication_frozen(p_actor_user_id);

  if not v_request.is_test then
    v_active_count := public._lock_and_count_active_supply(p_actor_user_id);
    v_plan_id := public._get_effective_merchant_plan_id(p_actor_user_id);
    select active_publication_limit into v_publication_limit from public.merchant_subscription_plans where id = v_plan_id;
    if v_publication_limit is not null and v_active_count >= v_publication_limit then
      raise exception 'active_publication_limit_reached: the % plan allows up to % active published entities', v_plan_id, v_publication_limit;
    end if;
  end if;

  perform public._assert_account_status_permits_creation(p_actor_user_id, 'self');

  update public.marketplace_requests set status = 'active' where id = p_request_id;
  perform public._marketplace_request_history(p_request_id, null, 'requester', p_actor_user_id, 'published', 'draft', 'active');

  v_result := jsonb_build_object('request_id', p_request_id, 'status', 'active');
  return v_result;
end;
$function$;
