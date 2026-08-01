import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminEmailDeliveries } from '@/lib/admin/email-deliveries-service'
import { csvResponse } from '@/lib/admin/csv'

/** GET /api/admin/email-deliveries — real delivery records, no template_vars in bulk. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:email-deliveries:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Email delivery storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const filters = { status: searchParams.get('status') ?? undefined, eventType: searchParams.get('event_type') ?? undefined }

  try {
    const deliveries = await listAdminEmailDeliveries(admin, filters)

    if (searchParams.get('format') === 'csv') {
      return csvResponse(
        'email-deliveries.csv',
        ['id', 'eventType', 'templateId', 'recipientEmail', 'status', 'attempts', 'provider', 'createdAt', 'sentAt'],
        deliveries
      )
    }

    return NextResponse.json({ deliveries })
  } catch (err) {
    console.error('[admin.email-deliveries.list] error', err)
    return NextResponse.json({ error: 'Could not load email deliveries' }, { status: 500 })
  }
}
