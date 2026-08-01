/**
 * Payment state machine -- mirrors the CASE statement in
 * transition_payment_status() exactly
 * (supabase/migrations/20260801000004_payment_rpcs.sql). The RPC is the
 * actual enforcement point (SECURITY DEFINER, service_role only); this
 * module exists so the same rules can be unit tested in isolation and so
 * a trusted server route can reject an obviously-invalid transition
 * before ever calling the RPC, for a clearer error message.
 *
 * Deliberately never merged with booking_status -- a booking's rental
 * lifecycle and its money movement are independent state machines. See
 * docs/PAYMENT_ARCHITECTURE.md.
 */

export type PaymentStatus =
  | 'pending'
  | 'authorised'
  | 'captured'
  | 'partially_captured'
  | 'released'
  | 'refunded'
  | 'partially_refunded'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'chargeback'

const ALLOWED_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ['authorised', 'captured', 'failed', 'cancelled', 'expired'],
  authorised: ['captured', 'partially_captured', 'released', 'cancelled', 'expired'],
  captured: ['refunded', 'partially_refunded', 'chargeback'],
  partially_captured: ['captured', 'refunded', 'partially_refunded', 'chargeback'],
  partially_refunded: ['refunded', 'chargeback'],
  released: [],
  refunded: [],
  failed: [],
  cancelled: [],
  expired: [],
  chargeback: [],
}

export function isValidPaymentTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export function allowedNextStatuses(from: PaymentStatus): readonly PaymentStatus[] {
  return ALLOWED_TRANSITIONS[from]
}

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0
}
