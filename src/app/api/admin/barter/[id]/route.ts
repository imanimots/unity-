import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminBarterDetail } from '@/lib/admin/barter-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/admin/barter/[id] -- full agreement detail, admin-only. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: agreementId } = await params
  if (!isValidUuid(agreementId)) {
    return NextResponse.json({ error: 'Invalid barter agreement id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:barter:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const detail = await getAdminBarterDetail(admin, agreementId)
  if (!detail) {
    return NextResponse.json({ error: 'Barter agreement not found' }, { status: 404 })
  }

  return NextResponse.json(detail)
}
