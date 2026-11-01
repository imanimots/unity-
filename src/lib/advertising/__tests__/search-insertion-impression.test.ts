import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * E9-F1 regression coverage for getSponsoredListingSlot()'s impression
 * path -- previously untested (only spliceSponsoredListing() had
 * coverage). record_ad_impression is now SERVER-ONLY (direct anon/
 * authenticated EXECUTE was revoked at the DB level because it let any
 * Data API caller manufacture unlimited impressions at zero cost); this
 * file proves the application side of that fix: the impression RPC is
 * invoked via a service-role client (never the session client), is
 * rate-limited per client IP first, and is given a fresh per-call
 * idempotency key.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'
process.env.ADVERTISING_ENABLED = 'true'

const headersMock = vi.fn()
vi.mock('next/headers', () => ({
  headers: () => headersMock(),
}))

const checkRateLimitMock = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}))

const serviceRpcMock = vi.fn()
const createServiceClientMock = vi.fn((..._args: unknown[]) => ({ rpc: serviceRpcMock }))
vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => createServiceClientMock(...args),
}))

const { getSponsoredListingSlot } = await import('../search-insertion')

const ELIGIBLE_AD_ROW = {
  campaign_id: 'campaign-1',
  target_type: 'listing',
  listing_id: 'listing-1',
  marketplace_request_id: null,
  barter_skill_task_post_id: null,
}

function sessionClient(eligibleAdsResult: { data: unknown; error: unknown } = { data: [ELIGIBLE_AD_ROW], error: null }) {
  const rpc = vi.fn().mockResolvedValue(eligibleAdsResult)
  return { client: { rpc } as unknown as import('@supabase/supabase-js').SupabaseClient, rpc }
}

beforeEach(() => {
  headersMock.mockReset().mockReturnValue({ get: (name: string) => (name === 'x-forwarded-for' ? '203.0.113.5' : null) })
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, remaining: 59 })
  serviceRpcMock.mockReset().mockResolvedValue({ data: { recorded: true, impression_id: 'imp-1', countable: true }, error: null })
  createServiceClientMock.mockClear()
})

describe('getSponsoredListingSlot() impression recording (category: ADMIN-CONTROL-CENTRE-BATCH-E9-F1)', () => {
  it('1. records the impression via a service-role client, never the session client', async () => {
    const { client, rpc: sessionRpc } = sessionClient()
    await getSponsoredListingSlot(client, {}, [], null)

    expect(createServiceClientMock).toHaveBeenCalledWith('https://fake-project.supabase.co', 'fake-service-role-key')
    expect(serviceRpcMock).toHaveBeenCalledWith('record_ad_impression', expect.objectContaining({ p_campaign_id: 'campaign-1' }))
    // get_eligible_ads is still the session client's call -- only the impression write moved.
    expect(sessionRpc).toHaveBeenCalledWith('get_eligible_ads', expect.any(Object))
    expect(sessionRpc).not.toHaveBeenCalledWith('record_ad_impression', expect.anything())
  })

  it('2. passes a fresh, non-empty idempotency key with the impression call', async () => {
    const { client } = sessionClient()
    await getSponsoredListingSlot(client, {}, [], null)

    const call = serviceRpcMock.mock.calls.find((c) => c[0] === 'record_ad_impression')
    expect(call).toBeTruthy()
    const key = call?.[1]?.p_idempotency_key
    expect(typeof key).toBe('string')
    expect(key.length).toBeGreaterThan(0)
  })

  it('3. two separate calls to getSponsoredListingSlot() generate two different idempotency keys -- each real serving decision gets its own key, never a reused/predictable one', async () => {
    const { client: client1 } = sessionClient()
    const { client: client2 } = sessionClient()
    await getSponsoredListingSlot(client1, {}, [], null)
    await getSponsoredListingSlot(client2, {}, [], null)

    const keys = serviceRpcMock.mock.calls.filter((c) => c[0] === 'record_ad_impression').map((c) => c[1]?.p_idempotency_key)
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })

  it('4. passes the caller-supplied viewerId through unchanged -- it is already session-verified by the caller before reaching this function', async () => {
    const { client } = sessionClient()
    await getSponsoredListingSlot(client, {}, [], 'viewer-42')

    expect(serviceRpcMock).toHaveBeenCalledWith('record_ad_impression', expect.objectContaining({ p_viewer_id: 'viewer-42' }))
  })

  it('5. anonymous callers (viewerId null) pass p_viewer_id: null and a reach_key starting with "anon:"', async () => {
    const { client } = sessionClient()
    await getSponsoredListingSlot(client, {}, [], null)

    const call = serviceRpcMock.mock.calls.find((c) => c[0] === 'record_ad_impression')
    expect(call?.[1]).toMatchObject({ p_viewer_id: null })
    expect(call?.[1]?.p_reach_key).toMatch(/^anon:/)
  })

  it('6. rate-limits per client IP (x-forwarded-for) before ever calling record_ad_impression -- when exceeded, no ad is shown and no RPC is attempted', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0 })
    const { client } = sessionClient()

    const result = await getSponsoredListingSlot(client, {}, [], null)

    expect(result).toBeNull()
    expect(serviceRpcMock).not.toHaveBeenCalled()
    expect(checkRateLimitMock).toHaveBeenCalledWith(expect.stringContaining('203.0.113.5'), expect.any(Number), expect.any(Number))
  })

  it('7. falls back to "unknown" as the rate-limit key component when x-forwarded-for is absent, rather than throwing', async () => {
    headersMock.mockReturnValue({ get: () => null })
    const { client } = sessionClient()

    await getSponsoredListingSlot(client, {}, [], null)

    expect(checkRateLimitMock).toHaveBeenCalledWith(expect.stringContaining('unknown'), expect.any(Number), expect.any(Number))
  })

  it('8. when service-role credentials are not configured, silently returns null (no ad shown) rather than throwing or falling back to the session client', async () => {
    const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    const { client } = sessionClient()

    const result = await getSponsoredListingSlot(client, {}, [], null)

    expect(result).toBeNull()
    expect(serviceRpcMock).not.toHaveBeenCalled()
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
  })

  it('9. when record_ad_impression reports recorded: false (e.g. the campaign became ineligible between selection and recording), returns null -- never shows an ad Unity cannot account for', async () => {
    serviceRpcMock.mockResolvedValue({ data: { recorded: false, reason: 'quota_exhausted' }, error: null })
    const { client } = sessionClient()

    const result = await getSponsoredListingSlot(client, {}, [], null)

    expect(result).toBeNull()
  })

  it('10. when get_eligible_ads returns no eligible candidate, returns null without ever attempting a rate-limit check or impression recording', async () => {
    const { client } = sessionClient({ data: [], error: null })

    const result = await getSponsoredListingSlot(client, {}, [], null)

    expect(result).toBeNull()
    expect(checkRateLimitMock).not.toHaveBeenCalled()
    expect(serviceRpcMock).not.toHaveBeenCalled()
  })

  it('11. when advertising is disabled, returns null immediately without touching rate-limiting, headers, or either Supabase client', async () => {
    process.env.ADVERTISING_ENABLED = 'false'
    const { client, rpc } = sessionClient()

    const result = await getSponsoredListingSlot(client, {}, [], null)

    expect(result).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
    expect(checkRateLimitMock).not.toHaveBeenCalled()
    process.env.ADVERTISING_ENABLED = 'true'
  })
})
