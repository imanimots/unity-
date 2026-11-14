import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { isPayoutExecutionEnabled } from '@/lib/payments/payout-execution/gate'

/**
 * Provider-neutral payment/payout readiness. Peach-specific readiness
 * remains in legacy modules only and is not part of active launch logic.
 * No secret values are returned.
 */
export async function GET() {
  const adminRequester = await requireAdmin()
  if (!adminRequester) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  let destinationAuthorityHealthy = false
  try {
    const { error } = await admin.from('payout_banks').select('bank_code', { count: 'exact', head: true }).limit(1)
    destinationAuthorityHealthy = !error
  } catch {
    destinationAuthorityHealthy = false
  }

  const configuredProvider = process.env.PAYMENT_PROVIDER || 'mock'
  const legacyProviderSelected = configuredProvider === 'peach'
  const realProviderConfigured = configuredProvider !== 'mock' && !legacyProviderSelected

  const readiness = {
    activeProvider: legacyProviderSelected ? 'peach (legacy/blocked)' : configuredProvider,
    realProviderConfigured,
    executionGateConfigured: isPayoutExecutionEnabled(),
    destinationAuthorityHealthy,
    sandboxCertified: false,
    productionCanaryApproved: false,
    integrationStatus: realProviderConfigured ? 'provider-configured' : 'awaiting-real-provider',
  }

  // A real provider integration + explicit execution gate + sandbox
  // certification are all required. Until TradeSafe is integrated this
  // intentionally remains false.
  const productionReady =
    readiness.realProviderConfigured &&
    readiness.executionGateConfigured &&
    readiness.destinationAuthorityHealthy &&
    readiness.sandboxCertified &&
    readiness.productionCanaryApproved

  return NextResponse.json({ readiness, productionReady })
}
