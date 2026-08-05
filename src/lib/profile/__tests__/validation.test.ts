import { describe, it, expect } from 'vitest'
import { countryUpdateSchema } from '../validation'

describe('countryUpdateSchema', () => {
  it('accepts a valid country code', () => {
    expect(countryUpdateSchema.safeParse({ country_id: 'ZA' }).success).toBe(true)
  })

  it('rejects a missing country_id', () => {
    expect(countryUpdateSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(countryUpdateSchema.safeParse({ country_id: '' }).success).toBe(false)
  })

  it('rejects a non-string value', () => {
    expect(countryUpdateSchema.safeParse({ country_id: 123 }).success).toBe(false)
  })
})
