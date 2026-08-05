import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { payBarterCashAdjustmentSchema } from '@/lib/barter/validation'
import { blockIfCannotTransact } from '@/lib/admin/account-status'
import { chargeBarterCashAdjustment, OrchestrationError, isRetryableOrchestrationError } from '@/lib/payments/orchestrator'
import { isMockScenarioSelectionAllowed } from '@/lib/checkout/test-scenario'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/barter/[id]/cash-adjustment -- the caller (whoever owes the
 * cash difference) pays it (Step 11 Phase 4). Mirrors the deposit route
 * exactly, single-step charge via chargeBarterCashAdjustment() (reuses
 * provider.chargeRental(), same as order checkout).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: agreementId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(agreementId)) {
    return NextResponse.json({ error: 'Invalid barter agreement id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`barter:cash-adjustment:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }
  const blocked = blockIfCannotTransact(requester.profile)
  if (blocked) return blocked

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = payBarterCashAdjustmentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }
  if (parsed.data.test_scenario && !isMockScenarioSelectionAllowed()) {
    return NextResponse.json({ error: 'Test scenarios are not available in this environment' }, { status: 403 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const result = await chargeBarterCashAdjustment(
      { admin, testRentalScenario: parsed.data.test_scenario },
      agreementId,
      requester.userId,
      parsed.data.idempotency_key
    )

    return NextResponse.json({ status: 'success', paymentId: result.paymentId, cashAdjustmentStatus: result.status })
  } catch (err) {
    if (err instanceof OrchestrationError) {
      console.error('[barter.cash-adjustment] orchestration error', { userId: requester.userId, agreementId, code: err.code, message: err.message })

      if (err.code === 'missing_payment') {
        return NextResponse.json({ error: err.message }, { status: 404 })
      }
      if (isRetryableOrchestrationError(err.code)) {
        return NextResponse.json({ status: 'failed_retryable', error: 'A temporary issue stopped this payment. Please try again.' }, { status: 503 })
      }
      if (err.code === 'provider_declined' || err.code === 'terminal_provider_error') {
        return NextResponse.json({ status: 'failed_terminal', error: err.message }, { status: 200 })
      }
      return NextResponse.json({ error: 'Could not process this payment — please try again' }, { status: 500 })
    }
    console.error('[barter.cash-adjustment] unexpected error', { userId: requester.userId, agreementId, err })
    return NextResponse.json({ error: 'Could not process this payment — please try again' }, { status: 500 })
  }
}
