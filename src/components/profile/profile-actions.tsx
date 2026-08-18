'use client'

import { useTranslations } from 'next-intl'
import { MessageCircle } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { ReportProfileDialog } from './report-profile-dialog'

/**
 * Message + Report -- Block is deliberately not implemented (Step Q: no
 * blocking infrastructure exists anywhere in this codebase, and proper
 * implementation would touch many systems; reported as a follow-up in
 * the final report rather than shipping a cosmetic button that does
 * nothing). 'use client' implicitly required by useTranslations, but this
 * only ever renders inside profile/[id]/page.tsx's narrowly scoped
 * provider -- not admin-shared.
 */
export function ProfileActions({ profileId, messageHref }: { profileId: string; messageHref: string | null }) {
  const t = useTranslations('common.profile')
  return (
    <div className="flex flex-wrap items-center gap-3">
      {messageHref && (
        <Link
          href={messageHref}
          className="flex items-center justify-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#6B1414] transition-colors"
        >
          <MessageCircle size={14} /> {t('message')}
        </Link>
      )}
      <ReportProfileDialog profileId={profileId} />
    </div>
  )
}
