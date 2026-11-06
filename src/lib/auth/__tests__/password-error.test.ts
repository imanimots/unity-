import { describe, it, expect } from 'vitest'
import { AuthWeakPasswordError, AuthApiError } from '@supabase/supabase-js'
import { classifyPasswordError } from '../password-error'

describe('classifyPasswordError', () => {
  it('1. classifies a pwned-reason AuthWeakPasswordError as "leaked"', () => {
    const error = new AuthWeakPasswordError('Password found in breach', 422, ['pwned'])
    expect(classifyPasswordError(error)).toBe('leaked')
  })

  it('2. classifies a pwned reason alongside other reasons as "leaked" (pwned takes priority)', () => {
    const error = new AuthWeakPasswordError('Password too weak', 422, ['length', 'pwned'])
    expect(classifyPasswordError(error)).toBe('leaked')
  })

  it('3. classifies a length/characters-only AuthWeakPasswordError as "weak", not "leaked"', () => {
    const error = new AuthWeakPasswordError('Password too short', 422, ['length'])
    expect(classifyPasswordError(error)).toBe('weak')

    const error2 = new AuthWeakPasswordError('Password missing character classes', 422, ['characters'])
    expect(classifyPasswordError(error2)).toBe('weak')
  })

  it('4. classifies an unrelated AuthApiError (e.g. invalid credentials) as "generic"', () => {
    const error = new AuthApiError('Invalid login credentials', 400, 'invalid_credentials')
    expect(classifyPasswordError(error)).toBe('generic')
  })

  it('5. classifies null, undefined, and non-error values as "generic" without throwing', () => {
    expect(classifyPasswordError(null)).toBe('generic')
    expect(classifyPasswordError(undefined)).toBe('generic')
    expect(classifyPasswordError('some string')).toBe('generic')
    expect(classifyPasswordError({})).toBe('generic')
  })

  it('6. never inspects or requires a password value -- operates purely on the error object', () => {
    // The function signature itself only accepts `unknown`; this test
    // documents that no password/credential field is ever read.
    const error = new AuthWeakPasswordError('weak', 422, ['pwned'])
    expect(Object.keys(error)).not.toContain('password')
    expect(classifyPasswordError(error)).toBe('leaked')
  })
})
