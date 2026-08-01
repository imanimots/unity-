import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { addNoteSchema } from '@/lib/admin/validation'
import { addAdminNote } from '@/lib/admin/users-service'
import { mapAdminOperationsRpcError } from '@/lib/admin/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/users/[id]/notes — append-only internal note, admin-only read/write. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: userId } = await params
  if (!isValidUuid(userId)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:users:notes')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = addNoteSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Notes storage is not configured' }, { status: 503 })
  }

  const { data, error } = await addAdminNote(admin, 'user', userId, gate.requester.userId, parsed.data.note, parsed.data.idempotency_key)

  if (error) {
    console.error('[admin.users.notes] RPC error', { userId, error })
    const mapped = mapAdminOperationsRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
