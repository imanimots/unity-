import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'

/**
 * GET /api/admin/verifications -- the KYC review queue. Deliberately
 * does NOT select any document/evidence column -- "do not expose
 * sensitive document details in the queue" (Step 4 brief), same
 * principle as Step 3's listing moderation queue. Only the fields
 * explicitly asked for: user name, role, current status, submitted
 * date, account age, risk indicators already available (unity_score),
 * prior review attempts (review_count).
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:verifications:queue')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Verification storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const role = searchParams.get('role')
  const country = searchParams.get('country')
  const search = searchParams.get('search')
  const submittedAfter = searchParams.get('submitted_after')
  const submittedBefore = searchParams.get('submitted_before')

  let query = admin
    .from('identity_verifications')
    .select(
      `
      user_id, status, country_of_residence, submitted_at, review_count, created_at,
      profiles!identity_verifications_user_id_fkey(full_name, role, unity_score, created_at, country_id)
    `
    )
    .order('submitted_at', { ascending: true, nullsFirst: true })
    .limit(200)

  if (status) query = query.eq('status', status)
  if (submittedAfter) query = query.gte('submitted_at', submittedAfter)
  if (submittedBefore) query = query.lte('submitted_at', submittedBefore)

  const { data, error } = await query

  if (error) {
    console.error('[admin.verifications.queue] query error', error)
    return NextResponse.json({ error: 'Could not load the verification queue' }, { status: 500 })
  }

  const now = Date.now()
  let rows = (data ?? []).map((row) => {
    const profile = (row as unknown as { profiles?: { full_name: string | null; role: string; unity_score: number; created_at: string; country_id: string } }).profiles

    return {
      userId: row.user_id,
      userName: profile?.full_name ?? null,
      role: profile?.role ?? null,
      status: row.status,
      countryOfResidence: row.country_of_residence,
      accountCountry: profile?.country_id ?? null,
      unityScore: profile?.unity_score ?? null,
      submittedAt: row.submitted_at,
      accountCreatedAt: profile?.created_at ?? null,
      accountAgeDays: profile?.created_at ? Math.floor((now - new Date(profile.created_at).getTime()) / (1000 * 60 * 60 * 24)) : null,
      reviewCount: row.review_count,
    }
  })

  if (role) rows = rows.filter((r) => r.role === role)
  if (country) rows = rows.filter((r) => r.countryOfResidence === country || r.accountCountry === country)
  if (search) {
    const q = search.toLowerCase()
    rows = rows.filter((r) => (r.userName ?? '').toLowerCase().includes(q) || r.userId.toLowerCase().includes(q))
  }

  return NextResponse.json({ verifications: rows })
}
