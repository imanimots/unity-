import { describe, it, expect } from 'vitest'
import { checkEnvironmentSeparation } from '../environment-separation'

describe('checkEnvironmentSeparation (category: E49 Phase 3 item 11)', () => {
  it('1. safe when no production project ref is configured yet -- the current, only-one-project state, must never throw', () => {
    const result = checkEnvironmentSeparation({
      supabaseUrl: 'https://pwueguyrlcorurvbphej.supabase.co',
      vercelEnv: 'production',
      productionProjectRef: undefined,
    })
    expect(result.safe).toBe(true)
  })

  it('2. safe when no production project ref is configured, regardless of vercelEnv value', () => {
    for (const vercelEnv of ['production', 'preview', 'development', undefined]) {
      expect(checkEnvironmentSeparation({ supabaseUrl: 'https://anything.supabase.co', vercelEnv, productionProjectRef: undefined }).safe).toBe(true)
    }
  })

  it('3. unsafe: production deployment pointing at a URL that does NOT match the designated production ref', () => {
    const result = checkEnvironmentSeparation({
      supabaseUrl: 'https://devstagingref.supabase.co',
      vercelEnv: 'production',
      productionProjectRef: 'realprodref',
    })
    expect(result.safe).toBe(false)
    expect(result.reason).toMatch(/wrong Supabase project/)
  })

  it('4. safe: production deployment correctly pointing at the designated production ref', () => {
    const result = checkEnvironmentSeparation({
      supabaseUrl: 'https://realprodref.supabase.co',
      vercelEnv: 'production',
      productionProjectRef: 'realprodref',
    })
    expect(result.safe).toBe(true)
  })

  it('5. unsafe: a non-production deployment pointing at the designated production ref', () => {
    const result = checkEnvironmentSeparation({
      supabaseUrl: 'https://realprodref.supabase.co',
      vercelEnv: 'preview',
      productionProjectRef: 'realprodref',
    })
    expect(result.safe).toBe(false)
    expect(result.reason).toMatch(/live production database/)
  })

  it('6. safe: a non-production deployment pointing at a different (dev/staging) project once production is designated', () => {
    const result = checkEnvironmentSeparation({
      supabaseUrl: 'https://devstagingref.supabase.co',
      vercelEnv: 'development',
      productionProjectRef: 'realprodref',
    })
    expect(result.safe).toBe(true)
  })

  it('7. treats an undefined vercelEnv (plain local dev, no Vercel) the same as any other non-production value', () => {
    const result = checkEnvironmentSeparation({
      supabaseUrl: 'https://realprodref.supabase.co',
      vercelEnv: undefined,
      productionProjectRef: 'realprodref',
    })
    expect(result.safe).toBe(false)
  })

  it('8. treats a missing supabaseUrl as "does not point at production" -- never crashes on undefined', () => {
    const result = checkEnvironmentSeparation({
      supabaseUrl: undefined,
      vercelEnv: 'production',
      productionProjectRef: 'realprodref',
    })
    expect(result.safe).toBe(false) // production env but doesn't point at the real production ref
  })
})
