import type { SupabaseClient } from '@supabase/supabase-js'
import type { BookingLifecycleStatus } from '@/lib/bookings/status-labels'
import type { PaymentStatus, WorkflowStatus } from './financial-readiness'

export interface CheckoutBookingSummary {
  id: string
  bookingReference: string | null
  renterId: string
  merchantId: string
  listingId: string
  status: BookingLifecycleStatus
  startAt: string | null
  endAt: string | null
  paymentDueAt: string | null
  paymentExpiredAt: string | null
  subtotalAmount: number | null
  depositAmountSnapshot: number | null
  renterTotalAmount: number | null
  platformFeeAmount: number | null
  currency: string | null
  rateAmount: number | null
  rateUnit: string | null
  durationUnits: number | null
}

export interface BookingFinancialState {
  booking: CheckoutBookingSummary | null
  workflowStatus: WorkflowStatus
  rentalPaymentStatus: PaymentStatus
  depositPaymentStatus: PaymentStatus
  rentalFailureReason: string | null
  depositFailureReason: string | null
}

const EMPTY_STATE: BookingFinancialState = {
  booking: null,
  workflowStatus: null,
  rentalPaymentStatus: null,
  depositPaymentStatus: null,
  rentalFailureReason: null,
  depositFailureReason: null,
}

/**
 * The single read path shared by the checkout API routes, the checkout
 * page, and the renter/merchant dashboards -- everywhere that needs a
 * booking's trusted financial state reads it through here instead of
 * re-deriving its own queries, so there is exactly one place that knows
 * which columns/tables the financial domain uses.
 */
export async function loadBookingFinancialState(admin: SupabaseClient, bookingId: string): Promise<BookingFinancialState> {
  const { data: bookingRow } = await admin
    .from('bookings')
    .select(
      'id, booking_reference, renter_id, merchant_id, listing_id, status, start_at, end_at, payment_due_at, payment_expired_at, subtotal_amount, deposit_amount_snapshot, renter_total_amount, platform_fee_amount, currency, rate_amount, rate_unit, duration_units'
    )
    .eq('id', bookingId)
    .maybeSingle()

  if (!bookingRow) return EMPTY_STATE

  const booking: CheckoutBookingSummary = {
    id: bookingRow.id,
    bookingReference: bookingRow.booking_reference,
    renterId: bookingRow.renter_id,
    merchantId: bookingRow.merchant_id,
    listingId: bookingRow.listing_id,
    status: bookingRow.status,
    startAt: bookingRow.start_at,
    endAt: bookingRow.end_at,
    paymentDueAt: bookingRow.payment_due_at,
    paymentExpiredAt: bookingRow.payment_expired_at,
    subtotalAmount: bookingRow.subtotal_amount,
    depositAmountSnapshot: bookingRow.deposit_amount_snapshot,
    renterTotalAmount: bookingRow.renter_total_amount,
    platformFeeAmount: bookingRow.platform_fee_amount,
    currency: bookingRow.currency,
    rateAmount: bookingRow.rate_amount,
    rateUnit: bookingRow.rate_unit,
    durationUnits: bookingRow.duration_units,
  }

  const [{ data: workflow }, { data: payments }] = await Promise.all([
    admin
      .from('financial_workflows')
      .select('status')
      .eq('booking_id', bookingId)
      .eq('workflow_type', 'authorize_booking_financials')
      .maybeSingle(),
    admin.from('payments').select('payment_type, status, failure_reason').eq('booking_id', bookingId),
  ])

  const rental = payments?.find((p) => p.payment_type === 'rental_charge')
  const deposit = payments?.find((p) => p.payment_type === 'deposit')

  return {
    booking,
    workflowStatus: (workflow?.status ?? null) as WorkflowStatus,
    rentalPaymentStatus: (rental?.status ?? null) as PaymentStatus,
    depositPaymentStatus: (deposit?.status ?? null) as PaymentStatus,
    rentalFailureReason: rental?.failure_reason ?? null,
    depositFailureReason: deposit?.failure_reason ?? null,
  }
}
