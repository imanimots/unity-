/**
 * Centralized, role-aware "what does this status mean, do I need to act,
 * what happens next" guidance for Buy orders and Rent bookings -- the
 * customer-journey mapping found only one booking/payment sub-state
 * (via FinancialReadinessCard) had any explanatory copy; every other
 * status was a bare badge. One entry per (status, role) pair here,
 * never scattered hardcoded sentences at each render site.
 *
 * Every sentence is grounded in the actual RPC/route behavior already
 * verified in this engagement (supabase/migrations/20260812000004_order_rpcs.sql,
 * 20260730000007_booking_rpcs.sql and its widening migrations) -- not
 * invented. In particular: confirm_order_delivery only changes status
 * and starts the review window, it does not itself release payment
 * (verified directly against the RPC body in the prior phase), so no
 * entry here claims otherwise.
 */

import type { OrderStatus } from '@/types'
import type { BookingLifecycleStatus } from '@/lib/bookings/status-labels'

export const ORDER_STATUS_GUIDANCE: Record<OrderStatus, { buyer: string; seller: string }> = {
  pending: {
    buyer: 'Complete payment to confirm this order.',
    seller: 'Waiting for the buyer to pay — nothing to do yet.',
  },
  paid: {
    buyer: 'Payment is complete. The seller will prepare your item for shipping or collection.',
    seller: 'Payment is complete. Mark the order as shipped once you’ve sent or handed over the item.',
  },
  shipped: {
    buyer: 'The seller has marked this as shipped. Confirm once you’ve received it.',
    seller: 'Waiting for the buyer to confirm receipt.',
  },
  delivered: {
    buyer: 'You’ve confirmed receipt. You can leave a review once it’s eligible.',
    seller: 'The buyer has confirmed receipt.',
  },
  disputed: {
    buyer: 'This order is under review. Check the dispute for any evidence or response needed from you.',
    seller: 'This order is under review. Check the dispute for any evidence or response needed from you.',
  },
  cancelled: {
    buyer: 'This order was cancelled. Any payment collected follows Unity’s standard refund policy for the stage it was cancelled at.',
    seller: 'This order was cancelled.',
  },
}

export const BOOKING_STATUS_GUIDANCE: Partial<Record<BookingLifecycleStatus, { renter: string; merchant: string }>> = {
  requested: {
    renter: 'Waiting for the merchant to accept or decline your request.',
    merchant: 'Accept or decline this request.',
  },
  accepted: {
    renter: 'Accepted — complete checkout to secure your booking.',
    merchant: 'Waiting for the renter to complete payment.',
  },
  rejected: {
    renter: 'The merchant declined this request. No payment was collected.',
    merchant: 'You declined this request.',
  },
  expired: {
    renter: 'This request expired before being accepted or paid for. No payment was collected.',
    merchant: 'This request expired.',
  },
  cancelled_by_renter: {
    renter: 'You cancelled this booking.',
    merchant: 'The renter cancelled this booking.',
  },
  cancelled_by_merchant: {
    renter: 'The merchant cancelled this booking.',
    merchant: 'You cancelled this booking.',
  },
  active: {
    renter: 'Your rental is active. Document the item’s condition when you return it.',
    merchant: 'The rental is active with the renter.',
  },
  return_pending: {
    renter: 'Waiting for the return to be confirmed.',
    merchant: 'Confirm once the item has been returned to release the deposit.',
  },
  returned: {
    renter: 'The return has been confirmed.',
    merchant: 'The return has been confirmed.',
  },
  completed: {
    renter: 'This rental is complete. You can leave a review once it’s eligible.',
    merchant: 'This rental is complete.',
  },
  disputed: {
    renter: 'This booking is under review. Check the dispute for any evidence or response needed from you.',
    merchant: 'This booking is under review. Check the dispute for any evidence or response needed from you.',
  },
  // 'cancelled' (generic, pre-renter/merchant-split legacy value) has
  // no real current caller per BOOKING_STATUS_LABELS' own history --
  // deliberately left without an entry rather than guessed at.
}
