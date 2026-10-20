'use client'

import { useTranslations } from 'next-intl'
import { MediaUpload } from '@/components/trust/media-upload'
import { EvidenceAccessButton } from '@/components/shared/evidence-access-button'
import type { BookingConditionEvidenceRow } from '@/lib/bookings/condition-evidence-page-data'

interface Props {
  bookingId: string
  userId: string
  listingTitle: string
  backHref: string
  preHandoverEvidence: BookingConditionEvidenceRow[]
  postReturnEvidence: BookingConditionEvidenceRow[]
  canUploadPreHandover: boolean
  canUploadPostReturn: boolean
}

/**
 * Real, durable condition-evidence surface for a booking
 * (P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I) -- both renter and merchant
 * see the same two sections (pre-handover, post-return): existing
 * evidence (viewable via short-lived signed URLs, never a permanent
 * link) plus an upload form when the booking's current status makes
 * that stage eligible (server-decided -- src/lib/bookings/
 * evidence-eligibility.ts -- never inferred client-side).
 */
export function ConditionEvidencePanel({
  bookingId,
  userId,
  listingTitle,
  backHref,
  preHandoverEvidence,
  postReturnEvidence,
  canUploadPreHandover,
  canUploadPostReturn,
}: Props) {
  const t = useTranslations('rent.media')

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 font-['Plus_Jakarta_Sans'] space-y-10">
      <EvidenceSection
        title={t('preRental')}
        evidence={preHandoverEvidence}
        bookingId={bookingId}
        viewLabel={t('viewEvidence')}
        viewErrorLabel={t('couldNotAccessEvidence')}
      />
      {canUploadPreHandover && (
        <MediaUpload bookingId={bookingId} userId={userId} stage="pre" listingTitle={listingTitle} backHref={backHref} />
      )}

      <EvidenceSection
        title={t('postRental')}
        evidence={postReturnEvidence}
        bookingId={bookingId}
        viewLabel={t('viewEvidence')}
        viewErrorLabel={t('couldNotAccessEvidence')}
      />
      {canUploadPostReturn && (
        <MediaUpload bookingId={bookingId} userId={userId} stage="post" listingTitle={listingTitle} backHref={backHref} />
      )}

      {!canUploadPreHandover && !canUploadPostReturn && preHandoverEvidence.length === 0 && postReturnEvidence.length === 0 && (
        <p className="text-sm text-[#9B8B85] text-center">{t('noEvidenceYet')}</p>
      )}
    </div>
  )
}

function EvidenceSection({
  title,
  evidence,
  bookingId,
  viewLabel,
  viewErrorLabel,
}: {
  title: string
  evidence: BookingConditionEvidenceRow[]
  bookingId: string
  viewLabel: string
  viewErrorLabel: string
}) {
  if (evidence.length === 0) return null
  return (
    <div>
      <h2 className="text-sm font-bold uppercase tracking-wide text-[#6B5B55] dark:text-[#9B8B85] mb-3">{title}</h2>
      <ul className="space-y-2">
        {evidence.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-3 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] px-4 py-3">
            <span className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] truncate">
              {e.file_type === 'video' ? '🎬' : '📷'} {new Date(e.created_at).toLocaleString()}
              {e.caption ? ` — ${e.caption}` : ''}
            </span>
            <EvidenceAccessButton accessUrl={`/api/bookings/${bookingId}/evidence/${e.id}/access`} label={viewLabel} errorLabel={viewErrorLabel} />
          </li>
        ))}
      </ul>
    </div>
  )
}
