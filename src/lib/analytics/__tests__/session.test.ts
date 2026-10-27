import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getOrCreateSessionId } from '../session'

// No jsdom in this project's vitest config (node environment only) --
// same documented condition as src/lib/personalization/__tests__/anonymous.test.ts.
// `window` is genuinely undefined by default here; tests that need a
// "browser" stub it explicitly with vi.stubGlobal and restore it after.

describe('getOrCreateSessionId -- SSR safety (category: ADMIN-CONTROL-CENTRE-BATCH-D2)', () => {
  it('1. never throws when window is undefined', () => {
    expect(() => getOrCreateSessionId()).not.toThrow()
  })

  it('2. still returns a non-empty string id when window is undefined (never persisted, but never crashes the caller)', () => {
    const id = getOrCreateSessionId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })
})

describe('getOrCreateSessionId -- browser behavior (category: ADMIN-CONTROL-CENTRE-BATCH-D2)', () => {
  function makeFakeLocalStorage() {
    const store = new Map<string, string>()
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    }
  }

  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: makeFakeLocalStorage() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('1. returns the same id across repeated calls within the active window (stable session)', () => {
    const first = getOrCreateSessionId()
    const second = getOrCreateSessionId()
    expect(second).toBe(first)
  })

  it('2. is a valid-looking UUID when crypto.randomUUID is available', () => {
    const id = getOrCreateSessionId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('3. rotates to a new id after the 30-minute inactivity window has elapsed', () => {
    const originalNow = Date.now
    let fakeNow = 1_000_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)

    const first = getOrCreateSessionId()
    fakeNow += 31 * 60 * 1000 // 31 minutes later -- past the 30-minute rotation window
    const second = getOrCreateSessionId()

    expect(second).not.toBe(first)
    Date.now = originalNow
  })

  it('4. does NOT rotate within the inactivity window (e.g. 10 minutes later is still the same session)', () => {
    const originalNow = Date.now
    let fakeNow = 1_000_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)

    const first = getOrCreateSessionId()
    fakeNow += 10 * 60 * 1000
    const second = getOrCreateSessionId()

    expect(second).toBe(first)
    Date.now = originalNow
  })

  it('5. never throws and still returns an id when localStorage access itself throws (private browsing / quota)', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => { throw new Error('blocked') },
        setItem: () => { throw new Error('blocked') },
      },
    })
    let id = ''
    expect(() => { id = getOrCreateSessionId() }).not.toThrow()
    expect(id.length).toBeGreaterThan(0)
  })
})
