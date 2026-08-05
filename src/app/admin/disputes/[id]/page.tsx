import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getAdminDisputeDetail } from '@/lib/admin/disputes-service'
import { AdminPageHeader } from '@/components/admin/ui'
import { DisputeDetailView } from '@/components/disputes/dispute-detail-view'
import { DisputeAdminActions } from '@/components/disputes/dispute-admin-actions'
import type { Dispute, DisputeHistoryEntry, DisputeEvidence } from '@/types'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Dispute — Unity Admin' }

/**
 * The chat panel inside DisputeDetailView fetches its own history via
 * ChatThread's useAdminEndpoint=true, which routes through the audited
 * GET /api/admin/messages (src/lib/messaging/admin.ts) -- this page no
 * longer queries `messages` directly, closing the unaudited admin read
 * that existed before Step 11 Phase 3.
 */
export default async function AdminDisputeDetailPage({ params }: PageProps) {
  const { id: disputeId } = await params
  const requester = await requireAdmin()
  if (!requester) redirect('/login')

  const admin = await getAdminServiceClient()
  if (!admin) notFound()

  const detail = await getAdminDisputeDetail(admin, disputeId)
  if (!detail) notFound()

  const dispute = detail.dispute as unknown as Dispute

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Link href="/admin/disputes" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
        <ArrowLeft size={13} /> Back to disputes
      </Link>

      <AdminPageHeader eyebrow="Trust & Safety" title="Dispute detail" />

      <div className="max-w-2xl">
        <DisputeDetailView
          dispute={dispute}
          history={detail.history as unknown as DisputeHistoryEntry[]}
          evidence={detail.evidence as unknown as DisputeEvidence[]}
          currentUserId={requester.userId}
          viewerRole="admin"
          adminActions={
            <DisputeAdminActions
              disputeId={dispute.id}
              status={dispute.status}
              currentAdminId={requester.userId}
              assignedAdminId={dispute.assigned_admin_id}
            />
          }
        />
      </div>
    </div>
  )
}
