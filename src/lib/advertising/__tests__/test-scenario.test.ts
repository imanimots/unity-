import { describe, it, expect, afterEach } from 'vitest'
import { isAdvertisingMockScenarioSelectionAllowed } from '../test-scenario'

// process.env.NODE_ENV is typed read-only by @types/node -- same cast
// used by src/lib/advertising/__tests__/registry.test.ts to mutate it
// directly and prove the real runtime guard it reads.
const mutableEnv = process.env as Record<string, string | undefined>

// E48 Risk 2 -- the double gate deciding whether a client may show an
// explicit mock-scenario picker at all. Mirrors
// src/lib/checkout/test-scenario.ts's isMockScenarioSelectionAllowed()
// semantics exactly, adapted to the advertising provider's own env vars.
describe('isAdvertisingMockScenarioSelectionAllowed', () => {
  const ORIGINAL_PROVIDER = process.env.ADVERTISING_BILLING_PROVIDER
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV

  afterEach(() => {
    if (ORIGINAL_PROVIDER === undefined) delete mutableEnv.ADVERTISING_BILLING_PROVIDER
    else mutableEnv.ADVERTISING_BILLING_PROVIDER = ORIGINAL_PROVIDER
    mutableEnv.NODE_ENV = ORIGINAL_NODE_ENV
  })

  it('allows selection when the provider is mock and the environment is not production', () => {
    delete mutableEnv.ADVERTISING_BILLING_PROVIDER
    mutableEnv.NODE_ENV = 'test'
    expect(isAdvertisingMockScenarioSelectionAllowed()).toBe(true)
  })

  it('denies selection when NODE_ENV is production, even with the mock provider configured', () => {
    mutableEnv.ADVERTISING_BILLING_PROVIDER = 'mock'
    mutableEnv.NODE_ENV = 'production'
    expect(isAdvertisingMockScenarioSelectionAllowed()).toBe(false)
  })

  it('denies selection when a real (non-mock) provider is configured, regardless of environment', () => {
    mutableEnv.ADVERTISING_BILLING_PROVIDER = 'peach'
    mutableEnv.NODE_ENV = 'test'
    expect(isAdvertisingMockScenarioSelectionAllowed()).toBe(false)
  })
})
