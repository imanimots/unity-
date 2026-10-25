import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { addNoteSchema } from '@/lib/admin/validation'
import { addAdminNote } from '@/lib/admin/users-service'
import { listAdminNotesForEntity } from '@/lib/admin/notes-service'
import { mapAdminOperationsRpcError } from '@/lib/admin/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/admin/bookings/[id]/notes — admin-only read of this booking's internal notes. Never exposed to the renter/merchant. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: bookingId } = await params
  if (!isValidUuid(bookingId)) {
    return NextResponse.json({ error: 'Invalid booking id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:bookings:notes')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Notes storage is not configured' }, { status: 503 })
  }

  try {
    const notes = await listAdminNotesForEntity(admin, 'booking', bookingId)
    return NextResponse.json({ notes })
  } catch (err) {
    console.error('[admin.bookings.notes] GET error', { bookingId, err })
    return NextResponse.json({ error: 'Could not load notes' }, { status: 500 })
  }
}

/** POST /api/admin/bookings/[id]/notes — append-only internal note, admin-only read/write. Same `add_admin_note` RPC the user-notes route already uses, which has always accepted entity_type='booking'. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: bookingId } = await params
  if (!isValidUuid(bookingId)) {
    return NextResponse.json({ error: 'Invalid booking id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:bookings:notes')
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

  const { data, error } = await addAdminNote(admin, 'booking', bookingId, gate.requester.userId, parsed.data.note, parsed.data.idempotency_key)

  if (error) {
    console.error('[admin.bookings.notes] POST RPC error', { bookingId, error })
    const mapped = mapAdminOperationsRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
