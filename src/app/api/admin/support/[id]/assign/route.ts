import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { assignSupportCaseSchema } from '@/lib/support/validation'
import { mapSupportRpcError } from '@/lib/support/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/support/[id]/assign — assign or reassign a case to an admin. Any valid admin may be assigned (RBAC is Batch C). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: caseId } = await params
  if (!isValidUuid(caseId)) {
    return NextResponse.json({ error: 'Invalid case id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:support:assign')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = assignSupportCaseSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Support storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('assign_support_case', {
    p_admin_id: gate.requester.userId,
    p_case_id: caseId,
    p_assignee_admin_id: parsed.data.assignee_admin_id,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.support.assign] RPC error', { caseId, error })
    const mapped = mapSupportRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
