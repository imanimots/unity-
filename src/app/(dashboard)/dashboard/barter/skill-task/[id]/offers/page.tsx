import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { ProfileLink } from '@/components/shared/profile-link'
import { BarterStatusBadge } from '@/components/barter/barter-status-badge'
import type { BarterStatus } from '@/types'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Offers received — Unity' }

interface OfferRow {
  id: string
  agreement_reference: string
  status: BarterStatus
  party_b_id: string
  proposed_at: string
  accepted_at: string | null
}

/**
 * The "offer inbox" for a Looking-For post owner -- every
 * barter_agreements row referencing this post via
 * source_skill_task_post_id, each linking to the existing, unmodified
 * /dashboard/barter/[id] agreement detail page for accept/counter/
 * decline. This page itself never reimplements those actions.
 */
export default async function SkillTaskPostOffersPage({ params }: PageProps) {
  const { id: postId } = await params
  const requester = await requireAuth()
  if (!requester) redirect(`/login?redirectTo=/dashboard/barter/skill-task/${postId}/offers`)

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) notFound()

  const { data: post } = await supabase.from('barter_skill_task_posts').select('id, title, owner_id, direction').eq('id', postId).eq('owner_id', requester.userId).maybeSingle()
  if (!post || post.direction !== 'looking_for') notFound()

  const { data: offers } = await supabase
    .from('barter_agreements')
    .select('id, agreement_reference, status, party_b_id, proposed_at, accepted_at')
    .eq('source_skill_task_post_id', postId)
    .order('proposed_at', { ascending: false })

  const rows = (offers ?? []) as OfferRow[]
  const proposerIds = [...new Set(rows.map((r) => r.party_b_id))]
  const { data: proposers } = proposerIds.length
    ? await supabase.from('public_profiles').select('id, display_name, full_name').in('id', proposerIds)
    : { data: [] as { id: string; display_name: string | null; full_name: string | null }[] }
  const nameById = new Map((proposers ?? []).map((p) => [p.id, p.display_name || p.full_name || 'Unity user']))

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
      <div className="mb-8">
        <Link href="/dashboard/barter/skill-task" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back to Skills &amp; Tasks
        </Link>
        <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mt-4">Offers on &ldquo;{post.title}&rdquo;</h1>
      </div>

      {rows.length === 0 ? (
        <div className="text-center py-24 rounded-2xl border border-dashed border-[#F2EDE8] dark:border-[#2A1A1A]">
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">No offers yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((o) => (
            <Link
              key={o.id}
              href={`/dashboard/barter/${o.id}`}
              className="flex items-center justify-between gap-3 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] p-4 hover:border-[#8B1A1A]/40 transition-colors"
            >
              <div className="min-w-0">
                <p className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                  <ProfileLink userId={o.party_b_id} displayName={nameById.get(o.party_b_id) ?? 'Unity user'} currentUserId={requester.userId} />
                </p>
                <p className="text-xs text-[#9B8B85] mt-0.5">
                  Trade {o.agreement_reference} · Proposed {new Date(o.proposed_at).toLocaleDateString()}
                </p>
              </div>
              <BarterStatusBadge status={o.status} />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
