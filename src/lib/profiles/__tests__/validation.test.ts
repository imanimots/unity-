import { describe, it, expect } from 'vitest'
import { reportProfileSchema } from '../validation'

describe('reportProfileSchema', () => {
  it('accepts a minimal valid report', () => {
    expect(reportProfileSchema.safeParse({ reason: 'spam' }).success).toBe(true)
  })

  it('accepts a full valid report with description and idempotency key', () => {
    const result = reportProfileSchema.safeParse({ reason: 'harassment', description: 'they kept messaging me', idempotency_key: 'a1b2c3d4e5f6' })
    expect(result.success).toBe(true)
  })

  it('rejects an invalid reason', () => {
    expect(reportProfileSchema.safeParse({ reason: 'i_dont_like_them' }).success).toBe(false)
  })

  it('rejects a missing reason', () => {
    expect(reportProfileSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a description over 1000 characters', () => {
    expect(reportProfileSchema.safeParse({ reason: 'spam', description: 'x'.repeat(1001) }).success).toBe(false)
  })
})
