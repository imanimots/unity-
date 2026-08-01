import { describe, it, expect } from 'vitest'
import { OrchestrationError, isRetryableOrchestrationError } from '../errors'

describe('OrchestrationError', () => {
  it('carries its code alongside the message', () => {
    const err = new OrchestrationError('invalid_booking_state', 'Booking is not accepted')
    expect(err.code).toBe('invalid_booking_state')
    expect(err.message).toBe('Booking is not accepted')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('isRetryableOrchestrationError', () => {
  it('treats provider_unavailable, provider_timeout, and retryable_provider_error as retryable', () => {
    expect(isRetryableOrchestrationError('provider_unavailable')).toBe(true)
    expect(isRetryableOrchestrationError('provider_timeout')).toBe(true)
    expect(isRetryableOrchestrationError('retryable_provider_error')).toBe(true)
  })

  it('treats a terminal decline and other codes as not retryable', () => {
    expect(isRetryableOrchestrationError('terminal_provider_error')).toBe(false)
    expect(isRetryableOrchestrationError('provider_declined')).toBe(false)
    expect(isRetryableOrchestrationError('invalid_booking_state')).toBe(false)
    expect(isRetryableOrchestrationError('duplicate_workflow_conflict')).toBe(false)
    expect(isRetryableOrchestrationError('internal_consistency_error')).toBe(false)
  })
})
