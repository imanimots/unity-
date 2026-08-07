import { describe, it, expect } from 'vitest'
import { PAYOUT_FAILURE_SAFE_MESSAGES, safeFailureMessageFor } from '../failure-messages'
import { PAYOUT_FAILURE_CATEGORIES } from '../status-labels'

describe('payout failure-message mapping (category: Financial Integrity)', () => {
  it('1. every failure category has a mapped safe message', () => {
    for (const category of PAYOUT_FAILURE_CATEGORIES) {
      expect(PAYOUT_FAILURE_SAFE_MESSAGES[category], category).toBeTruthy()
      expect(typeof PAYOUT_FAILURE_SAFE_MESSAGES[category]).toBe('string')
    }
  })

  it('2. safeFailureMessageFor returns the mapped sentence, never a raw category slug', () => {
    const msg = safeFailureMessageFor('account_restricted')
    expect(msg).not.toBe('account_restricted')
    expect(msg).toContain('account review')
  })

  it('3. no safe message contains a raw technical/internal-sounding token', () => {
    for (const category of PAYOUT_FAILURE_CATEGORIES) {
      const msg = PAYOUT_FAILURE_SAFE_MESSAGES[category]
      expect(msg.toLowerCase()).not.toMatch(/exception|stack trace|null|undefined|error:/i)
    }
  })

  it('4. every safe message is a complete sentence ending in punctuation', () => {
    for (const category of PAYOUT_FAILURE_CATEGORIES) {
      expect(PAYOUT_FAILURE_SAFE_MESSAGES[category], category).toMatch(/[.!]$/)
    }
  })
})
