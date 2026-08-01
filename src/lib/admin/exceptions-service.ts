import type { SupabaseClient } from '@supabase/supabase-js'

export type ExceptionSeverity = 'low' | 'medium' | 'high'
export type ExceptionEntityType = 'listing' | 'identity_verification' | 'booking' | 'email_delivery' | 'user'

export interface AdminException {
  id: string
  type: string
  severity: ExceptionSeverity
  entityType: ExceptionEntityType
  entityId: string
  summary: string
  detectedAt: string
  suggestedAction: string
  resolved: boolean
}

const REVIEW_OVERDUE_HOURS = 48

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
}

function exceptionId(type: string, entityId: string): string {
  return `${type}:${entityId}`
}

/**
 * Every category here is computed live from current table state, never
 * stored — "resolved" is tracked separately in exception_resolutions
 * (20260808000002) since several categories have no natural owning row
 * to flag. No category invents an automatic financial fix; every
 * suggestedAction points at an existing admin surface/action.
 */
export async function listOperationalExceptions(admin: SupabaseClient): Promise<AdminException[]> {
  const threshold = hoursAgo(REVIEW_OVERDUE_HOURS)
  const now = new Date().toISOString()

  const [
    { data: overdueListingReviews },
    { data: overdueOwnershipReviews },
    { data: overdueKyc },
    { data: overduePayments },
    { data: retryableWorkflows },
    { data: terminalWorkflows },
    { data: failedEmails },
    { data: overdueRentals },
    { data: suspendedWithBookings },
    { data: lateSuccessfulPayments },
    { data: bookingsMissingWorkflow },
    { data: existingWorkflowBookingIds },
    { data: resolutions },
  ] = await Promise.all([
    admin.from('listing_moderation').select('listing_id, created_at, listings(title)').eq('moderation_status', 'pending').lt('created_at', threshold),
    admin.from('listing_ownership_verification').select('listing_id, status, updated_at, listings(title)').in('status', ['pending', 'under_review']).lt('updated_at', threshold),
    admin.from('identity_verifications').select('user_id, status, updated_at, profiles(full_name, display_name)').in('status', ['pending', 'under_review']).lt('updated_at', threshold),
    admin.from('bookings').select('id, booking_reference, payment_due_at').eq('status', 'accepted').not('payment_due_at', 'is', null).lt('payment_due_at', now).is('payment_expired_at', null),
    admin.from('financial_workflows').select('id, booking_id, updated_at, bookings(booking_reference)').eq('status', 'failed_retryable'),
    admin.from('financial_workflows').select('id, booking_id, updated_at, bookings(booking_reference)').eq('status', 'failed_terminal'),
    admin.from('email_deliveries').select('id, event_type, status, created_at').in('status', ['failed_retryable', 'failed_terminal']),
    admin.from('bookings').select('id, booking_reference, end_at').eq('status', 'active').lt('end_at', now),
    admin.from('profiles').select('id, full_name, display_name').eq('account_status', 'suspended'),
    // A provider success arriving after the booking already expired — the
    // captured payment itself is authoritative and is never auto-reversed
    // here; this only flags the mismatch for a human to reconcile.
    admin
      .from('payments')
      .select('id, booking_id, captured_at, bookings!inner(booking_reference, payment_expired_at)')
      .not('captured_at', 'is', null)
      .not('bookings.payment_expired_at', 'is', null),
    // A booking past the request stage with a non-zero total but no
    // financial_workflows row at all -- the workflow was never even
    // started. Best-effort heuristic, not an authoritative reconciliation.
    admin.from('bookings').select('id, booking_reference, renter_total_amount').in('status', ['accepted', 'active', 'return_pending', 'completed']).gt('renter_total_amount', 0),
    admin.from('financial_workflows').select('booking_id'),
    admin.from('exception_resolutions').select('exception_type, entity_type, entity_id'),
  ])

  const resolvedSet = new Set((resolutions ?? []).map((r) => `${r.exception_type}:${r.entity_type}:${r.entity_id}`))
  const isResolved = (type: string, entityType: string, entityId: string) => resolvedSet.has(`${type}:${entityType}:${entityId}`)

  const exceptions: AdminException[] = []

  for (const row of overdueListingReviews ?? []) {
    exceptions.push({
      id: exceptionId('listing_review_overdue', row.listing_id),
      type: 'listing_review_overdue',
      severity: 'medium',
      entityType: 'listing',
      entityId: row.listing_id,
      summary: `Moderation review pending for "${(row.listings as unknown as { title: string } | null)?.title ?? row.listing_id}" for over ${REVIEW_OVERDUE_HOURS}h`,
      detectedAt: row.created_at,
      suggestedAction: `Open the listing review at /admin/listings/${row.listing_id}`,
      resolved: isResolved('listing_review_overdue', 'listing', row.listing_id),
    })
  }

  for (const row of overdueOwnershipReviews ?? []) {
    exceptions.push({
      id: exceptionId('ownership_review_overdue', row.listing_id),
      type: 'ownership_review_overdue',
      severity: 'medium',
      entityType: 'listing',
      entityId: row.listing_id,
      summary: `Ownership verification "${row.status}" for "${(row.listings as unknown as { title: string } | null)?.title ?? row.listing_id}" for over ${REVIEW_OVERDUE_HOURS}h`,
      detectedAt: row.updated_at,
      suggestedAction: `Open the listing review at /admin/listings/${row.listing_id}`,
      resolved: isResolved('ownership_review_overdue', 'listing', row.listing_id),
    })
  }

  for (const row of overdueKyc ?? []) {
    const name = (row.profiles as unknown as { full_name: string | null; display_name: string | null } | null)
    exceptions.push({
      id: exceptionId('kyc_review_overdue', row.user_id),
      type: 'kyc_review_overdue',
      severity: 'medium',
      entityType: 'identity_verification',
      entityId: row.user_id,
      summary: `KYC review "${row.status}" for ${name?.full_name ?? name?.display_name ?? row.user_id} for over ${REVIEW_OVERDUE_HOURS}h`,
      detectedAt: row.updated_at,
      suggestedAction: `Open the verification review at /admin/verifications/${row.user_id}`,
      resolved: isResolved('kyc_review_overdue', 'identity_verification', row.user_id),
    })
  }

  for (const row of overduePayments ?? []) {
    exceptions.push({
      id: exceptionId('booking_payment_deadline_overdue', row.id),
      type: 'booking_payment_deadline_overdue',
      severity: 'high',
      entityType: 'booking',
      entityId: row.id,
      summary: `Booking ${row.booking_reference} is past its payment deadline and not yet swept as expired`,
      detectedAt: row.payment_due_at,
      suggestedAction: 'Wait for the next expiry sweep, or trigger POST /api/internal/expire-unpaid-bookings',
      resolved: isResolved('booking_payment_deadline_overdue', 'booking', row.id),
    })
  }

  for (const row of retryableWorkflows ?? []) {
    exceptions.push({
      id: exceptionId('workflow_failed_retryable', row.booking_id),
      type: 'workflow_failed_retryable',
      severity: 'high',
      entityType: 'booking',
      entityId: row.booking_id,
      summary: `Financial workflow for ${(row.bookings as unknown as { booking_reference: string } | null)?.booking_reference ?? row.booking_id} failed retryably`,
      detectedAt: row.updated_at,
      suggestedAction: `Inspect at /admin/financial-operations, booking ${row.booking_id}`,
      resolved: isResolved('workflow_failed_retryable', 'booking', row.booking_id),
    })
  }

  for (const row of terminalWorkflows ?? []) {
    exceptions.push({
      id: exceptionId('workflow_failed_terminal', row.booking_id),
      type: 'workflow_failed_terminal',
      severity: 'high',
      entityType: 'booking',
      entityId: row.booking_id,
      summary: `Financial workflow for ${(row.bookings as unknown as { booking_reference: string } | null)?.booking_reference ?? row.booking_id} failed terminally`,
      detectedAt: row.updated_at,
      suggestedAction: `Inspect at /admin/financial-operations, booking ${row.booking_id}`,
      resolved: isResolved('workflow_failed_terminal', 'booking', row.booking_id),
    })
  }

  for (const row of failedEmails ?? []) {
    exceptions.push({
      id: exceptionId('email_delivery_failed', row.id),
      type: 'email_delivery_failed',
      severity: row.status === 'failed_terminal' ? 'medium' : 'low',
      entityType: 'email_delivery',
      entityId: row.id,
      summary: `${row.event_type} email is ${row.status}`,
      detectedAt: row.created_at,
      suggestedAction: row.status === 'failed_retryable' ? `Retry at /admin/email-deliveries` : 'Terminal failure — requires a configuration or code fix, not a retry',
      resolved: isResolved('email_delivery_failed', 'email_delivery', row.id),
    })
  }

  for (const row of overdueRentals ?? []) {
    exceptions.push({
      id: exceptionId('active_rental_overdue', row.id),
      type: 'active_rental_overdue',
      severity: 'medium',
      entityType: 'booking',
      entityId: row.id,
      summary: `Booking ${row.booking_reference} is still active past its scheduled end time`,
      detectedAt: row.end_at,
      suggestedAction: `Inspect at /admin/bookings, booking ${row.id}`,
      resolved: isResolved('active_rental_overdue', 'booking', row.id),
    })
  }

  for (const user of suspendedWithBookings ?? []) {
    const { data: openBookings } = await admin
      .from('bookings')
      .select('id')
      .or(`renter_id.eq.${user.id},merchant_id.eq.${user.id}`)
      .in('status', ['requested', 'accepted', 'active', 'return_pending'])
      .limit(1)
    if (openBookings && openBookings.length > 0) {
      exceptions.push({
        id: exceptionId('suspended_account_with_open_booking', user.id),
        type: 'suspended_account_with_open_booking',
        severity: 'high',
        entityType: 'user',
        entityId: user.id,
        summary: `${user.full_name ?? user.display_name ?? user.id} is suspended but has an open booking`,
        detectedAt: now,
        suggestedAction: `Review at /admin/users, user ${user.id}`,
        resolved: isResolved('suspended_account_with_open_booking', 'user', user.id),
      })
    }
  }

  for (const row of lateSuccessfulPayments ?? []) {
    const booking = row.bookings as unknown as { booking_reference: string; payment_expired_at: string } | null
    if (!booking || !row.captured_at) continue
    if (new Date(row.captured_at).getTime() <= new Date(booking.payment_expired_at).getTime()) continue
    exceptions.push({
      id: exceptionId('late_successful_provider_event', row.id),
      type: 'late_successful_provider_event',
      severity: 'high',
      entityType: 'booking',
      entityId: row.booking_id,
      summary: `Payment for ${booking.booking_reference} was captured after the booking had already expired unpaid`,
      detectedAt: row.captured_at,
      suggestedAction: `Manually reconcile — inspect at /admin/financial-operations, booking ${row.booking_id}`,
      resolved: isResolved('late_successful_provider_event', 'booking', row.id),
    })
  }

  const bookingIdsWithWorkflow = new Set((existingWorkflowBookingIds ?? []).map((w) => w.booking_id))
  for (const row of bookingsMissingWorkflow ?? []) {
    if (bookingIdsWithWorkflow.has(row.id)) continue
    exceptions.push({
      id: exceptionId('booking_missing_financial_workflow', row.id),
      type: 'booking_missing_financial_workflow',
      severity: 'medium',
      entityType: 'booking',
      entityId: row.id,
      summary: `Booking ${row.booking_reference} has a non-zero total but no financial workflow record`,
      detectedAt: now,
      suggestedAction: `Inspect at /admin/bookings, booking ${row.id}`,
      resolved: isResolved('booking_missing_financial_workflow', 'booking', row.id),
    })
  }

  return exceptions.sort((a, b) => (a.resolved === b.resolved ? 0 : a.resolved ? 1 : -1))
}

export async function resolveOperationalException(
  admin: SupabaseClient,
  exceptionType: string,
  entityType: ExceptionEntityType,
  entityId: string,
  adminId: string,
  note: string | null
) {
  return admin.rpc('resolve_exception', {
    p_exception_type: exceptionType,
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_admin_id: adminId,
    p_note: note,
  })
}
