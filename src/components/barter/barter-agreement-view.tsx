'use client'

import { useState } from 'react'
import Image from 'next/image'
import { useTranslations, useLocale } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { BarterStatusBadge } from './barter-status-badge'
import { BarterActions } from './barter-actions'
import { BarterFinancialStatus } from './barter-financial-status'
import { BarterTimeline } from './barter-timeline'
import { CounterOfferDialog } from './counter-offer-dialog'
import { ContributionMilestonesPanel } from './contribution-milestones-panel'
import { DepositEligibilityPanel } from './deposit-eligibility-panel'
import { BarterReviewForm } from './barter-review-form'
import type { ContributionInput } from './contribution-builder'
import { formatDateTime } from '@/lib/i18n/format'
import { MAX_MILESTONE_EVIDENCE_SIZE_BYTES } from '@/lib/barter/skill-task-evidence'
import type { Locale } from '@/i18n/locales'
import type {
  BarterAgreement, BarterOffer, BarterOfferItem, BarterHistoryEntry, BarterConfirmation, BarterPayment, Listing,
  BarterDepositTerm, BarterMilestoneEvidence, BarterSkillTaskPublicPost,
} from '@/types'

type OfferWithItems = BarterOffer & { items: (BarterOfferItem & { listing?: Listing })[] }

interface BarterAgreementViewProps {
  agreement: BarterAgreement
  offers: OfferWithItems[]
  history: BarterHistoryEntry[]
  confirmations: BarterConfirmation[]
  payments: BarterPayment[]
  depositTerms: BarterDepositTerm[]
  evidenceByMilestone: Record<string, BarterMilestoneEvidence[]>
  alreadyReviewed: boolean
  partyAName: string
  partyBName: string
  currentUserId: string
  myListings: Listing[]
  theirListings: Listing[]
  mySkillTaskOptions: BarterSkillTaskPublicPost[]
  theirSkillTaskOptions: BarterSkillTaskPublicPost[]
}

function toContributionInput(item: BarterOfferItem): ContributionInput {
  const d = item.contribution_details
  return {
    kind: item.kind === 'item' ? 'skill' : item.kind,
    skill_task_post_id: item.skill_task_post_id ?? undefined,
    title: item.skill_task_post_id ? undefined : d?.title,
    description: item.skill_task_post_id ? undefined : d?.description ?? undefined,
    delivery_mode: item.skill_task_post_id ? undefined : d?.delivery_mode ?? undefined,
    province: item.skill_task_post_id ? undefined : d?.province ?? undefined,
    city: item.skill_task_post_id ? undefined : d?.city ?? undefined,
    contribution_weight_percent: item.contribution_weight_percent ?? 0,
    milestones: (item.milestones ?? [])
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((m) => ({ title: m.title, description: m.description ?? undefined, sequence: m.sequence, weight_percent: m.weight_percent })),
  }
}

function ItemGrid({ items, emptyLabel }: { items: (BarterOfferItem & { listing?: Listing })[]; emptyLabel: string }) {
  if (items.length === 0) return <p className="text-sm text-[#9B8B85]">{emptyLabel}</p>
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
      {items.map((item) => (
        <Link
          key={item.id}
          href={`/listings/${item.listing_id}`}
          className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-2 hover:border-[#8B1A1A]/50 transition-colors"
        >
          <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] mb-1.5">
            {item.listing?.media?.[0]?.url ? (
              <Image src={item.listing.media[0].url} alt={item.listing.title} fill className="object-cover" sizes="120px" />
            ) : null}
          </div>
          <p className="text-xs font-medium text-[#1A0A0A] dark:text-[#F5F0ED] line-clamp-2">{item.listing?.title ?? 'Listing'}</p>
        </Link>
      ))}
    </div>
  )
}

/** Compact preview of this side's Skill/Task contributions inside the current offer -- title, kind, and weight only, never a rand value. */
function ContributionSummaryList({ items, skillLabel, taskLabel, contributionFallback }: { items: BarterOfferItem[]; skillLabel: string; taskLabel: string; contributionFallback: string }) {
  if (items.length === 0) return null
  return (
    <div className="mt-2.5 space-y-1.5">
      {items.map((item) => (
        <div key={item.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-xs">
          <span className="text-[#1A0A0A] dark:text-[#F5F0ED] truncate">
            <span className="font-bold uppercase text-[#8B1A1A] mr-1.5">{item.kind === 'skill' ? skillLabel : taskLabel}</span>
            {item.contribution_details?.title ?? contributionFallback}
          </span>
          <span className="text-[#9B8B85] shrink-0">{item.contribution_weight_percent}%</span>
        </div>
      ))}
    </div>
  )
}

export function BarterAgreementView({
  agreement, offers, history, confirmations, payments, depositTerms, evidenceByMilestone, alreadyReviewed,
  partyAName, partyBName, currentUserId, myListings, theirListings, mySkillTaskOptions, theirSkillTaskOptions,
}: BarterAgreementViewProps) {
  const [counterOpen, setCounterOpen] = useState(false)
  const t = useTranslations('barter')
  const tCommon = useTranslations('common.disputes')
  const tSkills = useTranslations('skills')
  const tTasks = useTranslations('tasks')
  const locale = useLocale() as Locale

  const deliveryMethodLabels: Record<string, string> = {
    meet_in_person: t('view.deliveryMethods.meet_in_person'),
    courier: t('view.deliveryMethods.courier'),
    self_collection: t('view.deliveryMethods.self_collection'),
    other: t('view.deliveryMethods.other'),
  }

  const financialLabels = {
    paymentStatus: t('financial.paymentStatus'),
    readiness: {
      no_payment_required: { label: t('financial.readiness.noPaymentRequired'), description: t('financial.readiness.noPaymentRequiredDesc') },
      awaiting_payment: { label: t('financial.readiness.awaitingPayment'), description: t('financial.readiness.awaitingPaymentDesc') },
      payment_failed: { label: t('financial.readiness.paymentFailed'), description: t('financial.readiness.paymentFailedDesc') },
      financially_ready: { label: t('financial.readiness.financiallyReady'), description: t('financial.readiness.financiallyReadyDesc') },
    },
    paid: t('financial.paid'),
    failed: t('financial.failed'),
    pending: t('financial.pending'),
    depositOf: (name: string) => t('financial.depositOf', { name }),
    cashAdjustmentOf: (amount: string) => t('financial.cashAdjustmentOf', { amount }),
  }

  const timelineLabels = {
    title: t('timeline.title'),
    events: {
      barter_proposed: t('timeline.events.barter_proposed'),
      barter_countered: t('timeline.events.barter_countered'),
      barter_accepted: t('timeline.events.barter_accepted'),
      barter_rejected: t('timeline.events.barter_rejected'),
      barter_cancelled: t('timeline.events.barter_cancelled'),
      barter_auto_cancelled_listing_locked: t('timeline.events.barter_auto_cancelled_listing_locked'),
      barter_expired: t('timeline.events.barter_expired'),
      barter_progress_marked: t('timeline.events.barter_progress_marked'),
      barter_completion_confirmed: t('timeline.events.barter_completion_confirmed'),
      barter_completed: t('timeline.events.barter_completed'),
      barter_admin_hold_set: t('timeline.events.barter_admin_hold_set'),
      barter_admin_hold_released: t('timeline.events.barter_admin_hold_released'),
      barter_admin_cancelled: t('timeline.events.barter_admin_cancelled'),
    },
    actors: {
      party_a: t('timeline.actors.party_a'),
      party_b: t('timeline.actors.party_b'),
      system: t('timeline.actors.system'),
      admin: t('timeline.actors.admin'),
    },
    formatDateTime: (iso: string) => formatDateTime(iso, locale),
  }

  const evidenceLabels = {
    title: tCommon('evidence'),
    noEvidence: tCommon('noEvidence'),
    disclaimer: t('milestonesPanel.evidence.disclaimer'),
    uploadEvidence: tCommon('uploadEvidence'),
    uploading: tCommon('uploading'),
    couldNotRegister: tCommon('couldNotRegisterEvidence'),
    couldNotUpload: tCommon('couldNotUploadEvidence'),
    errorUnsupportedType: tCommon('errorUnsupportedType'),
    errorTooLarge: tCommon('errorTooLarge', { mb: MAX_MILESTONE_EVIDENCE_SIZE_BYTES / 1024 / 1024 }),
  }

  const milestonesPanelLabels = {
    status: {
      pending: t('milestonesPanel.status.pending'),
      active: t('milestonesPanel.status.active'),
      completed: t('milestonesPanel.status.completed'),
    },
    contributionPercent: (percent: number) => t('milestonesPanel.contributionPercent', { percent }),
    contribution: t('milestonesPanel.contribution'),
    skill: tSkills('label'),
    task: tTasks('label'),
    markComplete: t('milestonesPanel.markComplete'),
    marking: t('milestonesPanel.marking'),
    couldNotMarkComplete: t('milestonesPanel.couldNotMarkComplete'),
    couldNotMarkCompleteRetry: t('milestonesPanel.couldNotMarkCompleteRetry'),
    schedule: {
      inPersonSchedule: t('milestonesPanel.schedule.inPersonSchedule'),
      noScheduleYet: t('milestonesPanel.schedule.noScheduleYet'),
      confirmThisSchedule: t('milestonesPanel.schedule.confirmThisSchedule'),
      confirming: t('milestonesPanel.schedule.confirming'),
      proposeSchedule: t('milestonesPanel.schedule.proposeSchedule'),
      proposing: t('milestonesPanel.schedule.proposing'),
      proposeDateTimeLocation: t('milestonesPanel.schedule.proposeDateTimeLocation'),
      cityPlaceholder: t('milestonesPanel.schedule.cityPlaceholder'),
      provincePlaceholder: t('milestonesPanel.schedule.provincePlaceholder'),
      allFieldsRequired: t('milestonesPanel.schedule.allFieldsRequired'),
      couldNotPropose: t('milestonesPanel.schedule.couldNotPropose'),
      couldNotProposeRetry: t('milestonesPanel.schedule.couldNotProposeRetry'),
      couldNotConfirm: t('milestonesPanel.schedule.couldNotConfirm'),
      couldNotConfirmRetry: t('milestonesPanel.schedule.couldNotConfirmRetry'),
    },
    evidence: evidenceLabels,
  }

  const currentUserRole: 'party_a' | 'party_b' = agreement.party_a_id === currentUserId ? 'party_a' : 'party_b'
  const otherPartyId = currentUserRole === 'party_a' ? agreement.party_b_id : agreement.party_a_id
  const otherPartyName = currentUserRole === 'party_a' ? partyBName : partyAName
  const currentOffer = offers.find((o) => o.id === agreement.current_offer_id)
  const isCurrentProposer = currentOffer?.proposed_by === currentUserId
  const acceptedOffer = offers.find((o) => o.id === agreement.accepted_offer_id)

  const myItems = (currentOffer?.items ?? []).filter((i) => i.offered_by === currentUserId && i.kind === 'item')
  const theirItems = (currentOffer?.items ?? []).filter((i) => i.offered_by === otherPartyId && i.kind === 'item')
  const myContributionItems = (currentOffer?.items ?? []).filter((i) => i.offered_by === currentUserId && i.kind !== 'item')
  const theirContributionItems = (currentOffer?.items ?? []).filter((i) => i.offered_by === otherPartyId && i.kind !== 'item')

  const acceptedSkillTaskItems = (acceptedOffer?.items ?? []).filter((i) => i.kind !== 'item')

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-3 flex-wrap mb-2">
          <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">
            {t('tradeReference', { reference: agreement.agreement_reference })}
          </h1>
          <BarterStatusBadge status={agreement.status} label={t(`status.${agreement.status}`)} />
        </div>
        <BarterActions
          agreementId={agreement.id}
          status={agreement.status}
          isCurrentProposer={isCurrentProposer}
          onCounterClick={() => setCounterOpen(true)}
          currentUserId={currentUserId}
          partyAId={agreement.party_a_id}
          partyBId={agreement.party_b_id}
          acceptedOffer={acceptedOffer ?? null}
          payments={payments}
          confirmations={confirmations}
        />
      </div>

      {acceptedOffer && (
        <BarterFinancialStatus
          offer={acceptedOffer}
          payments={payments}
          partyAId={agreement.party_a_id}
          partyBId={agreement.party_b_id}
          partyAName={partyAName}
          partyBName={partyBName}
          labels={financialLabels}
        />
      )}

      {currentOffer && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">{t('view.yourItems')}</h2>
              <ItemGrid items={myItems} emptyLabel={t('view.noItemsYourSide')} />
              <ContributionSummaryList items={myContributionItems} skillLabel={tSkills('label')} taskLabel={tTasks('label')} contributionFallback={t('milestonesPanel.contribution')} />
            </div>
            <div>
              <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">{t('view.theirItems')}</h2>
              <ItemGrid items={theirItems} emptyLabel={t('view.noItemsTheirSide')} />
              <ContributionSummaryList items={theirContributionItems} skillLabel={tSkills('label')} taskLabel={tTasks('label')} contributionFallback={t('milestonesPanel.contribution')} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {currentOffer.cash_adjustment_amount > 0 && (
              <div className="flex justify-between items-center px-4 py-3 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm">
                <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('cashAdjustment')}</span>
                <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">R{currentOffer.cash_adjustment_amount}</span>
              </div>
            )}
            <div className="flex justify-between items-center px-4 py-3 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('view.delivery')}</span>
              <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{deliveryMethodLabels[currentOffer.delivery_method] ?? currentOffer.delivery_method}</span>
            </div>
            {currentOffer.deposit_required && (
              <div className="flex justify-between items-center px-4 py-3 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm">
                <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('view.deposit')}</span>
                <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">R{currentOffer.deposit_amount} ({currentOffer.deposit_payer})</span>
              </div>
            )}
          </div>

          {currentOffer.message && (
            <div>
              <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">{t('view.message')}</h2>
              <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{currentOffer.message}</p>
            </div>
          )}
        </>
      )}

      {confirmations.length > 0 && (
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">{t('view.confirmations')}</h2>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{t('view.confirmationsCount', { count: confirmations.length })}</p>
        </div>
      )}

      {acceptedSkillTaskItems.length > 0 && (
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">{t('view.skillTaskProgress')}</h2>
          <div className="space-y-4">
            {acceptedSkillTaskItems.map((item) => (
              <ContributionMilestonesPanel
                key={item.id}
                agreementId={agreement.id}
                offerItem={item}
                currentUserId={currentUserId}
                partyAId={agreement.party_a_id}
                partyBId={agreement.party_b_id}
                partyAName={partyAName}
                partyBName={partyBName}
                evidenceByMilestone={evidenceByMilestone}
                labels={milestonesPanelLabels}
              />
            ))}
          </div>
        </div>
      )}

      {agreement.status === 'completed' && (
        <DepositEligibilityPanel
          depositTerms={depositTerms}
          items={acceptedOffer?.items ?? []}
          partyAId={agreement.party_a_id}
          partyBId={agreement.party_b_id}
          partyAName={partyAName}
          partyBName={partyBName}
          labels={{
            title: t('deposit.eligibility'),
            thisParty: t('deposit.thisParty'),
            eligibleText: (amount: string) => t('deposit.eligibleText', { amount }),
            percentText: (percent: number, totalAmount: string) => t('deposit.percentText', { percent, amount: totalAmount }),
          }}
        />
      )}

      {agreement.status === 'completed' && !alreadyReviewed && (
        <BarterReviewForm agreementId={agreement.id} revieweeName={otherPartyName} />
      )}

      <BarterTimeline history={history} labels={timelineLabels} />

      <CounterOfferDialog
        open={counterOpen}
        onOpenChange={setCounterOpen}
        agreementId={agreement.id}
        currentUserId={currentUserId}
        currentUserRole={currentUserRole}
        otherPartyId={otherPartyId}
        myListings={myListings}
        theirListings={theirListings}
        mySkillTaskOptions={mySkillTaskOptions}
        theirSkillTaskOptions={theirSkillTaskOptions}
        currentMyItemIds={myItems.map((i) => i.listing_id).filter((id): id is string => !!id)}
        currentTheirItemIds={theirItems.map((i) => i.listing_id).filter((id): id is string => !!id)}
        currentMyContributions={myContributionItems.map(toContributionInput)}
        currentTheirContributions={theirContributionItems.map(toContributionInput)}
        defaults={
          currentOffer
            ? {
                cash_adjustment_amount: currentOffer.cash_adjustment_amount,
                cash_adjustment_payer: currentOffer.cash_adjustment_payer ?? undefined,
                delivery_method: currentOffer.delivery_method,
                delivery_notes: currentOffer.delivery_notes ?? undefined,
                delivery_responsibility: currentOffer.delivery_responsibility ?? undefined,
                deposit_required: currentOffer.deposit_required,
                deposit_amount: currentOffer.deposit_amount ?? undefined,
                deposit_currency: currentOffer.deposit_currency,
                deposit_payer: currentOffer.deposit_payer ?? undefined,
              }
            : undefined
        }
      />
    </div>
  )
}
