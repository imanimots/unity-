import { describe, it, expect, afterEach } from 'vitest'
import { isAdvertisingEnabled } from '../config'

describe('isAdvertisingEnabled', () => {
  const original = process.env.ADVERTISING_ENABLED

  afterEach(() => {
    if (original === undefined) delete process.env.ADVERTISING_ENABLED
    else process.env.ADVERTISING_ENABLED = original
  })

  it('defaults to false when unset', () => {
    delete process.env.ADVERTISING_ENABLED
    expect(isAdvertisingEnabled()).toBe(false)
  })

  it('is false for any value other than the literal string "true"', () => {
    process.env.ADVERTISING_ENABLED = 'TRUE'
    expect(isAdvertisingEnabled()).toBe(false)
    process.env.ADVERTISING_ENABLED = '1'
    expect(isAdvertisingEnabled()).toBe(false)
  })

  it('is true only for the literal string "true"', () => {
    process.env.ADVERTISING_ENABLED = 'true'
    expect(isAdvertisingEnabled()).toBe(true)
  })
})
