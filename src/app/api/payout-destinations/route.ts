import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/require-admin'
import { addPayoutDestinationSchema } from '@/lib/payments/payout-destinations/validation'
import { addPayoutDestination, getPayoutDestinationEligibility } from '@/lib/payments/payout-destinations/service'
import { PayoutDestinationError } from '@/lib/payments/payout-destinations/errors'

/**
 * GET/POST /api/payout-destinations -- self-service payout bank details
 * for the signed-in user (merchant and/or affiliate; the same
 * destination serves both, see the migration's own recipient-model
 * comment). Never returns raw account data -- payout_destinations'
 * own columns are already safe, so this simply forwards the RLS-backed
 * table read.
 *
 * E32 scope boundary: this only establishes/replaces a destination.
 * Submitting it for bank account verification is a separate endpoint
 * (/api/payout-destinations/[id]/verify) so a client can show "added,
 * not yet verified" as a distinct step.
 */
export async function GET() {
  const requester = await requireAuth()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data: destinations, error } = await admin
    .from('payout_destinations')
    .select(
      'id, version, is_current, bank_code, universal_branch_code, account_type, account_last4, verification_status, verified_at, verification_expires_at, disabled_at, created_at, payout_banks(display_name, banv_supported)'
    )
    .eq('owner_id', requester.userId)
    .order('created_at', { ascending: false })
  if (error) {
    console.error('[payout-destinations.list] error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not load payout destinations' }, { status: 500 })
  }

  let eligibility
  try {
    eligibility = await getPayoutDestinationEligibility({ admin }, requester.userId)
  } catch (err) {
    console.error('[payout-destinations.list] eligibility error', { userId: requester.userId, err })
    eligibility = null
  }

  return NextResponse.json({ destinations, eligibility })
}

export async function POST(request: NextRequest) {
  const requester = await requireAuth()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = addPayoutDestinationSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  try {
    const result = await addPayoutDestination(
      { admin },
      {
        ownerId: requester.userId,
        bankCode: parsed.data.bank_code,
        accountNumber: parsed.data.account_number,
        accountType: parsed.data.account_type,
        actorId: requester.userId,
        actorType: 'owner',
      }
    )
    return NextResponse.json({ destination: result }, { status: 201 })
  } catch (err) {
    return mapPayoutDestinationErrorResponse(err, 'payout-destinations.create', requester.userId)
  }
}

export function mapPayoutDestinationErrorResponse(err: unknown, logTag: string, userId: string): NextResponse {
  if (err instanceof PayoutDestinationError) {
    const status: Record<PayoutDestinationError['code'], number> = {
      invalid_input: 400,
      bank_not_found: 404,
      bank_payout_unsupported: 422,
      bank_banv_unsupported: 422,
      destination_not_found: 404,
      destination_not_current: 409,
      identity_not_approved: 422,
      concurrent_change: 409,
      provider_configuration_error: 503,
      provider_timeout: 504,
      retryable_provider_error: 502,
      terminal_provider_error: 502,
      internal_consistency_error: 500,
    }
    return NextResponse.json({ error: err.message, code: err.code }, { status: status[err.code] })
  }
  console.error(`[${logTag}] unexpected error`, { userId, err })
  return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
}
