import { describe, it, expect } from 'vitest'
import { createOrderRequestSchema, orderCheckoutRequestSchema, cancelOrderSchema, orderActionSchema } from '../validation'

const VALID_LISTING_ID = '11111111-1111-1111-8111-111111111111'

describe('createOrderRequestSchema', () => {
  it('accepts a minimal valid request', () => {
    expect(createOrderRequestSchema.safeParse({ listing_id: VALID_LISTING_ID }).success).toBe(true)
  })

  it('defaults quantity to 1 when omitted', () => {
    const result = createOrderRequestSchema.safeParse({ listing_id: VALID_LISTING_ID })
    expect(result.success && result.data.quantity).toBe(1)
  })

  it('rejects a malformed listing id', () => {
    expect(createOrderRequestSchema.safeParse({ listing_id: 'not-a-uuid' }).success).toBe(false)
  })

  it('rejects a quantity below 1', () => {
    expect(createOrderRequestSchema.safeParse({ listing_id: VALID_LISTING_ID, quantity: 0 }).success).toBe(false)
  })

  it('rejects a non-integer quantity', () => {
    expect(createOrderRequestSchema.safeParse({ listing_id: VALID_LISTING_ID, quantity: 1.5 }).success).toBe(false)
  })
})

describe('orderCheckoutRequestSchema', () => {
  it('requires an idempotency key', () => {
    expect(orderCheckoutRequestSchema.safeParse({}).success).toBe(false)
  })

  it('accepts a valid key with no test_scenario', () => {
    expect(orderCheckoutRequestSchema.safeParse({ idempotency_key: 'a-valid-key-12345' }).success).toBe(true)
  })

  it('rejects an unrecognized test_scenario value', () => {
    const result = orderCheckoutRequestSchema.safeParse({ idempotency_key: 'a-valid-key-12345', test_scenario: 'bogus' })
    expect(result.success).toBe(false)
  })

  it('accepts every valid MockScenario value', () => {
    for (const scenario of ['success', 'declined', 'timeout', 'retryable_failure', 'terminal_failure', 'duplicate']) {
      expect(orderCheckoutRequestSchema.safeParse({ idempotency_key: 'a-valid-key-12345', test_scenario: scenario }).success).toBe(true)
    }
  })
})

describe('cancelOrderSchema / orderActionSchema', () => {
  it('accept an empty body', () => {
    expect(cancelOrderSchema.safeParse({}).success).toBe(true)
    expect(orderActionSchema.safeParse({}).success).toBe(true)
  })
})
