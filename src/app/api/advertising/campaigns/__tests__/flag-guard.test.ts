import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '../route'

/**
 * CASE 4 (backend guard): the flag check is the literal first line of the
 * route, before rate limiting, auth, or body parsing -- so this needs no
 * mocking at all to prove the guard itself. Never permanently sets
 * ADVERTISING_ENABLED=true; restored in afterEach regardless of outcome.
 */

function req() {
  return new NextRequest('http://localhost/api/advertising/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}

describe('POST /api/advertising/campaigns -- feature-flag guard (category: Fail-Closed Enforcement)', () => {
  const original = process.env.ADVERTISING_ENABLED

  afterEach(() => {
    if (original === undefined) delete process.env.ADVERTISING_ENABLED
    else process.env.ADVERTISING_ENABLED = original
  })

  it('1. flag unset (dev default): rejects with 503 before reaching auth/rate-limit/body parsing', async () => {
    delete process.env.ADVERTISING_ENABLED
    const res = await POST(req())
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({ error: 'Advertising is not currently available' })
  })

  it('2. flag set to any non-"true" value: still rejects with 503', async () => {
    process.env.ADVERTISING_ENABLED = 'TRUE'
    const res = await POST(req())
    expect(res.status).toBe(503)
  })

  it('3. flag "true": does not short-circuit at the flag guard (proceeds past it -- fails later on auth, never on the flag)', async () => {
    process.env.ADVERTISING_ENABLED = 'true'
    const res = await POST(req())
    expect(res.status).not.toBe(503)
  })
})
