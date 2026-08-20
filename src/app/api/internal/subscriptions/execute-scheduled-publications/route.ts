import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/internal/subscriptions/execute-scheduled-publications --
 * secret-authenticated sweep, exact same shape as
 * /api/internal/subscriptions/apply-due and
 * /api/internal/expire-marketplace-requests. Calls
 * execute_due_scheduled_publications(), which is idempotent and never
 * auto-deactivates anything to make room for a scheduled publish.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal scheduled-publication sweep endpoint is not configured' }, { status: 503 })
  }
  const provided = request.headers.get('authorization')
  if (provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)
    const { data, error } = await admin.rpc('execute_due_scheduled_publications', { p_limit: 50 })
    if (error) {
      console.error('[internal.execute-scheduled-publications] RPC error', error)
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }
    return NextResponse.json(data)
  } catch (err) {
    console.error('[internal.execute-scheduled-publications] unexpected error', { err })
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
