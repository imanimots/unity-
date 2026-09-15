import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { hasCronAuthConfigured, isAuthorizedCronRequest } from '../auth'

const ORIGINAL_ENV = { ...process.env }

function req(authHeader?: string): Request {
  const headers = new Headers()
  if (authHeader !== undefined) headers.set('authorization', authHeader)
  return new Request('https://example.test/api/internal/whatever', { headers })
}

describe('internal-cron auth (category: P4 shared cron authority)', () => {
  beforeEach(() => {
    delete process.env.INTERNAL_CRON_SECRET
    delete process.env.CRON_SECRET
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('1. valid native cron GET with a valid CRON_SECRET is authorized', () => {
    process.env.CRON_SECRET = 'vercel-secret'
    expect(isAuthorizedCronRequest(req('Bearer vercel-secret'))).toBe(true)
  })

  it('2. an invalid CRON_SECRET is rejected', () => {
    process.env.CRON_SECRET = 'vercel-secret'
    expect(isAuthorizedCronRequest(req('Bearer wrong-value'))).toBe(false)
  })

  it('3. a GET with no Authorization header at all is rejected', () => {
    process.env.CRON_SECRET = 'vercel-secret'
    expect(isAuthorizedCronRequest(req())).toBe(false)
  })

  it('4. a malformed Bearer header (wrong scheme, missing space, wrong case) is rejected', () => {
    process.env.CRON_SECRET = 'vercel-secret'
    expect(isAuthorizedCronRequest(req('Basic vercel-secret'))).toBe(false)
    expect(isAuthorizedCronRequest(req('Bearervercel-secret'))).toBe(false)
    expect(isAuthorizedCronRequest(req('bearer vercel-secret'))).toBe(false)
  })

  it('5. no request can be authorized when CRON_SECRET is not configured, even with a POST-side secret set', () => {
    process.env.INTERNAL_CRON_SECRET = 'internal-secret'
    // No CRON_SECRET configured -- a request presenting a CRON_SECRET-shaped
    // bearer token can never match, since none is configured to compare against.
    expect(isAuthorizedCronRequest(req('Bearer some-vercel-value'))).toBe(false)
    expect(hasCronAuthConfigured()).toBe(true) // still true -- INTERNAL_CRON_SECRET is configured
  })

  it('6. valid internal POST with a valid INTERNAL_CRON_SECRET is authorized', () => {
    process.env.INTERNAL_CRON_SECRET = 'internal-secret'
    expect(isAuthorizedCronRequest(req('Bearer internal-secret'))).toBe(true)
  })

  it('7. an invalid INTERNAL_CRON_SECRET is rejected', () => {
    process.env.INTERNAL_CRON_SECRET = 'internal-secret'
    expect(isAuthorizedCronRequest(req('Bearer wrong-value'))).toBe(false)
  })

  it('8. when INTERNAL_CRON_SECRET is not configured (and neither is CRON_SECRET), every request is rejected and hasCronAuthConfigured() is false', () => {
    expect(hasCronAuthConfigured()).toBe(false)
    expect(isAuthorizedCronRequest(req('Bearer anything'))).toBe(false)
  })

  it('9. the authorization result never carries or exposes the secret value -- return type is a plain boolean', () => {
    process.env.INTERNAL_CRON_SECRET = 'internal-secret'
    const result = isAuthorizedCronRequest(req('Bearer internal-secret'))
    expect(typeof result).toBe('boolean')
    expect(result).toBe(true)
  })

  it('10. either configured secret independently authorizes a request -- both can be set at once without conflict', () => {
    process.env.INTERNAL_CRON_SECRET = 'internal-secret'
    process.env.CRON_SECRET = 'vercel-secret'
    expect(isAuthorizedCronRequest(req('Bearer internal-secret'))).toBe(true)
    expect(isAuthorizedCronRequest(req('Bearer vercel-secret'))).toBe(true)
    expect(isAuthorizedCronRequest(req('Bearer neither-of-these'))).toBe(false)
  })

  it('11. an empty Bearer token (trailing space, no value) is rejected even if a secret is configured', () => {
    process.env.INTERNAL_CRON_SECRET = 'internal-secret'
    expect(isAuthorizedCronRequest(req('Bearer '))).toBe(false)
  })

  it('12. hasCronAuthConfigured() fails closed with neither secret set, and reflects either being set', () => {
    expect(hasCronAuthConfigured()).toBe(false)
    process.env.INTERNAL_CRON_SECRET = 'x'
    expect(hasCronAuthConfigured()).toBe(true)
    delete process.env.INTERNAL_CRON_SECRET
    process.env.CRON_SECRET = 'y'
    expect(hasCronAuthConfigured()).toBe(true)
  })
})
