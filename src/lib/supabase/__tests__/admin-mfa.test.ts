import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fake-anon-key'

let aalResult: { data: { currentLevel: string | null } | null; error: unknown }
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { mfa: { getAuthenticatorAssuranceLevel: () => Promise.resolve(aalResult) } },
  }),
}))
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ getAll: () => [], set: () => {} }),
}))

const { isAdminMfaEnforced, hasVerifiedAdminMfaSession } = await import('../admin-mfa')

const ORIGINAL_ENV = process.env.ADMIN_MFA_ENFORCED

beforeEach(() => {
  aalResult = { data: { currentLevel: 'aal1' }, error: null }
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.ADMIN_MFA_ENFORCED
  else process.env.ADMIN_MFA_ENFORCED = ORIGINAL_ENV
  vi.restoreAllMocks()
})

describe('isAdminMfaEnforced (category: E46 Admin MFA)', () => {
  it('1. defaults to false when unset -- the overwhelming majority of this flag\'s life so far', () => {
    delete process.env.ADMIN_MFA_ENFORCED
    expect(isAdminMfaEnforced()).toBe(false)
  })

  it('2. false for any value other than the exact string "true"', () => {
    process.env.ADMIN_MFA_ENFORCED = 'TRUE'
    expect(isAdminMfaEnforced()).toBe(false)
    process.env.ADMIN_MFA_ENFORCED = '1'
    expect(isAdminMfaEnforced()).toBe(false)
  })

  it('3. true only for the exact string "true"', () => {
    process.env.ADMIN_MFA_ENFORCED = 'true'
    expect(isAdminMfaEnforced()).toBe(true)
  })
})

describe('hasVerifiedAdminMfaSession (category: E46 Admin MFA)', () => {
  it('1. true when the current session is already at aal2 (admin challenged a verified factor this session)', async () => {
    aalResult = { data: { currentLevel: 'aal2' }, error: null }
    expect(await hasVerifiedAdminMfaSession()).toBe(true)
  })

  it('2. false when the session is only at aal1, even if the admin has an enrolled factor they just haven\'t used this session', async () => {
    aalResult = { data: { currentLevel: 'aal1' }, error: null }
    expect(await hasVerifiedAdminMfaSession()).toBe(false)
  })

  it('3. fails closed on a Supabase error -- never treats an error as "assume verified"', async () => {
    aalResult = { data: null, error: { message: 'network error' } }
    expect(await hasVerifiedAdminMfaSession()).toBe(false)
  })

  it('4. fails closed when Supabase is not configured', async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    expect(await hasVerifiedAdminMfaSession()).toBe(false)
    process.env.NEXT_PUBLIC_SUPABASE_URL = url
  })
})
