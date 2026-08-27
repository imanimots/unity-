-- REVIEWS V2 — neutralize create_barter_review() as an independent
-- review-creation path (corrective, fix-forward).
--
-- Audit findings, confirmed live immediately before this migration:
--   - anon EXECUTE: false. authenticated EXECUTE: false. Only
--     service_role can ever invoke it (proacl:
--     "{postgres=X/postgres,service_role=X/postgres}") -- no
--     PostgREST/client call can reach it today.
--   - grep across src/ and scripts/ found zero live callers (routes,
--     components, tests) -- the only remaining hit was this migration's
--     own prior commit-message-style comment naming it, not a call.
--   - Its OLD independent body inserted directly into public.reviews
--     with NO cutover check, NO 14-day-window check, NO account-status
--     check, and NO header_snapshot/domain/context_label/eligible_at/
--     review_deadline_at population (those columns would have been left
--     at their schema defaults). Because nothing else in this system
--     ever creates a review_windows row or sets published_at for a row
--     inserted this way, such a review would in practice have been
--     permanently unpublished/invisible (RLS + aggregates both require
--     published_at IS NOT NULL) -- but "currently unreachable, and
--     currently produces an orphaned row" is a fragile safety story, not
--     a real guarantee, and depends entirely on nobody ever re-granting
--     EXECUTE.
--
-- Fix: convert to a thin, same-signature compatibility wrapper that
-- delegates entirely to submit_review(p_actor_user_id, 'barter',
-- p_agreement_id, p_rating, p_comment, p_idempotency_key) -- the
-- canonical Reviews V2 authority. From this point forward there is
-- structurally only ONE review-creation code path for every domain,
-- including barter; this old name can never again diverge from Reviews
-- V2's rules regardless of future grants. Signature is unchanged
-- (uuid, uuid, smallint, text, text) -- a plain CREATE OR REPLACE is
-- safe here, no DROP FUNCTION/overload-ambiguity risk.
create or replace function public.create_barter_review(
  p_actor_user_id uuid,
  p_agreement_id uuid,
  p_rating smallint,
  p_comment text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  return public.submit_review(p_actor_user_id, 'barter', p_agreement_id, p_rating, p_comment, p_idempotency_key);
end;
$$;

revoke all on function public.create_barter_review(uuid, uuid, smallint, text, text) from public, anon, authenticated;
grant execute on function public.create_barter_review(uuid, uuid, smallint, text, text) to service_role;

comment on function public.create_barter_review(uuid, uuid, smallint, text, text) is 'Reviews V2: retained-name compatibility wrapper only -- delegates entirely to submit_review(), which is the sole review-creation authority for every domain including barter. Never has independent review-creation logic again.';
