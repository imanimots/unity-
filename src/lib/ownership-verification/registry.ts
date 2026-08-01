import type { OwnershipVerificationProvider } from './types'
import { ManualOwnershipVerificationProvider } from './manual-provider'
import { SumsubOwnershipVerificationProvider } from './sumsub-provider'

/**
 * Mirrors src/lib/payments/registry.ts exactly -- the same
 * proven provider-selection pattern, one env var
 * (OWNERSHIP_VERIFICATION_PROVIDER, default 'manual'), applied to a
 * different domain. Swapping to a real Sumsub integration later is a
 * one-line config change, not a redesign of anything that calls
 * getOwnershipVerificationProvider().
 */
const providers: Record<string, OwnershipVerificationProvider> = {
  manual: new ManualOwnershipVerificationProvider(),
  sumsub: new SumsubOwnershipVerificationProvider(),
}

export function getOwnershipVerificationProvider(name?: string): OwnershipVerificationProvider {
  const key = name || process.env.OWNERSHIP_VERIFICATION_PROVIDER || 'manual'
  const provider = providers[key]
  if (!provider) {
    throw new Error(`Unknown ownership verification provider "${key}". Registered providers: ${Object.keys(providers).join(', ')}`)
  }
  return provider
}

export function listRegisteredOwnershipVerificationProviders(): string[] {
  return Object.keys(providers)
}
