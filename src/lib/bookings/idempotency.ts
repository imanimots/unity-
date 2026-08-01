import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Mirrors each booking RPC's request_hash formula exactly
 * (supabase/migrations/20260730000007_booking_rpcs.sql). Lets each API
 * route recognize a genuine retry before calling its RPC, the same
 * pattern used for listing submission -- see
 * src/lib/listings/idempotency.ts and
 * src/app/api/listings/[id]/submit/route.ts. Must stay byte-for-byte in
 * sync with the SQL; each formula below was cross-checked live against
 * the actual Postgres md5() output for the same inputs.
 */

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeCreateBookingRequestHash(
  listingId: string,
  startAt: Date,
  endAt: Date,
  renterMessage: string | null | undefined
): string {
  // Postgres's extract(epoch from timestamptz)::text renders 6 decimal
  // places (e.g. "1785578400.000000"), not a bare integer -- verified
  // live. toFixed(6) matches that exactly; a plain toString() here would
  // silently produce a hash that never matches the RPC's.
  const startEpoch = (startAt.getTime() / 1000).toFixed(6)
  const endEpoch = (endAt.getTime() / 1000).toFixed(6)
  return md5(`${listingId}|${startEpoch}|${endEpoch}|${renterMessage ?? ''}`)
}

export function computeAcceptBookingRequestHash(bookingId: string, merchantResponseNote: string | null | undefined): string {
  return md5(`${bookingId}|${merchantResponseNote ?? ''}`)
}

export function computeRejectBookingRequestHash(bookingId: string, rejectionReason: string | null | undefined): string {
  return md5(`${bookingId}|${rejectionReason ?? ''}`)
}

export function computeCancelBookingHash(bookingId: string, cancellationReason: string | null | undefined): string {
  return md5(`${bookingId}|${cancellationReason ?? ''}`)
}

export function computeBookingIdOnlyHash(bookingId: string): string {
  return md5(bookingId)
}

export type ReplayCheckResult =
  | { status: 'none' }
  | { status: 'replay'; result: unknown }
  | { status: 'conflict' }

/**
 * Shared replay check for every booking transition route (accept, reject,
 * cancel, start, initiate-return, confirm-return). Must run BEFORE any
 * status/ownership check that could reject an already-transitioned
 * booking -- that ordering bug (route checks status before the RPC gets a
 * chance to recognize a retry) is exactly what was fixed for listing
 * submission, see src/app/api/listings/[id]/submit/route.ts's module
 * comment and the migration/fix this mirrors. idempotency_keys has zero
 * RLS policies by design -- only ever read here via a service-role
 * client, never exposed to the browser, and only the `result` field is
 * ever returned to a client.
 */
export async function checkIdempotentReplay(
  admin: SupabaseClient,
  actorUserId: string,
  operation: string,
  idempotencyKey: string | undefined,
  computedHash: string
): Promise<ReplayCheckResult> {
  if (!idempotencyKey) return { status: 'none' }

  const { data } = await admin
    .from('idempotency_keys')
    .select('request_hash, result')
    .eq('merchant_id', actorUserId)
    .eq('operation', operation)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()

  if (!data) return { status: 'none' }
  if (data.request_hash !== computedHash) return { status: 'conflict' }
  return { status: 'replay', result: data.result }
}
