import type { IdentityVerificationProvider } from './types'
import { ManualIdentityVerificationProvider } from './manual-provider'
import { SumsubIdentityVerificationProvider } from './sumsub-provider'

/**
 * Mirrors src/lib/ownership-verification/registry.ts (Step 3) and
 * src/lib/payments/registry.ts (Phase 2C) exactly -- the same proven
 * provider-selection pattern, one env var
 * (IDENTITY_VERIFICATION_PROVIDER, default 'manual'), applied to a third
 * domain. Swapping to a real Sumsub integration later is a one-line
 * config change, not a redesign of anything that calls
 * getIdentityVerificationProvider().
 */
const providers: Record<string, IdentityVerificationProvider> = {
  manual: new ManualIdentityVerificationProvider(),
  sumsub: new SumsubIdentityVerificationProvider(),
}

export function getIdentityVerificationProvider(name?: string): IdentityVerificationProvider {
  const key = name || process.env.IDENTITY_VERIFICATION_PROVIDER || 'manual'
  const provider = providers[key]
  if (!provider) {
    throw new Error(`Unknown identity verification provider "${key}". Registered providers: ${Object.keys(providers).join(', ')}`)
  }
  return provider
}

export function listRegisteredIdentityVerificationProviders(): string[] {
  return Object.keys(providers)
}
