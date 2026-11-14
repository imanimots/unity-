import type { PaymentProvider, PaymentCapability } from './provider'
import { ProviderCapabilityUnsupportedError } from './provider'
import { MockProvider } from './providers/mock-provider'
import { PeachPaymentsProvider } from './providers/peach-provider'

const providers: Record<string, PaymentProvider> = {
  mock: new MockProvider(),
  peach: new PeachPaymentsProvider(),
}

/**
 * E30: looks up a provider by name with NO environment permission check
 * -- the one place that is still legitimate to call directly is the
 * generic payment webhook route, which needs to resolve a NAMED
 * provider (from the URL) purely to run ITS OWN verifyWebhook(); that
 * route applies its own, separate isMockPaymentAuthorityAllowed() guard
 * before ever reaching this lookup for 'mock' (see src/app/api/
 * payments/webhooks/[provider]/route.ts). Every real money-moving
 * caller should use getActivePaymentProvider() below instead.
 */
export function getPaymentProvider(name?: string): PaymentProvider {
  const key = name || process.env.PAYMENT_PROVIDER || 'mock'
  const provider = providers[key]
  if (!provider) {
    throw new Error(`Unknown payment provider "${key}". Registered providers: ${Object.keys(providers).join(', ')}`)
  }
  return provider
}

export function listRegisteredProviders(): string[] {
  return Object.keys(providers)
}

/**
 * E30: whether 'mock' is permitted to act as real financial authority in
 * the CURRENT runtime -- never whether mock mode is merely configured.
 * VERCEL_ENV is authoritative when present: Vercel sets it on every
 * deployment (production/preview/development), and it is the ONLY
 * reliable way to distinguish a real production deployment from a
 * Preview deployment, since Next.js still sets NODE_ENV=production
 * during a Preview build (confirmed precedent: isMockScenarioSelectionAllowed()
 * in src/lib/checkout/test-scenario.ts hits exactly this gap for a
 * narrower, pre-existing concern). NODE_ENV is the fallback only when
 * VERCEL_ENV is entirely absent (local development, or a non-Vercel
 * production host) -- fails closed there too, matching that same
 * existing precedent's own final fallback.
 */
export function isMockPaymentAuthorityAllowed(): boolean {
  if (process.env.NODE_ENV === 'test') return true
  const vercelEnv = process.env.VERCEL_ENV
  if (vercelEnv) return vercelEnv !== 'production'
  return process.env.NODE_ENV !== 'production'
}

export class ProviderNotPermittedError extends Error {
  constructor(name: string) {
    super(`Payment provider "${name}" is not permitted as real financial authority in this environment.`)
    this.name = 'ProviderNotPermittedError'
  }
}

/**
 * E30: the authority every real money-moving orchestrator call should
 * use instead of getPaymentProvider() directly. Same resolution
 * precedence (explicit name > PAYMENT_PROVIDER > 'mock'), but rejects
 * outright -- never silently substituting a different provider --
 * whenever the resolved key is 'mock' and isMockPaymentAuthorityAllowed()
 * is false. This closes all three of the brief's named paths at once:
 * an unset PAYMENT_PROVIDER in production, PAYMENT_PROVIDER=mock in
 * production, and an explicit providerName='mock' argument in
 * production -- all three resolve to the identical key 'mock' by the
 * time this check runs.
 */
export function getActivePaymentProvider(name?: string): PaymentProvider {
  const key = name || process.env.PAYMENT_PROVIDER || 'mock'

  // Peach is retained in the registry only as isolated legacy code so
  // historical webhook/provider tests can continue to resolve it. It is
  // no longer a permitted active financial authority. TradeSafe will be
  // added here only when its real integration is implemented.
  if (key === 'peach') {
    throw new ProviderNotPermittedError(key)
  }

  if (key === 'mock' && !isMockPaymentAuthorityAllowed()) {
    throw new ProviderNotPermittedError(key)
  }
  return getPaymentProvider(key)
}

/**
 * E30: a pre-flight check an orchestrator calls BEFORE marking any DB
 * row 'processing' -- never after. Throws ProviderCapabilityUnsupportedError
 * (never silently no-ops, never falls back to a different provider) so
 * a known-in-advance provider capability gap is rejected before the first financial
 * state transition, not discovered mid-attempt.
 */
export function assertProviderSupportsCapability(provider: PaymentProvider, capability: PaymentCapability): void {
  if (!provider.supportsCapability(capability)) {
    throw new ProviderCapabilityUnsupportedError(provider.name, capability)
  }
}
