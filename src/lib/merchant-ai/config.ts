/**
 * Server-authoritative flag (Section 33) -- default false, never
 * NEXT_PUBLIC_-prefixed. Plan eligibility (Pro/Elite entitlement) and
 * provider availability (a real ANTHROPIC_API_KEY configured) are
 * deliberately separate checks -- a merchant can be ENTITLED to the
 * assistant while it stays runtime-disabled until both this flag is
 * true AND a provider is actually configured (see provider.ts's
 * isProviderConfigured()).
 */
function readBooleanFlag(value: string | undefined): boolean {
  return value === 'true'
}

export function isMerchantAiAssistantEnabled(): boolean {
  return readBooleanFlag(process.env.MERCHANT_AI_ASSISTANT_ENABLED)
}
