import { describe, it, expect, vi, afterEach } from 'vitest'
import { requestAffiliateToggle } from '../toggle-client'

const FALLBACK = 'Could not update this listing\'s affiliate setting'

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

describe('requestAffiliateToggle (category: Failure Handling)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('1. success: ok:true, no error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { id: 'listing-1', accepts_affiliates: true })))
    const result = await requestAffiliateToggle('listing-1', true, FALLBACK)
    expect(result).toEqual({ ok: true })
  })

  it('2. RPC/API explicit error: ok:false, surfaces the server-provided message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(403, { error: 'Only Pro/Elite merchants can accept affiliates.' })))
    const result = await requestAffiliateToggle('listing-1', true, FALLBACK)
    expect(result).toEqual({ ok: false, error: 'Only Pro/Elite merchants can accept affiliates.' })
  })

  it('3. RPC/API error response with no parseable body: falls back to the generic message, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('not json') } } as unknown as Response))
    const result = await requestAffiliateToggle('listing-1', true, FALLBACK)
    expect(result).toEqual({ ok: false, error: FALLBACK })
  })

  it('4. network failure: fetch() itself rejects -> caught, ok:false, generic message (never uncaught)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const result = await requestAffiliateToggle('listing-1', true, FALLBACK)
    expect(result).toEqual({ ok: false, error: FALLBACK })
  })

  it('5. never returns ok:true on any failure path (success requires a genuine res.ok response)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(400, { error: 'bad request' })))
    const result = await requestAffiliateToggle('listing-1', false, FALLBACK)
    expect(result.ok).toBe(false)
  })

  it('6. calls the enable/disable route matching the requested direction', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)
    await requestAffiliateToggle('listing-42', false, FALLBACK)
    expect(fetchMock).toHaveBeenCalledWith('/api/listings/listing-42/affiliate/disable', expect.objectContaining({ method: 'POST' }))
    await requestAffiliateToggle('listing-42', true, FALLBACK)
    expect(fetchMock).toHaveBeenCalledWith('/api/listings/listing-42/affiliate/enable', expect.objectContaining({ method: 'POST' }))
  })
})
