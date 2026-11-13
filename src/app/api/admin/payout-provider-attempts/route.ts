import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'

/**
 * GET /api/admin/payout-provider-attempts -- master launch phase
 * (Workstream F, §50-53): the operational visibility this codebase was
 * missing -- admins previously had no way to see provider-attempt
 * state at all (only the per-booking merchant_payouts list existed).
 * Read-only, safe fields only: no raw bank data, no provider
 * credentials, no raw request body. Supports a `status` filter so
 * "stuck" (pending/processing past a caller-supplied age) is easy to
 * find without a bespoke stuck-payout endpoint -- the admin UI
 * computes "stuck" client-side from submission_started_at.
 */
export async function GET(request: NextRequest) {
  const admin_requester = await requireAdmin()
  if (!admin_requester) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const statusFilter = request.nextUrl.searchParams.get('status')

  let query = admin
    .from('payout_provider_attempts')
    .select(
      'id, merchant_payout_id, affiliate_commission_id, provider, provider_payout_id, provider_request_id, attempt_number, amount, currency, provider_status, result_code, failure_category, provider_last_updated_at, submission_started_at, submitted_at, resolved_at, created_at, payout_destinations(bank_code, account_last4, payout_banks(display_name))'
    )
    .order('created_at', { ascending: false })
    .limit(200)

  if (statusFilter) {
    query = query.eq('provider_status', statusFilter)
  }

  const { data: attempts, error } = await query
  if (error) {
    console.error('[admin.payout-provider-attempts.list] error', { adminId: admin_requester.userId, error })
    return NextResponse.json({ error: 'Could not load provider attempts' }, { status: 500 })
  }

  return NextResponse.json({ attempts })
}
