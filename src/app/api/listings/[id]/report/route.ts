import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { reportListingSchema } from '@/lib/listings/report-validation'
import { mapListingReportRpcError } from '@/lib/listings/report-rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/listings/[id]/report — an authenticated, non-owning user reports a listing. Never auto-hides or suspends it -- feeds the admin moderation queue only. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const rate = await checkRateLimit(`listings:report:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = reportListingSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid report', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)
    const { data, error } = await admin.rpc('report_listing', {
      p_reporter_id: requester.userId,
      p_listing_id: id,
      p_reason: parsed.data.reason,
      p_description: parsed.data.description ?? null,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })
    if (error) {
      const mapped = mapListingReportRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Could not submit your report — please try again' }, { status: 500 })
  }
}
