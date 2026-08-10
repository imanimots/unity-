import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminRentToBuyAgreements } from '@/lib/admin/rent-to-buy-service'

export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:rtb:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status') ?? undefined
  const search = searchParams.get('search') ?? undefined

  const agreements = await listAdminRentToBuyAgreements(admin, { status, search })
  return NextResponse.json({ agreements })
}
