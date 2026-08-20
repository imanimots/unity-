export type MerchantAiCapability = 'listing_assistant' | 'analytics_assistant'

export interface MerchantAiRequest {
  capability: MerchantAiCapability
  systemPrompt: string
  userPrompt: string
}

export interface MerchantAiResult {
  status: 'succeeded' | 'failed' | 'rate_limited' | 'provider_unavailable'
  text?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  latencyMs?: number
  errorMessage?: string
}

/**
 * Provider-neutral boundary (Section 30): every capability route
 * depends on THIS interface, never on the Anthropic SDK directly.
 * Swapping providers later means writing a new implementation of this
 * interface, not touching any calling code.
 */
export interface MerchantAiProvider {
  readonly name: string
  isConfigured(): boolean
  complete(request: MerchantAiRequest): Promise<MerchantAiResult>
}
