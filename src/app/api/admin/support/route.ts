import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid, parseListLimit } from '@/lib/admin/route-helpers'
import { listAdminSupportCases } from '@/lib/admin/support-service'
import { createSupportCaseSchema } from '@/lib/support/validation'
import { mapSupportRpcError } from '@/lib/support/rpc-errors'

/** GET /api/admin/support — the operational case queue, server-side filtered + paginated (Part 13). */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:support:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Support storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const userIdParam = searchParams.get('userId')
  if (userIdParam && !isValidUuid(userIdParam)) {
    return NextResponse.json({ error: 'Invalid userId' }, { status: 400 })
  }
  const assignedAdminId = searchParams.get('assignedAdminId')
  if (assignedAdminId && !isValidUuid(assignedAdminId)) {
    return NextResponse.json({ error: 'Invalid assignedAdminId' }, { status: 400 })
  }
  const offsetParam = Number(searchParams.get('offset') ?? '0')

  try {
    const page = await listAdminSupportCases(admin, {
      status: searchParams.get('status') ?? undefined,
      priority: searchParams.get('priority') ?? undefined,
      category: searchParams.get('category') ?? undefined,
      unassigned: searchParams.get('unassigned') === 'true',
      assignedAdminId: assignedAdminId ?? undefined,
      search: searchParams.get('search') ?? undefined,
      participantUserId: userIdParam ?? undefined,
      limit: parseListLimit(searchParams.get('limit'), 200),
      offset: Number.isInteger(offsetParam) && offsetParam >= 0 ? offsetParam : 0,
    })
    return NextResponse.json(page)
  } catch (err) {
    console.error('[admin.support.list] error', err)
    return NextResponse.json({ error: 'Could not load support cases' }, { status: 500 })
  }
}

/** POST /api/admin/support — create a new support case. */
export async function POST(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:support:create')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = createSupportCaseSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Support storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('create_support_case', {
    p_admin_id: gate.requester.userId,
    p_title: parsed.data.title,
    p_category: parsed.data.category,
    p_description: parsed.data.description ?? '',
    p_priority: parsed.data.priority ?? 'normal',
    p_customer_id: parsed.data.customer_id ?? null,
    p_merchant_id: parsed.data.merchant_id ?? null,
    p_linked_entity_type: parsed.data.linked_entity_type ?? null,
    p_linked_entity_id: parsed.data.linked_entity_id ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.support.create] RPC error', { error })
    const mapped = mapSupportRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
