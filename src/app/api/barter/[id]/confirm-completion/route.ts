import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { confirmBarterCompletionSchema } from '@/lib/barter/validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'
import { computeConfirmBarterCompletionHash, checkIdempotentReplay } from '@/lib/barter/idempotency'
import { releaseBarterDeposit } from '@/lib/payments/orchestrator'
import { notifyBarterParties, notifyBarterParty } from '@/lib/barter/notify'
import { releaseEscrowForPayment } from '@/lib/escrow/orchestrator'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/barter/[id]/confirm-completion -- either party confirms the
 * exchange is done (Step 11 Phase 4). confirm_barter_completion() is
 * the real authority: it records this confirmation and only flips the
 * agreement to 'completed' once BOTH parties have confirmed -- no
 * automatic completion from one side. Only when the RPC reports
 * 'completed' does this route release every 'authorised' deposit via
 * the orchestrator (a real provider call, so it happens here, never
 * inside the SQL RPC) -- a successful trade returns deposits, it never
 * captures/forfeits them (see docs/BARTER_EXECUTION.md "Known
 * limitations": capture/forfeiture is a future dispute-resolution
 * lever, not part of this phase's happy path).
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

  const rate = checkRateLimit(`barter:confirm-completion:${getClientKey(request)}`, 20, 60_000)
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
  const parsed = confirmBarterCompletionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeConfirmBarterCompletionHash(agreementId, parsed.data.confirmation_note)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'confirm_barter_completion', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result)
      if (replay.status === 'conflict') {
        const mapped = mapBarterRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('confirm_barter_completion', {
      p_actor_user_id: requester.userId,
      p_agreement_id: agreementId,
      p_confirmation_note: parsed.data.confirmation_note ?? null,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[barter.confirm-completion] RPC error', { userId: requester.userId, agreementId, error })
      const mapped = mapBarterRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    if (data?.status === 'completed') {
      const { data: agreementPayments } = await admin
        .from('payments')
        .select('id, status, payment_type, renter_id')
        .eq('barter_agreement_id', agreementId)
        .eq('payment_type', 'barter_deposit')
        .eq('status', 'authorised')

      for (const payment of agreementPayments ?? []) {
        try {
          await releaseBarterDeposit({ admin }, agreementId, payment.renter_id)
        } catch (releaseErr) {
          console.error('[barter.confirm-completion] deposit release failed', { agreementId, paymentId: payment.id, releaseErr })
        }
      }

      // Phase 3: best-effort escrow release for the cash-adjustment
      // payment (if any) at the agreement's own completion point, never
      // blocking confirmation. A no-op unless ESCROW_ENABLED and an
      // escrow transaction actually exists.
      const { data: cashAdjustmentPayments } = await admin
        .from('payments')
        .select('id, merchant_id')
        .eq('barter_agreement_id', agreementId)
        .eq('payment_type', 'barter_cash_adjustment')
        .eq('status', 'captured')
      for (const payment of cashAdjustmentPayments ?? []) {
        try {
          await releaseEscrowForPayment(admin, payment.id, payment.merchant_id, { actorType: 'system', reason: 'barter completed' })
        } catch (escrowErr) {
          console.error('[barter.confirm-completion] escrow release failed', { agreementId, paymentId: payment.id, escrowErr })
        }
      }

      try {
        await notifyBarterParties(admin, agreementId, 'barter.completed', 'barter-completed')
      } catch (emailErr) {
        console.error('[barter.confirm-completion] email dispatch failed', { agreementId, emailErr })
      }
    } else if (data?.status === 'awaiting_confirmation') {
      // Only one side has confirmed so far -- notify the OTHER party that their confirmation is needed.
      try {
        const { data: agreement } = await admin.from('barter_agreements').select('party_a_id, party_b_id').eq('id', agreementId).maybeSingle()
        if (agreement) {
          const otherPartyId = agreement.party_a_id === requester.userId ? agreement.party_b_id : agreement.party_a_id
          await notifyBarterParty(admin, agreementId, otherPartyId, 'barter.completion_requested', 'barter-completion-requested')
        }
      } catch (emailErr) {
        console.error('[barter.confirm-completion] email dispatch failed', { agreementId, emailErr })
      }
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[barter.confirm-completion] unexpected error', { userId: requester.userId, agreementId, err })
    return NextResponse.json({ error: 'Could not confirm completion — please try again' }, { status: 500 })
  }
}
