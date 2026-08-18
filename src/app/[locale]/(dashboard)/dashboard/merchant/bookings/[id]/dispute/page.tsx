import { notFound, redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireMerchant } from '@/lib/supabase/require-admin'
import { OpenDisputeDialog } from '@/components/disputes/open-dispute-dialog'
import { withLocalePrefix, type Locale } from '@/i18n/locales'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params
  return { title: `Dispute — Booking ${id.slice(-6).toUpperCase()} — Unity` }
}

/**
 * Was entirely mock-mode-gated (404 in real mode) -- now real, mirrors
 * the renter dispute page exactly.
 */
export default async function MerchantDisputePage({ params }: PageProps) {
  const { id: bookingId } = await params
  const locale = (await getLocale()) as Locale
  const requester = await requireMerchant()
  if (!requester) {
    const target = withLocalePrefix(`/dashboard/merchant/bookings/${bookingId}/dispute`, locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) notFound()

  const { data: booking } = await supabase.from('bookings').select('id, booking_reference, listings(title)').eq('id', bookingId).maybeSingle()
  if (!booking) notFound()

  const { data: existing } = await supabase.from('disputes').select('id').eq('booking_id', bookingId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (existing) redirect(withLocalePrefix(`/dashboard/disputes/${existing.id}`, locale))

  const t = await getTranslations('rent')
  const listingTitle = (booking.listings as unknown as { title: string } | null)?.title ?? t('dispute.thisBooking')

  return (
    <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A] px-4 sm:px-6 lg:px-8 py-10">
      <div className="max-w-lg mx-auto">
        <Link href="/dashboard/merchant/bookings" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors mb-8">
          <ArrowLeft size={13} /> {t('backToBookings')}
        </Link>
        <h1 className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">{t('dispute.raiseDispute')}</h1>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-8">
          {t('dispute.regarding', { reference: booking.booking_reference ?? bookingId.slice(0, 8).toUpperCase(), listing: listingTitle })}
        </p>
        <OpenDisputeDialog transactionType="booking" transactionId={bookingId} triggerLabel={t('dispute.openDisputeForm')} className="w-full py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#6B1414] transition-colors" />
      </div>
    </div>
  )
}
