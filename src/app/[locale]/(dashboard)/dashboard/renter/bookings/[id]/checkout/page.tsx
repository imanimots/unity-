import { redirect, notFound } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { triggerLazyExpirySweep } from '@/lib/bookings/lazy-expiry'
import { withLocalePrefix, type Locale } from '@/i18n/locales'
import { CheckoutFlow } from './checkout-flow'

export const metadata = { title: 'Checkout — Unity' }

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function BookingCheckoutPage({ params }: PageProps) {
  const { id: bookingId } = await params
  const locale = (await getLocale()) as Locale
  const requester = await requireAuth()
  if (!requester) {
    const target = withLocalePrefix(`/dashboard/renter/bookings/${bookingId}/checkout`, locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) notFound()

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  await triggerLazyExpirySweep(admin)

  const { loadBookingFinancialState } = await import('@/lib/checkout/load-financial-state')
  const state = await loadBookingFinancialState(admin, bookingId)
  if (!state.booking || state.booking.renterId !== requester.userId) notFound()

  const [{ data: listing }, { data: merchantProfile }] = await Promise.all([
    admin.from('listings').select('title').eq('id', state.booking.listingId).maybeSingle(),
    admin.from('profiles').select('display_name, full_name').eq('id', state.booking.merchantId).maybeSingle(),
  ])

  const t = await getTranslations('rent')

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
      <Link
        href="/dashboard/renter/bookings"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] mb-6"
      >
        <ArrowLeft size={13} /> {t('backToBookings')}
      </Link>

      <div className="mb-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{t('checkout.secureCheckout')}</p>
        <h1 className="text-3xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">{t('checkout.completePayment')}</h1>
      </div>

      <CheckoutFlow
        bookingId={bookingId}
        initial={{
          bookingReference: state.booking.bookingReference,
          listingTitle: listing?.title ?? 'Listing',
          merchantDisplayName: merchantProfile?.display_name ?? merchantProfile?.full_name ?? 'Merchant',
          startAt: state.booking.startAt,
          endAt: state.booking.endAt,
          paymentDueAt: state.booking.paymentDueAt,
          durationUnits: state.booking.durationUnits,
          rateUnit: state.booking.rateUnit,
          rateAmount: state.booking.rateAmount,
          subtotalAmount: state.booking.subtotalAmount,
          platformFeeAmount: state.booking.platformFeeAmount,
          depositAmount: state.booking.depositAmountSnapshot,
          totalAmount: state.booking.renterTotalAmount,
          currency: state.booking.currency ?? 'ZAR',
        }}
      />
    </div>
  )
}
