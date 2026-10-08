/**
 * Shared cron-authentication authority for every internal scheduled
 * route (P4 -- Production Operations: Scheduled Job Activation).
 *
 * Behaviorally mirrors the exact dual-secret contract already proven
 * live by src/app/api/internal/reviews/process-deadlines/route.ts --
 * that route keeps its own inline copy (a parked file, untouched by
 * this module); this factors the SAME behavior out once so the other
 * 17 internal routes don't each duplicate it.
 *
 * Two independent secrets, either one authorizes a request:
 * - CRON_SECRET -- Vercel Cron's own platform-fixed env var name (not
 *   renameable, not configurable via vercel.json). Once set on the
 *   project, Vercel automatically attaches `Authorization: Bearer
 *   <value>` to every scheduled invocation, which Vercel Cron always
 *   issues via GET.
 * - INTERNAL_CRON_SECRET -- this codebase's pre-existing convention for
 *   manual/curl invocation, unchanged from every internal route's
 *   original contract (see docs/PUBLIC_TEST_RUNBOOK.md).
 *
 * Fails closed if neither secret is configured server-side -- never
 * treats an unconfigured secret as authorization. Never accepts a
 * query-string secret. Never logs, echoes, or otherwise exposes which
 * secret matched or any secret material. Pure function of the request
 * + environment -- no database/network access, matching the existing
 * Reviews implementation's own scope exactly.
 */
export function hasCronAuthConfigured(): boolean {
  return Boolean(process.env.INTERNAL_CRON_SECRET || process.env.CRON_SECRET)
}

export function isAuthorizedCronRequest(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false

  const internalSecret = process.env.INTERNAL_CRON_SECRET
  const vercelCronSecret = process.env.CRON_SECRET
  if (!internalSecret && !vercelCronSecret) return false

  if (internalSecret && authHeader === `Bearer ${internalSecret}`) return true
  if (vercelCronSecret && authHeader === `Bearer ${vercelCronSecret}`) return true
  return false
}

/**
 * Google Cloud Scheduler OIDC authentication (P5D-GCP-AUTH-I).
 *
 * A second, independent way to authorize an internal cron request,
 * additive to -- never a replacement for -- the static-secret contract
 * above. Every eligible route checks isAuthorizedCronRequest() FIRST and
 * only falls through to this (async, network-involving) check if that
 * synchronous, zero-dependency check fails -- existing CRON_SECRET and
 * INTERNAL_CRON_SECRET callers are completely unaffected by anything in
 * this section, including total absence of the two env vars below.
 *
 * Cloud Scheduler sends its OIDC ID token in the exact same header this
 * module already parses: `Authorization: Bearer <id_token>`. The token
 * is RS256-signed by Google and verified here against Google's own
 * live JWKS -- never hand-rolled RSA verification.
 *
 * Identity is checked via immutable claims only (sub, azp), never via
 * `email`/`email_verified`/`hd` -- those are user-account-shaped claims
 * that may not even be present on a service-account ID token, and this
 * verifier must never assume they are.
 *
 * Audience is constructed from a TRUSTED, configured origin
 * (GCP_SCHEDULER_AUDIENCE_ORIGIN) plus the actual pathname Next.js
 * already used to route to this exact handler (request.url's path
 * component -- not a spoofable header, it's how the request reached
 * this code in the first place). This ties every token to exactly the
 * one route it was minted for: a token issued for
 * `/api/internal/expire-unpaid-bookings` is cryptographically rejected
 * by every other route, since its `aud` claim will never match their
 * own constructed audience.
 *
 * Fails closed in every branch: missing configuration, malformed
 * configured origin, missing/malformed Authorization header, JWKS fetch
 * failure, wrong algorithm, wrong issuer, wrong audience, wrong
 * subject/authorized-party, expired token, or any other verification
 * error all resolve to `false` -- never an exception escapes to the
 * caller, and never does an unverifiable token default to authorized.
 */

const GOOGLE_OIDC_ISSUER = 'https://accounts.google.com'
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

type JwksKeyResolver = Parameters<typeof import('jose').jwtVerify>[1]

/**
 * The active key resolver, swappable only via setGcpSchedulerJwksForTests()
 * below. Production code path never touches this directly -- it always
 * goes through resolveJwks(), which lazily constructs the real remote
 * Google JWKS fetcher on first use and never at module load.
 */
let activeJwks: JwksKeyResolver | undefined
let testJwksOverride: JwksKeyResolver | undefined

async function resolveJwks(): Promise<JwksKeyResolver> {
  if (testJwksOverride) return testJwksOverride
  if (!activeJwks) {
    const { createRemoteJWKSet } = await import('jose')
    activeJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL))
  }
  return activeJwks
}

/** Test-only: injects a local (non-network) JWKS resolver, e.g. from jose's createLocalJWKSet() built against a locally-generated test key pair. Never used by production code paths. */
export function setGcpSchedulerJwksForTests(resolver: JwksKeyResolver): void {
  testJwksOverride = resolver
}

/** Test-only: clears any injected test resolver, restoring the real (lazily-constructed) Google remote JWKS for subsequent calls. Never used by production code paths. */
export function resetGcpSchedulerVerifierForTests(): void {
  testJwksOverride = undefined
  activeJwks = undefined
}

/**
 * Normalizes the configured trusted audience origin: https only, no
 * credentials, no query, no fragment, no path, no trailing slash. Any
 * deviation is treated as misconfiguration -- fails closed rather than
 * guessing at the operator's intent.
 */
function parseTrustedAudienceOrigin(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  return `${url.protocol}//${url.host}`
}

export async function isAuthorizedGcpSchedulerRequest(request: Request): Promise<boolean> {
  const authHeader = request.headers.get('authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false
  const token = authHeader.slice('Bearer '.length)
  if (!token) return false

  const expectedSub = process.env.GCP_SCHEDULER_SERVICE_ACCOUNT_SUB
  const audienceOriginRaw = process.env.GCP_SCHEDULER_AUDIENCE_ORIGIN
  if (!expectedSub || !audienceOriginRaw) return false

  const trustedOrigin = parseTrustedAudienceOrigin(audienceOriginRaw)
  if (!trustedOrigin) return false

  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return false
  }
  const expectedAudience = `${trustedOrigin}${pathname}`

  try {
    const jwks = await resolveJwks()
    const { jwtVerify } = await import('jose')
    const { payload } = await jwtVerify(token, jwks, {
      issuer: GOOGLE_OIDC_ISSUER,
      audience: expectedAudience,
      algorithms: ['RS256'],
    })

    if (payload.sub !== expectedSub) return false
    // azp (authorized party) is present on most Google-issued service
    // account ID tokens; if present, it must also match -- if absent,
    // sub alone (already checked) is the authoritative identity claim.
    if (payload.azp !== undefined && payload.azp !== expectedSub) return false

    return true
  } catch {
    return false
  }
}
