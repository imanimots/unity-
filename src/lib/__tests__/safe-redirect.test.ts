import { describe, it, expect } from 'vitest'
import { getSafeRedirectPath } from '../safe-redirect'

const FALLBACK = '/dashboard'

describe('getSafeRedirectPath (category: Security Hardening -- auth redirect validation)', () => {
  it('1. allows a plain app-relative path', () => {
    expect(getSafeRedirectPath('/dashboard', FALLBACK)).toBe('/dashboard')
  })

  it('2. allows a locale-prefixed app-relative path', () => {
    expect(getSafeRedirectPath('/en/dashboard', FALLBACK)).toBe('/en/dashboard')
  })

  it('3. allows a nested locale-prefixed path', () => {
    expect(getSafeRedirectPath('/zu/listings/123', FALLBACK)).toBe('/zu/listings/123')
  })

  it('4. allows the root path', () => {
    expect(getSafeRedirectPath('/', FALLBACK)).toBe('/')
  })

  it('5. rejects an absolute https URL', () => {
    expect(getSafeRedirectPath('https://evil.example', FALLBACK)).toBe(FALLBACK)
  })

  it('6. rejects an absolute http URL', () => {
    expect(getSafeRedirectPath('http://evil.example', FALLBACK)).toBe(FALLBACK)
  })

  it('7. rejects a protocol-relative URL', () => {
    expect(getSafeRedirectPath('//evil.example', FALLBACK)).toBe(FALLBACK)
  })

  it('8. rejects a javascript: pseudo-protocol', () => {
    expect(getSafeRedirectPath('javascript:alert(1)', FALLBACK)).toBe(FALLBACK)
  })

  it('9. rejects a data: URL', () => {
    expect(getSafeRedirectPath('data:text/html,test', FALLBACK)).toBe(FALLBACK)
  })

  it('10. rejects a bare hostname with no scheme and no leading slash', () => {
    expect(getSafeRedirectPath('evil.example', FALLBACK)).toBe(FALLBACK)
    expect(getSafeRedirectPath('evil.example/path', FALLBACK)).toBe(FALLBACK)
  })

  it('11. falls back for null, undefined, and empty string', () => {
    expect(getSafeRedirectPath(null, FALLBACK)).toBe(FALLBACK)
    expect(getSafeRedirectPath(undefined, FALLBACK)).toBe(FALLBACK)
    expect(getSafeRedirectPath('', FALLBACK)).toBe(FALLBACK)
  })

  it('12. rejects a backslash-normalization bypass right after the leading slash', () => {
    expect(getSafeRedirectPath('/\\evil.example', FALLBACK)).toBe(FALLBACK)
  })

  it('13. URLSearchParams already percent-decodes before this function sees it -- a decoded protocol-relative value is rejected the same as the literal form', () => {
    const decoded = decodeURIComponent('%2F%2Fevil.example')
    expect(decoded).toBe('//evil.example')
    expect(getSafeRedirectPath(decoded, FALLBACK)).toBe(FALLBACK)
  })

  it('14. preserves a locale-prefixed safe path exactly, with no normalization/trimming', () => {
    expect(getSafeRedirectPath('/af/dashboard/merchant/listings', FALLBACK)).toBe('/af/dashboard/merchant/listings')
  })

  // --- control-character normalization bypass (Security Hardening Phase C finding) ---
  //
  // The WHATWG URL spec strips ASCII tab/LF/CR anywhere in a URL before
  // parsing, so a value that merely *looks* app-relative to a naive
  // startsWith('/') check can still collapse into a protocol-relative
  // "//evil.example" once actually navigated to. These cases must be
  // rejected outright (fallback), never stripped/sanitized into a
  // different value.

  it('15. rejects a leading tab-based protocol-relative normalization bypass', () => {
    expect(getSafeRedirectPath('/\t/evil.example', FALLBACK)).toBe(FALLBACK)
  })

  it('16. rejects a leading line-feed-based protocol-relative normalization bypass', () => {
    expect(getSafeRedirectPath('/\n/evil.example', FALLBACK)).toBe(FALLBACK)
  })

  it('17. rejects a leading carriage-return-based protocol-relative normalization bypass', () => {
    expect(getSafeRedirectPath('/\r/evil.example', FALLBACK)).toBe(FALLBACK)
  })

  it('18. rejects a tab embedded later in an otherwise-safe-looking path', () => {
    expect(getSafeRedirectPath('/foo\t/bar', FALLBACK)).toBe(FALLBACK)
  })

  it('19. rejects a line feed embedded later in an otherwise-safe-looking path', () => {
    expect(getSafeRedirectPath('/foo\n/bar', FALLBACK)).toBe(FALLBACK)
  })

  it('20. rejects a carriage return embedded later in an otherwise-safe-looking path', () => {
    expect(getSafeRedirectPath('/foo\r/bar', FALLBACK)).toBe(FALLBACK)
  })

  it('21. rejects the percent-decoded form of a tab-based bypass -- URLSearchParams decodes %09 to a literal tab before this function ever sees it', () => {
    const decoded = decodeURIComponent('/%09/evil.example')
    expect(decoded).toBe('/\t/evil.example')
    expect(getSafeRedirectPath(decoded, FALLBACK)).toBe(FALLBACK)
  })

  it('22. rejects the percent-decoded form of an LF-based bypass', () => {
    const decoded = decodeURIComponent('/%0A/evil.example')
    expect(decoded).toBe('/\n/evil.example')
    expect(getSafeRedirectPath(decoded, FALLBACK)).toBe(FALLBACK)
  })

  it('23. rejects the percent-decoded form of a CR-based bypass', () => {
    const decoded = decodeURIComponent('/%0D/evil.example')
    expect(decoded).toBe('/\r/evil.example')
    expect(getSafeRedirectPath(decoded, FALLBACK)).toBe(FALLBACK)
  })

  it('24. still allows a legitimate path with no control characters after the fix', () => {
    expect(getSafeRedirectPath('/dashboard/merchant', FALLBACK)).toBe('/dashboard/merchant')
  })
})
