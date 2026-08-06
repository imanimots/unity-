import { NextRequest, NextResponse } from 'next/server'
import { AFFILIATE_SWEEP_BATCH_LIMIT } from '@/lib/affiliate/constants'
import { isMockScenarioSelectionAllowed } from '@/lib/checkout/test-scenario'
import { getPaymentProvider } from '@/lib/payments/registry'
import { notifyAffiliateOfCommission } from '@/lib/affiliate/notify'
import type { MockScenario } from '@/lib/payments/provider'

/**
 * POST /api/internal/affiliate/process-payouts -- payout_queued ->
 * processing -> paid/failed, calling the configured payout provider
 * once per commission. If no provider is configured (mock is always
 * configured in dev; this branch matters for a future real-provider
 * deployment with missing credentials), the sweep stops each row at
 * `processing` rather than falsely marking anything paid -- an
 * exception surfaces it (Part F's own "payout queued but not
 * processed").
 *
 * `mock_scenario` is only ever honoured when isMockScenarioSelectionAllowed()
 * -- the same dev/test-only gate checkout itself uses -- letting the
 * regression script deterministically force a payout failure to prove
 * "failed" and "retry" behave correctly. Never trusted in a real
 * deployment.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal affiliate payout-processing endpoint is not configured' }, { status: 503 })
  }
  const provided = request.headers.get('authorization')
  if (provided !== `Bearer ${secret}`) {
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

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)
    const providerName = process.env.PAYMENT_PROVIDER || 'mock'
    const provider = getPaymentProvider(providerName)

    const { data: candidates, error: selectError } = await admin
      .from('affiliate_commissions')
      .select('id, affiliate_id, commission_amount, currency')
      .eq('status', 'payout_queued')
      .limit(AFFILIATE_SWEEP_BATCH_LIMIT)

    if (selectError) {
      console.error('[internal.affiliate.process-payouts] select error', selectError)
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }

    let paidCount = 0
    let failedCount = 0
    for (const row of candidates ?? []) {
      const { data: processing, error: processingError } = await admin.rpc('mark_affiliate_commission_processing', {
        p_commission_id: row.id,
        p_provider: provider.name,
      })
      if (processingError || processing?.status !== 'processing') {
        console.error('[internal.affiliate.process-payouts] could not mark processing', { commissionId: row.id, processingError })
        continue
      }

      try {
        const payout = await provider.createAffiliatePayout({
          affiliateId: row.affiliate_id,
          commissionId: row.id,
          amount: row.commission_amount,
          currency: row.currency,
          mockScenario,
        })

        const { data: result, error: resultError } = await admin.rpc('record_affiliate_payout_result', {
          p_commission_id: row.id,
          p_status: payout.status,
          p_provider_reference: payout.providerReference,
          p_failure_reason: payout.failureReason ?? null,
        })
        if (resultError) {
          console.error('[internal.affiliate.process-payouts] could not record result', { commissionId: row.id, resultError })
          continue
        }

        if (result?.status === 'paid') {
          paidCount++
          try {
            await notifyAffiliateOfCommission(admin, row.id, 'affiliate.commission_paid', 'affiliate-commission-paid')
          } catch (emailErr) {
            console.error('[internal.affiliate.process-payouts] email dispatch failed', { commissionId: row.id, emailErr })
          }
        } else {
          failedCount++
          try {
            await notifyAffiliateOfCommission(admin, row.id, 'affiliate.payout_failed', 'affiliate-payout-failed')
          } catch (emailErr) {
            console.error('[internal.affiliate.process-payouts] email dispatch failed', { commissionId: row.id, emailErr })
          }
        }
      } catch (providerErr) {
        console.error('[internal.affiliate.process-payouts] provider call failed', { commissionId: row.id, providerErr })
        await admin.rpc('record_affiliate_payout_result', {
          p_commission_id: row.id,
          p_status: 'failed',
          p_failure_reason: providerErr instanceof Error ? providerErr.name : 'provider error',
        })
        failedCount++
      }
    }

    return NextResponse.json({ considered: (candidates ?? []).length, paid: paidCount, failed: failedCount })
  } catch (err) {
    console.error('[internal.affiliate.process-payouts] unexpected error', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
