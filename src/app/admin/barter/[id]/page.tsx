import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getAdminBarterDetail } from '@/lib/admin/barter-service'
import { AdminPageHeader } from '@/components/admin/ui'
import { BarterStatusBadge } from '@/components/barter/barter-status-badge'
import { BarterFinancialStatus } from '@/components/barter/barter-financial-status'
import { BarterTimeline } from '@/components/barter/barter-timeline'
import { BarterAdminActions } from '@/components/barter/barter-admin-actions'
import { ContributionMilestonesPanel } from '@/components/barter/contribution-milestones-panel'
import { DepositEligibilityPanel } from '@/components/barter/deposit-eligibility-panel'
import type { BarterAgreement, BarterOffer, BarterHistoryEntry, BarterPayment, BarterOfferItem, BarterDepositTerm, BarterMilestoneEvidence } from '@/types'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Barter trade — Unity Admin' }

/** Step 11 Phase 4 Part J -- read-only admin detail, mirrors /admin/disputes/[id]'s exact shape. No admin "confirm as a party" path. */
export default async function AdminBarterDetailPage({ params }: PageProps) {
  const { id: agreementId } = await params
  const requester = await requireAdmin()
  if (!requester) redirect('/login')

  const admin = await getAdminServiceClient()
  if (!admin) notFound()

  const detail = await getAdminBarterDetail(admin, agreementId)
  if (!detail) notFound()

  const agreement = detail.agreement as unknown as BarterAgreement
  const offers = detail.offers as unknown as BarterOffer[]
  const acceptedOffer = offers.find((o) => o.id === agreement.accepted_offer_id)

  const [{ data: profiles }, { data: anchorListing }, { data: anchorSkillTaskPost }] = await Promise.all([
    admin.from('profiles').select('id, display_name, full_name').in('id', [agreement.party_a_id, agreement.party_b_id]),
    agreement.anchor_listing_id ? admin.from('listings').select('title').eq('id', agreement.anchor_listing_id).maybeSingle() : Promise.resolve({ data: null }),
    agreement.source_skill_task_post_id ? admin.from('barter_skill_task_posts').select('title, kind').eq('id', agreement.source_skill_task_post_id).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.display_name || p.full_name || 'Unity user']))
  const anchorTitle = anchorListing?.title ?? anchorSkillTaskPost?.title ?? '—'
  const anchorLabel = anchorListing ? 'Anchor listing' : anchorSkillTaskPost ? `Anchor ${anchorSkillTaskPost.kind === 'skill' ? 'Skill' : 'Task'} post` : 'Anchor'

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Link href="/admin/barter" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
        <ArrowLeft size={13} /> Back to barter trades
      </Link>

      <AdminPageHeader eyebrow="Marketplace" title={`Trade ${agreement.agreement_reference}`} />

      <div className="max-w-2xl space-y-8">
        <div className="flex items-center gap-3 flex-wrap">
          <BarterStatusBadge status={agreement.status} />
          {agreement.admin_hold && (
            <span className="text-[10px] font-bold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
              Held{agreement.admin_hold_reason ? `: ${agreement.admin_hold_reason}` : ''}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="px-4 py-3 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A]">
            <span className="text-[#9B8B85] block text-xs uppercase tracking-[0.08em] mb-1">Party A</span>
            <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">{nameById.get(agreement.party_a_id) ?? '—'}</span>
          </div>
          <div className="px-4 py-3 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A]">
            <span className="text-[#9B8B85] block text-xs uppercase tracking-[0.08em] mb-1">Party B</span>
            <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">{nameById.get(agreement.party_b_id) ?? '—'}</span>
          </div>
          <div className="px-4 py-3 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] sm:col-span-2">
            <span className="text-[#9B8B85] block text-xs uppercase tracking-[0.08em] mb-1">{anchorLabel}</span>
            <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">{anchorTitle}</span>
          </div>
        </div>

        {acceptedOffer && (
          <BarterFinancialStatus
            offer={acceptedOffer}
            payments={detail.payments as unknown as BarterPayment[]}
            partyAId={agreement.party_a_id}
            partyBId={agreement.party_b_id}
            partyAName={nameById.get(agreement.party_a_id) ?? 'Party A'}
            partyBName={nameById.get(agreement.party_b_id) ?? 'Party B'}
          />
        )}

        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Completion confirmations</h2>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{detail.confirmations.length} of 2 parties have confirmed completion.</p>
        </div>

        {detail.acceptedSkillTaskItems.length > 0 && (
          <div>
            <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Skill/Task progress (read-only)</h2>
            <div className="space-y-4">
              {(detail.acceptedSkillTaskItems as unknown as BarterOfferItem[]).map((item) => (
                <ContributionMilestonesPanel
                  key={item.id}
                  agreementId={agreement.id}
                  offerItem={item}
                  currentUserId=""
                  partyAId={agreement.party_a_id}
                  partyBId={agreement.party_b_id}
                  partyAName={nameById.get(agreement.party_a_id) ?? 'Party A'}
                  partyBName={nameById.get(agreement.party_b_id) ?? 'Party B'}
                  evidenceByMilestone={detail.evidenceByMilestone as unknown as Record<string, BarterMilestoneEvidence[]>}
                  readOnly
                />
              ))}
            </div>
          </div>
        )}

        {agreement.status === 'completed' && (detail.depositTerms as unknown as BarterDepositTerm[]).length > 0 && (
          <DepositEligibilityPanel
            depositTerms={detail.depositTerms as unknown as BarterDepositTerm[]}
            items={detail.acceptedSkillTaskItems as unknown as BarterOfferItem[]}
            partyAId={agreement.party_a_id}
            partyBId={agreement.party_b_id}
            partyAName={nameById.get(agreement.party_a_id) ?? 'Party A'}
            partyBName={nameById.get(agreement.party_b_id) ?? 'Party B'}
          />
        )}

        <BarterAdminActions agreementId={agreement.id} status={agreement.status} adminHold={agreement.admin_hold} />

        <BarterTimeline history={detail.history as unknown as BarterHistoryEntry[]} />
      </div>
    </div>
  )
}
