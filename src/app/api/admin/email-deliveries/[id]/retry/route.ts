import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { retryDelivery } from '@/lib/email'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/email-deliveries/[id]/retry — reuses Step 8's
 * retryDelivery() exactly (src/lib/email/service.ts), the same function
 * the secret-authenticated internal sweep route calls. There is no
 * request body accepted at all — the recipient is always the one
 * already stored on the delivery row; this route cannot be used to
 * resend to an arbitrary address. retryDelivery() itself only proceeds
 * if the current status is 'failed_retryable' (a terminal failure is
 * never auto- or admin-retried without a code/config fix).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: deliveryId } = await params
  if (!isValidUuid(deliveryId)) {
    return NextResponse.json({ error: 'Invalid delivery id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:email-deliveries:retry')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Email delivery storage is not configured' }, { status: 503 })
  }

  const result = await retryDelivery(admin, deliveryId)
  return NextResponse.json(result)
}
