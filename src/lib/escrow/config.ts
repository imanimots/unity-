/**
 * Safe-by-default feature flag for the whole escrow domain, mirroring
 * src/lib/seo/config.ts's readBooleanFlag() pattern exactly. While
 * ESCROW_ENABLED is unset or anything other than the literal string
 * "true", no escrow transaction is ever created and every existing
 * payment/commission/payout/dispute flow is byte-identical to before
 * Phase 3 -- the escrow orchestrator functions early-return a no-op
 * result rather than being called conditionally at every site, so a
 * caller can always invoke them safely.
 */
function readBooleanFlag(value: string | undefined): boolean {
  return value === 'true'
}

export function isEscrowEnabled(): boolean {
  return readBooleanFlag(process.env.ESCROW_ENABLED)
}
