import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, AlertTriangle } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { DisputeStatusBadge } from '@/components/disputes/dispute-status-badge'
import type { Dispute } from '@/types'

export const metadata = { title: 'My Disputes — Unity' }

export default async function DisputesInboxPage() {
  const requester = await requireAuth()
  if (!requester) redirect('/login?redirectTo=/dashboard/disputes')

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  const { data } = supabase
    ? await supabase.from('disputes').select('*').order('created_at', { ascending: false })
    : { data: [] as Dispute[] }

  const disputes = (data ?? []) as Dispute[]

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Disputes</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">Disputes</h1>
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-3">
          {disputes.length} dispute{disputes.length !== 1 ? 's' : ''} total
        </p>
      </div>

      {disputes.length === 0 ? (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-16 text-center">
          <AlertTriangle size={36} className="mx-auto text-[#9B8B85] mb-4" />
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">No disputes</p>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">
            You can raise a dispute from any booking, purchase, or trade if something goes wrong.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {disputes.map((d) => (
            <Link
              key={d.id}
              href={`/dashboard/disputes/${d.id}`}
              className="block bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 hover:border-[#8B1A1A]/40 transition-colors"
            >
              <div className="flex items-start justify-between gap-2 flex-wrap mb-1">
                <span className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{d.title}</span>
                <DisputeStatusBadge status={d.status} />
              </div>
              <p className="text-xs text-[#9B8B85]">
                Opened {new Date(d.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
