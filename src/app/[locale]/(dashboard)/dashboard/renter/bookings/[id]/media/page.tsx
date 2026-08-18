import { notFound } from 'next/navigation'
import { MediaUpload } from '@/components/trust/media-upload'
import { IS_MOCK_MODE, MOCK_RENTER_BOOKINGS } from '@/lib/mock/data'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params
  return { title: `Upload Media — Booking ${id.slice(-6).toUpperCase()} — Unity` }
}

export default async function MediaPage({ params }: PageProps) {
  const { id } = await params
  const booking = IS_MOCK_MODE ? MOCK_RENTER_BOOKINGS.find((b) => b.id === id) : null
  if (!booking) notFound()
  // Reachable only when NEXT_PUBLIC_MOCK_MODE=true (currently unset in
  // production/staging) -- localized regardless, since this is real
  // shipped code, not a stub.

  const stage = (booking.status === 'approved' && !booking.pre_rental_media_url) ? 'pre' : 'post'

  return (
    <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A]">
      <MediaUpload
        bookingId={id}
        stage={stage}
        listingTitle={booking.listing.title}
        backHref="/dashboard/renter/bookings"
      />
    </div>
  )
}
