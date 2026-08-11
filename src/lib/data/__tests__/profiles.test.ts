import { describe, it, expect } from 'vitest'
import { displayNameOf } from '../profiles'

describe('displayNameOf', () => {
  it('prefers display_name over full_name', () => {
    expect(displayNameOf({ display_name: 'Ari', full_name: 'Ari Botha' })).toBe('Ari')
  })

  it('falls back to full_name when display_name is null', () => {
    expect(displayNameOf({ display_name: null, full_name: 'Ari Botha' })).toBe('Ari Botha')
  })

  it('falls back to a generic label when both are null -- never blank', () => {
    expect(displayNameOf({ display_name: null, full_name: null })).toBe('Unity Member')
  })

  it('uses nullish coalescing, not a falsy check -- an empty string is not null, so it is not replaced', () => {
    expect(displayNameOf({ display_name: '', full_name: 'Ari Botha' })).toBe('')
  })
})
