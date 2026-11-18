import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const SECRET = 'test-internal-cron-secret'

let rpcResult: { data: unknown; error?: unknown }
const rpc = vi.fn(() => Promise.resolve(rpcResult))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc }) }))

const { POST } = await import('../route')

function req(auth?: string) {
  return new NextRequest('http://localhost/api/internal/analytics/purge-events', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  rpcResult = { data: 0, error: null }
  rpc.mockClear()
  process.env.INTERNAL_CRON_SECRET = SECRET
})

describe('POST /api/internal/analytics/purge-events', () => {
  it('no secret configured -> 503', async () => {
    delete process.env.INTERNAL_CRON_SECRET
    delete process.env.CRON_SECRET
    const res = await POST(req(`Bearer ${SECRET}`))
    expect(res.status).toBe(503)
  })

  it('missing authorization -> 401', async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
  })

  it('wrong secret -> 401', async () => {
    const res = await POST(req('Bearer nope'))
    expect(res.status).toBe(401)
  })

  it('correct secret -> calls cleanup_analytics_events and returns the deleted count', async () => {
    rpcResult = { data: 42, error: null }
    const res = await POST(req(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('cleanup_analytics_events')
    const body = await res.json()
    expect(body).toEqual({ deleted_count: 42 })
  })

  it('RPC error -> 500, sanitized (never echoes the raw DB error)', async () => {
    rpcResult = { data: null, error: { message: 'permission denied for function cleanup_analytics_events' } }
    const res = await POST(req(`Bearer ${SECRET}`))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toMatch(/permission denied/i)
  })
})
