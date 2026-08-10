import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getAdminRentToBuyAgreementDetail } from '@/lib/admin/rent-to-buy-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid agreement id' }, { status: 400 })

  const gate = await requireAdminForRoute(request, 'admin:rtb:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })

  const detail = await getAdminRentToBuyAgreementDetail(admin, id)
  if (!detail) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 })
  return NextResponse.json(detail)
}
