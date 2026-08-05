import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { proposeBarterSchema } from '@/lib/barter/validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'
import { computeProposeBarterHash, checkIdempotentReplay } from '@/lib/barter/idempotency'
import { BARTER_PROPOSAL_EXPIRY_HOURS } from '@/lib/barter/proposal-expiry'
import { triggerBarterLazyExpirySweep } from '@/lib/barter/lazy-expiry'
import { isKycApproved } from '@/lib/verification/eligibility'
import { blockIfCannotCreate } from '@/lib/admin/account-status'

/**
 * POST /api/barter -- propose a trade (Item<->Item, MVP scope).
 * GET  /api/barter -- list the caller's own agreements (as either party).
 *
 * propose_barter() (20260810000011_barter_rpcs_phase_a.sql) is service-role
 * only -- party_a_id is derived server-side from the anchor listing's
 * owner, party_b_id is always requester.userId, never client-supplied.
 *
 * Future subscription-gate hook point: if a subscription-tier system is
 * ever added, a check such as `requireBarterEntitlement(requester.profile)`
 * would go here, mirroring blockIfCannotCreate's placement. No
 * subscription system exists anywhere in this codebase today (scope
 * decision) -- Barter is available to any KYC-approved, non-suspended
 * user, identical to Buy/Rent.
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !anonKey || !serviceKey) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`barter:propose:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in to propose a trade' }, { status: 401 })
  }
  const blocked = blockIfCannotCreate(requester.profile)
  if (blocked) return blocked

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = proposeBarterSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid trade proposal', fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 }
    )
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeProposeBarterHash(parsed.data.anchor_listing_id, {
        partyAListingIds: parsed.data.party_a_listing_ids,
        partyBListingIds: parsed.data.party_b_listing_ids,
        cashAdjustmentAmount: parsed.data.cash_adjustment_amount ?? 0,
        deliveryMethod: parsed.data.delivery_method,
        depositAmount: parsed.data.deposit_amount,
        depositPayer: parsed.data.deposit_payer,
        message: parsed.data.message,
      })
      const replay = await checkIdempotentReplay(admin, requester.userId, 'propose_barter', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
      if (replay.status === 'conflict') {
        const mapped = mapBarterRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    // Checked after the idempotency replay above (an already-completed
    // request must still return its cached result even if KYC status
    // changed since) and before the RPC -- the established ordering rule
    // for every mutation route in this codebase.
    if (!isKycApproved(requester.profile.kyc_status)) {
      return NextResponse.json({ error: 'Your identity must be verified before you can propose a trade.' }, { status: 403 })
    }

    const { data, error } = await admin.rpc('propose_barter', {
      p_proposer_id: requester.userId,
      p_anchor_listing_id: parsed.data.anchor_listing_id,
      p_party_a_listing_ids: parsed.data.party_a_listing_ids,
      p_party_b_listing_ids: parsed.data.party_b_listing_ids,
      p_cash_adjustment_amount: parsed.data.cash_adjustment_amount ?? 0,
      p_cash_adjustment_payer: parsed.data.cash_adjustment_payer ?? null,
      p_delivery_method: parsed.data.delivery_method,
      p_delivery_notes: parsed.data.delivery_notes ?? null,
      p_delivery_responsibility: parsed.data.delivery_responsibility ?? null,
      p_deposit_required: parsed.data.deposit_required ?? false,
      p_deposit_amount: parsed.data.deposit_amount ?? null,
      p_deposit_currency: parsed.data.deposit_currency ?? 'ZAR',
      p_deposit_payer: parsed.data.deposit_payer ?? null,
      p_message: parsed.data.message ?? null,
      p_expiry_hours: BARTER_PROPOSAL_EXPIRY_HOURS,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[barter.propose] RPC error', { userId: requester.userId, error })
      const mapped = mapBarterRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    console.error('[barter.propose] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not submit your trade proposal — please try again' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url && serviceKey) {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    await triggerBarterLazyExpirySweep(createServiceClient(url, serviceKey))
  }

  const statusParam = request.nextUrl.searchParams.get('status')

  // RLS ("barter_agreements: parties read") scopes this to rows where the
  // caller is party_a_id or party_b_id regardless of the filter applied here.
  let query = supabase.from('barter_agreements').select('*').order('proposed_at', { ascending: false })
  if (statusParam) {
    query = query.eq('status', statusParam)
  }

  const { data, error } = await query
  if (error) {
    console.error('[barter.list] error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not load barter agreements' }, { status: 500 })
  }

  return NextResponse.json({ agreements: data ?? [] })
}
