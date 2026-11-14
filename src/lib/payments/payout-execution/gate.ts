/**
 * Provider-neutral payout execution gate.
 *
 * Real payout execution remains disabled unless a future real provider
 * integration explicitly sets PAYOUT_EXECUTION_ENABLED="true". Peach's
 * old switch is deliberately ignored by active runtime code.
 */
export function isPayoutExecutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAYOUT_EXECUTION_ENABLED === 'true'
}

/**
 * Legacy Peach-only helper retained solely for the isolated historical
 * readiness module/tests. Active payout routes must not use this.
 */
export function isLegacyPeachPayoutExecutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PEACH_PAYOUTS_EXECUTION_ENABLED === 'true'
}

export class PayoutExecutionNotEnabledError extends Error {
  constructor() {
    super('Payout execution is not enabled in this environment (PAYOUT_EXECUTION_ENABLED is not "true").')
    this.name = 'PayoutExecutionNotEnabledError'
  }
}

export class PayoutEnvironmentMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayoutEnvironmentMismatchError'
  }
}

/**
 * E34 (phase brief §51/§52): a real app-environment vs Peach-environment
 * consistency check, run immediately before every provider payout call
 * -- a deployed app environment and a Peach host selection can
 * independently drift (someone sets PEACH_ENVIRONMENT=sandbox on a real
 * production deployment, or vice versa), and nothing before this phase
 * cross-checked the two. Two directions matter:
 *
 *   - app is real production (VERCEL_ENV==='production', the same
 *     signal isMockPaymentAuthorityAllowed() already trusts as
 *     authoritative) + Peach pointed at sandbox -- allowed ONLY under
 *     an explicit, narrowly-named escape hatch
 *     (PEACH_SANDBOX_CERTIFICATION_MODE==='true') for a deliberate
 *     controlled sandbox run from a production deployment; otherwise
 *     rejected, since a real production deployment silently submitting
 *     to Peach's sandbox would mean no money moves while everything
 *     LOOKS like it worked.
 *   - app is NOT production (preview/development/test) + Peach pointed
 *     at production -- always rejected outright. There is no
 *     legitimate reason for a preview deployment to ever reach Peach's
 *     live host (phase brief's own example: "APP preview/test + Peach
 *     live host -> reject").
 *
 * Fails closed (throws) on any mismatch rather than warning and
 * proceeding. Hosts themselves remain enum-derived (loadPeachPayoutsConfig
 * only ever resolves 'sandbox'|'production' to one of two hardcoded
 * constants -- never a raw PEACH_PAYOUTS_BASE_URL env var, phase brief
 * §52's own stated preference, already true since E32/E33 and
 * unchanged here).
 */
export function assertPeachEnvironmentConsistency(peachEnvironment: 'sandbox' | 'production', env: NodeJS.ProcessEnv = process.env): void {
  const isRealProduction = env.NODE_ENV !== 'test' && (env.VERCEL_ENV ? env.VERCEL_ENV === 'production' : env.NODE_ENV === 'production')
  const sandboxCertificationMode = env.PEACH_SANDBOX_CERTIFICATION_MODE === 'true'

  if (isRealProduction && peachEnvironment === 'sandbox' && !sandboxCertificationMode) {
    throw new PayoutEnvironmentMismatchError(
      'Refusing to call Peach sandbox from a real production deployment without PEACH_SANDBOX_CERTIFICATION_MODE="true" explicitly set.'
    )
  }
  if (!isRealProduction && peachEnvironment === 'production') {
    throw new PayoutEnvironmentMismatchError('Refusing to call Peach production from a non-production app environment.')
  }
}
