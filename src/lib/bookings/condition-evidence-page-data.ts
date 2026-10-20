import { createClient } from '@/lib/supabase/server'
import { canUploadConditionEvidence } from '@/lib/bookings/evidence-eligibility'

export interface BookingConditionEvidenceRow {
  id: string
  evidence_stage: 'pre_handover' | 'post_return'
  file_type: string
  caption: string | null
  display_order: number
  created_at: string
  uploaded_by: string
}

export interface BookingConditionEvidencePageData {
  bookingId: string
  listingTitle: string
  bookingReference: string
  isRenter: boolean
  isMerchant: boolean
  preHandoverEvidence: BookingConditionEvidenceRow[]
  postReturnEvidence: BookingConditionEvidenceRow[]
  canUploadPreHandover: boolean
  canUploadPostReturn: boolean
}

/**
 * Real, RLS-gated loader for the booking condition-evidence page --
 * mirrors src/lib/reviews/page-data.ts's own "replace fake success with
 * real server-backed state" pattern (Rule 27). Uses the authenticated
 * caller's own cookie-bound client throughout, never a service-role
 * client -- `bookings: parties read` and `booking_condition_evidence:
 * parties read` RLS are what actually decide visibility; this function
 * never re-implements that authorization logic. Returns null if the
 * booking doesn't exist or the caller isn't a genuine party to it
 * (RLS-indistinguishable from "not found," which is the correct,
 * non-leaking behavior for a 404 page).
 */
export async function loadBookingConditionEvidencePageData(bookingId: string, requesterId: string): Promise<BookingConditionEvidencePageData | null> {
  const supabase = await createClient()
  if (!supabase) return null

  const { data: booking } = await supabase
    .from('bookings')
    .select('id, renter_id, merchant_id, status, booking_reference, listings(title)')
    .eq('id', bookingId)
    .maybeSingle()

  if (!booking) return null

  const { data: evidence } = await supabase
    .from('booking_condition_evidence')
    .select('id, evidence_stage, file_type, caption, display_order, created_at, uploaded_by')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true })

  const rows = evidence ?? []

  return {
    bookingId: booking.id,
    listingTitle: (booking.listings as unknown as { title: string } | null)?.title ?? 'Listing',
    bookingReference: booking.booking_reference ?? booking.id.slice(0, 8).toUpperCase(),
    isRenter: booking.renter_id === requesterId,
    isMerchant: booking.merchant_id === requesterId,
    preHandoverEvidence: rows.filter((r) => r.evidence_stage === 'pre_handover'),
    postReturnEvidence: rows.filter((r) => r.evidence_stage === 'post_return'),
    canUploadPreHandover: canUploadConditionEvidence(booking.status, 'pre_handover'),
    canUploadPostReturn: canUploadConditionEvidence(booking.status, 'post_return'),
  }
}
