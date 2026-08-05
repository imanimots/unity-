import Image from 'next/image'
import type { ConversationSummary } from '@/lib/messaging/conversations'

interface ConversationListItemProps {
  conversation: ConversationSummary
  isActive: boolean
  currentUserId: string
  onSelect: () => void
}

function timeStr(iso: string) {
  return new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function ConversationListItem({ conversation, isActive, currentUserId, onSelect }: ConversationListItemProps) {
  const last = conversation.lastMessage
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left flex items-center gap-3 px-5 py-3.5 border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors ${
        isActive ? 'bg-[#F2EDE8] dark:bg-[#2A1A1A]' : ''
      }`}
    >
      <div className="w-9 h-9 rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0 relative">
        {conversation.listingCoverUrl ? (
          <Image src={conversation.listingCoverUrl} alt={conversation.listingTitle ?? ''} fill className="object-cover" sizes="36px" />
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-0.5">
          <span className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] truncate">{conversation.otherUserName}</span>
          {last && <span className="text-[10px] text-[#9B8B85] shrink-0 ml-2">{timeStr(last.createdAt)}</span>}
        </div>
        <p className="text-xs text-[#9B8B85] truncate">
          {last ? (last.isFiltered ? '— blocked' : `${last.senderId === currentUserId ? 'You: ' : ''}${last.content}`) : ''}
        </p>
        {conversation.listingTitle && <p className="text-[10px] text-[#9B8B85] truncate mt-0.5">{conversation.listingTitle}</p>}
      </div>
    </button>
  )
}
