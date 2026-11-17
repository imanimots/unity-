import type { AdvertisingMockScenario } from './provider'

/**
 * Mirrors src/lib/checkout/test-scenario.ts's isMockScenarioSelectionAllowed()
 * exactly -- scenario selection is permitted only when the active
 * advertising billing provider is "mock" AND the environment is not
 * production. The fund route (POST /api/advertising/campaigns/[id]/fund)
 * independently re-validates this on every request regardless of what
 * the client sends, so a forged scenario value is rejected server-side
 * either way -- this function only decides whether the client is allowed
 * to SHOW a scenario picker at all.
 */
export function isAdvertisingMockScenarioSelectionAllowed(): boolean {
  const provider = process.env.ADVERTISING_BILLING_PROVIDER || 'mock'
  if (provider !== 'mock') return false
  return process.env.NODE_ENV !== 'production'
}

export const ADVERTISING_TEST_SCENARIOS: readonly AdvertisingMockScenario[] = ['success', 'declined', 'timeout']

export const ADVERTISING_TEST_SCENARIO_LABELS: Record<AdvertisingMockScenario, string> = {
  success: 'Successful charge',
  declined: 'Charge declined',
  timeout: 'Provider timeout',
}
