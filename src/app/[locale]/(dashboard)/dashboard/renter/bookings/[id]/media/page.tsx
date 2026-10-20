import { notFound } from 'next/navigation'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { loadBookingConditionEvidencePageData } from '@/lib/bookings/condition-evidence-page-data'
import { ConditionEvidencePanel } from '@/components/trust/condition-evidence-panel'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params
  return { title: `Condition Evidence — Booking ${id.slice(-6).toUpperCase()} — Unity` }
}

/**
 * Real, durable condition-evidence page for the renter side of an
 * ordinary rental booking (P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I --
 * replaces the prior NEXT_PUBLIC_MOCK_MODE-only fake stub). Loaded via
 * loadBookingConditionEvidencePageData(), which is RLS-gated to the
 * authenticated caller's own session -- a non-participant gets exactly
 * the same 404 as a nonexistent booking, never a leaked existence
 * signal.
 */
export default async function MediaPage({ params }: PageProps) {
  const { id } = await params
  const requester = await getRequestProfile()
  if (!requester) notFound()

  const data = await loadBookingConditionEvidencePageData(id, requester.userId)
  if (!data || !data.isRenter) notFound()

  return (
    <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A]">
      <ConditionEvidencePanel
        bookingId={data.bookingId}
        userId={requester.userId}
        listingTitle={data.listingTitle}
        backHref="/dashboard/renter/bookings"
        preHandoverEvidence={data.preHandoverEvidence}
        postReturnEvidence={data.postReturnEvidence}
        canUploadPreHandover={data.canUploadPreHandover}
        canUploadPostReturn={data.canUploadPostReturn}
      />
    </div>
  )
}
