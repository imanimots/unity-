import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { reconcilePayoutProviderAttempt } from '@/lib/payments/orchestrator'
import { OrchestrationError } from '@/lib/payments/orchestrator/errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/payout-provider-attempts/[id]/reconcile -- admin-
 * triggered query-by-payoutId reconciliation (phase brief §46/§63),
 * for a stuck or lost-create-response attempt. Works for either
 * domain (merchant or affiliate) -- the shared reconciliation
 * authority looks up which one owns the attempt. Never accepts a
 * client-supplied provider status -- always queries Peach directly.
 */
export async function POST(_request: Request, { params }: RouteParams) {
  const admin_requester = await requireAdmin()
  if (!admin_requester) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id: attemptId } = await params

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  try {
    const result = await reconcilePayoutProviderAttempt({ admin }, attemptId)
    return NextResponse.json({ result })
  } catch (err) {
    if (err instanceof OrchestrationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'missing_payment' ? 404 : 502 })
    }
    console.error('[admin.payout-provider-attempts.reconcile] unexpected error', { adminId: admin_requester.userId, attemptId, err })
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
}
