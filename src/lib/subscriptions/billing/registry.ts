import type { SubscriptionBillingProvider } from './provider'
import { MockSubscriptionBillingProvider } from './mock-provider'

const providers: Record<string, SubscriptionBillingProvider> = {
  mock: new MockSubscriptionBillingProvider(),
}

export function getSubscriptionBillingProvider(name?: string): SubscriptionBillingProvider {
  const key = name || process.env.SUBSCRIPTION_BILLING_PROVIDER || 'mock'
  const provider = providers[key]
  if (!provider) {
    throw new Error(`Unknown subscription billing provider "${key}". Registered providers: ${Object.keys(providers).join(', ')}`)
  }
  return provider
}

export function listRegisteredSubscriptionBillingProviders(): string[] {
  return Object.keys(providers)
}
