import { NextRequest, NextResponse } from 'next/server'
import { hasCronAuthConfigured, isAuthorizedCronRequest } from '@/lib/internal-cron/auth'

/**
 * GET|POST /api/internal/email/purge-deliveries -- 180-day retention
 * sweep for email_deliveries, via cleanup_email_deliveries() (new,
 * supabase/migrations/20261118095132_email_deliveries_retention_cleanup.sql).
 * Same shape as /api/internal/advertising/purge-events.
 *
 * NOT YET SCHEDULED: vercel.json is a standing parked file in this
 * project that must not be edited without explicit approval, so the
 * one line (`{ "path": "/api/internal/email/purge-deliveries",
 * "schedule": "0 4 * * *" }`) needs to be added by whoever owns that
 * file. This route is fully built and safe to call manually (POST,
 * with the correct cron secret) in the meantime.
 */
async function handleCronRequest(request: NextRequest) {
  if (!hasCronAuthConfigured()) return NextResponse.json({ error: 'Internal email retention endpoint is not configured' }, { status: 503 })

  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Email storage is not configured' }, { status: 503 })

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)
    const { data, error } = await admin.rpc('cleanup_email_deliveries')
    if (error) {
      console.error('[internal.email.purge-deliveries] RPC error', error)
      return NextResponse.json({ error: 'Purge failed' }, { status: 500 })
    }
    return NextResponse.json({ deleted_count: data })
  } catch (err) {
    console.error('[internal.email.purge-deliveries] unexpected error', { err })
    return NextResponse.json({ error: 'Purge failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handleCronRequest(request)
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request)
}
