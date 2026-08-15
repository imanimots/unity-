import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'

const bodySchema = z.object({
  campaignId: z.string().uuid(),
  impressionId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
})

/**
 * POST /api/advertising/click -- public (anonymous browsing is allowed
 * per the marketplace's own existing design), resolves the destination
 * SERVER-SIDE only (no open redirect -- the client never supplies an
 * arbitrary destination). Clicks are analytics-only, never billable.
 */
export async function POST(request: NextRequest) {
  const rate = checkRateLimit(`advertising:click:${getClientKey(request)}`, 60, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }
  const { createClient } = await import('@supabase/supabase-js')
  const admin = createClient(url, serviceKey)

  const requester = await getRequestProfile()
  const reachKey = requester ? `viewer:${requester.userId}` : `anon:${randomUUID()}`

  const { data, error } = await admin.rpc('record_ad_click', {
    p_campaign_id: parsed.data.campaignId,
    p_impression_id: parsed.data.impressionId ?? null,
    p_viewer_id: requester?.userId ?? null,
    p_reach_key: reachKey,
    p_idempotency_key: parsed.data.idempotencyKey ?? null,
  })

  if (error) {
    console.error('[advertising.click] RPC error', { campaignId: parsed.data.campaignId, error })
    return NextResponse.json({ error: 'Could not record click' }, { status: 400 })
  }

  return NextResponse.json(data)
}
