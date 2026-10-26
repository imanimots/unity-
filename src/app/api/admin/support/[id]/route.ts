import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminSupportCaseDetail } from '@/lib/admin/support-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/admin/support/[id] — full case workspace: case + notes + history. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: caseId } = await params
  if (!isValidUuid(caseId)) {
    return NextResponse.json({ error: 'Invalid case id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:support:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Support storage is not configured' }, { status: 503 })
  }

  try {
    const detail = await getAdminSupportCaseDetail(admin, caseId)
    if (!detail) {
      return NextResponse.json({ error: 'Support case not found' }, { status: 404 })
    }
    return NextResponse.json(detail)
  } catch (err) {
    console.error('[admin.support.detail] error', { caseId, err })
    return NextResponse.json({ error: 'Could not load this support case' }, { status: 500 })
  }
}
