import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listFinancialOperations } from '@/lib/admin/operations-service'
import { csvResponse } from '@/lib/admin/csv'

/**
 * GET /api/admin/financial-operations — provider-neutral, normalized
 * financial monitoring. Never returns raw card data, provider payloads,
 * bank details, service keys, or raw webhook content — only the
 * already-normalized `payments`/`financial_workflows`/`ledger_entries`/
 * `merchant_payouts` fields.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:financial-operations:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Financial storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const filters = { status: searchParams.get('status') ?? undefined }

  try {
    const rows = await listFinancialOperations(admin, filters)

    if (searchParams.get('format') === 'csv') {
      return csvResponse(
        'financial-operations.csv',
        ['paymentId', 'bookingReference', 'paymentType', 'status', 'amount', 'currency', 'workflowStatus', 'failureCategory', 'ledgerEntryCount', 'payoutStatus'],
        rows
      )
    }

    return NextResponse.json({ operations: rows })
  } catch (err) {
    console.error('[admin.financial-operations.list] error', err)
    return NextResponse.json({ error: 'Could not load financial operations' }, { status: 500 })
  }
}
