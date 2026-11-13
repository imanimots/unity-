import { NextRequest, NextResponse } from 'next/server'
import { AFFILIATE_SWEEP_BATCH_LIMIT } from '@/lib/affiliate/constants'
import { isMockScenarioSelectionAllowed } from '@/lib/checkout/test-scenario'
import { getActivePaymentProvider, assertProviderSupportsCapability, ProviderNotPermittedError } from '@/lib/payments/registry'
import { isPayoutExecutionEnabled } from '@/lib/payments/payout-execution/gate'
import { loadPeachPayoutsConfig } from '@/lib/payments/providers/peach/payouts-config'
import { getPayoutDestinationEligibility } from '@/lib/payments/payout-destinations/service'
import { executeAffiliatePayoutProviderAttempt } from '@/lib/payments/orchestrator'
import { notifyAffiliateOfCommission } from '@/lib/affiliate/notify'
import type { MockScenario } from '@/lib/payments/provider'
import { ProviderCapabilityUnsupportedError } from '@/lib/payments/provider'
import { hasCronAuthConfigured, isAuthorizedCronRequest, isAuthorizedGcpSchedulerRequest } from '@/lib/internal-cron/auth'

/**
 * GET|POST /api/internal/affiliate/process-payouts -- third step of the
 * affiliate automation chain (review-and-approve -> queue-payouts ->
 * process-payouts), scheduled via vercel.json (P4). payout_queued ->
 * processing -> paid/failed, calling the real Peach payout provider
 * once per commission (E33).
 *
 * E33 rewrite -- the whole sweep now fails closed BEFORE the candidate
 * query (phase brief §59) on FOUR independent gates, in order:
 *   1. the dedicated payout-execution gate (PEACH_PAYOUTS_EXECUTION_ENABLED)
 *   2. active provider + capability (unchanged from E30)
 *   3. Peach Payouts configuration present
 * Per candidate, a NEW destination-eligibility PRECHECK (phase brief
 * §58) runs before ever calling mark_affiliate_commission_processing:
 * an ineligible destination leaves the commission at payout_queued,
 * untouched, logged as an operational exception -- never a processing
 * transition with nothing to actually pay out to.
 *
 * E33 SAFETY FIX (phase brief §60): the old catch block here
 * unconditionally marked a commission 'failed' on ANY thrown provider
 * error, including a timeout/network error that may have occurred
 * AFTER Peach already accepted the payout -- a real duplicate-payout
 * risk on the next sweep. executeAffiliatePayoutProviderAttempt()
 * already classifies this: an 'ambiguous' outcome leaves the
 * commission in 'processing' (no RPC call at all here), relying on
 * query-by-payoutId reconciliation, never an automatic retry.
 *
 * `mock_scenario` is only ever honoured when isMockScenarioSelectionAllowed()
 * -- the same dev/test-only gate checkout itself uses. GET (Vercel
 * Cron) and POST (manual/curl) share one handler and the shared
 * isAuthorizedCronRequest() authority (src/lib/internal-cron/auth.ts).
 */
async function handleCronRequest(request: NextRequest) {
  if (!hasCronAuthConfigured()) {
    return NextResponse.json({ error: 'Internal affiliate payout-processing endpoint is not configured' }, { status: 503 })
  }
  if (!isAuthorizedCronRequest(request) && !(await isAuthorizedGcpSchedulerRequest(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Affiliate storage is not configured' }, { status: 503 })
  }

  let mockScenario: MockScenario | undefined
  try {
    const body = await request.json()
    if (isMockScenarioSelectionAllowed() && typeof body?.mock_scenario === 'string') {
      mockScenario = body.mock_scenario as MockScenario
    }
  } catch {
    // No body / not JSON -- fine, this route takes no required fields.
  }

  if (!isPayoutExecutionEnabled()) {
    return NextResponse.json({ error: 'Payout execution is not enabled in this environment', considered: 0, paid: 0, failed: 0 }, { status: 503 })
  }

  let provider
  try {
    provider = getActivePaymentProvider()
    assertProviderSupportsCapability(provider, 'affiliate_payout')
  } catch (err) {
    if (err instanceof ProviderNotPermittedError || err instanceof ProviderCapabilityUnsupportedError) {
      console.error('[internal.affiliate.process-payouts] provider not available for this sweep', { message: err.message })
      return NextResponse.json({ error: 'Affiliate payout processing is not available in this environment', considered: 0, paid: 0, failed: 0 }, { status: 503 })
    }
    throw err
  }

  if (provider.name === 'peach' && !loadPeachPayoutsConfig()) {
    return NextResponse.json({ error: 'Peach Payouts is not configured', considered: 0, paid: 0, failed: 0 }, { status: 503 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data: candidates, error: selectError } = await admin
      .from('affiliate_commissions')
      .select('id, affiliate_id')
      .eq('status', 'payout_queued')
      .limit(AFFILIATE_SWEEP_BATCH_LIMIT)

    if (selectError) {
      console.error('[internal.affiliate.process-payouts] select error', selectError)
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }

    let paidCount = 0
    let failedCount = 0
    for (const row of candidates ?? []) {
      let eligibility
      try {
        eligibility = await getPayoutDestinationEligibility({ admin }, row.affiliate_id)
      } catch (eligErr) {
        console.error('[internal.affiliate.process-payouts] destination eligibility check failed', { commissionId: row.id, eligErr })
        continue
      }
      if (!eligibility.eligible) {
        // Left at payout_queued, untouched -- surfaced as an
        // operational exception elsewhere (listOperationalExceptions),
        // never silently dropped and never force-processed anyway.
        console.error('[internal.affiliate.process-payouts] affiliate has no eligible payout destination -- leaving commission queued', {
          commissionId: row.id,
          affiliateId: row.affiliate_id,
          reason: eligibility.reason,
        })
        continue
      }

      try {
        const result = await executeAffiliatePayoutProviderAttempt({ admin, providerName: provider.name, testPayoutScenario: mockScenario }, row.id)

        if (result.outcome === 'ambiguous') {
          // Deliberately no count increment, no email -- the commission
          // remains 'processing'; reconciliation resolves it later.
          console.error('[internal.affiliate.process-payouts] ambiguous provider outcome -- left processing for reconciliation', { commissionId: row.id, reason: result.ambiguousReason })
          continue
        }

        if (result.status === 'successful') {
          paidCount++
          try {
            await notifyAffiliateOfCommission(admin, row.id, 'affiliate.commission_paid', 'affiliate-commission-paid')
          } catch (emailErr) {
            console.error('[internal.affiliate.process-payouts] email dispatch failed', { commissionId: row.id, emailErr })
          }
        } else if (result.status === 'failed' || result.status === 'cancelled') {
          failedCount++
          try {
            await notifyAffiliateOfCommission(admin, row.id, 'affiliate.payout_failed', 'affiliate-payout-failed')
          } catch (emailErr) {
            console.error('[internal.affiliate.process-payouts] email dispatch failed', { commissionId: row.id, emailErr })
          }
        }
        // 'pending'/'processing' (and 'reversed', which cannot occur
        // on a create response): no count increment, no email yet --
        // the commission stays 'processing' until a webhook or
        // reconciliation resolves it to a terminal state.
      } catch (err) {
        // A thrown OrchestrationError here means the attempt could not
        // even be STARTED (ineligible, misconfigured, etc) -- never a
        // provider-call ambiguity (that path returns a result, it
        // never throws). Safe to skip without any state mutation.
        console.error('[internal.affiliate.process-payouts] could not start provider attempt', { commissionId: row.id, err })
        continue
      }
    }

    return NextResponse.json({ considered: (candidates ?? []).length, paid: paidCount, failed: failedCount })
  } catch (err) {
    console.error('[internal.affiliate.process-payouts] unexpected error', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handleCronRequest(request)
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request)
}
