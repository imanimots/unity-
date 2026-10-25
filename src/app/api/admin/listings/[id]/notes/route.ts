import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { addNoteSchema } from '@/lib/admin/validation'
import { addAdminNote } from '@/lib/admin/users-service'
import { listAdminNotesForEntity } from '@/lib/admin/notes-service'
import { mapAdminOperationsRpcError } from '@/lib/admin/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/admin/listings/[id]/notes — admin-only read of this listing's internal notes. Never exposed to the merchant/public listing views. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!isValidUuid(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:listings:notes')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Notes storage is not configured' }, { status: 503 })
  }

  try {
    const notes = await listAdminNotesForEntity(admin, 'listing', listingId)
    return NextResponse.json({ notes })
  } catch (err) {
    console.error('[admin.listings.notes] GET error', { listingId, err })
    return NextResponse.json({ error: 'Could not load notes' }, { status: 500 })
  }
}

/** POST /api/admin/listings/[id]/notes — append-only internal note, admin-only read/write. Same `add_admin_note` RPC the user-notes route already uses, which has always accepted entity_type='listing'. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!isValidUuid(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:listings:notes')
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

  const { data, error } = await addAdminNote(admin, 'listing', listingId, gate.requester.userId, parsed.data.note, parsed.data.idempotency_key)

  if (error) {
    console.error('[admin.listings.notes] POST RPC error', { listingId, error })
    const mapped = mapAdminOperationsRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
