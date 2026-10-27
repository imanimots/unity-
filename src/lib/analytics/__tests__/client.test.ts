import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { trackEvent } from '../client'

/** vi.fn()'s inferred call-args tuple is `[]` for a zero-arg implementation -- this gives `.mock.calls[0][n]` a real tuple type to index into, matching how sendBeacon/fetch are actually invoked at runtime. */
function variadicMock<T>(returnValue: T) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return vi.fn((..._args: unknown[]) => returnValue)
}

describe('trackEvent -- SSR safety (category: ADMIN-CONTROL-CENTRE-BATCH-D2)', () => {
  it('1. never throws when window is undefined', () => {
    expect(() => trackEvent('page_view')).not.toThrow()
  })
})

describe('trackEvent -- browser behavior (category: ADMIN-CONTROL-CENTRE-BATCH-D2)', () => {
  function makeFakeLocalStorage() {
    const store = new Map<string, string>()
    return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) }
  }

  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: makeFakeLocalStorage(), location: { pathname: '/listings/abc' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('1. prefers navigator.sendBeacon when available, posting to /api/analytics/events', () => {
    const sendBeacon = variadicMock(true)
    vi.stubGlobal('navigator', { sendBeacon })
    trackEvent('listing_viewed', { entityType: 'listing', entityId: 'abc' })
    expect(sendBeacon).toHaveBeenCalledTimes(1)
    expect(sendBeacon.mock.calls[0]?.[0]).toBe('/api/analytics/events')
  })

  it('2. the beacon payload includes the event name, a generated eventId, and the sanitized route path -- never a raw query string', () => {
    vi.stubGlobal('window', { localStorage: makeFakeLocalStorage(), location: { pathname: '/listings' } })
    const sendBeacon = variadicMock(true)
    vi.stubGlobal('navigator', { sendBeacon })
    trackEvent('page_view')
    const blob = sendBeacon.mock.calls[0]?.[1] as Blob
    // jsdom-less environment: Blob is available via Node's global Blob (Node 18+).
    return blob.text().then((text) => {
      const payload = JSON.parse(text)
      expect(payload.eventName).toBe('page_view')
      expect(typeof payload.eventId).toBe('string')
      expect(payload.eventId.length).toBeGreaterThan(0)
      expect(payload.routePath).toBe('/listings')
    })
  })

  it('3. falls back to fetch with keepalive when sendBeacon is unavailable', async () => {
    const fetchMock = variadicMock(Promise.resolve({ ok: true }))
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('fetch', fetchMock)
    trackEvent('page_view')
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/analytics/events')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', keepalive: true })
  })

  it('4. never throws even when fetch itself throws synchronously', () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('fetch', () => { throw new Error('network down') })
    expect(() => trackEvent('page_view')).not.toThrow()
  })

  it('5. a rejected fetch promise is swallowed, never surfaced as an unhandled rejection the caller has to handle', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network down')))
    expect(() => trackEvent('page_view')).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })
})
