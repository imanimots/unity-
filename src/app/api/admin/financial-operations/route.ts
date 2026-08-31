import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, parseListLimit } from '@/lib/admin/route-helpers'
import { listFinancialOperations } from '@/lib/admin/operations-service'
import { csvResponse } from '@/lib/admin/csv'
import { InvalidCursorError } from '@/lib/admin/cursor'

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
  const filters = {
    status: searchParams.get('status') ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
    limit: parseListLimit(searchParams.get('limit')),
  }

  try {
    if (searchParams.get('format') === 'csv') {
      const { operations } = await listFinancialOperations(admin, { status: filters.status })
      return csvResponse(
        'financial-operations.csv',
        ['paymentId', 'bookingReference', 'orderReference', 'paymentType', 'status', 'amount', 'currency', 'workflowStatus', 'failureCategory', 'ledgerEntryCount', 'payoutStatus'],
        operations
      )
    }

    const { operations, hasMore, nextCursor } = await listFinancialOperations(admin, filters)
    return NextResponse.json({ operations, hasMore, nextCursor })
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      return NextResponse.json({ error: 'Invalid or expired pagination cursor' }, { status: 400 })
    }
    console.error('[admin.financial-operations.list] error', err)
    return NextResponse.json({ error: 'Could not load financial operations' }, { status: 500 })
  }
}
