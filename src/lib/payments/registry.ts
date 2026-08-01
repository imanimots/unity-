import type { PaymentProvider } from './provider'
import { MockProvider } from './providers/mock-provider'
import { PeachPaymentsProvider } from './providers/peach-provider'

const providers: Record<string, PaymentProvider> = {
  mock: new MockProvider(),
  peach: new PeachPaymentsProvider(),
}

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
