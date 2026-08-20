import type { MerchantAiProvider, MerchantAiRequest, MerchantAiResult } from './types'
import { ClaudeMerchantAiProvider } from './claude-provider'

/**
 * Deterministic mock provider (Section 100 -- the general test suite
 * must never require a real Anthropic secret). Never fabricates a real
 * Claude-shaped response; just enough to exercise the calling code's
 * success path in tests.
 */
export class MockMerchantAiProvider implements MerchantAiProvider {
  readonly name = 'mock'
  isConfigured(): boolean {
    return true
  }
  async complete(request: MerchantAiRequest): Promise<MerchantAiResult> {
    return {
      status: 'succeeded',
      text: `[mock ${request.capability} response] Suggestions based on your draft are not available in this test environment.`,
      model: 'mock',
      inputTokens: request.userPrompt.length,
      outputTokens: 12,
      latencyMs: 1,
    }
  }
}

let overrideProvider: MerchantAiProvider | null = null

/** Test-only seam -- never used by production request handling. */
export function __setMerchantAiProviderForTests(provider: MerchantAiProvider | null): void {
  overrideProvider = provider
}

export function getMerchantAiProvider(): MerchantAiProvider {
  if (overrideProvider) return overrideProvider
  return new ClaudeMerchantAiProvider()
}

export async function completeWithMerchantAiProvider(request: MerchantAiRequest): Promise<MerchantAiResult> {
  const provider = getMerchantAiProvider()
  if (!provider.isConfigured()) {
    return { status: 'provider_unavailable', errorMessage: `${provider.name} is not configured` }
  }
  return provider.complete(request)
}
