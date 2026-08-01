import { createHash } from 'crypto'

/**
 * Orchestrator-level idempotency hashes. Unlike src/lib/bookings/
 * idempotency.ts or src/lib/payments/idempotency.ts, these have no SQL
 * RPC counterpart to mirror -- the orchestrator writes its own
 * idempotency_keys rows directly (via the service-role client), since
 * release-deposit/capture-deposit/create-merchant-payout each already
 * compose multiple existing RPC calls rather than being one RPC
 * themselves. The primary correctness net is still each payment's own
 * terminal status (checked before this ever runs) -- these hashes only
 * cover the "same key, different input" conflict case.
 */
function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeReleaseDepositHash(paymentId: string): string {
  return md5(`release_deposit|${paymentId}`)
}

export function computeCaptureDepositHash(paymentId: string, amount: number, reason: string | null | undefined): string {
  return md5(`capture_deposit|${paymentId}|${String(amount)}|${reason ?? ''}`)
}

export function computeOrchestratorPayoutHash(bookingId: string): string {
  return md5(`create_merchant_payout|${bookingId}`)
}

export { checkIdempotentReplay } from '@/lib/bookings/idempotency'
