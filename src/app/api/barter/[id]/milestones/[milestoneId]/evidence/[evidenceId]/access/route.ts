import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { getMilestoneEvidenceSignedUrl } from '@/lib/barter/milestone-evidence-access'

interface RouteParams {
  params: Promise<{ id: string; milestoneId: string; evidenceId: string }>
}

const UUID_RE = /^[0-9a-f-]{36}$/i

/**
 * POST /api/barter/[id]/milestones/[milestoneId]/evidence/[evidenceId]/access
 * -- the only way to view/download barter milestone evidence. Mirrors
 * /api/disputes/[id]/evidence/[evidenceId]/access and
 * /api/messages/[id]/attachments/[attachmentId]/access exactly. Never
 * returns a permanent URL; the signed URL expires in 120s
 * (src/lib/barter/milestone-evidence-access.ts) and is never stored.
 *
 * Authorization is delegated to barter_milestone_evidence's own
 * existing RLS (participants + admin, powered by
 * is_barter_contribution_participant()) via a cookie-bound client --
 * never re-implemented here. A caller who is not a party to this
 * evidence's agreement, or who supplies an evidence/milestone/agreement
 * id combination that doesn't actually chain together, gets the same
 * 404 as a genuinely missing row.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: agreementId, milestoneId, evidenceId } = await params
  if (!UUID_RE.test(agreementId) || !UUID_RE.test(milestoneId) || !UUID_RE.test(evidenceId)) {
    return NextResponse.json({ error: 'Invalid agreement, milestone, or evidence id' }, { status: 400 })
  }

  const rate = checkRateLimit(`barter:milestone:evidence:access:${getClientKey(request)}`, 30, 60_000)
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
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const asUser = await createClient()
  if (!asUser) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const result = await getMilestoneEvidenceSignedUrl(asUser, admin, agreementId, milestoneId, evidenceId)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'evidence_not_found') {
      return NextResponse.json({ error: 'Evidence not found for this milestone' }, { status: 404 })
    }
    console.error('[barter.milestone.evidence.access] error', { userId: requester.userId, agreementId, milestoneId, evidenceId, err })
    return NextResponse.json({ error: 'Could not generate a secure evidence link' }, { status: 500 })
  }
}
