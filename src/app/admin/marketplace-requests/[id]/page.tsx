import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getAdminMarketplaceRequestDetail } from '@/lib/admin/marketplace-requests-service'
import { AdminPageHeader, formatDateTime } from '@/components/admin/ui'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Request — Unity Admin' }

export default async function AdminMarketplaceRequestDetailPage({ params }: PageProps) {
  const { id } = await params
  const requester = await requireAdmin()
  if (!requester) redirect('/login')

  const admin = await getAdminServiceClient()
  if (!admin) notFound()

  const detail = await getAdminMarketplaceRequestDetail(admin, id)
  if (!detail) notFound()

  const req = detail.request as Record<string, unknown> & { id: string; status: string; transaction_type: string; title: string; created_at: string }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Link href="/admin/marketplace-requests" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85]">
        <ArrowLeft size={13} /> Back to requests
      </Link>
      <AdminPageHeader eyebrow="Marketplace" title={req.title} badge={req.status} />

      <div className="max-w-3xl space-y-8">
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Request</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Type</dt><dd className="capitalize">{req.transaction_type}</dd>
            <dt className="text-[#9B8B85]">Requester</dt><dd>{detail.requesterName ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Created</dt><dd>{formatDateTime(req.created_at)}</dd>
          </dl>
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Offers ({detail.offers.length})</h2>
          {detail.offers.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No offers yet.</p>
          ) : (
            <ul className="space-y-2">
              {detail.offers.map((o) => {
                const row = o as unknown as { id: string; offer_type: string; status: string; created_at: string }
                return (
                  <li key={row.id} className="text-sm flex items-baseline justify-between gap-4">
                    <span>{row.offer_type} — {row.status}</span>
                    <span className="text-[#9B8B85]">{formatDateTime(row.created_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">History</h2>
          {detail.history.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No history recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {detail.history.map((h) => {
                const row = h as unknown as { id: string; event_type: string; actor_role: string; created_at: string }
                return (
                  <li key={row.id} className="text-sm flex items-baseline justify-between gap-4">
                    <span>{row.event_type} — {row.actor_role}</span>
                    <span className="text-[#9B8B85]">{formatDateTime(row.created_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
