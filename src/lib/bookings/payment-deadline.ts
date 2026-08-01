/**
 * The single authoritative source for the payment deadline duration --
 * every caller that needs this number (currently only the accept route,
 * which passes it explicitly into accept_booking_request()'s
 * p_payment_deadline_hours parameter) reads it from here, never from a
 * hardcoded literal. See docs/PAYMENT_READINESS.md "Deadline model".
 */
const raw = process.env.BOOKING_PAYMENT_DEADLINE_HOURS
const parsed = raw ? Number.parseInt(raw, 10) : NaN

export const BOOKING_PAYMENT_DEADLINE_HOURS = Number.isFinite(parsed) && parsed > 0 ? parsed : 24
