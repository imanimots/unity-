import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { DisputeDetailView } from '@/components/disputes/dispute-detail-view'
import type { Dispute, DisputeHistoryEntry, DisputeEvidence } from '@/types'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Dispute — Unity' }

export default async function DisputeDetailPage({ params }: PageProps) {
  const { id: disputeId } = await params
  const requester = await requireAuth()
  if (!requester) redirect(`/login?redirectTo=/dashboard/disputes/${disputeId}`)

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) notFound()

  const { data: dispute } = await supabase.from('disputes').select('*').eq('id', disputeId).maybeSingle()
  if (!dispute) notFound()

  const [{ data: history }, { data: evidence }] = await Promise.all([
    supabase.from('dispute_history').select('*').eq('dispute_id', disputeId).order('created_at', { ascending: true }),
    supabase.from('dispute_evidence').select('*').eq('dispute_id', disputeId).order('created_at', { ascending: true }),
  ])

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/disputes" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back to disputes
        </Link>
      </div>

      <DisputeDetailView
        dispute={dispute as Dispute}
        history={(history ?? []) as DisputeHistoryEntry[]}
        evidence={(evidence ?? []) as DisputeEvidence[]}
        currentUserId={requester.userId}
        viewerRole="participant"
      />
    </div>
  )
}
