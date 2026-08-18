'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { MessageCircle, ArrowLeft } from 'lucide-react'
import { ChatThread } from '@/components/messaging/chat-thread'
import { ConversationListItem } from '@/components/messaging/conversation-list-item'
import type { ConversationSummary } from '@/lib/messaging/conversations'
import type { Locale } from '@/i18n/locales'

interface ActiveThread {
  type: 'booking' | 'order' | 'barter'
  id: string
  disputeId?: string
  otherUserName: string
}

function ChatUIInner({ conversations, currentUserId, locale }: { conversations: ConversationSummary[]; currentUserId: string; locale: Locale }) {
  const searchParams = useSearchParams()
  const t = useTranslations('common.chat')
  const tThread = useTranslations('common.chat.thread')
  const [active, setActive] = useState<ActiveThread | null>(null)
  const [mobileShowThread, setMobileShowThread] = useState(false)
  const [resolvingDeepLink, setResolvingDeepLink] = useState(false)

  // Deep-link support: ?booking=/?order=/?barter= select directly from
  // the conversation list; ?dispute= resolves the dispute to its
  // underlying transaction first (a dispute has no thread of its own --
  // see src/lib/messaging/service.ts).
  useEffect(() => {
    const bookingId = searchParams.get('booking')
    const orderId = searchParams.get('order')
    const barterId = searchParams.get('barter')
    const disputeId = searchParams.get('dispute')

    if (bookingId) {
      const conv = conversations.find((c) => c.type === 'booking' && c.id === bookingId)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActive({ type: 'booking', id: bookingId, otherUserName: conv?.otherUserName ?? t('defaultConversationName') })
      setMobileShowThread(true)
      return
    }
    if (orderId) {
      const conv = conversations.find((c) => c.type === 'order' && c.id === orderId)
      setActive({ type: 'order', id: orderId, otherUserName: conv?.otherUserName ?? t('defaultConversationName') })
      setMobileShowThread(true)
      return
    }
    if (barterId) {
      const conv = conversations.find((c) => c.type === 'barter' && c.id === barterId)
      setActive({ type: 'barter', id: barterId, otherUserName: conv?.otherUserName ?? t('defaultConversationName') })
      setMobileShowThread(true)
      return
    }
    if (disputeId) {
      setResolvingDeepLink(true)
      fetch(`/api/disputes/${disputeId}`)
        .then((res) => res.json())
        .then((data) => {
          const dispute = data.dispute
          if (!dispute) return
          const type: ActiveThread['type'] = dispute.booking_id ? 'booking' : dispute.order_id ? 'order' : 'barter'
          const id = dispute.booking_id ?? dispute.order_id ?? dispute.barter_agreement_id
          const conv = conversations.find((c) => c.type === type && c.id === id)
          setActive({ type, id, disputeId, otherUserName: conv?.otherUserName ?? t('defaultConversationName') })
          setMobileShowThread(true)
        })
        .finally(() => setResolvingDeepLink(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  function selectConversation(conv: ConversationSummary) {
    setActive({ type: conv.type, id: conv.id, otherUserName: conv.otherUserName })
    setMobileShowThread(true)
  }

  return (
    <div className="h-[calc(100vh-4rem)] flex overflow-hidden bg-[#FAF8F5] dark:bg-[#0F0A0A]">
      <div
        className={`w-full lg:w-72 lg:flex-shrink-0 lg:border-r border-[#F2EDE8] dark:border-[#2A1A1A] flex flex-col bg-white dark:bg-[#1A1010] ${
          mobileShowThread ? 'hidden lg:flex' : 'flex'
        }`}
      >
        <div className="px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
          <span className="text-xs font-medium uppercase tracking-[0.12em] text-[#9B8B85]">{t('messagesLabel')}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
              <MessageCircle size={32} className="text-[#F2EDE8] dark:text-[#2A1A1A] mb-3" />
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-[#9B8B85]">{t('noConversationsYet')}</p>
              <p className="text-xs text-[#9B8B85] mt-1">{t('noConversationsDesc')}</p>
            </div>
          ) : (
            conversations.map((conv) => (
              <ConversationListItem
                key={`${conv.type}-${conv.id}`}
                conversation={conv}
                isActive={active?.type === conv.type && active?.id === conv.id}
                currentUserId={currentUserId}
                onSelect={() => selectConversation(conv)}
                locale={locale}
              />
            ))
          )}
        </div>
      </div>

      <div className={`flex-1 flex flex-col min-w-0 ${mobileShowThread ? 'flex' : 'hidden lg:flex'}`}>
        {resolvingDeepLink ? (
          <div className="flex-1 flex items-center justify-center text-sm text-[#9B8B85]">{t('loadingConversation')}</div>
        ) : active ? (
          <>
            <div className="flex items-center gap-3 px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] shrink-0">
              <button
                onClick={() => setMobileShowThread(false)}
                className="lg:hidden p-1.5 rounded-lg hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors text-[#6B5B55] dark:text-[#9B8B85]"
              >
                <ArrowLeft size={16} />
              </button>
              <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] flex-1">{active.otherUserName}</p>
              <div className="flex items-center gap-1.5 text-[11px] text-[#9B8B85] uppercase tracking-[0.06em]">
                <MessageCircle size={11} className="text-green-500" />
                <span className="hidden sm:block">{t('filtered')}</span>
              </div>
            </div>
            <ChatThread
              transactionType={active.type}
              transactionId={active.id}
              currentUserId={currentUserId}
              canSend
              disputeId={active.disputeId}
              variant="full"
              locale={locale}
              labels={{
                loadingMessages: tThread('loadingMessages'),
                noMessagesYet: tThread('noMessagesYet'),
                messageBlocked: tThread('messageBlocked'),
                contentPolicyViolation: tThread('contentPolicyViolation'),
                keepContactInfoOff: tThread('keepContactInfoOff'),
                failedRetry: tThread('failedRetry'),
                sending: tThread('sending'),
                attachmentUploadFailed: tThread('attachmentUploadFailed'),
                couldNotSend: tThread('couldNotSend'),
                couldNotSendRetry: tThread('couldNotSendRetry'),
                messagePlaceholder: tThread('messagePlaceholder'),
                attachmentFallbackName: tThread('attachmentFallbackName'),
              }}
            />
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-[#FAF8F5] dark:bg-[#0F0A0A]">
            <MessageCircle size={36} className="text-[#F2EDE8] dark:text-[#2A1A1A] mb-4" />
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-[#9B8B85]">{t('selectConversation')}</p>
          </div>
        )}
      </div>
    </div>
  )
}

export function ChatUI({ conversations, currentUserId, locale }: { conversations: ConversationSummary[]; currentUserId: string; locale: Locale }) {
  return (
    <Suspense>
      <ChatUIInner conversations={conversations} currentUserId={currentUserId} locale={locale} />
    </Suspense>
  )
}
