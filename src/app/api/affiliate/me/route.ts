import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'

/** GET /api/affiliate/me -- the caller's own affiliate status, never another user's. */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  return NextResponse.json({
    is_affiliate: requester.profile.is_affiliate ?? false,
    affiliate_code: requester.profile.affiliate_code ?? null,
  })
}
