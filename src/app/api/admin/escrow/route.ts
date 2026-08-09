import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminEscrowTransactions, ADMIN_ESCROW_CSV_COLUMNS } from '@/lib/admin/escrow-service'
import { csvResponse } from '@/lib/admin/csv'

/** GET /api/admin/escrow -- real data, read-only list, no mutating actions on this route. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:escrow:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Escrow storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const filters = {
    search: searchParams.get('search') ?? undefined,
    status: searchParams.get('status') ?? undefined,
  }

  try {
    const escrowTransactions = await listAdminEscrowTransactions(admin, filters)

    if (searchParams.get('format') === 'csv') {
      return csvResponse('escrow-transactions.csv', ADMIN_ESCROW_CSV_COLUMNS, escrowTransactions)
    }

    return NextResponse.json({ escrowTransactions })
  } catch (err) {
    console.error('[admin.escrow.list] error', err)
    return NextResponse.json({ error: 'Could not load escrow transactions' }, { status: 500 })
  }
}
