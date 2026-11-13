import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/require-admin'

/**
 * GET /api/payout-banks -- the bank catalog for the add-destination
 * dropdown (phase brief §15). Authenticated only (matches the RLS
 * policy on payout_banks -- authenticated SELECT, no anon access).
 * Returns ONLY active, payout-supported banks -- a bank E32/E33
 * considers unsupported for real-time EFT must never even appear as a
 * selectable option. banv_supported is included so the client can show
 * the "automatic verification unavailable for this bank" state (phase
 * brief §16) without a second round trip.
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

  const { data: banks, error } = await admin
    .from('payout_banks')
    .select('bank_code, display_name, banv_supported')
    .eq('active', true)
    .eq('payout_supported', true)
    .order('display_name', { ascending: true })
  if (error) {
    console.error('[payout-banks.list] error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not load bank catalog' }, { status: 500 })
  }

  return NextResponse.json({ banks })
}
