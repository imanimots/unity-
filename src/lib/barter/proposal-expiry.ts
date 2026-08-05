/**
 * The single authoritative source for the barter proposal/counter
 * response window -- every caller that needs this number (propose and
 * counter routes, passed explicitly into propose_barter()/
 * counter_barter_offer()'s p_expiry_hours parameter) reads it from here,
 * never from a hardcoded literal. Mirrors
 * src/lib/bookings/payment-deadline.ts's pattern exactly.
 */
const raw = process.env.BARTER_PROPOSAL_EXPIRY_HOURS
const parsed = raw ? Number.parseInt(raw, 10) : NaN

export const BARTER_PROPOSAL_EXPIRY_HOURS = Number.isFinite(parsed) && parsed > 0 ? parsed : 72
