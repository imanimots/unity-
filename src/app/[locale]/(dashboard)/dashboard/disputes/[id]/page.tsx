import { notFound, redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { DisputeDetailView } from '@/components/disputes/dispute-detail-view'
import { formatDateTime } from '@/lib/i18n/format'
import { MAX_EVIDENCE_SIZE_BYTES } from '@/lib/disputes/evidence'
import { withLocalePrefix, type Locale } from '@/i18n/locales'
import type { Dispute, DisputeHistoryEntry, DisputeEvidence } from '@/types'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Dispute — Unity' }

export default async function DisputeDetailPage({ params }: PageProps) {
  const { id: disputeId } = await params
  const locale = (await getLocale()) as Locale
  const requester = await requireAuth()
  if (!requester) {
    const target = withLocalePrefix(`/dashboard/disputes/${disputeId}`, locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) notFound()

  const { data: dispute } = await supabase.from('disputes').select('*').eq('id', disputeId).maybeSingle()
  if (!dispute) notFound()

  const [{ data: history }, { data: evidence }] = await Promise.all([
    supabase.from('dispute_history').select('*').eq('dispute_id', disputeId).order('created_at', { ascending: true }),
    supabase.from('dispute_evidence').select('*').eq('dispute_id', disputeId).order('created_at', { ascending: true }),
  ])

  const t = await getTranslations('common.disputes')
  const tChat = await getTranslations('common.chat.thread')
  const typedDispute = dispute as Dispute
  const outcomeKey = typedDispute.outcome === 'favor_raiser' || typedDispute.outcome === 'favor_respondent'
    ? typedDispute.outcome
    : typedDispute.outcome === 'mutual_agreement' || typedDispute.outcome === 'manual_settlement'
      ? typedDispute.outcome
      : undefined

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/disputes" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> {t('backToDisputes')}
        </Link>
      </div>

      <DisputeDetailView
        dispute={typedDispute}
        history={(history ?? []) as DisputeHistoryEntry[]}
        evidence={(evidence ?? []) as DisputeEvidence[]}
        currentUserId={requester.userId}
        viewerRole="participant"
        labels={{
          statusLabel: t(`status.${typedDispute.status}`),
          requestedResolution: t('requestedResolution'),
          outcome: t('outcome'),
          outcomeLabel: outcomeKey ? t(`outcomeLabels.${outcomeKey}`) : '',
          messages: t('messages'),
          evidencePanel: {
            title: t('evidence'),
            noEvidence: t('noEvidence'),
            uploadEvidence: t('uploadEvidence'),
            uploading: t('uploading'),
            couldNotRegister: t('couldNotRegisterEvidence'),
            couldNotUpload: t('couldNotUploadEvidence'),
            errorUnsupportedType: t('errorUnsupportedType'),
            errorTooLarge: t('errorTooLarge', { mb: MAX_EVIDENCE_SIZE_BYTES / 1024 / 1024 }),
          },
          timeline: {
            title: t('timeline'),
            events: {
              dispute_opened: t('timelineEvents.dispute_opened'),
              dispute_assigned: t('timelineEvents.dispute_assigned'),
              dispute_review_started: t('timelineEvents.dispute_review_started'),
              dispute_evidence_requested: t('timelineEvents.dispute_evidence_requested'),
              evidence_uploaded: t('timelineEvents.evidence_uploaded'),
              dispute_resolved: t('timelineEvents.dispute_resolved'),
              dispute_closed: t('timelineEvents.dispute_closed'),
              dispute_cancelled: t('timelineEvents.dispute_cancelled'),
            },
            actors: {
              raiser: t('timelineActors.raiser'),
              respondent: t('timelineActors.respondent'),
              admin: t('timelineActors.admin'),
              system: t('timelineActors.system'),
            },
            formatDateTime: (iso: string) => formatDateTime(iso, locale),
          },
          chatThread: {
            loadingMessages: tChat('loadingMessages'),
            noMessagesYet: tChat('noMessagesYet'),
            messageBlocked: tChat('messageBlocked'),
            contentPolicyViolation: tChat('contentPolicyViolation'),
            keepContactInfoOff: tChat('keepContactInfoOff'),
            failedRetry: tChat('failedRetry'),
            sending: tChat('sending'),
            attachmentUploadFailed: tChat('attachmentUploadFailed'),
            couldNotSend: tChat('couldNotSend'),
            couldNotSendRetry: tChat('couldNotSendRetry'),
            messagePlaceholder: tChat('messagePlaceholder'),
            attachmentFallbackName: tChat('attachmentFallbackName'),
          },
          locale,
        }}
      />
    </div>
  )
}
