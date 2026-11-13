import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { executeMerchantPayoutProviderAttempt } from '@/lib/payments/orchestrator'
import { OrchestrationError } from '@/lib/payments/orchestrator/errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/payouts/[id]/execute-provider -- the dedicated
 * provider-execution path for a merchant payout (phase brief §52).
 * Deliberately NOT the manual admin "mark paid" route -- that remains
 * src/lib/payments/.../mark_payout_paid, untouched, and is itself now
 * guarded against racing a live provider attempt (see the E33
 * migration's "manual-flow conflict guard").
 */
export async function POST(_request: Request, { params }: RouteParams) {
  const admin_requester = await requireAdmin()
  if (!admin_requester) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id: payoutId } = await params

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  try {
    const result = await executeMerchantPayoutProviderAttempt({ admin }, payoutId, admin_requester.userId)
    return NextResponse.json({ result })
  } catch (err) {
    if (err instanceof OrchestrationError) {
      const status: Record<string, number> = {
        provider_configuration_error: 503,
        invalid_payment_transition: 409,
        missing_payment: 404,
        internal_consistency_error: 500,
      }
      return NextResponse.json({ error: err.message, code: err.code }, { status: status[err.code] ?? 500 })
    }
    console.error('[admin.payouts.execute-provider] unexpected error', { adminId: admin_requester.userId, payoutId, err })
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
}
