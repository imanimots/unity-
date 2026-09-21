import { describe, it, expect, beforeAll } from 'vitest'
import nextConfig from '../../../next.config'

/**
 * Security Hardening -- Phase F, Commit A: static, network-free
 * verification of next.config.ts's headers() output. Evaluates the
 * actual exported config (through the next-intl plugin wrapper, exactly
 * as Next.js itself would) rather than re-typing the expected policy --
 * a typo or accidental duplicate/removal in next.config.ts fails these
 * assertions directly.
 */

type HeaderEntry = { key: string; value: string }
type HeaderRule = { source: string; headers: HeaderEntry[] }

let rules: HeaderRule[]

beforeAll(async () => {
  const result = await nextConfig.headers!()
  rules = result as HeaderRule[]
})

function findRule(source: string): HeaderRule {
  const rule = rules.find((r) => r.source === source)
  if (!rule) throw new Error(`No headers() rule found for source "${source}"`)
  return rule
}

function findHeader(rule: HeaderRule, key: string): string {
  const matches = rule.headers.filter((h) => h.key === key)
  expect(matches.length, `expected exactly one "${key}" header on "${rule.source}", found ${matches.length}`).toBe(1)
  return matches[0].value
}

describe('next.config.ts headers() -- existing X-Robots-Tag behavior unchanged', () => {
  it('still applies noindex to /api, /dashboard, /af/dashboard, /zu/dashboard, /admin', () => {
    for (const source of ['/api/:path*', '/dashboard/:path*', '/af/dashboard/:path*', '/zu/dashboard/:path*', '/admin/:path*']) {
      const rule = findRule(source)
      expect(findHeader(rule, 'X-Robots-Tag')).toBe('noindex, nofollow')
    }
  })
})

describe('next.config.ts headers() -- global security headers (Security Hardening Phase F)', () => {
  const globalRule = () => findRule('/:path*')

  it('CSP ships as Report-Only, not enforced', () => {
    const rule = globalRule()
    expect(rule.headers.some((h) => h.key === 'Content-Security-Policy-Report-Only')).toBe(true)
    expect(rule.headers.some((h) => h.key === 'Content-Security-Policy')).toBe(false)
  })

  it('CSP contains no bare wildcard source', () => {
    const csp = findHeader(globalRule(), 'Content-Security-Policy-Report-Only')
    // A bare "*" as a whole source token (not part of a real hostname).
    expect(/(^|[\s;])\*($|[\s;])/.test(csp)).toBe(false)
  })

  it('CSP directives each appear exactly once', () => {
    const csp = findHeader(globalRule(), 'Content-Security-Policy-Report-Only')
    const directiveNames = csp.split(';').map((d) => d.trim().split(' ')[0])
    const seen = new Set<string>()
    for (const name of directiveNames) {
      expect(seen.has(name), `duplicate CSP directive: ${name}`).toBe(false)
      seen.add(name)
    }
  })

  it('allows Supabase over HTTPS for images/media, and WSS for realtime, in connect-src', () => {
    const csp = findHeader(globalRule(), 'Content-Security-Policy-Report-Only')
    expect(csp).toContain('https://*.supabase.co')
    expect(csp).toContain('wss://*.supabase.co')
  })

  it('allows the picsum.photos placeholder image host in img-src', () => {
    const csp = findHeader(globalRule(), 'Content-Security-Policy-Report-Only')
    const imgSrc = csp.split(';').find((d) => d.trim().startsWith('img-src'))
    expect(imgSrc).toContain('https://picsum.photos')
  })

  it('object-src is none, base-uri and form-action are self, frame-ancestors is none', () => {
    const csp = findHeader(globalRule(), 'Content-Security-Policy-Report-Only')
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('sets X-Frame-Options: DENY as the active clickjacking defense during Report-Only rollout', () => {
    expect(findHeader(globalRule(), 'X-Frame-Options')).toBe('DENY')
  })

  it('sets X-Content-Type-Options: nosniff', () => {
    expect(findHeader(globalRule(), 'X-Content-Type-Options')).toBe('nosniff')
  })

  it('sets Referrer-Policy: strict-origin-when-cross-origin', () => {
    expect(findHeader(globalRule(), 'Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })

  it('sets a maximally restrictive Permissions-Policy for unused browser capabilities', () => {
    const value = findHeader(globalRule(), 'Permissions-Policy')
    for (const capability of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()', 'interest-cohort=()']) {
      expect(value).toContain(capability)
    }
  })
})

describe('next.config.ts headers() -- HSTS is production-only', () => {
  it('does not emit Strict-Transport-Security outside production (this test suite runs with NODE_ENV=test)', () => {
    const rule = findRule('/:path*')
    expect(process.env.NODE_ENV).not.toBe('production')
    expect(rule.headers.some((h) => h.key === 'Strict-Transport-Security')).toBe(false)
  })

  it('emits the expected HSTS value when NODE_ENV is production, without preload, restoring NODE_ENV immediately after', async () => {
    // NODE_ENV is typed read-only in @types/node; process.env itself is a
    // genuinely mutable object at runtime, so a narrow local cast is the
    // correct escape hatch here rather than widening the real type.
    const env = process.env as { NODE_ENV: string }
    const original = env.NODE_ENV
    try {
      // next.config.ts's headers() reads process.env.NODE_ENV at call
      // time, not at import time -- flipping it right before this one
      // call and restoring it in `finally` is sufficient, no re-import
      // needed, and leaves no lasting effect on the process or other tests.
      env.NODE_ENV = 'production'
      const result = await nextConfig.headers!()
      const rule = (result as HeaderRule[]).find((r) => r.source === '/:path*')!
      const hsts = rule.headers.find((h) => h.key === 'Strict-Transport-Security')
      expect(hsts?.value).toBe('max-age=63072000; includeSubDomains')
      expect(hsts?.value).not.toContain('preload')
    } finally {
      env.NODE_ENV = original
    }
  })
})
