'use client'

import { useState, useRef, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Image from 'next/image'
import { Send, ShieldAlert, ArrowLeft, MessageCircle } from 'lucide-react'
import { MOCK_CONVERSATIONS, type MockConversation, type MockMessage } from '@/lib/mock/conversations'
import { filterMessage } from '@/lib/chat-filter'

const CURRENT_USER_ID = 'user-1'

function timeStr(iso: string) {
  return new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function dateSep(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' })
}

function BlockedMessage({ reason }: { reason: string | null }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-xs text-red-600 dark:text-red-400 max-w-xs ml-auto">
      <ShieldAlert size={13} className="shrink-0 mt-0.5" />
      <div>
        <p className="font-semibold">Message blocked</p>
        <p>{reason ?? 'Content policy violation'}. Keep all contact info off Unity.</p>
      </div>
    </div>
  )
}

function ConversationList({
  conversations, activeId, onSelect,
}: {
  conversations: MockConversation[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const totalUnread = conversations.reduce((s, c) => s + c.unread_count, 0)

  return (
    <div className="flex flex-col h-full">
      {/* Sidebar header */}
      <div className="px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-[0.12em] text-[#9B8B85]">Messages</span>
          {totalUnread > 0 && (
            <span className="text-[10px] font-bold bg-[#8B1A1A] text-white rounded-full px-2 py-0.5 uppercase tracking-[0.05em]">
              {totalUnread} new
            </span>
          )}
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {conversations.map((conv) => {
          const last = conv.messages[conv.messages.length - 1]
          const isActive = conv.id === activeId
          return (
            <button
              key={conv.id}
              onClick={() => onSelect(conv.id)}
              className={`w-full text-left flex items-center gap-3 px-5 py-3.5 border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors ${
                isActive ? 'bg-[#F2EDE8] dark:bg-[#2A1A1A]' : ''
              }`}
            >
              {/* Cover image */}
              <div className="w-9 h-9 rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0 relative">
                <Image src={conv.listing_cover} alt={conv.listing_title} fill className="object-cover" sizes="36px" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] truncate">
                    {conv.other_user.name}
                  </span>
                  {last && (
                    <span className="text-[10px] text-[#9B8B85] shrink-0 ml-2">{timeStr(last.created_at)}</span>
                  )}
                </div>
                <p className="text-xs text-[#9B8B85] truncate">
                  {last?.is_blocked ? '— blocked' : last?.content ?? ''}
                </p>
              </div>
              {conv.unread_count > 0 && (
                <div className="w-4 h-4 rounded-full bg-[#8B1A1A] flex items-center justify-center shrink-0">
                  <span className="text-[9px] font-bold text-white">{conv.unread_count}</span>
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function MessageThread({
  conversation,
  onBack,
}: {
  conversation: MockConversation
  onBack: () => void
}) {
  const [messages, setMessages] = useState<MockMessage[]>(conversation.messages)
  const [input, setInput] = useState('')
  const [blocked, setBlocked] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = () => {
    const content = input.trim()
    if (!content) return
    const { blocked: isBlocked, reason } = filterMessage(content)
    const msg: MockMessage = {
      id: `m-new-${Date.now()}`,
      sender_id: CURRENT_USER_ID,
      content,
      created_at: new Date().toISOString(),
      is_blocked: isBlocked,
      block_reason: reason,
    }
    setMessages((prev) => [...prev, msg])
    setInput('')
    if (isBlocked) {
      setBlocked(reason)
      setTimeout(() => setBlocked(null), 5000)
    }
  }

  // Group messages by date
  const groups: { date: string; messages: MockMessage[] }[] = []
  for (const msg of messages) {
    const d = dateSep(msg.created_at)
    const last = groups[groups.length - 1]
    if (!last || last.date !== d) groups.push({ date: d, messages: [msg] })
    else last.messages.push(msg)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Thread header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] shrink-0">
        <button
          onClick={onBack}
          className="lg:hidden p-1.5 rounded-lg hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors text-[#6B5B55] dark:text-[#9B8B85]"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="w-8 h-8 rounded-lg bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center text-xs font-extrabold text-[#6B5B55] dark:text-[#9B8B85] shrink-0">
          {conversation.other_user.initials}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{conversation.other_user.name}</p>
          <p className="text-xs text-[#9B8B85] truncate">{conversation.listing_title}</p>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-[#9B8B85] uppercase tracking-[0.06em]">
          <ShieldAlert size={11} className="text-green-500" />
          <span className="hidden sm:block">Filtered</span>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4 bg-[#FAF8F5] dark:bg-[#0F0A0A]">
        {/* Filter notice */}
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-[#F2EDE8] dark:bg-[#2A1A1A]" />
          <span className="text-[11px] text-[#9B8B85] flex items-center gap-1.5 uppercase tracking-[0.06em]">
            <ShieldAlert size={10} className="text-green-500" />
            Messages monitored for safety
          </span>
          <div className="h-px flex-1 bg-[#F2EDE8] dark:bg-[#2A1A1A]" />
        </div>

        {groups.map(({ date, messages: groupMsgs }) => (
          <div key={date}>
            <div className="flex items-center gap-3 my-5">
              <div className="h-px flex-1 bg-[#F2EDE8] dark:bg-[#2A1A1A]" />
              <span className="text-[11px] text-[#9B8B85] uppercase tracking-[0.06em] px-2">{date}</span>
              <div className="h-px flex-1 bg-[#F2EDE8] dark:bg-[#2A1A1A]" />
            </div>

            <div className="space-y-2">
              {groupMsgs.map((msg) => {
                const isMine = msg.sender_id === CURRENT_USER_ID
                if (msg.is_blocked) {
                  return (
                    <div key={msg.id} className="flex justify-end">
                      <BlockedMessage reason={msg.block_reason} />
                    </div>
                  )
                }
                return (
                  <div key={msg.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[72%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                      isMine
                        ? 'bg-[#8B1A1A] text-white rounded-br-sm'
                        : 'bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-bl-sm'
                    }`}>
                      {msg.content}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Block notice */}
      {blocked && (
        <div className="mx-5 mb-2 flex items-center gap-2 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-xs text-red-600 dark:text-red-400">
          <ShieldAlert size={12} className="shrink-0" />
          <span><strong>Message not sent.</strong> {blocked}. All contact info must stay within Unity.</span>
        </div>
      )}

      {/* Input bar */}
      <div className="px-5 py-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] flex items-end gap-2 shrink-0">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Type a message…"
          rows={1}
          className="flex-1 resize-none px-4 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#0F0A0A] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20 transition-colors max-h-28"
        />
        <button
          onClick={send}
          disabled={!input.trim()}
          className="p-2.5 rounded-xl bg-[#8B1A1A] text-white hover:bg-[#7A1616] transition-colors disabled:opacity-40 shrink-0"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  )
}

function ChatUIInner() {
  const searchParams = useSearchParams()
  const bookingParam = searchParams.get('booking')

  const initialConvId = bookingParam
    ? (MOCK_CONVERSATIONS.find((c) => c.booking_id === bookingParam)?.id ?? null)
    : null

  const [activeId, setActiveId] = useState<string | null>(initialConvId)
  const [mobileShowThread, setMobileShowThread] = useState(!!initialConvId)

  const activeConv = MOCK_CONVERSATIONS.find((c) => c.id === activeId) ?? null

  const selectConversation = (id: string) => {
    setActiveId(id)
    setMobileShowThread(true)
  }

  return (
    <div className="h-[calc(100vh-4rem)] flex overflow-hidden bg-[#FAF8F5] dark:bg-[#0F0A0A]">

      {/* Sidebar — conversation list */}
      <div className={`w-full lg:w-72 lg:flex-shrink-0 lg:border-r border-[#F2EDE8] dark:border-[#2A1A1A] flex flex-col bg-white dark:bg-[#1A1010] ${mobileShowThread ? 'hidden lg:flex' : 'flex'}`}>
        {MOCK_CONVERSATIONS.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <MessageCircle size={32} className="text-[#F2EDE8] dark:text-[#2A1A1A] mb-3" />
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-[#9B8B85]">No conversations yet</p>
            <p className="text-xs text-[#9B8B85] mt-1">Messages from bookings appear here</p>
          </div>
        ) : (
          <ConversationList
            conversations={MOCK_CONVERSATIONS}
            activeId={activeId}
            onSelect={selectConversation}
          />
        )}
      </div>

      {/* Thread pane */}
      <div className={`flex-1 flex flex-col min-w-0 ${mobileShowThread ? 'flex' : 'hidden lg:flex'}`}>
        {activeConv ? (
          <MessageThread
            conversation={activeConv}
            onBack={() => setMobileShowThread(false)}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-[#FAF8F5] dark:bg-[#0F0A0A]">
            <MessageCircle size={36} className="text-[#F2EDE8] dark:text-[#2A1A1A] mb-4" />
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-[#9B8B85]">Select a conversation</p>
          </div>
        )}
      </div>

    </div>
  )
}

export function ChatUI() {
  return (
    <Suspense>
      <ChatUIInner />
    </Suspense>
  )
}
