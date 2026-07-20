import { notFound } from 'next/navigation'
import { DisputeForm } from '@/components/trust/dispute-form'
import { IS_MOCK_MODE, MOCK_RENTER_BOOKINGS } from '@/lib/mock/data'
import { MOCK_DISPUTES } from '@/lib/mock/disputes'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params
  return { title: `Dispute — Booking ${id.slice(-6).toUpperCase()} — Unity` }
}

export default async function RenterDisputePage({ params }: PageProps) {
  const { id } = await params
  const booking = IS_MOCK_MODE ? MOCK_RENTER_BOOKINGS.find((b) => b.id === id) : null
  if (!booking) notFound()

  const existing = MOCK_DISPUTES.find((d) => d.booking_id === id) ?? null

  return (
    <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A]">
      <DisputeForm
        bookingId={id}
        listingTitle={booking.listing.title}
        bookingStatus={booking.status}
        merchantOrRenterName={booking.merchant?.display_name ?? booking.merchant?.full_name ?? 'merchant'}
        backHref="/dashboard/renter/bookings"
        existingDispute={existing}
      />
    </div>
  )
}
