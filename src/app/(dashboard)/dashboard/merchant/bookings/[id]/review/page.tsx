import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { IS_MOCK_MODE, MOCK_MERCHANT_BOOKINGS } from '@/lib/mock/data'
import { ReviewForm } from '@/components/trust/review-form'

export const metadata = { title: 'Leave a Review — Unity' }

interface Props {
  params: Promise<{ id: string }>
}

export default async function MerchantReviewPage({ params }: Props) {
  const { id } = await params
  const booking = IS_MOCK_MODE ? MOCK_MERCHANT_BOOKINGS.find((b) => b.id === id) : null

  if (!booking) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A] flex items-center justify-center">
        <div className="max-w-lg mx-auto px-4 py-16 text-center">
          <p className="text-[#6B5B55] dark:text-[#9B8B85] font-['Plus_Jakarta_Sans']">Booking not found.</p>
          <Link
            href="/dashboard/merchant/bookings"
            className="text-sm text-[#8B1A1A] hover:text-[#7A1616] underline mt-2 inline-block font-['Plus_Jakarta_Sans'] transition-colors"
          >
            ← Back to bookings
          </Link>
        </div>
      </div>
    )
  }

  if (booking.status !== 'returned') {
    return (
      <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A] flex items-center justify-center">
        <div className="max-w-lg mx-auto px-4 py-16 text-center">
          <p className="text-[#6B5B55] dark:text-[#9B8B85] font-['Plus_Jakarta_Sans']">Reviews can only be left after a booking is completed.</p>
          <Link
            href="/dashboard/merchant/bookings"
            className="text-sm text-[#8B1A1A] hover:text-[#7A1616] underline mt-2 inline-block font-['Plus_Jakarta_Sans'] transition-colors"
          >
            ← Back to bookings
          </Link>
        </div>
      </div>
    )
  }

  const backHref = '/dashboard/merchant/bookings'

  return (
    <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A]">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-3 mb-8">
          <Link
            href={backHref}
            className="p-1.5 rounded-lg text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
          >
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] font-['Plus_Jakarta_Sans']">
              Leave a Review
            </h1>
            <p className="text-xs text-[#9B8B85] mt-0.5 font-['Plus_Jakarta_Sans']">{booking.listing.title}</p>
          </div>
        </div>

        <ReviewForm
          bookingId={id}
          listingTitle={booking.listing.title}
          revieweeLabel="your renter"
          backHref={backHref}
        />
      </div>
    </div>
  )
}
