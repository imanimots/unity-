import type { EmailProvider } from './provider'
import { ConsoleEmailProvider } from './providers/console-provider'
import { ResendEmailProvider } from './providers/resend-provider'

const providers: Record<string, EmailProvider> = {
  console: new ConsoleEmailProvider(),
  resend: new ResendEmailProvider(),
}

/** Mirrors src/lib/payments/registry.ts exactly: name param -> EMAIL_PROVIDER env -> default 'console'. */
export function getEmailProvider(name?: string): EmailProvider {
  const key = name || process.env.EMAIL_PROVIDER || 'console'
  const provider = providers[key]
  if (!provider) {
    throw new Error(`Unknown email provider "${key}". Registered providers: ${Object.keys(providers).join(', ')}`)
  }
  return provider
}

export function listRegisteredEmailProviders(): string[] {
  return Object.keys(providers)
}
