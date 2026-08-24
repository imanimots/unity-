import type { SupabaseClient } from '@supabase/supabase-js'
import { deriveBarterFinancialReadiness, type BarterDepositRequirement } from '@/lib/barter/financial-readiness'

export type ExceptionSeverity = 'low' | 'medium' | 'high'
export type ExceptionEntityType =
  | 'listing'
  | 'identity_verification'
  | 'booking'
  | 'email_delivery'
  | 'user'
  | 'dispute'
  | 'barter_agreement'
  | 'order'
  | 'affiliate_commission'
  | 'merchant_payout'
  | 'merchant_subscription'
  | 'unity_commission'

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

  const [{ data: overdueDisputes }] = await Promise.all([
    admin.from('disputes').select('id, title, status, created_at').in('status', ['open', 'evidence', 'under_review']).lt('created_at', threshold),
  ])

  // Step 11 Phase 5 closure -- barter categories, absorbing the former
  // "Phase 5 (Barter Phase C)" roadmap item. Every category mirrors an
  // existing pattern above exactly (overdue reviews, failed payments,
  // suspended-with-open-commitment); no automatic financial correction
  // is invented, every suggestedAction points at an existing admin
  // surface.
  const [
    { data: staleBarterProposals },
    { data: accruedAcceptedBarter },
    { data: failedBarterPayments },
    { data: disputedBarterAgreements },
    { data: staleAwaitingConfirmation },
    { data: heldBarterAgreements },
    { data: frozenCancelledBarter },
    { data: completedWithUnresolvedDeposit },
  ] = await Promise.all([
    admin.from('barter_agreements').select('id, agreement_reference, status, proposed_at').in('status', ['proposed', 'countered']).lt('proposed_at', threshold),
    admin.from('barter_agreements').select('id, agreement_reference, accepted_offer_id, accepted_at, party_a_id, party_b_id').eq('status', 'accepted').not('accepted_at', 'is', null).lt('accepted_at', threshold),
    admin.from('payments').select('id, barter_agreement_id, payment_type, updated_at, barter_agreements(agreement_reference)').in('payment_type', ['barter_deposit', 'barter_cash_adjustment']).eq('status', 'failed'),
    admin.from('barter_agreements').select('id, agreement_reference, updated_at').eq('status', 'disputed'),
    admin.from('barter_agreements').select('id, agreement_reference, updated_at').eq('status', 'awaiting_confirmation').lt('updated_at', threshold),
    admin.from('barter_agreements').select('id, agreement_reference, admin_hold_reason, updated_at').eq('admin_hold', true),
    admin.from('barter_agreements').select('id, agreement_reference, updated_at').eq('status', 'cancelled').eq('cancellation_settlement', 'frozen_pending_dispute'),
    admin.from('payments').select('id, barter_agreement_id, updated_at, barter_agreements(agreement_reference, status)').eq('payment_type', 'barter_deposit').eq('status', 'authorised'),
  ])

  // Step 11 Phase 6 -- order categories. Every category mirrors an
  // existing pattern above exactly (overdue reviews, failed payments,
  // suspended-with-open-commitment); no automatic financial correction
  // is invented, every suggestedAction points at an existing admin
  // surface. order_payment_failed is a single category, not a
  // retryable/terminal split -- orders have no financial_workflows-style
  // stored classification the way bookings do (see
  // docs/ORDER_ADMINISTRATION.md, "failure category").
  const [
    { data: staleUnpaidOrders },
    { data: failedOrderPayments },
    { data: staleAwaitingShipment },
    { data: staleAwaitingDelivery },
    { data: disputedOrders },
    { data: cancelledOrdersWithPayment },
  ] = await Promise.all([
    admin.from('orders').select('id, order_reference, status, created_at').eq('status', 'pending').lt('created_at', threshold),
    admin.from('payments').select('id, order_id, updated_at, orders(order_reference, status)').eq('payment_type', 'order_payment').eq('status', 'failed'),
    admin.from('orders').select('id, order_reference, paid_at').eq('status', 'paid').not('paid_at', 'is', null).lt('paid_at', threshold),
    admin.from('orders').select('id, order_reference, shipped_at').eq('status', 'shipped').not('shipped_at', 'is', null).lt('shipped_at', threshold),
    admin.from('orders').select('id, order_reference, created_at').eq('status', 'disputed'),
    admin.from('payments').select('id, order_id, status, updated_at, orders(order_reference, status)').eq('payment_type', 'order_payment').in('status', ['authorised', 'captured']),
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

  for (const row of overdueDisputes ?? []) {
    exceptions.push({
      id: exceptionId('dispute_open_too_long', row.id),
      type: 'dispute_open_too_long',
      severity: 'high',
      entityType: 'dispute',
      entityId: row.id,
      summary: `Dispute "${row.title}" has been ${row.status.replace('_', ' ')} for over ${REVIEW_OVERDUE_HOURS}h`,
      detectedAt: row.created_at,
      suggestedAction: `Open the dispute at /admin/disputes/${row.id}`,
      resolved: isResolved('dispute_open_too_long', 'dispute', row.id),
    })
  }

  // ── Step 11 Phase 5 closure: barter categories ──

  for (const row of staleBarterProposals ?? []) {
    exceptions.push({
      id: exceptionId('barter_proposal_stale', row.id),
      type: 'barter_proposal_stale',
      severity: 'low',
      entityType: 'barter_agreement',
      entityId: row.id,
      summary: `Trade ${row.agreement_reference} has been "${row.status}" for over ${REVIEW_OVERDUE_HOURS}h with no response`,
      detectedAt: row.proposed_at,
      suggestedAction: `Inspect at /admin/barter/${row.id}`,
      resolved: isResolved('barter_proposal_stale', 'barter_agreement', row.id),
    })
  }

  // Financial readiness re-derived per agreement (not a plain column
  // filter) -- reuses the same deriveBarterFinancialReadiness() the
  // mark_barter_progress RPC and the trade UI both already use, so this
  // exception category can never disagree with what the RPC would
  // actually allow.
  if (accruedAcceptedBarter && accruedAcceptedBarter.length > 0) {
    const offerIds = accruedAcceptedBarter.map((a) => a.accepted_offer_id).filter((id): id is string => !!id)
    const agreementIds = accruedAcceptedBarter.map((a) => a.id)
    const [{ data: offers }, { data: barterPayments }] = await Promise.all([
      offerIds.length
        ? admin.from('barter_offers').select('id, agreement_id, deposit_required, deposit_payer, cash_adjustment_amount').in('id', offerIds)
        : Promise.resolve({ data: [] as { id: string; agreement_id: string; deposit_required: boolean; deposit_payer: string | null; cash_adjustment_amount: number }[] }),
      admin.from('payments').select('barter_agreement_id, payment_type, renter_id, status').in('barter_agreement_id', agreementIds),
    ])
    const offerByAgreement = new Map((offers ?? []).map((o) => [o.agreement_id, o]))

    for (const row of accruedAcceptedBarter) {
      const offer = offerByAgreement.get(row.id)
      if (!offer) continue
      const payments = (barterPayments ?? []).filter((p) => p.barter_agreement_id === row.id)
      const depositRequirements: BarterDepositRequirement[] = []
      if (offer.deposit_required && (offer.deposit_payer === 'party_a' || offer.deposit_payer === 'both')) {
        const payer = payments.find((p) => p.payment_type === 'barter_deposit' && p.renter_id === row.party_a_id)
        depositRequirements.push({ payer: 'party_a', status: (payer?.status as BarterDepositRequirement['status']) ?? 'pending' })
      }
      if (offer.deposit_required && (offer.deposit_payer === 'party_b' || offer.deposit_payer === 'both')) {
        const payer = payments.find((p) => p.payment_type === 'barter_deposit' && p.renter_id === row.party_b_id)
        depositRequirements.push({ payer: 'party_b', status: (payer?.status as BarterDepositRequirement['status']) ?? 'pending' })
      }
      const cashPayment = payments.find((p) => p.payment_type === 'barter_cash_adjustment')
      const readiness = deriveBarterFinancialReadiness({
        depositRequirements,
        cashAdjustmentRequired: offer.cash_adjustment_amount > 0,
        cashAdjustmentStatus: (cashPayment?.status as BarterDepositRequirement['status']) ?? null,
      })
      if (readiness === 'financially_ready' || readiness === 'no_payment_required') continue

      exceptions.push({
        id: exceptionId('barter_accepted_awaiting_financial_readiness', row.id),
        type: 'barter_accepted_awaiting_financial_readiness',
        severity: 'medium',
        entityType: 'barter_agreement',
        entityId: row.id,
        summary: `Trade ${row.agreement_reference} has been accepted for over ${REVIEW_OVERDUE_HOURS}h but is still not financially ready`,
        detectedAt: row.accepted_at,
        suggestedAction: `Inspect at /admin/barter/${row.id}`,
        resolved: isResolved('barter_accepted_awaiting_financial_readiness', 'barter_agreement', row.id),
      })
    }
  }

  for (const row of failedBarterPayments ?? []) {
    const ref = (row.barter_agreements as unknown as { agreement_reference: string } | null)?.agreement_reference ?? row.barter_agreement_id
    exceptions.push({
      id: exceptionId('barter_payment_failed', row.id),
      type: 'barter_payment_failed',
      severity: 'high',
      entityType: 'barter_agreement',
      entityId: row.barter_agreement_id,
      summary: `A ${row.payment_type === 'barter_deposit' ? 'deposit' : 'cash adjustment'} payment failed on trade ${ref}`,
      detectedAt: row.updated_at,
      suggestedAction: `Inspect at /admin/barter/${row.barter_agreement_id}`,
      resolved: isResolved('barter_payment_failed', 'barter_agreement', row.barter_agreement_id),
    })
  }

  for (const row of disputedBarterAgreements ?? []) {
    exceptions.push({
      id: exceptionId('barter_disputed', row.id),
      type: 'barter_disputed',
      severity: 'high',
      entityType: 'barter_agreement',
      entityId: row.id,
      summary: `Trade ${row.agreement_reference} is currently disputed`,
      detectedAt: row.updated_at,
      suggestedAction: `Review the linked dispute, then inspect the trade at /admin/barter/${row.id}`,
      resolved: isResolved('barter_disputed', 'barter_agreement', row.id),
    })
  }

  for (const row of staleAwaitingConfirmation ?? []) {
    exceptions.push({
      id: exceptionId('barter_awaiting_confirmation_stale', row.id),
      type: 'barter_awaiting_confirmation_stale',
      severity: 'medium',
      entityType: 'barter_agreement',
      entityId: row.id,
      summary: `Trade ${row.agreement_reference} has been awaiting completion confirmation for over ${REVIEW_OVERDUE_HOURS}h`,
      detectedAt: row.updated_at,
      suggestedAction: `Inspect at /admin/barter/${row.id}`,
      resolved: isResolved('barter_awaiting_confirmation_stale', 'barter_agreement', row.id),
    })
  }

  for (const row of heldBarterAgreements ?? []) {
    exceptions.push({
      id: exceptionId('barter_admin_held', row.id),
      type: 'barter_admin_held',
      severity: 'low',
      entityType: 'barter_agreement',
      entityId: row.id,
      summary: `Trade ${row.agreement_reference} is on admin hold${row.admin_hold_reason ? `: ${row.admin_hold_reason}` : ''}`,
      detectedAt: row.updated_at,
      suggestedAction: `Review and release the hold at /admin/barter/${row.id} if appropriate`,
      resolved: isResolved('barter_admin_held', 'barter_agreement', row.id),
    })
  }

  for (const row of frozenCancelledBarter ?? []) {
    exceptions.push({
      id: exceptionId('barter_cancelled_frozen_pending_dispute', row.id),
      type: 'barter_cancelled_frozen_pending_dispute',
      severity: 'high',
      entityType: 'barter_agreement',
      entityId: row.id,
      summary: `Trade ${row.agreement_reference} was cancelled with funds frozen pending dispute resolution -- no automatic settlement exists yet`,
      detectedAt: row.updated_at,
      suggestedAction: `Manually reconcile — inspect at /admin/barter/${row.id}`,
      resolved: isResolved('barter_cancelled_frozen_pending_dispute', 'barter_agreement', row.id),
    })
  }

  for (const row of completedWithUnresolvedDeposit ?? []) {
    const agreementInfo = row.barter_agreements as unknown as { agreement_reference: string; status: string } | null
    if (agreementInfo?.status !== 'completed') continue
    exceptions.push({
      id: exceptionId('barter_completed_with_unresolved_deposit', row.id),
      type: 'barter_completed_with_unresolved_deposit',
      severity: 'high',
      entityType: 'barter_agreement',
      entityId: row.barter_agreement_id,
      summary: `Trade ${agreementInfo.agreement_reference} is completed but a deposit was never released -- data inconsistency, requires manual reconciliation`,
      detectedAt: row.updated_at,
      suggestedAction: `Manually reconcile — inspect at /admin/barter/${row.barter_agreement_id}`,
      resolved: isResolved('barter_completed_with_unresolved_deposit', 'barter_agreement', row.barter_agreement_id),
    })
  }

  // ── Step 11 Phase 6: order categories ──

  for (const row of staleUnpaidOrders ?? []) {
    exceptions.push({
      id: exceptionId('order_awaiting_payment_too_long', row.id),
      type: 'order_awaiting_payment_too_long',
      severity: 'medium',
      entityType: 'order',
      entityId: row.id,
      summary: `Order ${row.order_reference} has been awaiting payment for over ${REVIEW_OVERDUE_HOURS}h`,
      detectedAt: row.created_at,
      suggestedAction: `Inspect at /admin/orders/${row.id}`,
      resolved: isResolved('order_awaiting_payment_too_long', 'order', row.id),
    })
  }

  for (const row of failedOrderPayments ?? []) {
    const order = row.orders as unknown as { order_reference: string; status: string } | null
    if (order?.status !== 'pending') continue
    exceptions.push({
      id: exceptionId('order_payment_failed', row.order_id),
      type: 'order_payment_failed',
      severity: 'high',
      entityType: 'order',
      entityId: row.order_id,
      summary: `Payment failed for order ${order.order_reference}`,
      detectedAt: row.updated_at,
      suggestedAction: `Inspect at /admin/orders/${row.order_id}`,
      resolved: isResolved('order_payment_failed', 'order', row.order_id),
    })
  }

  for (const row of staleAwaitingShipment ?? []) {
    exceptions.push({
      id: exceptionId('order_paid_awaiting_shipment_too_long', row.id),
      type: 'order_paid_awaiting_shipment_too_long',
      severity: 'medium',
      entityType: 'order',
      entityId: row.id,
      summary: `Order ${row.order_reference} has been paid and awaiting shipment for over ${REVIEW_OVERDUE_HOURS}h`,
      detectedAt: row.paid_at,
      suggestedAction: `Inspect at /admin/orders/${row.id}`,
      resolved: isResolved('order_paid_awaiting_shipment_too_long', 'order', row.id),
    })
  }

  for (const row of staleAwaitingDelivery ?? []) {
    exceptions.push({
      id: exceptionId('order_shipped_awaiting_delivery_too_long', row.id),
      type: 'order_shipped_awaiting_delivery_too_long',
      severity: 'medium',
      entityType: 'order',
      entityId: row.id,
      summary: `Order ${row.order_reference} has been shipped and awaiting delivery confirmation for over ${REVIEW_OVERDUE_HOURS}h`,
      detectedAt: row.shipped_at,
      suggestedAction: `Inspect at /admin/orders/${row.id}`,
      resolved: isResolved('order_shipped_awaiting_delivery_too_long', 'order', row.id),
    })
  }

  for (const row of disputedOrders ?? []) {
    exceptions.push({
      id: exceptionId('order_disputed', row.id),
      type: 'order_disputed',
      severity: 'high',
      entityType: 'order',
      entityId: row.id,
      summary: `Order ${row.order_reference} is currently disputed`,
      detectedAt: row.created_at,
      suggestedAction: `Review the linked dispute, then inspect the order at /admin/orders/${row.id}`,
      resolved: isResolved('order_disputed', 'order', row.id),
    })
  }

  for (const row of cancelledOrdersWithPayment ?? []) {
    const order = row.orders as unknown as { order_reference: string; status: string } | null
    if (order?.status !== 'cancelled') continue
    exceptions.push({
      id: exceptionId('order_cancelled_with_unresolved_payment', row.order_id),
      type: 'order_cancelled_with_unresolved_payment',
      severity: 'high',
      entityType: 'order',
      entityId: row.order_id,
      summary: `Order ${order.order_reference} was cancelled but its payment is still ${row.status} -- no automatic refund exists yet`,
      detectedAt: row.updated_at,
      suggestedAction: `Manually reconcile — inspect at /admin/orders/${row.order_id}`,
      resolved: isResolved('order_cancelled_with_unresolved_payment', 'order', row.order_id),
    })
  }

  for (const user of suspendedWithBookings ?? []) {
    const { data: openOrders } = await admin
      .from('orders')
      .select('id')
      .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
      .in('status', ['pending', 'paid', 'shipped'])
      .limit(1)
    if (openOrders && openOrders.length > 0) {
      exceptions.push({
        id: exceptionId('suspended_account_with_open_order', user.id),
        type: 'suspended_account_with_open_order',
        severity: 'high',
        entityType: 'user',
        entityId: user.id,
        summary: `${user.full_name ?? user.display_name ?? user.id} is suspended but has an open order`,
        detectedAt: now,
        suggestedAction: `Review at /admin/users, user ${user.id}`,
        resolved: isResolved('suspended_account_with_open_order', 'user', user.id),
      })
    }
  }

  // ── Step 11 Phase 7: affiliate commission categories ──
  // "successful eligible payment missing commission" is deliberately
  // NOT built as a live-computed category here -- detecting it
  // correctly requires a 3-way join (payment -> transaction -> a
  // matching attribution -> anti-join against affiliate_commissions)
  // that's either expensive on every admin page load or, restricted to
  // a narrow recent window, would rarely have a real candidate anyway
  // (qualification runs synchronously inside the same payment-capture
  // call in the overwhelming majority of cases; a genuine miss is a
  // rare best-effort-call failure already logged via console.error).
  // Documented as a known limitation, not silently dropped.
  const [
    { data: stalePendingCommissions },
    { data: staleHeldCommissions },
    { data: staleApprovedCommissions },
    { data: stalePayoutQueuedCommissions },
    { data: failedPayoutCommissions },
    { data: staleProcessingCommissions },
    { data: paidCommissionsForRefundCheck },
    { data: suspendedAffiliates },
  ] = await Promise.all([
    admin.from('affiliate_commissions').select('id, listing_id, created_at').eq('status', 'pending').lt('created_at', threshold),
    admin.from('affiliate_commissions').select('id, listing_id, updated_at').eq('status', 'held').lt('updated_at', threshold),
    admin.from('affiliate_commissions').select('id, listing_id, approved_at').eq('status', 'approved').not('approved_at', 'is', null).lt('approved_at', threshold),
    admin.from('affiliate_commissions').select('id, listing_id, updated_at').eq('status', 'payout_queued').lt('updated_at', threshold),
    admin.from('affiliate_commissions').select('id, listing_id, updated_at').eq('status', 'failed'),
    admin.from('affiliate_commissions').select('id, listing_id, payout_requested_at').eq('status', 'processing').not('payout_requested_at', 'is', null).lt('payout_requested_at', threshold),
    admin.from('affiliate_commissions').select('id, listing_id, updated_at, payments(status)').eq('status', 'paid'),
    admin.from('profiles').select('id, full_name, display_name').eq('is_affiliate', true).eq('account_status', 'suspended'),
  ])

  for (const row of stalePendingCommissions ?? []) {
    exceptions.push({
      id: exceptionId('affiliate_commission_pending_stale', row.id),
      type: 'affiliate_commission_pending_stale',
      severity: 'medium',
      entityType: 'affiliate_commission',
      entityId: row.id,
      summary: `Commission has been pending review for over ${REVIEW_OVERDUE_HOURS}h`,
      detectedAt: row.created_at,
      suggestedAction: `Inspect at /admin/affiliate-commissions/${row.id}`,
      resolved: isResolved('affiliate_commission_pending_stale', 'affiliate_commission', row.id),
    })
  }

  for (const row of staleHeldCommissions ?? []) {
    exceptions.push({
      id: exceptionId('affiliate_commission_held_stale', row.id),
      type: 'affiliate_commission_held_stale',
      severity: 'medium',
      entityType: 'affiliate_commission',
      entityId: row.id,
      summary: `Commission has been on hold for over ${REVIEW_OVERDUE_HOURS}h`,
      detectedAt: row.updated_at,
      suggestedAction: `Review and release or void at /admin/affiliate-commissions/${row.id}`,
      resolved: isResolved('affiliate_commission_held_stale', 'affiliate_commission', row.id),
    })
  }

  for (const row of staleApprovedCommissions ?? []) {
    exceptions.push({
      id: exceptionId('affiliate_commission_approved_not_queued', row.id),
      type: 'affiliate_commission_approved_not_queued',
      severity: 'medium',
      entityType: 'affiliate_commission',
      entityId: row.id,
      summary: `Commission was approved over ${REVIEW_OVERDUE_HOURS}h ago but has not been queued for payout -- the queue-payouts sweep may be stuck`,
      detectedAt: row.approved_at,
      suggestedAction: `Inspect at /admin/affiliate-commissions/${row.id}`,
      resolved: isResolved('affiliate_commission_approved_not_queued', 'affiliate_commission', row.id),
    })
  }

  for (const row of stalePayoutQueuedCommissions ?? []) {
    exceptions.push({
      id: exceptionId('affiliate_commission_payout_stuck', row.id),
      type: 'affiliate_commission_payout_stuck',
      severity: 'high',
      entityType: 'affiliate_commission',
      entityId: row.id,
      summary: `Commission has been payout-queued for over ${REVIEW_OVERDUE_HOURS}h without processing -- the process-payouts sweep may be stuck`,
      detectedAt: row.updated_at,
      suggestedAction: `Inspect at /admin/affiliate-commissions/${row.id}`,
      resolved: isResolved('affiliate_commission_payout_stuck', 'affiliate_commission', row.id),
    })
  }

  for (const row of failedPayoutCommissions ?? []) {
    exceptions.push({
      id: exceptionId('affiliate_commission_payout_failed', row.id),
      type: 'affiliate_commission_payout_failed',
      severity: 'high',
      entityType: 'affiliate_commission',
      entityId: row.id,
      summary: `A payout attempt failed for this commission`,
      detectedAt: row.updated_at,
      suggestedAction: `Retry or record a manual payout at /admin/affiliate-commissions/${row.id}`,
      resolved: isResolved('affiliate_commission_payout_failed', 'affiliate_commission', row.id),
    })
  }

  for (const row of staleProcessingCommissions ?? []) {
    exceptions.push({
      id: exceptionId('affiliate_commission_provider_result_not_reconciled', row.id),
      type: 'affiliate_commission_provider_result_not_reconciled',
      severity: 'high',
      entityType: 'affiliate_commission',
      entityId: row.id,
      summary: `Commission has been processing for over ${REVIEW_OVERDUE_HOURS}h with no provider result recorded`,
      detectedAt: row.payout_requested_at,
      suggestedAction: `Manually reconcile — inspect at /admin/affiliate-commissions/${row.id}`,
      resolved: isResolved('affiliate_commission_provider_result_not_reconciled', 'affiliate_commission', row.id),
    })
  }

  for (const row of paidCommissionsForRefundCheck ?? []) {
    const paymentStatus = (row.payments as unknown as { status: string } | null)?.status
    if (!paymentStatus || !['refunded', 'partially_refunded', 'chargeback'].includes(paymentStatus)) continue
    exceptions.push({
      id: exceptionId('affiliate_commission_paid_then_refunded', row.id),
      type: 'affiliate_commission_paid_then_refunded',
      severity: 'high',
      entityType: 'affiliate_commission',
      entityId: row.id,
      summary: `This commission was already paid, but its underlying payment is now ${paymentStatus} -- requires admin review before any recovery`,
      detectedAt: row.updated_at,
      suggestedAction: `Manually reconcile — consider an append-only adjustment at /admin/affiliate-commissions/${row.id}`,
      resolved: isResolved('affiliate_commission_paid_then_refunded', 'affiliate_commission', row.id),
    })
  }

  for (const affiliate of suspendedAffiliates ?? []) {
    const { data: openCommissions } = await admin
      .from('affiliate_commissions')
      .select('id')
      .eq('affiliate_id', affiliate.id)
      .in('status', ['pending', 'held', 'approved', 'payout_queued', 'processing'])
      .limit(1)
    if (openCommissions && openCommissions.length > 0) {
      exceptions.push({
        id: exceptionId('suspended_affiliate_with_open_commissions', affiliate.id),
        type: 'suspended_affiliate_with_open_commissions',
        severity: 'high',
        entityType: 'user',
        entityId: affiliate.id,
        summary: `${affiliate.full_name ?? affiliate.display_name ?? affiliate.id} is suspended but has open affiliate commissions`,
        detectedAt: now,
        suggestedAction: `Review at /admin/users, user ${affiliate.id}`,
        resolved: isResolved('suspended_affiliate_with_open_commissions', 'user', affiliate.id),
      })
    }
  }

  // ------------------------------------------------------------
  // Step 11 Phase 8: merchant payout categories. refund_block and
  // chargeback_block from the spec's suggested list are folded into
  // merchant_payout_source_payment_invalid -- all three describe the
  // same underlying fact (the rental payment is no longer 'captured'
  // for an unpaid payout), so three near-identical categories would
  // just be noise. Read-only detection only, matching every other
  // category in this file -- nothing here ever mutates a payout.
  // ------------------------------------------------------------
  const [
    { data: stalePendingPayouts },
    { data: staleProcessingPayouts },
    { data: failedPayouts },
    { data: allPayoutsForDuplicateCheck },
    { data: nonPendingPayoutIds },
    { data: historyRows },
  ] = await Promise.all([
    admin.from('merchant_payouts').select('id, created_at').eq('status', 'pending').lt('created_at', threshold),
    admin.from('merchant_payouts').select('id, processing_started_at').eq('status', 'processing').not('processing_started_at', 'is', null).lt('processing_started_at', threshold),
    admin.from('merchant_payouts').select('id, updated_at').eq('status', 'failed'),
    admin.from('merchant_payouts').select('id, booking_id, created_at'),
    admin.from('merchant_payouts').select('id, status, processing_started_by').neq('status', 'pending'),
    admin.from('merchant_payout_history').select('payout_id'),
  ])

  // Wave 2C -- payout query scalability, final correction. The prior fix
  // (_merchant_payout_relevant_context(uuid[])) removed the PostgREST
  // URL/header overflow but was still fed by an unbounded, all-time
  // Node-side query (`status = 'paid'` has no time bound -- 'paid' is
  // terminal, so that set only grows). Replaced by
  // _merchant_payout_exception_candidates() (migration
  // 20260904000005_payout_exception_context_relational.sql): a single
  // PARAMETERLESS RPC that begins from merchant_payouts itself and joins
  // to payments/disputes/profiles entirely server-side, applying every
  // exception predicate (source-payment-invalid, unresolved-dispute,
  // restricted-merchant, paid-then-refunded, paid-then-disputed,
  // paid-without-reference) in the SQL WHERE clause. No id list of any
  // size, still or ever, crosses this boundary -- the returned row set is
  // bounded to "payouts currently exhibiting an exception", which does
  // not grow with total historical payout volume.
  interface PayoutExceptionCandidateRow {
    payout_id: string
    booking_id: string | null
    merchant_id: string
    status: 'pending' | 'processing' | 'paid'
    updated_at: string
    provider_reference: string | null
    rental_payment_status: string | null
    has_blocking_dispute: boolean
    merchant_account_status: string | null
  }

  const { data: payoutExceptionCandidates } = await (admin.rpc('_merchant_payout_exception_candidates') as unknown as Promise<{ data: PayoutExceptionCandidateRow[] | null }>)

  for (const payout of payoutExceptionCandidates ?? []) {
    if (!payout.booking_id) continue
    if (payout.status === 'pending' || payout.status === 'processing') {
      if (payout.rental_payment_status && payout.rental_payment_status !== 'captured') {
        exceptions.push({
          id: exceptionId('merchant_payout_source_payment_invalid', payout.payout_id),
          type: 'merchant_payout_source_payment_invalid',
          severity: 'high',
          entityType: 'merchant_payout',
          entityId: payout.payout_id,
          summary: `This unpaid payout's source rental payment is now "${payout.rental_payment_status}" -- processing must not continue`,
          detectedAt: now,
          suggestedAction: `Review at /admin/payouts/${payout.payout_id}`,
          resolved: isResolved('merchant_payout_source_payment_invalid', 'merchant_payout', payout.payout_id),
        })
      }
      if (payout.has_blocking_dispute) {
        exceptions.push({
          id: exceptionId('merchant_payout_unresolved_dispute', payout.payout_id),
          type: 'merchant_payout_unresolved_dispute',
          severity: 'high',
          entityType: 'merchant_payout',
          entityId: payout.payout_id,
          summary: 'This payout is blocked by an unresolved dispute on its source booking',
          detectedAt: now,
          suggestedAction: `Review the linked dispute at /admin/payouts/${payout.payout_id}`,
          resolved: isResolved('merchant_payout_unresolved_dispute', 'merchant_payout', payout.payout_id),
        })
      }
      if (payout.merchant_account_status === 'suspended' || payout.merchant_account_status === 'restricted') {
        exceptions.push({
          id: exceptionId('merchant_payout_restricted_merchant', payout.payout_id),
          type: 'merchant_payout_restricted_merchant',
          severity: 'high',
          entityType: 'merchant_payout',
          entityId: payout.payout_id,
          summary: 'This payout belongs to a suspended or restricted merchant',
          detectedAt: now,
          suggestedAction: `Review the merchant account at /admin/users, then /admin/payouts/${payout.payout_id}`,
          resolved: isResolved('merchant_payout_restricted_merchant', 'merchant_payout', payout.payout_id),
        })
      }
    }
  }

  for (const row of stalePendingPayouts ?? []) {
    exceptions.push({
      id: exceptionId('merchant_payout_pending_overdue', row.id),
      type: 'merchant_payout_pending_overdue',
      severity: 'medium',
      entityType: 'merchant_payout',
      entityId: row.id,
      summary: `Payout has been pending for over ${REVIEW_OVERDUE_HOURS}h`,
      detectedAt: row.created_at,
      suggestedAction: `Inspect at /admin/payouts/${row.id}`,
      resolved: isResolved('merchant_payout_pending_overdue', 'merchant_payout', row.id),
    })
  }

  for (const row of staleProcessingPayouts ?? []) {
    exceptions.push({
      id: exceptionId('merchant_payout_processing_overdue', row.id),
      type: 'merchant_payout_processing_overdue',
      severity: 'medium',
      entityType: 'merchant_payout',
      entityId: row.id,
      summary: `Payout has been processing for over ${REVIEW_OVERDUE_HOURS}h with no resolution`,
      detectedAt: row.processing_started_at,
      suggestedAction: `Mark paid or failed at /admin/payouts/${row.id}`,
      resolved: isResolved('merchant_payout_processing_overdue', 'merchant_payout', row.id),
    })
  }

  for (const row of failedPayouts ?? []) {
    exceptions.push({
      id: exceptionId('merchant_payout_failed', row.id),
      type: 'merchant_payout_failed',
      severity: 'medium',
      entityType: 'merchant_payout',
      entityId: row.id,
      summary: 'Payout is in a failed state and awaiting retry or review',
      detectedAt: row.updated_at,
      suggestedAction: `Retry or review at /admin/payouts/${row.id}`,
      resolved: isResolved('merchant_payout_failed', 'merchant_payout', row.id),
    })
  }

  for (const payout of payoutExceptionCandidates ?? []) {
    if (!payout.booking_id || payout.status !== 'paid') continue
    if (payout.rental_payment_status && ['refunded', 'partially_refunded', 'chargeback'].includes(payout.rental_payment_status)) {
      exceptions.push({
        id: exceptionId('merchant_payout_paid_then_refunded', payout.payout_id),
        type: 'merchant_payout_paid_then_refunded',
        severity: 'high',
        entityType: 'merchant_payout',
        entityId: payout.payout_id,
        summary: `This payout was already paid, but its source payment is now "${payout.rental_payment_status}" -- requires admin review before any recovery`,
        detectedAt: payout.updated_at,
        suggestedAction: `Manually reconcile at /admin/payouts/${payout.payout_id} -- do not rewrite the paid record`,
        resolved: isResolved('merchant_payout_paid_then_refunded', 'merchant_payout', payout.payout_id),
      })
    }
    if (payout.has_blocking_dispute) {
      exceptions.push({
        id: exceptionId('merchant_payout_paid_then_disputed', payout.payout_id),
        type: 'merchant_payout_paid_then_disputed',
        severity: 'high',
        entityType: 'merchant_payout',
        entityId: payout.payout_id,
        summary: 'This payout was already paid, but a dispute has since opened on its source booking',
        detectedAt: now,
        suggestedAction: `Review the linked dispute at /admin/payouts/${payout.payout_id} -- do not rewrite the paid record`,
        resolved: isResolved('merchant_payout_paid_then_disputed', 'merchant_payout', payout.payout_id),
      })
    }
    if (!payout.provider_reference) {
      exceptions.push({
        id: exceptionId('merchant_payout_paid_without_reference', payout.payout_id),
        type: 'merchant_payout_paid_without_reference',
        severity: 'medium',
        entityType: 'merchant_payout',
        entityId: payout.payout_id,
        summary: 'Payout is marked paid but has no recorded payout reference',
        detectedAt: payout.updated_at,
        suggestedAction: `Investigate at /admin/payouts/${payout.payout_id}`,
        resolved: isResolved('merchant_payout_paid_without_reference', 'merchant_payout', payout.payout_id),
      })
    }
  }

  const bookingPayoutCounts = new Map<string, number>()
  for (const row of allPayoutsForDuplicateCheck ?? []) {
    if (!row.booking_id) continue
    bookingPayoutCounts.set(row.booking_id, (bookingPayoutCounts.get(row.booking_id) ?? 0) + 1)
  }
  for (const row of allPayoutsForDuplicateCheck ?? []) {
    if (!row.booking_id || (bookingPayoutCounts.get(row.booking_id) ?? 0) <= 1) continue
    exceptions.push({
      id: exceptionId('merchant_payout_duplicate', row.id),
      type: 'merchant_payout_duplicate',
      severity: 'high',
      entityType: 'merchant_payout',
      entityId: row.id,
      summary: 'More than one payout row exists for the same source booking',
      detectedAt: row.created_at,
      suggestedAction: `Investigate at /admin/payouts/${row.id}`,
      resolved: isResolved('merchant_payout_duplicate', 'merchant_payout', row.id),
    })
  }

  const historyPayoutIds = new Set((historyRows ?? []).map((h) => h.payout_id))
  for (const row of nonPendingPayoutIds ?? []) {
    if (historyPayoutIds.has(row.id)) continue
    exceptions.push({
      id: exceptionId('merchant_payout_missing_history', row.id),
      type: 'merchant_payout_missing_history',
      severity: 'high',
      entityType: 'merchant_payout',
      entityId: row.id,
      summary: `Payout is in status "${row.status}" but has no immutable history record -- integrity issue`,
      detectedAt: now,
      suggestedAction: `Investigate at /admin/payouts/${row.id}`,
      resolved: isResolved('merchant_payout_missing_history', 'merchant_payout', row.id),
    })
    if (row.status === 'processing' && !row.processing_started_by) {
      exceptions.push({
        id: exceptionId('merchant_payout_processing_without_actor', row.id),
        type: 'merchant_payout_processing_without_actor',
        severity: 'medium',
        entityType: 'merchant_payout',
        entityId: row.id,
        summary: 'Payout is processing but has no recorded actor who started it',
        detectedAt: now,
        suggestedAction: `Investigate at /admin/payouts/${row.id}`,
        resolved: isResolved('merchant_payout_processing_without_actor', 'merchant_payout', row.id),
      })
    }
  }

  const bookingIdsWithPayout = new Set((allPayoutsForDuplicateCheck ?? []).map((p) => p.booking_id).filter(Boolean))
  const { data: completedBookingsForMissingPayout } = await admin
    .from('bookings')
    .select('id')
    .eq('status', 'completed')
  for (const booking of completedBookingsForMissingPayout ?? []) {
    if (bookingIdsWithPayout.has(booking.id)) continue
    const { data: capturedRental } = await admin
      .from('payments')
      .select('id')
      .eq('booking_id', booking.id)
      .eq('payment_type', 'rental_charge')
      .eq('status', 'captured')
      .maybeSingle()
    if (!capturedRental) continue
    exceptions.push({
      id: exceptionId('merchant_payout_missing_for_completed_booking', booking.id),
      type: 'merchant_payout_missing_for_completed_booking',
      severity: 'high',
      entityType: 'booking',
      entityId: booking.id,
      summary: 'This booking is completed with a captured rental payment but has no payout record -- run the reconcile-missing sweep or investigate',
      detectedAt: now,
      suggestedAction: 'POST /api/internal/payouts/reconcile-missing, or inspect the booking directly',
      resolved: isResolved('merchant_payout_missing_for_completed_booking', 'booking', booking.id),
    })
  }

  // ------------------------------------------------------------
  // Unity Phase 1: merchant subscription categories. Read-only
  // detection only -- nothing here mutates a subscription; every
  // suggestedAction points at the admin subscription detail page or the
  // existing admin_correct_merchant_subscription action.
  // ------------------------------------------------------------
  const [{ data: overduePendingChanges }, { data: recentBillingAttempts }] = await Promise.all([
    admin
      .from('merchant_subscriptions')
      .select('id, merchant_id, status, pending_plan_id, pending_plan_effective_at')
      .in('status', ['pending_change', 'cancelled'])
      .lt('pending_plan_effective_at', threshold),
    admin
      .from('merchant_subscription_billing_attempts')
      .select('merchant_id, status, created_at')
      .gte('created_at', threshold),
  ])

  for (const row of overduePendingChanges ?? []) {
    exceptions.push({
      id: exceptionId('merchant_subscription_pending_change_overdue', row.id),
      type: 'merchant_subscription_pending_change_overdue',
      severity: 'medium',
      entityType: 'merchant_subscription',
      entityId: row.merchant_id,
      summary: `A scheduled plan change to "${row.pending_plan_id}" was due over ${REVIEW_OVERDUE_HOURS}h ago and has not yet been applied -- the lazy sweep may not be running for this merchant`,
      detectedAt: row.pending_plan_effective_at,
      suggestedAction: `Review at /admin/subscriptions/${row.merchant_id}, or invoke apply_due_merchant_subscription_changes()`,
      resolved: isResolved('merchant_subscription_pending_change_overdue', 'merchant_subscription', row.merchant_id),
    })
  }

  const billingAttemptsByMerchant = new Map<string, { failed: number; succeeded: number }>()
  for (const row of recentBillingAttempts ?? []) {
    const entry = billingAttemptsByMerchant.get(row.merchant_id) ?? { failed: 0, succeeded: 0 }
    if (row.status === 'failed') entry.failed += 1
    if (row.status === 'succeeded') entry.succeeded += 1
    billingAttemptsByMerchant.set(row.merchant_id, entry)
  }
  for (const [merchantId, counts] of billingAttemptsByMerchant) {
    if (counts.failed >= 3 && counts.succeeded === 0) {
      exceptions.push({
        id: exceptionId('merchant_subscription_repeated_billing_failures', merchantId),
        type: 'merchant_subscription_repeated_billing_failures',
        severity: 'medium',
        entityType: 'merchant_subscription',
        entityId: merchantId,
        summary: `This merchant has had ${counts.failed} failed subscription billing attempts in the last ${REVIEW_OVERDUE_HOURS}h with no success`,
        detectedAt: now,
        suggestedAction: `Review at /admin/subscriptions/${merchantId}`,
        resolved: isResolved('merchant_subscription_repeated_billing_failures', 'merchant_subscription', merchantId),
      })
    }
  }

  // ------------------------------------------------------------
  // Unity Phase 2: Unity commission categories. Read-only detection
  // only -- nothing here mutates a commission.
  // ------------------------------------------------------------
  const { data: overdueHeldCommissions } = await admin
    .from('unity_commissions')
    .select('id, merchant_id, updated_at')
    .eq('status', 'held')
    .lt('updated_at', threshold)

  for (const row of overdueHeldCommissions ?? []) {
    exceptions.push({
      id: exceptionId('unity_commission_held_overdue', row.id),
      type: 'unity_commission_held_overdue',
      severity: 'medium',
      entityType: 'unity_commission',
      entityId: row.id,
      summary: `This commission has been held for over ${REVIEW_OVERDUE_HOURS}h -- the underlying dispute may need attention`,
      detectedAt: row.updated_at,
      suggestedAction: `Review at /admin/commissions/${row.id}`,
      resolved: isResolved('unity_commission_held_overdue', 'unity_commission', row.id),
    })
  }

  const [{ data: capturedOrderPayments }, { data: qualifiedOrderPaymentIds }] = await Promise.all([
    admin.from('payments').select('id, order_id, captured_at').eq('payment_type', 'order_payment').eq('status', 'captured').lt('captured_at', threshold),
    admin.from('unity_commissions').select('payment_id').eq('transaction_type', 'sale'),
  ])
  const qualifiedOrderPaymentIdSet = new Set((qualifiedOrderPaymentIds ?? []).map((r) => r.payment_id))
  for (const payment of capturedOrderPayments ?? []) {
    if (qualifiedOrderPaymentIdSet.has(payment.id)) continue
    exceptions.push({
      id: exceptionId('unity_commission_missing_for_sale', payment.id),
      type: 'unity_commission_missing_for_sale',
      severity: 'high',
      entityType: 'order',
      entityId: payment.order_id,
      summary: 'This order payment captured successfully but no Unity commission was ever qualified -- the qualification hook may have failed',
      detectedAt: payment.captured_at,
      suggestedAction: `Inspect payment ${payment.id} and, if genuinely missing, re-trigger qualification manually`,
      resolved: isResolved('unity_commission_missing_for_sale', 'order', payment.order_id),
    })
  }

  const [{ data: capturedRentalPayments }, { data: qualifiedRentalPaymentIds }] = await Promise.all([
    admin.from('payments').select('id, booking_id, captured_at').eq('payment_type', 'rental_charge').in('status', ['captured', 'partially_captured']).lt('captured_at', threshold),
    admin.from('unity_commissions').select('payment_id').eq('transaction_type', 'rental'),
  ])
  const qualifiedRentalPaymentIdSet = new Set((qualifiedRentalPaymentIds ?? []).map((r) => r.payment_id))
  for (const payment of capturedRentalPayments ?? []) {
    if (qualifiedRentalPaymentIdSet.has(payment.id)) continue
    exceptions.push({
      id: exceptionId('unity_commission_missing_for_rental', payment.id),
      type: 'unity_commission_missing_for_rental',
      severity: 'high',
      entityType: 'booking',
      entityId: payment.booking_id,
      summary: 'This rental_charge payment captured successfully but no Unity commission was ever qualified -- the qualification hook may have failed',
      detectedAt: payment.captured_at,
      suggestedAction: `Inspect payment ${payment.id} and, if genuinely missing, re-trigger qualification manually`,
      resolved: isResolved('unity_commission_missing_for_rental', 'booking', payment.booking_id),
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
