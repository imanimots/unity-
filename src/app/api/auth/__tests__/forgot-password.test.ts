import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const resetPasswordForEmail = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { resetPasswordForEmail: (...args: unknown[]) => resetPasswordForEmail(...args) },
  }),
}))

const { POST } = await import('../forgot-password/route')

function req(body: unknown, ip: string) {
  return new NextRequest('http://localhost/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  })
}

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => {
    resetPasswordForEmail.mockReset()
    resetPasswordForEmail.mockResolvedValue({ error: null })
  })

  it('A/C. a well-formed request for a known-shape email returns a generic 200 success', async () => {
    const res = await POST(req({ email: 'known@unitytest.internal', locale: 'en-ZA' }, '10.0.0.1'))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  it('D. an email Supabase silently no-ops for (unknown account) still returns the SAME generic 200 shape', async () => {
    // This is exactly how Supabase's own resetPasswordForEmail behaves for
    // a non-existent email by design (no error) -- proving the route
    // doesn't merely happen to look generic today by accident, in case
    // that upstream behavior ever changes, the next assertion (D2) proves
    // genericity is enforced independent of what Supabase returns.
    resetPasswordForEmail.mockResolvedValue({ error: null })
    const res = await POST(req({ email: 'unknown@unitytest.internal', locale: 'en-ZA' }, '10.0.0.2'))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  it('D2. genericity is enforced by the route itself, not merely inherited from today\'s Supabase behavior', async () => {
    // Simulate a hypothetical future/alternate Supabase error unrelated to
    // rate limiting (e.g. a transient provider error) -- the response
    // shape to the caller must stay identical to the success case, never
    // distinguishing "something about this specific email failed."
    resetPasswordForEmail.mockResolvedValue({ error: { message: 'some internal provider error', status: 500 } })
    const res = await POST(req({ email: 'whatever@unitytest.internal', locale: 'en-ZA' }, '10.0.0.3'))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  it('E. a malformed email is rejected by validation, never reaching Supabase, no account disclosure', async () => {
    const res = await POST(req({ email: 'not-an-email', locale: 'en-ZA' }, '10.0.0.4'))
    expect(res.status).toBe(400)
    expect(resetPasswordForEmail).not.toHaveBeenCalled()
    const body = await res.json()
    expect(JSON.stringify(body).toLowerCase()).not.toMatch(/exist|found|registered|kyc|subscription|profile/)
  })

  describe('F/G. redirectTo is constructed only from known origin + validated locale + internal path', () => {
    it('en-ZA (unprefixed default locale)', async () => {
      await POST(req({ email: 'a@unitytest.internal', locale: 'en-ZA' }, '10.0.1.1'))
      const [, options] = resetPasswordForEmail.mock.calls[0]
      expect(options.redirectTo).toBe('http://localhost:3000/reset-password')
    })

    it('af-ZA (locale-prefixed)', async () => {
      await POST(req({ email: 'a@unitytest.internal', locale: 'af-ZA' }, '10.0.1.2'))
      const [, options] = resetPasswordForEmail.mock.calls[0]
      expect(options.redirectTo).toBe('http://localhost:3000/af/reset-password')
    })

    it('zu-ZA (locale-prefixed)', async () => {
      await POST(req({ email: 'a@unitytest.internal', locale: 'zu-ZA' }, '10.0.1.3'))
      const [, options] = resetPasswordForEmail.mock.calls[0]
      expect(options.redirectTo).toBe('http://localhost:3000/zu/reset-password')
    })

    it('an unrecognized/attacker-supplied locale value falls back to the default locale, never reflected verbatim', async () => {
      await POST(req({ email: 'a@unitytest.internal', locale: 'https://evil.example.com' }, '10.0.1.4'))
      const [, options] = resetPasswordForEmail.mock.calls[0]
      expect(options.redirectTo).toBe('http://localhost:3000/reset-password')
      expect(options.redirectTo).not.toContain('evil.example.com')
    })

    it('a missing locale value falls back to the default locale', async () => {
      await POST(req({ email: 'a@unitytest.internal' }, '10.0.1.5'))
      const [, options] = resetPasswordForEmail.mock.calls[0]
      expect(options.redirectTo).toBe('http://localhost:3000/reset-password')
    })

    it('redirectTo always starts with the known application origin and targets exactly /reset-password', async () => {
      for (const [locale, ip] of [['en-ZA', '10.0.1.6'], ['af-ZA', '10.0.1.7'], ['zu-ZA', '10.0.1.8']] as const) {
        await POST(req({ email: 'a@unitytest.internal', locale }, ip))
      }
      for (const call of resetPasswordForEmail.mock.calls) {
        const redirectTo = call[1].redirectTo as string
        expect(redirectTo.startsWith('http://localhost:3000')).toBe(true)
        expect(redirectTo).toMatch(/\/reset-password$/)
      }
    })
  })

  describe('rate limit disclosure', () => {
    it('a rate-limited response never discloses account existence, KYC, or subscription state', async () => {
      const ip = '10.0.2.1'
      let last!: Response
      for (let i = 0; i < 6; i++) {
        last = await POST(req({ email: 'a@unitytest.internal', locale: 'en-ZA' }, ip))
      }
      expect(last.status).toBe(429)
      const body = await last.json()
      expect(JSON.stringify(body).toLowerCase()).not.toMatch(/exist|found|registered|kyc|subscription|profile|account/)
    })
  })
})
