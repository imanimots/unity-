import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose'
import {
  hasCronAuthConfigured,
  isAuthorizedCronRequest,
  isAuthorizedGcpSchedulerRequest,
  setGcpSchedulerJwksForTests,
  resetGcpSchedulerVerifierForTests,
} from '../auth'

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

/**
 * P5D-GCP-AUTH-I: GCP Cloud Scheduler OIDC path. Every token here is
 * signed locally against a test-only RSA key pair and verified through
 * a locally-injected JWKS (setGcpSchedulerJwksForTests) -- no test in
 * this block makes a network request to Google at all.
 */
describe('isAuthorizedGcpSchedulerRequest (category: P5D-GCP-AUTH-I)', () => {
  const AUDIENCE_ORIGIN = 'https://unity-nine-iota.vercel.app'
  const EXPECTED_SUB = '109876543210987654321'
  const ROUTE_A_URL = `${AUDIENCE_ORIGIN}/api/internal/expire-unpaid-bookings`
  const ROUTE_B_URL = `${AUDIENCE_ORIGIN}/api/internal/email/retry-failed`

  let privateKeyA: CryptoKey
  let legitimateJwksRoute: ReturnType<typeof createLocalJWKSet>
  let attackerPrivateKey: CryptoKey

  function gcpReq(url: string, authHeader?: string): Request {
    const headers = new Headers()
    if (authHeader !== undefined) headers.set('authorization', authHeader)
    return new Request(url, { headers })
  }

  async function signToken(
    privateKey: CryptoKey,
    overrides: Partial<{ iss: string; aud: string; sub: string; azp: string | undefined; expiresInSeconds: number }> = {}
  ): Promise<string> {
    const {
      iss = 'https://accounts.google.com',
      aud = ROUTE_A_URL,
      sub = EXPECTED_SUB,
      azp = EXPECTED_SUB,
      expiresInSeconds = 3600,
    } = overrides
    const jwt = new SignJWT({ ...(azp !== undefined ? { azp } : {}) })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    return jwt.sign(privateKey)
  }

  beforeEach(async () => {
    delete process.env.INTERNAL_CRON_SECRET
    delete process.env.CRON_SECRET
    delete process.env.GCP_SCHEDULER_SERVICE_ACCOUNT_SUB
    delete process.env.GCP_SCHEDULER_AUDIENCE_ORIGIN
    resetGcpSchedulerVerifierForTests()

    const { privateKey, publicKey } = await generateKeyPair('RS256')
    privateKeyA = privateKey
    const jwk = await exportJWK(publicKey)
    jwk.alg = 'RS256'
    jwk.kid = 'test-key-1'
    legitimateJwksRoute = createLocalJWKSet({ keys: [jwk] })

    const attacker = await generateKeyPair('RS256')
    attackerPrivateKey = attacker.privateKey

    process.env.GCP_SCHEDULER_SERVICE_ACCOUNT_SUB = EXPECTED_SUB
    process.env.GCP_SCHEDULER_AUDIENCE_ORIGIN = AUDIENCE_ORIGIN
    setGcpSchedulerJwksForTests(legitimateJwksRoute)
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    resetGcpSchedulerVerifierForTests()
  })

  it('A. a valid token with correct signature, issuer, route audience, sub, azp, and expiry authorizes', async () => {
    const token = await signToken(privateKeyA)
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${token}`))).toBe(true)
  })

  it('rejects a token with the wrong signature (different key pair, otherwise identical claims)', async () => {
    const token = await signToken(attackerPrivateKey)
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${token}`))).toBe(false)
  })

  it('rejects a token with the wrong issuer', async () => {
    const token = await signToken(privateKeyA, { iss: 'https://evil.example.com' })
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${token}`))).toBe(false)
  })

  it('rejects a token whose audience does not match this route at all', async () => {
    const token = await signToken(privateKeyA, { aud: 'https://not-unity.example.com/api/internal/expire-unpaid-bookings' })
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${token}`))).toBe(false)
  })

  it('cross-route replay: a token minted for route A is rejected when presented to route B', async () => {
    const tokenForRouteA = await signToken(privateKeyA, { aud: ROUTE_A_URL })
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_B_URL, `Bearer ${tokenForRouteA}`))).toBe(false)
  })

  it('rejects a token with the wrong subject (a different, non-allowlisted service account)', async () => {
    const token = await signToken(privateKeyA, { sub: 'some-other-service-account-id', azp: 'some-other-service-account-id' })
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${token}`))).toBe(false)
  })

  it('rejects a token whose azp does not match the expected subject, even if sub is correct', async () => {
    const token = await signToken(privateKeyA, { sub: EXPECTED_SUB, azp: 'some-other-authorized-party' })
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${token}`))).toBe(false)
  })

  it('accepts a token with no azp claim at all, relying on sub alone', async () => {
    const token = await signToken(privateKeyA, { azp: undefined })
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${token}`))).toBe(true)
  })

  it('rejects an expired token', async () => {
    const token = await signToken(privateKeyA, { expiresInSeconds: -60 })
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${token}`))).toBe(false)
  })

  it('rejects a malformed JWT (not three valid base64url segments)', async () => {
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, 'Bearer not.a.valid.jwt.at.all'))).toBe(false)
  })

  it('rejects a request with no Authorization header at all', async () => {
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL))).toBe(false)
  })

  it('rejects a request with a malformed Bearer scheme', async () => {
    const token = await signToken(privateKeyA)
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Basic ${token}`))).toBe(false)
  })

  it('fails closed when GCP_SCHEDULER_SERVICE_ACCOUNT_SUB is not configured', async () => {
    delete process.env.GCP_SCHEDULER_SERVICE_ACCOUNT_SUB
    const token = await signToken(privateKeyA)
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${token}`))).toBe(false)
  })

  it('fails closed when GCP_SCHEDULER_AUDIENCE_ORIGIN is not configured', async () => {
    delete process.env.GCP_SCHEDULER_AUDIENCE_ORIGIN
    const token = await signToken(privateKeyA)
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${token}`))).toBe(false)
  })

  it('fails closed when GCP_SCHEDULER_AUDIENCE_ORIGIN is malformed (has a path, credentials, query, or non-https scheme)', async () => {
    const token = await signToken(privateKeyA)
    for (const bad of [
      'http://unity-nine-iota.vercel.app',
      'https://user:pass@unity-nine-iota.vercel.app',
      'https://unity-nine-iota.vercel.app/some/path',
      'https://unity-nine-iota.vercel.app?x=1',
      'not-a-url',
    ]) {
      process.env.GCP_SCHEDULER_AUDIENCE_ORIGIN = bad
      expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${token}`))).toBe(false)
    }
  })

  it('rejects when JWKS verification fails for an unrelated reason (no matching key in the injected JWKS)', async () => {
    setGcpSchedulerJwksForTests(createLocalJWKSet({ keys: [] }))
    const token = await signToken(privateKeyA)
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${token}`))).toBe(false)
  })

  it('rejects an HS256 algorithm-confusion token even if it carries all the right claims', async () => {
    const hsToken = await new SignJWT({ azp: EXPECTED_SUB })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('https://accounts.google.com')
      .setAudience(ROUTE_A_URL)
      .setSubject(EXPECTED_SUB)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode('any-arbitrary-shared-secret'))
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${hsToken}`))).toBe(false)
  })

  it('rejects an unsigned ("none" algorithm) token', async () => {
    // jose refuses to even construct a "none"-alg JWT via SignJWT's normal
    // signing path, so this is assembled by hand to prove the verifier
    // rejects it rather than relying on the signer's own refusal.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ iss: 'https://accounts.google.com', aud: ROUTE_A_URL, sub: EXPECTED_SUB, azp: EXPECTED_SUB, exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url')
    const unsigned = `${header}.${payload}.`
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, `Bearer ${unsigned}`))).toBe(false)
  })

  it('B. existing static-secret authorization is unaffected by GCP configuration or verification outcome', () => {
    process.env.INTERNAL_CRON_SECRET = 'internal-secret'
    expect(isAuthorizedCronRequest(gcpReq(ROUTE_A_URL, 'Bearer internal-secret'))).toBe(true)
  })

  it('13. precedence: valid static-secret authorization succeeds even when GCP config is entirely absent', async () => {
    delete process.env.GCP_SCHEDULER_SERVICE_ACCOUNT_SUB
    delete process.env.GCP_SCHEDULER_AUDIENCE_ORIGIN
    process.env.CRON_SECRET = 'vercel-secret'
    const staticOk = isAuthorizedCronRequest(gcpReq(ROUTE_A_URL, 'Bearer vercel-secret'))
    expect(staticOk).toBe(true)
    // The route-level pattern short-circuits on a true static check and
    // never calls the async verifier at all; demonstrate that even if it
    // were called, it would safely fail closed with config absent.
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, 'Bearer vercel-secret'))).toBe(false)
  })

  it('14. precedence: valid static-secret authorization succeeds even when a present OIDC token would independently fail verification', async () => {
    process.env.INTERNAL_CRON_SECRET = 'internal-secret'
    // A request can only carry one Authorization header; this proves the
    // static check alone is sufficient when it matches, regardless of
    // what the (here, deliberately malformed) OIDC path would decide.
    expect(isAuthorizedCronRequest(gcpReq(ROUTE_A_URL, 'Bearer internal-secret'))).toBe(true)
    expect(await isAuthorizedGcpSchedulerRequest(gcpReq(ROUTE_A_URL, 'Bearer internal-secret'))).toBe(false)
  })
})
