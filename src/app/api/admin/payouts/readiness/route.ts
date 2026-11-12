import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getPeachPayoutActivationReadiness, isProductionReady } from '@/lib/payments/payout-execution/activation-readiness'

/**
 * GET /api/admin/payouts/readiness -- E34 phase brief §47: exposes the
 * one authoritative readiness service to the admin UI. Every field
 * returned is already a safe boolean/status by construction of
 * getPeachPayoutActivationReadiness() -- no secret, no raw credential,
 * ever reaches this response.
 */
export async function GET() {
  const admin_requester = await requireAdmin()
  if (!admin_requester) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const readiness = await getPeachPayoutActivationReadiness(admin)
  return NextResponse.json({ readiness, productionReady: isProductionReady(readiness) })
}
