import { describe, it, expect, afterEach } from 'vitest'
import { MockMerchantAiProvider, __setMerchantAiProviderForTests, getMerchantAiProvider, completeWithMerchantAiProvider } from '../provider'
import { ClaudeMerchantAiProvider } from '../claude-provider'

describe('merchant AI provider abstraction (category: provider-neutral architecture, Section 30)', () => {
  afterEach(() => {
    __setMerchantAiProviderForTests(null)
  })

  it('1. defaults to the real Claude provider, never a fabricated response, when no test override is set', () => {
    expect(getMerchantAiProvider()).toBeInstanceOf(ClaudeMerchantAiProvider)
  })

  it('2. the mock provider is a real, separate class -- not silently used in production code paths', () => {
    const mock = new MockMerchantAiProvider()
    expect(mock.name).toBe('mock')
    expect(mock.isConfigured()).toBe(true)
  })

  it('3. completeWithMerchantAiProvider uses the test override when set (test seam)', async () => {
    __setMerchantAiProviderForTests(new MockMerchantAiProvider())
    const result = await completeWithMerchantAiProvider({ capability: 'listing_assistant', systemPrompt: 'sys', userPrompt: 'hello' })
    expect(result.status).toBe('succeeded')
    expect(result.model).toBe('mock')
  })

  it('4. Claude provider reports provider_unavailable (never a fabricated response) when ANTHROPIC_API_KEY is unset', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const provider = new ClaudeMerchantAiProvider()
      expect(provider.isConfigured()).toBe(false)
      const result = await provider.complete({ capability: 'listing_assistant', systemPrompt: 'sys', userPrompt: 'hello' })
      expect(result.status).toBe('provider_unavailable')
      expect(result.text).toBeUndefined()
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
    }
  })

  it('5. Claude provider treats a placeholder key as unconfigured (matches the existing chat assistant convention)', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-placeholder-test'
    try {
      const provider = new ClaudeMerchantAiProvider()
      expect(provider.isConfigured()).toBe(false)
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = original
    }
  })
})
