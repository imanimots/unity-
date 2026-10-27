import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { analyticsIngestRequestSchema, validateEventMetadata, sanitizeRoutePath, MAX_INGEST_BODY_BYTES } from '@/lib/analytics/validation'
import { deriveActorState } from '@/lib/analytics/server'

/**
 * POST /api/analytics/events -- first-party behavioral event ingestion
 * (ADMIN-CONTROL-CENTRE-BATCH-D2). Never used for admin analytics
 * reads (that's /api/admin/analytics) and never used for anything
 * other than appending one allowlisted, validated event row.
 *
 * actor_state and data_classification are ALWAYS derived server-side
 * (getRequestProfile() for the former; this route never trusts a
 * client-supplied value for either, and the request schema has no
 * field for them at all). occurred_at is always the server's own
 * now() (set inside record_analytics_event(), never read from the
 * client). Idempotent on event_id via the RPC's ON CONFLICT DO
 * NOTHING -- a retried send is a no-op, not a duplicate.
 *
 * Internal failures (misconfigured Supabase, an RPC error) are logged
 * server-side only and never surfaced to the browser -- analytics
 * ingestion is non-blocking and must never leak database details.
 */
export async function POST(request: NextRequest) {
  const rate = await checkRateLimit(`analytics:events:${getClientKey(request)}`, 60, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const rawBody = await request.text()
  if (rawBody.length > MAX_INGEST_BODY_BYTES) {
    return NextResponse.json({ error: 'Invalid analytics event' }, { status: 400 })
  }

  let body: unknown
  try {
    body = rawBody ? JSON.parse(rawBody) : null
  } catch {
    return NextResponse.json({ error: 'Invalid analytics event' }, { status: 400 })
  }

  const parsed = analyticsIngestRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid analytics event' }, { status: 400 })
  }

  const metadataResult = validateEventMetadata(parsed.data.eventName, parsed.data.metadata ?? {})
  if (!metadataResult.ok) {
    return NextResponse.json({ error: 'Invalid analytics event' }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    // Non-blocking by design -- never a 503 the client would need to
    // retry or surface; analytics storage being unconfigured is not the
    // caller's problem.
    return new NextResponse(null, { status: 202 })
  }

  const requester = await getRequestProfile()
  const actorState = deriveActorState(requester?.profile.role)

  // The only case where this route performs its own, bounded,
  // server-side classification lookup: a listing-scoped event can be
  // authoritatively classified from that listing's own is_test column.
  // Every other client-originated event (page_view, search_*, signup_*)
  // has no reliable test signal available and stays 'unknown' rather
  // than guessing (Section 8).
  let dataClassification: 'real' | 'test' | 'unknown' = 'unknown'
  if (parsed.data.entityType === 'listing' && parsed.data.entityId) {
    try {
      const { data: listingRow } = await admin.from('listings').select('is_test').eq('id', parsed.data.entityId).maybeSingle()
      if (listingRow) dataClassification = listingRow.is_test ? 'test' : 'real'
    } catch {
      // Lookup failure leaves classification 'unknown' -- never guessed.
    }
  }

  try {
    await admin.rpc('record_analytics_event', {
      p_event_id: parsed.data.eventId,
      p_event_name: parsed.data.eventName,
      p_session_id: parsed.data.sessionId ?? null,
      p_actor_state: actorState,
      p_route_path: sanitizeRoutePath(parsed.data.routePath),
      p_entity_type: parsed.data.entityType ?? null,
      p_entity_id: parsed.data.entityId ?? null,
      p_metadata: metadataResult.data,
      p_data_classification: dataClassification,
    })
  } catch (err) {
    console.error('[analytics.events] ingestion error', { err })
    // Still 202 -- the client must never see or retry on an internal
    // storage failure; this is best-effort telemetry, never a workflow
    // the caller depends on.
  }

  return new NextResponse(null, { status: 202 })
}
