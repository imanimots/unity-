import Link from 'next/link'
import { MessageCircle } from 'lucide-react'
import { ReportProfileDialog } from './report-profile-dialog'

/**
 * Message + Report -- Block is deliberately not implemented (Step Q: no
 * blocking infrastructure exists anywhere in this codebase, and proper
 * implementation would touch many systems; reported as a follow-up in
 * the final report rather than shipping a cosmetic button that does
 * nothing).
 */
export function ProfileActions({ profileId, messageHref }: { profileId: string; messageHref: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {messageHref && (
        <Link
          href={messageHref}
          className="flex items-center justify-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#6B1414] transition-colors"
        >
          <MessageCircle size={14} /> Message
        </Link>
      )}
      <ReportProfileDialog profileId={profileId} />
    </div>
  )
}
