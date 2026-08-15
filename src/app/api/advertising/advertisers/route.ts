import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { isAdvertisingEnabled } from '@/lib/advertising/config'

const bodySchema = z.object({
  advertiserType: z.enum(['unity', 'external']),
  displayName: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
})

/** POST /api/advertising/advertisers -- create the caller's own advertiser account. */
export async function POST(request: NextRequest) {
  if (!isAdvertisingEnabled()) {
    return NextResponse.json({ error: 'Advertising is not currently available' }, { status: 503 })
  }

  const rate = checkRateLimit(`advertising:advertisers:create:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
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

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('create_ad_advertiser', {
    p_owner_profile_id: requester.userId,
    p_advertiser_type: parsed.data.advertiserType,
    p_display_name: parsed.data.displayName,
    p_is_test: false,
    p_idempotency_key: parsed.data.idempotencyKey ?? null,
  })

  if (error) {
    console.error('[advertising.advertisers.create] RPC error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not create advertiser account' }, { status: 400 })
  }

  return NextResponse.json(data, { status: 201 })
}

/** GET /api/advertising/advertisers -- the caller's own advertiser accounts, with their (non-withdrawable) Advertising Balance. */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.from('ad_advertisers').select('*').eq('owner_profile_id', requester.userId).order('created_at', { ascending: false })
  if (error) {
    return NextResponse.json({ error: 'Could not load advertiser accounts' }, { status: 500 })
  }

  const advertisers = data ?? []
  const advertiserIds = advertisers.map((a) => a.id)
  const balanceByAdvertiser = new Map<string, { balance_cents: number; currency: string }>()
  if (advertiserIds.length > 0) {
    const { data: balances } = await admin.from('ad_balance_accounts').select('advertiser_id, balance_cents, currency').in('advertiser_id', advertiserIds)
    for (const b of balances ?? []) {
      balanceByAdvertiser.set(b.advertiser_id, { balance_cents: b.balance_cents, currency: b.currency })
    }
  }

  const shaped = advertisers.map((a) => ({ ...a, balance: balanceByAdvertiser.get(a.id) ?? null }))

  return NextResponse.json({ advertisers: shaped })
}
