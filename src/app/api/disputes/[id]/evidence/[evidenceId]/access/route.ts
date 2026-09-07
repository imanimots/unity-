import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { getDisputeEvidenceSignedUrl } from '@/lib/disputes/evidence-access'

interface RouteParams {
  params: Promise<{ id: string; evidenceId: string }>
}

const UUID_RE = /^[0-9a-f-]{36}$/i

/**
 * POST /api/disputes/[id]/evidence/[evidenceId]/access -- the only way
 * to view/download a dispute evidence file. Never returns a permanent
 * URL; the signed URL expires in 120s (src/lib/disputes/evidence-access.ts)
 * and is never stored. A tighter rate limit than most routes on purpose --
 * this is the one endpoint that can be used to enumerate/probe evidence
 * files, even though it still requires a valid session and a matching
 * (dispute_id, evidence_id) row visible under dispute_evidence's own RLS.
 *
 * Authorization is delegated to that existing RLS (parties + admin,
 * already RTB-aware via is_dispute_participant()) via a cookie-bound
 * client -- never re-implemented here. A caller who is not a party to
 * this dispute (or supplies an evidence id belonging to a different
 * dispute than the one in the URL) gets the same 404 as a genuinely
 * missing row -- indistinguishable, matching this codebase's existing
 * "forged id" convention elsewhere (e.g. admin order detail).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: disputeId, evidenceId } = await params
  if (!UUID_RE.test(disputeId) || !UUID_RE.test(evidenceId)) {
    return NextResponse.json({ error: 'Invalid dispute or evidence id' }, { status: 400 })
  }

  const rate = checkRateLimit(`disputes:evidence:access:${getClientKey(request)}`, 30, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  const asUser = await createClient()
  if (!asUser) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const result = await getDisputeEvidenceSignedUrl(asUser, admin, disputeId, evidenceId)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'evidence_not_found') {
      return NextResponse.json({ error: 'Evidence not found for this dispute' }, { status: 404 })
    }
    console.error('[disputes.evidence.access] error', { userId: requester.userId, disputeId, evidenceId, err })
    return NextResponse.json({ error: 'Could not generate a secure evidence link' }, { status: 500 })
  }
}
