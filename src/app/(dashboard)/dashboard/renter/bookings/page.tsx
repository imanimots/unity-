import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Clock, Package, ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { BOOKING_STATUS_LABELS, type BookingLifecycleStatus } from '@/lib/bookings/status-labels'
import { BookingActions } from '@/components/bookings/booking-actions'
import { deriveFinancialReadiness, FINANCIAL_READINESS_RENTER_COPY, type WorkflowStatus, type PaymentStatus } from '@/lib/checkout/financial-readiness'
import { triggerLazyExpirySweep } from '@/lib/bookings/lazy-expiry'
import { PaymentDeadlineNote } from '@/components/payments/payment-deadline-note'
import { TestModeBanner } from '@/components/shared/test-mode-banner'

export const metadata = { title: 'My Bookings — Unity' }

interface BookingRow {
  id: string
  booking_reference: string | null
  listing_id: string
  status: BookingLifecycleStatus
  start_at: string | null
  end_at: string | null
  payment_due_at: string | null
  payment_expired_at: string | null
  subtotal_amount: number | null
  deposit_amount_snapshot: number
  renter_total_amount: number | null
  currency: string
}

function fmt(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default async function RenterBookingsPage() {
  const requester = await requireAuth()
  if (!requester) redirect('/login?redirectTo=/dashboard/renter/bookings')

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url && serviceKey) {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    await triggerLazyExpirySweep(createServiceClient(url, serviceKey))
  }

  const { data } = supabase
    ? await supabase
        .from('bookings')
        .select('id, booking_reference, listing_id, status, start_at, end_at, payment_due_at, payment_expired_at, subtotal_amount, deposit_amount_snapshot, renter_total_amount, currency')
        .eq('renter_id', requester.userId)
        .order('created_at', { ascending: false })
    : { data: [] as BookingRow[] }

  const bookings = (data ?? []) as BookingRow[]
  const bookingIds = bookings.map((b) => b.id)

  const [{ data: workflows }, { data: payments }] = supabase && bookingIds.length > 0
    ? await Promise.all([
        supabase.from('financial_workflows').select('booking_id, status').eq('workflow_type', 'authorize_booking_financials').in('booking_id', bookingIds),
        supabase.from('payments').select('booking_id, payment_type, status').in('booking_id', bookingIds),
      ])
    : [{ data: [] as { booking_id: string; status: string }[] }, { data: [] as { booking_id: string; payment_type: string; status: string }[] }]

  const readinessByBooking = new Map(
    bookings.map((b) => {
      const workflowStatus = (workflows?.find((w) => w.booking_id === b.id)?.status ?? null) as WorkflowStatus
      const rentalPaymentStatus = (payments?.find((p) => p.booking_id === b.id && p.payment_type === 'rental_charge')?.status ?? null) as PaymentStatus
      const depositPaymentStatus = (payments?.find((p) => p.booking_id === b.id && p.payment_type === 'deposit')?.status ?? null) as PaymentStatus
      return [
        b.id,
        deriveFinancialReadiness({
          bookingStatus: b.status,
          renterTotalAmount: b.renter_total_amount,
          workflowStatus,
          rentalPaymentStatus,
          depositRequired: b.deposit_amount_snapshot > 0,
          depositPaymentStatus,
          paymentExpired: Boolean(b.payment_expired_at),
        }),
      ] as const
    })
  )

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/renter" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Your Bookings</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">Bookings</h1>
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-3">
          {bookings.length} booking{bookings.length !== 1 ? 's' : ''} total
        </p>
      </div>

      <TestModeBanner className="mb-8" />

      {bookings.length === 0 ? (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-16 text-center">
          <Package size={36} className="mx-auto text-[#9B8B85] mb-4" />
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">No bookings yet</p>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-6">Browse listings and make your first rental request.</p>
          <Link href="/listings" className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors">
            Browse Listings
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {bookings.map((b) => {
            const sc = BOOKING_STATUS_LABELS[b.status]
            const readiness = readinessByBooking.get(b.id)
            const readinessCopy = readiness ? FINANCIAL_READINESS_RENTER_COPY[readiness] : null
            return (
              <div key={b.id} className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5">
                <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
                  <Link href={`/listings/${b.listing_id}`} className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] hover:underline">
                    Booking {b.booking_reference}
                  </Link>
                  <span className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full ${sc.classes}`}>{sc.label}</span>
                </div>
                <p className="text-xs text-[#9B8B85] flex items-center gap-1.5">
                  <Clock size={11} /> {fmt(b.start_at)} – {fmt(b.end_at)}
                </p>
                <p className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">
                  R{b.subtotal_amount ?? 0} rental
                  {b.deposit_amount_snapshot > 0 && ` · R${b.deposit_amount_snapshot} deposit`}
                  {' · '}total obligation R{b.renter_total_amount ?? 0}
                </p>
                {readinessCopy && readiness !== 'not_prepared' && (
                  <p className="text-xs font-semibold mt-1.5 text-[#1A0A0A] dark:text-[#F5F0ED]">{readinessCopy.label}</p>
                )}
                {b.status === 'accepted' && readiness !== 'financially_ready' && readiness !== 'no_payment_required' && (
                  <PaymentDeadlineNote paymentDueAt={b.payment_due_at} />
                )}

                <BookingActions
                  bookingId={b.id}
                  status={b.status}
                  role="renter"
                  financiallyReady={readiness === 'financially_ready' || readiness === 'no_payment_required'}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
