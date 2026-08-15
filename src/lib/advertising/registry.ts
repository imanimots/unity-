import type { AdvertisingBillingProvider } from './provider'
import { MockAdvertisingBillingProvider } from './providers/mock-provider'

const providers: Record<string, AdvertisingBillingProvider> = {
  mock: new MockAdvertisingBillingProvider(),
}

/**
 * Deliberately NOT gated on isAdvertisingEnabled() -- every real call
 * site already checks the flag before ever reaching a provider call;
 * this function only resolves which implementation backs the
 * interface. Mirrors src/lib/escrow/registry.ts's own "deliberately
 * not gated" precedent.
 */
export function getAdvertisingBillingProvider(name?: string): AdvertisingBillingProvider {
  const key = name || process.env.ADVERTISING_BILLING_PROVIDER || 'mock'
  const provider = providers[key]
  if (!provider) {
    throw new Error(`Unknown advertising billing provider "${key}". Registered providers: ${Object.keys(providers).join(', ')}`)
  }
  if (key === 'mock' && process.env.NODE_ENV === 'production') {
    throw new Error('MockAdvertisingBillingProvider cannot be used while NODE_ENV=production. Set ADVERTISING_BILLING_PROVIDER to a real, production-ready provider, or leave ADVERTISING_ENABLED unset/false.')
  }
  return provider
}

export function listRegisteredAdvertisingBillingProviders(): string[] {
  return Object.keys(providers)
}
