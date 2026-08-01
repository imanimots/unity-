import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listOperationalExceptions } from '@/lib/admin/exceptions-service'
import { csvResponse } from '@/lib/admin/csv'

/** GET /api/admin/exceptions — one high-value queue computed live from current table state. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:exceptions:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Exception storage is not configured' }, { status: 503 })
  }

  try {
    const exceptions = await listOperationalExceptions(admin)

    const { searchParams } = new URL(request.url)
    if (searchParams.get('format') === 'csv') {
      return csvResponse(
        'exceptions.csv',
        ['id', 'type', 'severity', 'entityType', 'entityId', 'summary', 'detectedAt', 'resolved'],
        exceptions
      )
    }

    return NextResponse.json({ exceptions })
  } catch (err) {
    console.error('[admin.exceptions.list] error', err)
    return NextResponse.json({ error: 'Could not load exceptions' }, { status: 500 })
  }
}
