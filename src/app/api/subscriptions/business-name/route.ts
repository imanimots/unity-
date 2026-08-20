import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getMerchantEntitlements } from '@/lib/subscriptions/entitlements'

const bodySchema = z.object({ businessName: z.string().trim().max(200) })

/**
 * GET/POST /api/subscriptions/business-name -- Section 19. Storing the
 * value is allowed for any merchant (Section 13: preserved as private
 * account data across a downgrade), but it is only ever DISPLAYED
 * publicly while the caller's live effective plan has
 * business_name_enabled=true (enforced by public_profiles' own view
 * definition, never by this route). This route never touches KYC/legal
 * name fields -- business_name is a distinct, editable, non-legal
 * public-branding field.
 */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Profile storage is not configured' }, { status: 503 })

  const [profileResult, entitlements] = await Promise.all([
    admin.from('profiles').select('business_name, display_name, full_name').eq('id', requester.userId).maybeSingle(),
    getMerchantEntitlements(admin, requester.userId),
  ])
  // business_name may not exist yet if that migration hasn't been
  // applied -- fall back to the pre-V2 column set for publicName.
  let profile = profileResult.data
  if (profileResult.error && /business_name/.test(profileResult.error.message)) {
    const fallback = await admin.from('profiles').select('display_name, full_name').eq('id', requester.userId).maybeSingle()
    profile = fallback.data ? { ...fallback.data, business_name: null } : null
  }

  return NextResponse.json({
    businessName: profile?.business_name ?? null,
    publicName: profile?.display_name ?? profile?.full_name ?? null,
    businessNameEnabled: entitlements.businessNameEnabled,
  })
}

export async function POST(request: NextRequest) {
  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Profile storage is not configured' }, { status: 503 })

  const entitlements = await getMerchantEntitlements(admin, requester.userId)
  if (!entitlements.businessNameEnabled) {
    return NextResponse.json({ error: 'Business name branding requires an active Elite subscription' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const { error } = await admin.from('profiles').update({ business_name: parsed.data.businessName || null }).eq('id', requester.userId)
  if (error) {
    console.error('[subscriptions.business-name] update error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not update your business name — please try again' }, { status: 500 })
  }

  return NextResponse.json({ businessName: parsed.data.businessName || null })
}
