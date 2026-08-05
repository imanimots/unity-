import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { cancelBarterSchema } from '@/lib/barter/validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'
import { computeCancelBarterAgreementHash, checkIdempotentReplay } from '@/lib/barter/idempotency'
import { releaseBarterDeposit } from '@/lib/payments/orchestrator'
import { notifyBarterParties } from '@/lib/barter/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/barter/[id]/cancel -- either party may cancel, at any point
 * before completion, except while disputed. cancel_barter_agreement()
 * derives which side the caller is on from the agreement row itself and
 * determines the cancellation_settlement value from the agreement's
 * current status. No account-status gate, matching the booking cancel
 * route's precedent -- cancelling must remain available even to a
 * restricted/suspended user cleaning up a stale commitment.
 *
 * Step 11 Phase 4: cancel_barter_agreement itself is deliberately
 * unchanged (see docs/BARTER_EXECUTION.md "Deviation from the Phase A
 * plan") -- when its result reports settlement='refunded', THIS route
 * (not the RPC) executes the actual money movement: releasing any
 * 'authorised' deposit via the orchestrator (a real provider call, which
 * cannot happen inside a SQL function), and voiding any still-'pending'
 * cash-adjustment intent directly (safe without a provider call -- a
 * merely 'pending' row was never actually attempted with the provider).
 * settlement='frozen_pending_dispute' triggers no financial action,
 * matching "refunds (record only where already supported)".
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

  const rate = checkRateLimit(`barter:cancel:${getClientKey(request)}`, 20, 60_000)
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
  const parsed = cancelBarterSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeCancelBarterAgreementHash(agreementId, parsed.data.cancellation_reason)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'cancel_barter_agreement', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result)
      if (replay.status === 'conflict') {
        const mapped = mapBarterRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('cancel_barter_agreement', {
      p_actor_user_id: requester.userId,
      p_agreement_id: agreementId,
      p_cancellation_reason: parsed.data.cancellation_reason ?? null,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[barter.cancel] RPC error', { userId: requester.userId, agreementId, error })
      const mapped = mapBarterRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    if (data?.settlement === 'refunded') {
      const { data: agreementPayments } = await admin.from('payments').select('id, status, payment_type, renter_id').eq('barter_agreement_id', agreementId)

      for (const payment of agreementPayments ?? []) {
        try {
          if (payment.payment_type === 'barter_deposit' && payment.status === 'authorised') {
            await releaseBarterDeposit({ admin }, agreementId, payment.renter_id)
          } else if (payment.status === 'pending') {
            // Never actually attempted with the provider -- safe to void directly.
            await admin.rpc('transition_payment_status', { p_payment_id: payment.id, p_new_status: 'cancelled', p_actor_type: 'system' })
          }
        } catch (settlementErr) {
          console.error('[barter.cancel] settlement execution failed for a payment', { agreementId, paymentId: payment.id, settlementErr })
        }
      }
    }

    try {
      await notifyBarterParties(admin, agreementId, 'barter.cancelled', 'barter-cancelled', { cancellation_reason: parsed.data.cancellation_reason ?? '' })
    } catch (emailErr) {
      console.error('[barter.cancel] email dispatch failed', { agreementId, emailErr })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[barter.cancel] unexpected error', { userId: requester.userId, agreementId, err })
    return NextResponse.json({ error: 'Could not cancel this trade — please try again' }, { status: 500 })
  }
}
