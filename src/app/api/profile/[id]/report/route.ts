import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { reportProfileSchema } from '@/lib/profiles/validation'
import { mapProfileRpcError } from '@/lib/profiles/rpc-errors'
import { computeReportProfileHash, checkIdempotentReplay } from '@/lib/profiles/idempotency'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/profile/[id]/report -- minimal profile-report mechanism
 * (Step P). Deliberately not gated on KYC/account-status eligibility --
 * reporting abuse must remain reachable even by an unverified or
 * restricted account, same reasoning as disputes. report_profile()
 * (20260830000001_clickable_profiles_report.sql) is service-role only.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: reportedProfileId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(reportedProfileId)) {
    return NextResponse.json({ error: 'Invalid profile id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !anonKey || !serviceKey) {
    return NextResponse.json({ error: 'Profile report storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`profile:report:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in to report a profile' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = reportProfileSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid report', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  if (parsed.data.idempotency_key) {
    const hash = computeReportProfileHash(reportedProfileId, parsed.data.reason, parsed.data.description)
    const replay = await checkIdempotentReplay(admin, requester.userId, 'report_profile', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
    if (replay.status === 'conflict') {
      const mapped = mapProfileRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('report_profile', {
    p_reporter_id: requester.userId,
    p_reported_profile_id: reportedProfileId,
    p_reason: parsed.data.reason,
    p_description: parsed.data.description ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[profile.report] RPC error', { userId: requester.userId, reportedProfileId, error })
    const mapped = mapProfileRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data, { status: 201 })
}
