import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { closeSupportCaseSchema } from '@/lib/support/validation'
import { mapSupportRpcError } from '@/lib/support/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/support/[id]/close — reason optional from resolved, but required if closing without resolution (enforced server-side, Part 17). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: caseId } = await params
  if (!isValidUuid(caseId)) {
    return NextResponse.json({ error: 'Invalid case id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:support:close')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = closeSupportCaseSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Support storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('close_support_case', {
    p_admin_id: gate.requester.userId,
    p_case_id: caseId,
    p_reason: parsed.data.reason ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.support.close] RPC error', { caseId, error })
    const mapped = mapSupportRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
