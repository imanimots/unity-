/**
 * E33: the dedicated payout-execution gate (phase brief §9-10).
 * PAYMENT_PROVIDER=peach, by itself, must NOT automatically enable
 * payout execution -- Peach already serves charges/deposit
 * authorization/capture/release under that same env var, and
 * production may legitimately want those live before payouts are
 * operationally approved (float funded, source-of-funds compliance
 * signed off, Dashboard webhook configured, etc -- see phase brief
 * §68 and the planned E34 phase). This is therefore a SEPARATE,
 * independently-defaulting-false control, checked in addition to (not
 * instead of) getActivePaymentProvider()/assertProviderSupportsCapability().
 *
 * Exact-string check only ("true"), matching this codebase's
 * established convention for every other safety-relevant boolean env
 * var (ESCROW_ENABLED, isMockPaymentAuthorityAllowed's own strict
 * checks) -- never a truthy-string coercion.
 */
export function isPayoutExecutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PEACH_PAYOUTS_EXECUTION_ENABLED === 'true'
}

export class PayoutExecutionNotEnabledError extends Error {
  constructor() {
    super('Peach payout execution is not enabled in this environment (PEACH_PAYOUTS_EXECUTION_ENABLED is not "true").')
    this.name = 'PayoutExecutionNotEnabledError'
  }
}
