/**
 * Maps known RAISE EXCEPTION messages from the barter RPCs
 * (supabase/migrations/20260810000011_barter_rpcs_phase_a.sql) to a
 * user-safe message + HTTP status. Same convention as
 * src/lib/bookings/rpc-errors.ts -- substring .includes() matching (never
 * regex, never exact equality, since Postgres interpolates parameters
 * into some messages), never forward a raw Postgres error to the client.
 * The raw error is still logged server-side by the caller before this
 * runs.
 */
export function mapBarterRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('invalid expiry window')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }
  if (m.includes('at least one listing must be offered')) {
    return { status: 422, error: 'At least one listing must be offered from each side of the trade.' }
  }
  if (m.includes('the same listing cannot be offered more than once')) {
    return { status: 422, error: 'The same listing cannot be offered more than once.' }
  }
  if (m.includes('one or more offered listings could not be found')) {
    return { status: 404, error: 'One or more offered listings could not be found.' }
  }
  if (m.includes('does not belong to that party')) {
    return { status: 403, error: 'One or more offered listings do not belong to the party offering them.' }
  }
  if (m.includes('not yet active')) {
    return { status: 422, error: 'One or more offered listings are not yet active and cannot be included in a trade.' }
  }
  if (m.includes('currently committed to another barter agreement')) {
    return { status: 409, error: 'One or more offered listings are currently committed to another barter agreement.' }
  }
  if (m.includes('currently committed to a rent-to-buy agreement')) {
    return { status: 409, error: 'One or more offered listings are currently committed to a rent-to-buy agreement.' }
  }
  if (m.includes('this listing is not available for barter')) {
    return { status: 404, error: 'This listing is not available for barter.' }
  }
  if (m.includes('you cannot propose a trade on your own listing')) {
    return { status: 403, error: 'You cannot propose a trade on your own listing.' }
  }
  if (m.includes('verification_required:counterparty')) {
    return { status: 403, error: 'This listing is not currently available for a new transaction.' }
  }
  if (m.includes('verification_required:self')) {
    return { status: 403, error: 'You need to complete verification before doing this.' }
  }
  if (m.includes('account_restricted:self') || m.includes('account_suspended:self')) {
    return { status: 403, error: 'Your account cannot do this right now. Contact support if you believe this is a mistake.' }
  }
  if (m.includes('account_restricted:counterparty') || m.includes('account_suspended:counterparty')) {
    return { status: 403, error: 'This listing is not currently available for a new transaction.' }
  }
  if (m.includes('barter agreement not found or you are not a party to it')) {
    return { status: 404, error: 'Barter agreement not found.' }
  }
  if (m.includes('currently suspended by an administrator')) {
    return { status: 403, error: 'This barter agreement is currently suspended by an administrator.' }
  }
  if (m.includes('this offer can no longer be countered')) {
    return { status: 409, error: 'This offer can no longer be countered.' }
  }
  if (m.includes('this offer can no longer be accepted')) {
    return { status: 409, error: 'This offer can no longer be accepted.' }
  }
  if (m.includes('this offer can no longer be rejected')) {
    return { status: 409, error: 'This offer can no longer be rejected.' }
  }
  if (m.includes('it is not your turn to respond to this offer')) {
    return { status: 403, error: 'It is not your turn to respond to this offer.' }
  }
  if (m.includes('cannot cancel a disputed agreement')) {
    return { status: 409, error: 'A disputed agreement cannot be cancelled — it must be resolved first.' }
  }
  if (m.includes('cannot be cancelled in its current status')) {
    return { status: 409, error: 'This agreement cannot be cancelled in its current state.' }
  }
  if (m.includes('listing not found')) {
    return { status: 404, error: 'Listing not found.' }
  }
  if (m.includes('this agreement is currently disputed and cannot progress')) {
    return { status: 409, error: 'This agreement is currently disputed — it must be resolved before it can progress.' }
  }
  if (m.includes('this agreement is currently disputed and cannot be completed')) {
    return { status: 409, error: 'This agreement is currently disputed — it must be resolved before it can be completed.' }
  }
  if (m.includes('this agreement is not yet financially ready to proceed')) {
    return { status: 409, error: 'This agreement is not yet financially ready to proceed — every required payment must be completed first.' }
  }
  if (m.includes('this delivery method does not use an in-transit step')) {
    return { status: 409, error: 'This delivery method does not use an in-transit step.' }
  }
  if (m.includes('this delivery method requires marking the item in transit first')) {
    return { status: 409, error: 'This delivery method requires marking the item in transit first.' }
  }
  if (m.includes('this transition is not allowed from the agreement')) {
    return { status: 409, error: 'This transition is not allowed from the agreement’s current status.' }
  }
  if (m.includes('this agreement is not yet awaiting completion confirmation')) {
    return { status: 409, error: 'This agreement is not yet ready for completion confirmation.' }
  }
  if (m.includes('invalid payment type for a barter payment intent')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }
  if (m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  // ── Skills + Tasks under Barter ──
  if (m.includes('exactly one of an anchor listing or an anchor Skill/Task post')) {
    return { status: 400, error: 'Provide exactly one anchor — either a listing or a Skill/Task post.' }
  }
  if (m.includes('post not found or not owned by caller')) {
    return { status: 404, error: 'Post not found.' }
  }
  if (m.includes('post not found')) {
    return { status: 404, error: 'Post not found.' }
  }
  if (m.includes('this Skill/Task is not currently available for barter')) {
    return { status: 422, error: 'This Skill/Task is not currently available for barter.' }
  }
  if (m.includes('this request is no longer open for offers') || m.includes('the originating request is no longer open')) {
    return { status: 409, error: 'This request is no longer open for offers.' }
  }
  if (m.includes('you cannot propose a trade against your own listing or post')) {
    return { status: 403, error: 'You cannot propose a trade against your own listing or post.' }
  }
  if (m.includes('at least one contribution must be offered')) {
    return { status: 422, error: 'At least one contribution (item, Skill, or Task) must be offered from each side.' }
  }
  if (m.includes('a Looking-For post cannot be used as contribution provenance')) {
    return { status: 422, error: 'A Looking-For post cannot be offered as a contribution — only reusable Available supply can be offered.' }
  }
  if (m.includes('referenced Skill/Task supply is not currently active')) {
    return { status: 422, error: 'The referenced Skill/Task supply is not currently active.' }
  }
  if (m.includes('referenced Skill/Task supply does not belong to the contributing party')) {
    return { status: 403, error: 'You can only offer Skill/Task supply that belongs to you.' }
  }
  if (m.includes('referenced Skill/Task supply kind does not match')) {
    return { status: 422, error: 'The referenced post’s kind does not match this contribution.' }
  }
  if (m.includes('a private/custom contribution requires a title')) {
    return { status: 422, error: 'A private/custom contribution requires a title.' }
  }
  if (m.includes('contribution_weight_percent is required')) {
    return { status: 422, error: 'A contribution weight is required for every Skill/Task contribution.' }
  }
  if (m.includes('at least one milestone is required')) {
    return { status: 422, error: 'At least one milestone is required per Skill/Task contribution.' }
  }
  if (m.includes('milestone weights for a contribution must sum to exactly 100')) {
    return { status: 422, error: 'Milestone weights for each contribution must add up to exactly 100%.' }
  }
  if (m.includes('contribution weights for this party must sum to exactly 100')) {
    return { status: 422, error: 'A party’s contribution weights must add up to exactly 100%.' }
  }
  if (m.includes('cannot combine legacy deposit fields with deposit_terms')) {
    return { status: 422, error: 'Use either a single deposit or itemised deposit terms, not both.' }
  }
  if (m.includes('deposit payer must be a party to the agreement')) {
    return { status: 403, error: 'A deposit payer must be a party to this agreement.' }
  }
  if (m.includes('a milestone_weighted deposit requires a secured Skill/Task contribution')) {
    return { status: 422, error: 'A milestone-weighted deposit requires the payer to have a Skill/Task contribution in this offer.' }
  }
  if (m.includes('your offer must include at least one') || m.includes('your counter-offer must include at least one')) {
    return { status: 422, error: 'Your offer must include a contribution of the kind requested to satisfy this request.' }
  }
  if (m.includes('is no longer available for acceptance')) {
    return { status: 409, error: 'A Skill/Task supply referenced by this offer is no longer available — it may have been paused, suspended, or archived.' }
  }
  if (m.includes('prohibited_content')) {
    return { status: 422, error: m.split('prohibited_content:')[1]?.trim() || 'This content is not permitted.' }
  }
  if (m.includes('active_publication_limit_reached') || m.includes('active_listing_limit_reached')) {
    // Matches both the V2 error code and the pre-V2 live code -- the
    // migration renaming this may not be applied yet in every
    // environment this runs in (see the V2 migrations' own comment).
    return { status: 403, error: 'Your current plan does not allow another active published entity right now.' }
  }
  if (m.includes('publication_frozen_pending_keep_set')) {
    return { status: 409, error: 'Resolve your downgrade selection before publishing or reactivating anything.' }
  }
  if (m.includes('only a subscription-deactivated post can be reactivated from here')) {
    return { status: 409, error: 'This post is not in a subscription-deactivated state.' }
  }
  if (m.includes('only the responsible party may mark this milestone completed')) {
    return { status: 403, error: 'Only the responsible party can mark this milestone completed.' }
  }
  if (m.includes('only the currently active milestone can be completed')) {
    return { status: 409, error: 'Only the currently active milestone can be completed.' }
  }
  if (m.includes('both parties must mutually confirm the date, time, and location')) {
    return { status: 409, error: 'Both parties must confirm the schedule before this milestone can be completed.' }
  }
  if (m.includes('does not belong to the accepted offer')) {
    return { status: 409, error: 'This milestone is no longer part of the accepted offer.' }
  }
  if (m.includes('this milestone is already completed')) {
    return { status: 409, error: 'This milestone is already completed and its schedule cannot be changed.' }
  }
  if (m.includes('milestone not found')) {
    return { status: 404, error: 'Milestone not found.' }
  }
  if (m.includes('you are not a party to this agreement')) {
    return { status: 403, error: 'You are not a party to this agreement.' }
  }
  if (m.includes('this barter agreement has not been completed yet')) {
    return { status: 409, error: 'This barter agreement has not been completed yet.' }
  }
  if (m.includes('rating must be between 1 and 5')) {
    return { status: 422, error: 'Rating must be between 1 and 5.' }
  }
  if (m.includes('a reason is required')) {
    return { status: 400, error: 'A reason is required.' }
  }
  if (m.includes('post has no valid restorable prior status') || m.includes('post is not currently suspended')) {
    return { status: 409, error: 'This post cannot be restored right now.' }
  }
  if (m.includes('post cannot be edited in its current status')) {
    return { status: 409, error: 'This post cannot be edited in its current status.' }
  }
  if (m.includes('invalid_transition')) {
    return { status: 409, error: 'This action is not allowed for the post’s current status.' }
  }
  if (m.includes('you cannot report your own post')) {
    return { status: 403, error: 'You cannot report your own post.' }
  }
  if (m.includes('invalid report reason')) {
    return { status: 400, error: 'Invalid report reason.' }
  }
  if (m.includes('title, description, and delivery mode are required before publishing')) {
    return { status: 422, error: 'Title, description, and delivery mode are required before publishing.' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}
