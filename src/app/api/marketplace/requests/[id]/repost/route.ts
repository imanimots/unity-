import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { mapMarketplaceRpcError } from '@/lib/marketplace/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid request id' }, { status: 400 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Marketplace storage is not configured' }, { status: 503 })

  let body: unknown
  try { body = await request.json() } catch { body = {} }
  const expiresAt = (body as { expires_at?: string })?.expires_at

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data, error } = await admin.rpc('repost_marketplace_request', {
    p_actor_user_id: requester.userId, p_request_id: id, p_expires_at: expiresAt ?? null,
  })
  if (error) {
    const mapped = mapMarketplaceRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  return NextResponse.json(data, { status: 201 })
}
