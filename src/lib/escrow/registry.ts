import type { EscrowProvider } from './provider'
import { MockEscrowProvider } from './providers/mock-escrow-provider'
import { UnsupportedTradeSafeProvider } from './providers/tradesafe-provider'
import { EscrowProviderConfigurationError } from './provider-errors'

const providers: Record<string, EscrowProvider> = {
  mock: new MockEscrowProvider(),
  tradesafe: new UnsupportedTradeSafeProvider(),
}

/**
 * The one central, server-only production safety guard for the entire
 * escrow domain -- every path that ever instantiates a provider
 * (createEscrowForPayment / fundEscrowForPayment / releaseEscrowForPayment
 * / refundEscrowTransaction in src/lib/escrow/orchestrator.ts, and the
 * webhook route's own provider lookup) goes through getEscrowProvider(),
 * so this single check is sufficient -- no NODE_ENV check is scattered
 * into any individual route or orchestrator function.
 *
 * Deliberately NOT gated on ESCROW_ENABLED: every real call site already
 * checks isEscrowEnabled() before ever reaching getEscrowProvider(), so
 * in practice this only ever fires once escrow is genuinely active --
 * but the guard itself must hold unconditionally, so that a future or
 * mistaken direct call can never silently resolve to an unsafe mock
 * instance in production.
 *
 * Only 'mock' is blocked. 'tradesafe' is untouched -- it is already
 * safe by construction (UnsupportedTradeSafeProvider throws
 * EscrowNotImplementedError on every real operation, in every
 * environment) and this guard must never be read as endorsing or
 * enabling a real TradeSafe integration.
 *
 * The admin escrow override routes (release/cancel) never call a
 * provider at all, in any environment -- by design, mirroring Phase
 * 8's merchant-payout admin actions, which are deliberately manual/
 * provider-neutral (see docs/MERCHANT_PAYOUT_WORKFLOW.md, Correction 1).
 * They therefore need no guard of their own: this check is what
 * prevents a 'mock'-provider escrow_transactions row from ever being
 * CREATED in production in the first place, so there is never a mock
 * row for those routes to act on.
 */
function assertEscrowProviderRuntimeSafe(provider: EscrowProvider): void {
  if (process.env.NODE_ENV === 'production' && provider.name === 'mock') {
    throw new EscrowProviderConfigurationError(
      `MockEscrowProvider cannot be used while NODE_ENV=production. Set ESCROW_PROVIDER to a real, production-ready provider, or leave ESCROW_ENABLED unset/false.`
    )
  }
}

export function getEscrowProvider(name?: string): EscrowProvider {
  const key = name || process.env.ESCROW_PROVIDER || 'mock'
  const provider = providers[key]
  if (!provider) {
    throw new Error(`Unknown escrow provider "${key}". Registered providers: ${Object.keys(providers).join(', ')}`)
  }
  assertEscrowProviderRuntimeSafe(provider)
  return provider
}

export function listRegisteredEscrowProviders(): string[] {
  return Object.keys(providers)
}
