import { createHash } from 'crypto'
import { checkIdempotentReplay } from '@/lib/bookings/idempotency'
export { checkIdempotentReplay }

/**
 * Mirrors each dispute RPC's request_hash formula exactly
 * (supabase/migrations/20260814000006_dispute_rpcs.sql). Reuses
 * checkIdempotentReplay() directly from src/lib/bookings/idempotency.ts
 * -- it's already fully generic, no relocation needed, same precedent
 * as barter/orders.
 */

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeOpenDisputeHash(
  bookingId: string | null | undefined,
  orderId: string | null | undefined,
  barterAgreementId: string | null | undefined,
  title: string,
  reason: string | null | undefined,
  description: string,
  requestedResolution: string
): string {
  return md5(`${bookingId ?? ''}|${orderId ?? ''}|${barterAgreementId ?? ''}|${title}|${reason ?? ''}|${description}|${requestedResolution}`)
}

export function computeAssignDisputeHash(disputeId: string, assigneeAdminId: string): string {
  return md5(`${disputeId}|${assigneeAdminId}`)
}

export function computeDisputeIdOnlyHash(disputeId: string): string {
  return md5(disputeId)
}

export function computeRequestDisputeEvidenceHash(disputeId: string, note: string | null | undefined): string {
  return md5(`${disputeId}|${note ?? ''}`)
}

export function computeResolveDisputeHash(disputeId: string, outcome: string, resolutionNotes: string | null | undefined): string {
  return md5(`${disputeId}|${outcome}|${resolutionNotes ?? ''}`)
}

export function computeCancelDisputeHash(disputeId: string, cancellationReason: string | null | undefined): string {
  return md5(`${disputeId}|${cancellationReason ?? ''}`)
}

/** Route-level only (evidence registration isn't an RPC) -- same idempotency_keys table, operation='register_dispute_evidence'. */
export function computeRegisterDisputeEvidenceHash(disputeId: string, storagePath: string, fileType: string): string {
  return md5(`${disputeId}|${storagePath}|${fileType}`)
}
