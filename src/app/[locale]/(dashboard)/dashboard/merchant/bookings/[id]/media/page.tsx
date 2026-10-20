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
 * Merchant-side counterpart to src/app/[locale]/(dashboard)/dashboard/renter/bookings/[id]/media/page.tsx --
 * same real, RLS-gated loader, same panel component. Never existed as
 * a real page before this phase (P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I).
 */
export default async function MerchantMediaPage({ params }: PageProps) {
  const { id } = await params
  const requester = await getRequestProfile()
  if (!requester) notFound()

  const data = await loadBookingConditionEvidencePageData(id, requester.userId)
  if (!data || !data.isMerchant) notFound()

  return (
    <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A]">
      <ConditionEvidencePanel
        bookingId={data.bookingId}
        userId={requester.userId}
        listingTitle={data.listingTitle}
        backHref="/dashboard/merchant/bookings"
        preHandoverEvidence={data.preHandoverEvidence}
        postReturnEvidence={data.postReturnEvidence}
        canUploadPreHandover={data.canUploadPreHandover}
        canUploadPostReturn={data.canUploadPostReturn}
      />
    </div>
  )
}
