import { createHash } from 'crypto'
import { checkIdempotentReplay } from '@/lib/bookings/idempotency'
export { checkIdempotentReplay }

/**
 * Mirrors each barter RPC's request_hash formula exactly
 * (supabase/migrations/20260810000011_barter_rpcs_phase_a.sql). Reuses
 * checkIdempotentReplay() from src/lib/bookings/idempotency.ts directly
 * -- it's already fully generic (takes `operation` as a string param,
 * nothing booking-specific in its body), so no relocation/re-export shim
 * is needed, just a direct import.
 */

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

// Matches Postgres's uuid[]::text representation -- '{elem1,elem2}' --
// used wherever a listing-id array is hashed as a parameter.
function pgUuidArrayText(ids: string[]): string {
  return `{${ids.join(',')}}`
}

interface OfferFieldsForHash {
  partyAListingIds: string[]
  partyBListingIds: string[]
  cashAdjustmentAmount: number
  deliveryMethod: string
  depositAmount: number | null | undefined
  depositPayer: string | null | undefined
  message: string | null | undefined
  // Skills + Tasks under Barter -- best-effort route-level replay
  // detection only (JSON.stringify, not a byte-exact mirror of
  // Postgres's own jsonb::text serialization used inside the RPC's
  // own request_hash). The RPC's own hash remains the sole
  // authoritative dedup guarantee (zero client write policies means
  // it's the only possible write path); a mismatch here only means an
  // identical replay might skip the route-level fast-path cache and
  // fall through to the RPC, which still correctly returns its own
  // cached result.
  partyAContributions?: unknown
  partyBContributions?: unknown
  depositTerms?: unknown
}

function offerFieldsSuffix(fields: OfferFieldsForHash): string {
  return (
    `${pgUuidArrayText(fields.partyAListingIds)}|` +
    `${pgUuidArrayText(fields.partyBListingIds)}|` +
    `${JSON.stringify(fields.partyAContributions ?? [])}|` +
    `${JSON.stringify(fields.partyBContributions ?? [])}|` +
    `${JSON.stringify(fields.depositTerms ?? [])}|` +
    `${fields.cashAdjustmentAmount}|` +
    `${fields.deliveryMethod}|` +
    `${fields.depositAmount ?? ''}|` +
    `${fields.depositPayer ?? ''}|` +
    `${fields.message ?? ''}`
  )
}

export function computeProposeBarterHash(anchor: { listingId?: string | null; skillTaskPostId?: string | null }, fields: OfferFieldsForHash): string {
  return md5(`${anchor.listingId ?? ''}|${anchor.skillTaskPostId ?? ''}|${offerFieldsSuffix(fields)}`)
}

export function computeCounterBarterOfferHash(agreementId: string, fields: OfferFieldsForHash): string {
  return md5(`${agreementId}|${offerFieldsSuffix(fields)}`)
}

// Step 11 Phase 4: accept_barter_offer's formula gained a `p_provider`
// component when the RPC was widened to also create payment intents
// (supabase/migrations/20260816000003_barter_execution_rpcs.sql).
export function computeAcceptBarterOfferHash(agreementId: string, provider: string): string {
  return md5(`${agreementId}|${provider}`)
}

export function computeRejectBarterOfferHash(agreementId: string, rejectionReason: string | null | undefined): string {
  return md5(`${agreementId}|${rejectionReason ?? ''}`)
}

export function computeCancelBarterAgreementHash(agreementId: string, cancellationReason: string | null | undefined): string {
  return md5(`${agreementId}|${cancellationReason ?? ''}`)
}

// ── Step 11 Phase 4 additions ──

export function computeMarkBarterProgressHash(agreementId: string, targetStatus: string): string {
  return md5(`${agreementId}|${targetStatus}`)
}

export function computeConfirmBarterCompletionHash(agreementId: string, confirmationNote: string | null | undefined): string {
  return md5(`${agreementId}|${confirmationNote ?? ''}`)
}

export function computeAdminSetBarterHoldHash(agreementId: string, hold: boolean, reason: string | null | undefined): string {
  return md5(`${agreementId}|${hold}|${reason ?? ''}`)
}

export function computeAdminCancelBarterAgreementHash(agreementId: string, reason: string | null | undefined): string {
  return md5(`${agreementId}|${reason ?? ''}`)
}
