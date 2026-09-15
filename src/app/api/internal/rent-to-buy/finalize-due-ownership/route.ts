import { NextRequest, NextResponse } from 'next/server'
import { notifyRentToBuyParty } from '@/lib/rent-to-buy/notify'
import { hasCronAuthConfigured, isAuthorizedCronRequest } from '@/lib/internal-cron/auth'

/**
 * GET|POST /api/internal/rent-to-buy/finalize-due-ownership -- explicit
 * trigger, mirroring /api/internal/subscriptions/apply-due exactly,
 * scheduled via vercel.json (P4). This is NOT a default-like automatic
 * termination sweep (Rule 17 explicitly prohibits that shape) -- it
 * only ever finalizes an outcome that has ALREADY been fully earned
 * (100% paid, genuinely received via confirmed possession,
 * completion/inspection window elapsed, no unresolved dispute); every
 * one of those conditions is re-verified authoritatively inside
 * finalize_rent_to_buy_ownership() itself, this route only selects
 * plausible candidates to reduce wasted calls. GET (Vercel Cron) and
 * POST (manual/curl) share one handler and the shared
 * isAuthorizedCronRequest() authority (src/lib/internal-cron/auth.ts).
 */
async function handleCronRequest(request: NextRequest) {
  if (!hasCronAuthConfigured()) {
    return NextResponse.json({ error: 'Internal rent-to-buy sweep endpoint is not configured' }, { status: 503 })
  }
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })
  }

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const admin = createClient(url, serviceKey)

    const { data: candidates, error: candidatesError } = await admin
      .from('rent_to_buy_agreements')
      .select('id, merchant_id, customer_id')
      .eq('status', 'active')
      .eq('possession_status', 'customer_in_possession')
      .eq('ownership_status', 'merchant_owned')
      .not('fully_paid_at', 'is', null)
      .not('completion_window_ends_at', 'is', null)
      .lte('completion_window_ends_at', new Date().toISOString())

    if (candidatesError) {
      console.error('[internal.rent-to-buy.finalize-due-ownership] candidate query error', candidatesError)
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }

    let finalizedCount = 0
    const results: Array<{ agreementId: string; finalized: boolean; reason?: string }> = []

    for (const candidate of candidates ?? []) {
      const { data, error } = await admin.rpc('finalize_rent_to_buy_ownership', { p_agreement_id: candidate.id, p_idempotency_key: null })
      if (error) {
        console.error('[internal.rent-to-buy.finalize-due-ownership] RPC error', { agreementId: candidate.id, error })
        results.push({ agreementId: candidate.id, finalized: false, reason: 'rpc_error' })
        continue
      }
      results.push({ agreementId: candidate.id, finalized: Boolean(data?.finalized), reason: data?.reason })
      if (data?.finalized && !data?.already_finalized) {
        finalizedCount += 1
        try {
          await notifyRentToBuyParty(admin, candidate.id, candidate.customer_id, 'rent_to_buy.completed', 'rent-to-buy-completed', `rtb-completed-customer-${candidate.id}`)
          await notifyRentToBuyParty(admin, candidate.id, candidate.merchant_id, 'rent_to_buy.completed', 'rent-to-buy-completed-merchant', `rtb-completed-merchant-${candidate.id}`)
        } catch (emailErr) {
          console.error('[internal.rent-to-buy.finalize-due-ownership] email dispatch failed', { agreementId: candidate.id, emailErr })
        }
      }
    }

    return NextResponse.json({ checked: candidates?.length ?? 0, finalized: finalizedCount, results })
  } catch (err) {
    console.error('[internal.rent-to-buy.finalize-due-ownership] unexpected error', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handleCronRequest(request)
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request)
}
