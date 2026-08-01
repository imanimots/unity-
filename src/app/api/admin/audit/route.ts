import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminAuditEntries } from '@/lib/admin/audit-service'
import { csvResponse } from '@/lib/admin/csv'

/** GET /api/admin/audit — unified feed from the three existing immutable admin-action history tables. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:audit:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Audit storage is not configured' }, { status: 503 })
  }

  try {
    const entries = await listAdminAuditEntries(admin)

    const { searchParams } = new URL(request.url)
    if (searchParams.get('format') === 'csv') {
      return csvResponse('audit-log.csv', ['id', 'actorId', 'actionType', 'entityType', 'entityId', 'safeReason', 'result', 'createdAt'], entries)
    }

    return NextResponse.json({ entries })
  } catch (err) {
    console.error('[admin.audit.list] error', err)
    return NextResponse.json({ error: 'Could not load the audit log' }, { status: 500 })
  }
}
