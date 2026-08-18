import { redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Clock, Package } from 'lucide-react'
import { requireMerchant } from '@/lib/supabase/require-admin'
import { BOOKING_STATUS_LABELS, type BookingLifecycleStatus } from '@/lib/bookings/status-labels'
import { BookingActions } from '@/components/bookings/booking-actions'
import { deriveFinancialReadiness, type WorkflowStatus, type PaymentStatus, type FinancialReadinessState } from '@/lib/checkout/financial-readiness'
import { triggerLazyExpirySweep } from '@/lib/bookings/lazy-expiry'
import { PaymentDeadlineNote } from '@/components/payments/payment-deadline-note'
import { TestModeBanner } from '@/components/shared/test-mode-banner'
import { formatDate, formatDateTime, formatMoneyFromRands } from '@/lib/i18n/format'
import { withLocalePrefix, type Locale } from '@/i18n/locales'

export const metadata = { title: 'Booking Requests — Unity' }

const READINESS_KEYS: Record<FinancialReadinessState, string> = {
  not_prepared: 'notPrepared',
  awaiting_payment: 'awaitingPayment',
  processing: 'processing',
  payment_failed_retryable: 'paymentFailedRetryable',
  payment_failed_terminal: 'paymentFailedTerminal',
  deposit_failed_retryable: 'depositFailedRetryable',
  deposit_failed_terminal: 'depositFailedTerminal',
  financially_ready: 'financiallyReady',
  no_payment_required: 'noPaymentRequired',
  expired_unpaid: 'expiredUnpaid',
}

interface BookingRow {
  id: string
  booking_reference: string | null
  listing_id: string
  renter_id: string
  status: BookingLifecycleStatus
  start_at: string | null
  end_at: string | null
  payment_due_at: string | null
  payment_expired_at: string | null
  subtotal_amount: number | null
  deposit_amount_snapshot: number | null
  renter_total_amount: number | null
  merchant_proceeds_estimate: number | null
}

export default async function MerchantBookingsPage() {
  const locale = (await getLocale()) as Locale
  const requester = await requireMerchant()
  if (!requester) {
    const target = withLocalePrefix('/dashboard/merchant/bookings', locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }

  const t = await getTranslations('rent')
  const tCommon = await getTranslations('common')
  const fmt = (iso: string | null) => (iso ? formatDate(iso, locale) : '—')

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
        .select('id, booking_reference, listing_id, renter_id, status, start_at, end_at, payment_due_at, payment_expired_at, subtotal_amount, deposit_amount_snapshot, renter_total_amount, merchant_proceeds_estimate')
        .eq('merchant_id', requester.userId)
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
          depositRequired: (b.deposit_amount_snapshot ?? 0) > 0,
          depositPaymentStatus,
          paymentExpired: Boolean(b.payment_expired_at),
        }),
      ] as const
    })
  )

  const pendingCount = bookings.filter((b) => b.status === 'requested').length
  const activeCount = bookings.filter((b) => b.status === 'active').length
  const earnedTotal = bookings
    .filter((b) => b.status === 'completed')
    .reduce((sum, b) => sum + (b.merchant_proceeds_estimate ?? 0), 0)

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{t('manageRentals')}</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">{t('bookingsTitle')}</h1>
      </div>

      <TestModeBanner className="mb-8" text={tCommon('testMode')} />

      <div className="grid grid-cols-3 gap-4 mb-12">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{t('requested')}</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-amber-500 leading-none">{pendingCount}</div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">{t('needReview')}</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{t('active')}</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-green-500 leading-none">{activeCount}</div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">{t('outNow')}</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{t('earnedEstimate')}</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#8B1A1A] leading-none">{formatMoneyFromRands(earnedTotal, 'ZAR', locale)}</div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">{t('completedNotPaidOut')}</p>
        </div>
      </div>

      {bookings.length === 0 ? (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-16 text-center">
          <Package size={36} className="mx-auto text-[#9B8B85] mb-4" />
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">{t('noBookingRequests')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {bookings.map((booking) => {
            const sc = BOOKING_STATUS_LABELS[booking.status]
            const readiness = readinessByBooking.get(booking.id)
            return (
              <div key={booking.id} className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5">
                <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
                  <Link href={`/listings/${booking.listing_id}`} className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] hover:underline">
                    {t('booking')} {booking.booking_reference}
                  </Link>
                  <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium ${sc.classes}`}>{t(`status.${booking.status}`)}</span>
                </div>
                <p className="text-xs text-[#9B8B85] flex items-center gap-1.5">
                  <Clock size={11} /> {fmt(booking.start_at)} – {fmt(booking.end_at)}
                </p>
                <p className="text-xs font-semibold text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">R{booking.subtotal_amount ?? 0} {t('rentalLabel')}</p>
                {readiness && readiness !== 'not_prepared' && (
                  <p className="text-xs font-semibold mt-1.5 text-[#1A0A0A] dark:text-[#F5F0ED]">{t(`financialReadiness.merchant.${READINESS_KEYS[readiness]}`)}</p>
                )}
                {booking.status === 'accepted' && readiness !== 'financially_ready' && readiness !== 'no_payment_required' && booking.payment_due_at && (
                  <PaymentDeadlineNote label={t('payBy', { date: formatDateTime(booking.payment_due_at, locale) })} />
                )}

                <BookingActions
                  bookingId={booking.id}
                  status={booking.status}
                  role="merchant"
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
