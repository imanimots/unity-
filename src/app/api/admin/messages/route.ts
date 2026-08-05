import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listMessagesQuerySchema } from '@/lib/messaging/validation'
import { getMessagesForAdmin } from '@/lib/messaging/admin'

/**
 * GET /api/admin/messages -- the audited admin read path (Step 11
 * Phase 3 Part E/G). Every call writes one row to
 * admin_message_access_log (inside getMessagesForAdmin) before any
 * message data is returned. Read-only -- there is no admin send route.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:messages')
  if (!gate.ok) return gate.response

  const url = new URL(request.url)
  const parsed = listMessagesQuerySchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Chat storage is not configured' }, { status: 503 })
  }

  const result = await getMessagesForAdmin(admin, gate.requester.userId, {
    bookingId: parsed.data.booking_id,
    orderId: parsed.data.order_id,
    barterAgreementId: parsed.data.barter_agreement_id,
    disputeId: parsed.data.dispute_id,
  })
  if (!result) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  return NextResponse.json({ messages: result.messages })
}
