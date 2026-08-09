import { describe, it, expect, afterEach } from 'vitest'
import { isEscrowEnabled } from '../config'

describe('isEscrowEnabled', () => {
  const original = process.env.ESCROW_ENABLED

  afterEach(() => {
    if (original === undefined) delete process.env.ESCROW_ENABLED
    else process.env.ESCROW_ENABLED = original
  })

  it('defaults to false when unset', () => {
    delete process.env.ESCROW_ENABLED
    expect(isEscrowEnabled()).toBe(false)
  })

  it('is false for any value other than the literal string "true"', () => {
    process.env.ESCROW_ENABLED = 'TRUE'
    expect(isEscrowEnabled()).toBe(false)
    process.env.ESCROW_ENABLED = '1'
    expect(isEscrowEnabled()).toBe(false)
  })

  it('is true only for the literal string "true"', () => {
    process.env.ESCROW_ENABLED = 'true'
    expect(isEscrowEnabled()).toBe(true)
  })
})
