import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getAdminSupportCaseDetail } from '@/lib/admin/support-service'
import { AdminPageHeader } from '@/components/admin/ui'
import { SupportCaseDetailView } from '@/components/support/support-case-detail-view'
import { SupportCaseAdminActions } from '@/components/support/support-case-admin-actions'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Support case — Unity Admin' }

/** /admin/support/[id] — the case workspace (ADMIN-CONTROL-CENTRE-BATCH-A2). */
export default async function AdminSupportCaseDetailPage({ params }: PageProps) {
  const { id: caseId } = await params
  const requester = await requireAdmin()
  if (!requester) redirect('/login')

  const admin = await getAdminServiceClient()
  if (!admin) notFound()

  const detail = await getAdminSupportCaseDetail(admin, caseId)
  if (!detail) notFound()

  const supportCase = detail.case as {
    id: string
    case_number: string
    status: string
    priority: string
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Link href="/admin/support" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
        <ArrowLeft size={13} /> Back to support
      </Link>

      <AdminPageHeader eyebrow="Support" title={supportCase.case_number} />

      <div className="max-w-3xl space-y-6">
        <SupportCaseDetailView detail={detail} />

        <SupportCaseAdminActions
          caseId={supportCase.id}
          status={supportCase.status}
          priority={supportCase.priority}
          currentAdminId={requester.userId}
        />
      </div>
    </div>
  )
}
