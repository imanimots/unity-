import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isValidAffiliateCodeFormat,
  parseAffiliateCookie,
  serializeAffiliateCookie,
  pruneExpiredEntries,
  upsertAffiliateCookieEntry,
  getAffiliateCookieEntry,
  consumeAffiliateCookieEntry,
  readAffiliateCookieRaw,
  writeAffiliateCookieRaw,
  AFFILIATE_COOKIE_NAME,
  AFFILIATE_COOKIE_MAX_AGE_SECONDS,
} from '../cookie'

describe('isValidAffiliateCodeFormat (category: Attribution, Security)', () => {
  it('1. accepts a well-formed code', () => {
    expect(isValidAffiliateCodeFormat('AFC-9X2K')).toBe(true)
  })
  it('2. rejects a malformed code', () => {
    expect(isValidAffiliateCodeFormat('not-a-code')).toBe(false)
    expect(isValidAffiliateCodeFormat('')).toBe(false)
    expect(isValidAffiliateCodeFormat(null)).toBe(false)
    expect(isValidAffiliateCodeFormat(undefined)).toBe(false)
  })
})

describe('parseAffiliateCookie (category: Attribution, Security)', () => {
  it('3. parses a well-formed cookie payload', () => {
    const raw = serializeAffiliateCookie({ 'listing-1': { code: 'AFC-AAAA', capturedAt: '2026-08-01T00:00:00.000Z' } })
    expect(parseAffiliateCookie(raw)).toEqual({ 'listing-1': { code: 'AFC-AAAA', capturedAt: '2026-08-01T00:00:00.000Z' } })
  })
  it('4. never throws on garbage input -- returns empty object instead', () => {
    expect(parseAffiliateCookie('not json at all')).toEqual({})
    expect(parseAffiliateCookie('[]')).toEqual({})
    expect(parseAffiliateCookie('null')).toEqual({})
    expect(parseAffiliateCookie(undefined)).toEqual({})
  })
  it('5. drops an entry with a forged/malformed affiliate code rather than trusting it', () => {
    const raw = JSON.stringify({ 'listing-1': { code: 'forged-code', capturedAt: '2026-08-01T00:00:00.000Z' } })
    expect(parseAffiliateCookie(raw)).toEqual({})
  })
  it('6. drops an entry missing capturedAt', () => {
    const raw = JSON.stringify({ 'listing-1': { code: 'AFC-AAAA' } })
    expect(parseAffiliateCookie(raw)).toEqual({})
  })
})

describe('upsertAffiliateCookieEntry / getAffiliateCookieEntry (category: Attribution -- product-specific, per-listing)', () => {
  it('7. adds a new listing entry without touching an existing different listing', () => {
    const now = new Date('2026-08-01T00:00:00.000Z')
    let payload = upsertAffiliateCookieEntry({}, 'listing-A', 'AFC-AAAA', now)
    payload = upsertAffiliateCookieEntry(payload, 'listing-B', 'AFC-BBBB', now)
    expect(getAffiliateCookieEntry(payload, 'listing-A', now)?.code).toBe('AFC-AAAA')
    expect(getAffiliateCookieEntry(payload, 'listing-B', now)?.code).toBe('AFC-BBBB')
  })
  it('8. different listings may carry different affiliate codes simultaneously', () => {
    const now = new Date('2026-08-01T00:00:00.000Z')
    let payload = upsertAffiliateCookieEntry({}, 'listing-A', 'AFC-AAAA', now)
    payload = upsertAffiliateCookieEntry(payload, 'listing-B', 'AFC-CCCC', now)
    expect(Object.keys(payload)).toHaveLength(2)
  })
  it('9. caps the tracked listing count, evicting the oldest first', () => {
    const base = new Date('2026-08-01T00:00:00.000Z')
    let payload = {}
    for (let i = 0; i < 25; i++) {
      const t = new Date(base.getTime() + i * 1000)
      payload = upsertAffiliateCookieEntry(payload, `listing-${i}`, 'AFC-AAAA', t)
    }
    expect(Object.keys(payload).length).toBeLessThanOrEqual(20)
    // the earliest-captured listings should have been evicted
    expect(getAffiliateCookieEntry(payload, 'listing-0', base)).toBeNull()
  })
  it('10. an expired entry is not returned', () => {
    const capturedAt = new Date('2026-01-01T00:00:00.000Z')
    const payload = upsertAffiliateCookieEntry({}, 'listing-A', 'AFC-AAAA', capturedAt)
    const wayLater = new Date(capturedAt.getTime() + (AFFILIATE_COOKIE_MAX_AGE_SECONDS + 3600) * 1000)
    expect(getAffiliateCookieEntry(payload, 'listing-A', wayLater)).toBeNull()
  })
})

describe('pruneExpiredEntries / consumeAffiliateCookieEntry (category: Attribution)', () => {
  it('11. prunes only expired entries, keeps fresh ones', () => {
    const old = new Date('2026-01-01T00:00:00.000Z')
    const fresh = new Date('2026-08-01T00:00:00.000Z')
    const payload = {
      stale: { code: 'AFC-AAAA', capturedAt: old.toISOString() },
      recent: { code: 'AFC-BBBB', capturedAt: fresh.toISOString() },
    }
    const pruned = pruneExpiredEntries(payload, fresh)
    expect(pruned).toEqual({ recent: { code: 'AFC-BBBB', capturedAt: fresh.toISOString() } })
  })
  it('12. consuming a listing entry removes only that listing', () => {
    const now = new Date('2026-08-01T00:00:00.000Z')
    let payload = upsertAffiliateCookieEntry({}, 'listing-A', 'AFC-AAAA', now)
    payload = upsertAffiliateCookieEntry(payload, 'listing-B', 'AFC-BBBB', now)
    const consumed = consumeAffiliateCookieEntry(payload, 'listing-A')
    expect(getAffiliateCookieEntry(consumed, 'listing-A', now)).toBeNull()
    expect(getAffiliateCookieEntry(consumed, 'listing-B', now)?.code).toBe('AFC-BBBB')
  })
})

// Minimal cookie-jar stub -- real browser document.cookie semantics
// (setting one cookie upserts it into the jar without clobbering others,
// reading returns the full "name=value; name2=value2" string) rather than
// a plain string property, so this genuinely exercises
// readAffiliateCookieRaw/writeAffiliateCookieRaw's parsing/serialization,
// not just a mock returning canned data.
function installCookieJarStub() {
  const jar = new Map<string, string>()
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() {
        return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
      },
      set cookie(setString: string) {
        const [pair] = setString.split(';')
        const eq = pair.indexOf('=')
        jar.set(pair.slice(0, eq), pair.slice(eq + 1))
      },
    },
  })
  return jar
}

describe('readAffiliateCookieRaw / writeAffiliateCookieRaw (category: Attribution -- browser I/O)', () => {
  const originalDocument = globalThis.document

  beforeEach(() => {
    installCookieJarStub()
  })
  afterEach(() => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
  })

  it('13. reads null when no cookie is set', () => {
    expect(readAffiliateCookieRaw()).toBeNull()
  })

  it('14. round-trips a payload through write then read', () => {
    const now = new Date('2026-08-01T00:00:00.000Z')
    const payload = upsertAffiliateCookieEntry({}, 'listing-A', 'AFC-AAAA', now)
    writeAffiliateCookieRaw(payload)
    expect(parseAffiliateCookie(readAffiliateCookieRaw())).toEqual(payload)
  })

  it('15. writing the affiliate cookie does not clobber an unrelated cookie already present', () => {
    // Simulate an unrelated cookie already in the jar (e.g. a Supabase auth cookie).
    document.cookie = 'sb-other-cookie=some-session-value'
    writeAffiliateCookieRaw(upsertAffiliateCookieEntry({}, 'listing-A', 'AFC-AAAA', new Date()))
    expect(document.cookie).toContain('sb-other-cookie=some-session-value')
    expect(document.cookie).toContain(`${AFFILIATE_COOKIE_NAME}=`)
  })

  it('16. consuming an entry and writing back correctly drops just that listing on the next read', () => {
    const now = new Date('2026-08-01T00:00:00.000Z')
    let payload = upsertAffiliateCookieEntry({}, 'listing-A', 'AFC-AAAA', now)
    payload = upsertAffiliateCookieEntry(payload, 'listing-B', 'AFC-BBBB', now)
    writeAffiliateCookieRaw(payload)

    const readBack = parseAffiliateCookie(readAffiliateCookieRaw())
    const afterConsume = consumeAffiliateCookieEntry(readBack, 'listing-A')
    writeAffiliateCookieRaw(afterConsume)

    const final = parseAffiliateCookie(readAffiliateCookieRaw())
    expect(getAffiliateCookieEntry(final, 'listing-A', now)).toBeNull()
    expect(getAffiliateCookieEntry(final, 'listing-B', now)?.code).toBe('AFC-BBBB')
  })
})
