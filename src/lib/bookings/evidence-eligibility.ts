export type BookingConditionEvidenceStage = 'pre_handover' | 'post_return'

/**
 * Server-authoritative gate for when each condition-evidence stage may
 * be submitted, derived from the booking's own real lifecycle
 * (supabase/migrations/20260730000004_booking_status_model.sql,
 * 20260730000007_booking_rpcs.sql). Never trust the browser to decide
 * this -- the API route calls this against the booking's current,
 * freshly-read status, not a client-supplied value.
 *
 * pre_handover: documentable once the booking is confirmed and
 * payment-ready through the moment of handover itself (`accepted`,
 * which start_rental() transitions from; `active`, set by start_rental()
 * at the moment of handover) -- covers "about to hand over" through
 * "just handed over."
 *
 * post_return: documentable from the moment a return is initiated
 * through completion, and still while a dispute is open against the
 * booking (a dispute is often exactly the circumstance that makes late
 * post-return evidence most needed) -- `return_pending` (initiate_return()),
 * `returned` (the transient status confirm_return() sets just before
 * `completed`), `completed`, and `disputed`.
 */
const PRE_HANDOVER_ELIGIBLE_STATUSES = new Set(['accepted', 'active'])
const POST_RETURN_ELIGIBLE_STATUSES = new Set(['return_pending', 'returned', 'completed', 'disputed'])

export function canUploadConditionEvidence(bookingStatus: string, stage: BookingConditionEvidenceStage): boolean {
  if (stage === 'pre_handover') return PRE_HANDOVER_ELIGIBLE_STATUSES.has(bookingStatus)
  return POST_RETURN_ELIGIBLE_STATUSES.has(bookingStatus)
}
