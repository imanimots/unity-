import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getRequestProfileMock = vi.fn()
const cookiesMock = vi.fn()

vi.mock('@/lib/supabase/require-admin', () => ({
  getRequestProfile: () => getRequestProfileMock(),
}))
vi.mock('next/headers', () => ({
  cookies: () => cookiesMock(),
}))

function cookieJar(value: string | undefined) {
  return { get: () => (value === undefined ? undefined : { value }) }
}

describe('resolveEffectiveCountry', () => {
  const originalEnv = process.env.NEXT_PUBLIC_DEFAULT_COUNTRY

  beforeEach(() => {
    vi.resetModules()
    getRequestProfileMock.mockReset()
    cookiesMock.mockReset()
  })

  afterEach(() => {
    process.env.NEXT_PUBLIC_DEFAULT_COUNTRY = originalEnv
  })

  it('an authenticated profile country wins over everything else', async () => {
    getRequestProfileMock.mockResolvedValue({ profile: { country_id: 'ZA' } })
    cookiesMock.mockResolvedValue(cookieJar('ZA'))
    process.env.NEXT_PUBLIC_DEFAULT_COUNTRY = 'ZA'

    const { resolveEffectiveCountry } = await import('../resolve-effective-country')
    const result = await resolveEffectiveCountry()
    expect(result.source).toBe('profile')
    expect(result.countryId).toBe('ZA')
  })

  it('falls back to the cookie when the caller is anonymous', async () => {
    getRequestProfileMock.mockResolvedValue(null)
    cookiesMock.mockResolvedValue(cookieJar('ZA'))

    const { resolveEffectiveCountry } = await import('../resolve-effective-country')
    const result = await resolveEffectiveCountry()
    expect(result.source).toBe('cookie')
    expect(result.countryId).toBe('ZA')
  })

  it('falls back to NEXT_PUBLIC_DEFAULT_COUNTRY when neither profile nor cookie resolve', async () => {
    getRequestProfileMock.mockResolvedValue(null)
    cookiesMock.mockResolvedValue(cookieJar(undefined))
    process.env.NEXT_PUBLIC_DEFAULT_COUNTRY = 'ZA'

    const { resolveEffectiveCountry } = await import('../resolve-effective-country')
    const result = await resolveEffectiveCountry()
    expect(result.source).toBe('env_default')
    expect(result.countryId).toBe('ZA')
  })

  it('an invalid/garbage cookie value falls through safely rather than erroring', async () => {
    getRequestProfileMock.mockResolvedValue(null)
    cookiesMock.mockResolvedValue(cookieJar('not-a-real-country'))
    process.env.NEXT_PUBLIC_DEFAULT_COUNTRY = 'ZA'

    const { resolveEffectiveCountry } = await import('../resolve-effective-country')
    const result = await resolveEffectiveCountry()
    expect(result.source).toBe('env_default')
    expect(result.countryId).toBe('ZA')
  })

  it('a "coming soon" (known but inactive) cookie value is rejected, same as unknown', async () => {
    getRequestProfileMock.mockResolvedValue(null)
    cookiesMock.mockResolvedValue(cookieJar('NG'))
    process.env.NEXT_PUBLIC_DEFAULT_COUNTRY = 'ZA'

    const { resolveEffectiveCountry } = await import('../resolve-effective-country')
    const result = await resolveEffectiveCountry()
    expect(result.source).toBe('env_default')
  })

  it('falls back to the hardcoded default when nothing else resolves', async () => {
    getRequestProfileMock.mockResolvedValue(null)
    cookiesMock.mockResolvedValue(cookieJar(undefined))
    delete process.env.NEXT_PUBLIC_DEFAULT_COUNTRY

    const { resolveEffectiveCountry } = await import('../resolve-effective-country')
    const result = await resolveEffectiveCountry()
    expect(result.source).toBe('hardcoded_default')
    expect(result.countryId).toBe('ZA')
  })
})
