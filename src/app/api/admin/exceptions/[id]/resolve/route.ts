import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { resolveOperationalException, type ExceptionEntityType } from '@/lib/admin/exceptions-service'
import { mapAdminOperationsRpcError } from '@/lib/admin/rpc-errors'
import { z } from 'zod'

interface RouteParams {
  params: Promise<{ id: string }>
}

const TYPE_TO_ENTITY_TYPE: Record<string, ExceptionEntityType> = {
  listing_review_overdue: 'listing',
  ownership_review_overdue: 'listing',
  kyc_review_overdue: 'identity_verification',
  booking_payment_deadline_overdue: 'booking',
  workflow_failed_retryable: 'booking',
  workflow_failed_terminal: 'booking',
  email_delivery_failed: 'email_delivery',
  active_rental_overdue: 'booking',
  suspended_account_with_open_booking: 'user',
  late_successful_provider_event: 'booking',
  booking_missing_financial_workflow: 'booking',
}

const bodySchema = z.object({ note: z.string().max(1000).nullable().optional() })

/**
 * POST /api/admin/exceptions/[id]/resolve — id is the exception's own
 * stable id (`${type}:${entityId}`, from src/lib/admin/exceptions-service.ts),
 * never a database primary key the client could forge into pointing at
 * an unrelated record — entityType is derived server-side from the type
 * prefix, never trusted from the client. Idempotent via resolve_exception's
 * upsert (an exact replay just re-touches the same row).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const separatorIndex = id.indexOf(':')
  if (separatorIndex === -1) {
    return NextResponse.json({ error: 'Invalid exception id' }, { status: 400 })
  }
  const exceptionType = id.slice(0, separatorIndex)
  const entityId = id.slice(separatorIndex + 1)
  const entityType = TYPE_TO_ENTITY_TYPE[exceptionType]
  if (!entityType || !/^[0-9a-f-]{36}$/i.test(entityId)) {
    return NextResponse.json({ error: 'Unknown exception type' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:exceptions:resolve')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Exception storage is not configured' }, { status: 503 })
  }

  const { data, error } = await resolveOperationalException(admin, exceptionType, entityType, entityId, gate.requester.userId, parsed.data.note ?? null)

  if (error) {
    console.error('[admin.exceptions.resolve] RPC error', { id, error })
    const mapped = mapAdminOperationsRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
