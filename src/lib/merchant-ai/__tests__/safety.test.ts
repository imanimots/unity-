import { describe, it, expect } from 'vitest'
import { checkMerchantAiRateLimit, truncatePrompt, MERCHANT_AI_LIMITS } from '../safety'

describe('checkMerchantAiRateLimit (category: fair use)', () => {
  it('1. allows requests under the hourly limit', () => {
    const merchantId = `test-merchant-${Date.now()}-1`
    for (let i = 0; i < MERCHANT_AI_LIMITS.MAX_REQUESTS_PER_HOUR; i++) {
      expect(checkMerchantAiRateLimit(merchantId, 'listing_assistant').allowed).toBe(true)
    }
  })

  it('2. blocks the request once the hourly limit is exceeded', () => {
    const merchantId = `test-merchant-${Date.now()}-2`
    for (let i = 0; i < MERCHANT_AI_LIMITS.MAX_REQUESTS_PER_HOUR; i++) {
      checkMerchantAiRateLimit(merchantId, 'listing_assistant')
    }
    const result = checkMerchantAiRateLimit(merchantId, 'listing_assistant')
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('3. rate limits are scoped per capability -- exhausting listing_assistant does not block analytics_assistant', () => {
    const merchantId = `test-merchant-${Date.now()}-3`
    for (let i = 0; i < MERCHANT_AI_LIMITS.MAX_REQUESTS_PER_HOUR; i++) {
      checkMerchantAiRateLimit(merchantId, 'listing_assistant')
    }
    expect(checkMerchantAiRateLimit(merchantId, 'analytics_assistant').allowed).toBe(true)
  })

  it('4. rate limits are scoped per merchant -- one merchant exhausting their limit does not block another', () => {
    const merchantA = `test-merchant-${Date.now()}-4a`
    const merchantB = `test-merchant-${Date.now()}-4b`
    for (let i = 0; i < MERCHANT_AI_LIMITS.MAX_REQUESTS_PER_HOUR; i++) {
      checkMerchantAiRateLimit(merchantA, 'listing_assistant')
    }
    expect(checkMerchantAiRateLimit(merchantB, 'listing_assistant').allowed).toBe(true)
  })
})

describe('truncatePrompt (category: fair use)', () => {
  it('5. leaves a short prompt unchanged', () => {
    expect(truncatePrompt('hello')).toBe('hello')
  })

  it('6. truncates a prompt exceeding MAX_PROMPT_CHARS', () => {
    const long = 'a'.repeat(MERCHANT_AI_LIMITS.MAX_PROMPT_CHARS + 500)
    expect(truncatePrompt(long).length).toBe(MERCHANT_AI_LIMITS.MAX_PROMPT_CHARS)
  })
})
