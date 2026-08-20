import type { MerchantAiProvider, MerchantAiRequest, MerchantAiResult } from './types'
import { MERCHANT_AI_LIMITS } from './safety'

/**
 * Anthropic implementation of MerchantAiProvider. Reuses this
 * codebase's own already-proven integration pattern from
 * src/app/api/assistant/chat/route.ts exactly: same SDK
 * (@anthropic-ai/sdk, already a dependency), same ANTHROPIC_API_KEY
 * env var, same "sk-ant-placeholder" mock-key convention, same current
 * model id (claude-sonnet-4-6) as the one already live elsewhere in
 * this app -- not a guessed/invented model id. Model is still
 * configurable via ANTHROPIC_MODEL (Section 31) so it never needs a
 * code change to move to a newer model later.
 */
export class ClaudeMerchantAiProvider implements MerchantAiProvider {
  readonly name = 'anthropic'

  isConfigured(): boolean {
    const apiKey = process.env.ANTHROPIC_API_KEY
    return !!apiKey && !apiKey.startsWith('sk-ant-placeholder')
  }

  async complete(request: MerchantAiRequest): Promise<MerchantAiResult> {
    if (!this.isConfigured()) {
      return { status: 'provider_unavailable', errorMessage: 'Anthropic API key is not configured' }
    }

    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
    const startedAt = Date.now()

    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

      const response = await client.messages.create({
        model,
        max_tokens: MERCHANT_AI_LIMITS.MAX_OUTPUT_TOKENS,
        system: request.systemPrompt,
        messages: [{ role: 'user', content: request.userPrompt }],
      })

      const text = response.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()

      return {
        status: 'succeeded',
        text,
        model,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        latencyMs: Date.now() - startedAt,
      }
    } catch (err) {
      return {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Unknown provider error',
        latencyMs: Date.now() - startedAt,
      }
    }
  }
}
