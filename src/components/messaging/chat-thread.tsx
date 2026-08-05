'use client'

import { useState, useEffect, useRef } from 'react'
import { Send, ShieldAlert, Paperclip, X, FileText, Image as ImageIcon, RotateCw } from 'lucide-react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { validateAttachmentFile, uploadChatAttachment } from '@/lib/messaging/attachments'
import type { Message, MessageAttachment } from '@/types'

type ThreadType = 'booking' | 'order' | 'barter'

interface ChatThreadProps {
  transactionType: ThreadType
  transactionId: string
  currentUserId: string
  /** False for an admin/read-only viewer -- no input, no presence heartbeat. */
  canSend: boolean
  /** Set only when rendered from the dispute detail view -- outgoing messages get tagged with this dispute, but the thread shown is still the full transaction conversation (see src/lib/messaging/service.ts). */
  disputeId?: string
  /** 'embedded' is a compact fixed-height panel (dispute detail view); 'full' fills the available height (the /chat page). */
  variant?: 'full' | 'embedded'
  /** True only for the admin dispute detail page -- routes history reads through the audited GET /api/admin/messages instead of GET /api/messages, so every admin view of a thread is logged (admin_message_access_log). Implies canSend=false at the call site; never used to send. */
  useAdminEndpoint?: boolean
}

interface ThreadMessage extends Message {
  _pending?: boolean
  _failed?: boolean
  _tempId?: string
}

const PARAM_BY_TYPE: Record<ThreadType, string> = { booking: 'booking_id', order: 'order_id', barter: 'barter_agreement_id' }
const HEARTBEAT_INTERVAL_MS = 25_000

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function dateSep(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' })
}

function AttachmentChip({ attachment }: { attachment: MessageAttachment }) {
  const filename = attachment.storage_path.split('/').pop() ?? 'attachment'
  const Icon = attachment.file_type === 'image' ? ImageIcon : FileText
  return (
    <div className="flex items-center gap-1.5 mt-1.5 px-2 py-1 rounded-lg bg-black/10 text-xs">
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{filename}</span>
    </div>
  )
}

/**
 * The one shared chat implementation (Step 11 Phase 3) -- used by the
 * real /chat page and the dispute detail view alike. No BookingChat/
 * OrderChat/DisputeChat/BarterChat variants.
 */
export function ChatThread({ transactionType, transactionId, currentUserId, canSend, disputeId, variant = 'full', useAdminEndpoint = false }: ChatThreadProps) {
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [input, setInput] = useState('')
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const loadedIds = useRef<Set<string>>(new Set())

  const fetchParam = PARAM_BY_TYPE[transactionType]

  // Load history first -- the realtime subscription (below) only opens
  // once this has finished, per review point 9: subscribing before
  // history is loaded can deliver a realtime INSERT that then gets
  // duplicated when history finishes loading.
  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setHistoryLoaded(false)
    setMessages([])
    loadedIds.current = new Set()

    const endpoint = useAdminEndpoint ? '/api/admin/messages' : '/api/messages'
    fetch(`${endpoint}?${fetchParam}=${transactionId}&limit=50`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const history: Message[] = data.messages ?? []
        history.forEach((m) => loadedIds.current.add(m.id))
        setMessages(history)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        setHistoryLoaded(true)
      })

    return () => {
      cancelled = true
    }
  }, [transactionType, transactionId, fetchParam, useAdminEndpoint])

  // Subscribe to realtime inserts for this thread only after history has loaded.
  useEffect(() => {
    if (!historyLoaded) return
    let active = true
    let channel: RealtimeChannel | null = null

    import('@/lib/supabase/client').then(({ createClient }) => {
      if (!active) return
      const supabase = createClient()
      channel = supabase
        .channel(`messages-${transactionType}-${transactionId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages', filter: `${fetchParam}=eq.${transactionId}` },
          (payload: { new: Message }) => {
            const row = payload.new
            if (loadedIds.current.has(row.id)) return
            loadedIds.current.add(row.id)
            setMessages((prev) => [...prev, row])
          }
        )
        .subscribe()
    })

    return () => {
      active = false
      if (channel) {
        import('@/lib/supabase/client').then(({ createClient }) => createClient().removeChannel(channel!))
      }
    }
  }, [historyLoaded, transactionType, transactionId, fetchParam])

  // Presence heartbeat -- upserts this user's own row while the thread
  // is visible/focused; suppresses new-message emails to this user for
  // this thread while it's plausibly open (src/lib/messaging/notify.ts).
  useEffect(() => {
    if (!canSend) return
    let active = true

    async function beat() {
      if (!active || document.visibilityState !== 'visible') return
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      await supabase.from('message_thread_presence').upsert(
        { user_id: currentUserId, transaction_type: transactionType, transaction_id: transactionId, last_active_at: new Date().toISOString() },
        { onConflict: 'user_id,transaction_type,transaction_id' }
      )
    }

    beat()
    const interval = setInterval(beat, HEARTBEAT_INTERVAL_MS)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [canSend, currentUserId, transactionType, transactionId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function postMessage(content: string, tempId: string, file: File | null) {
    const body: Record<string, unknown> = { content, idempotency_key: crypto.randomUUID() }
    if (disputeId) body.dispute_id = disputeId
    else body[fetchParam] = transactionId

    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) {
      setMessages((prev) => prev.map((m) => (m._tempId === tempId ? { ...m, _pending: false, _failed: true } : m)))
      setSendError(data.error ?? 'Could not send this message')
      return
    }

    loadedIds.current.add(data.id)
    setMessages((prev) => prev.map((m) => (m._tempId === tempId ? { ...data } : m)))

    if (file) {
      try {
        const { path, fileType } = await uploadChatAttachment(transactionType, transactionId, currentUserId, file)
        await fetch(`/api/messages/${data.id}/attachments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storage_path: path, file_type: fileType, idempotency_key: crypto.randomUUID() }),
        })
        setMessages((prev) =>
          prev.map((m) => (m.id === data.id ? { ...m, attachments: [...(m.attachments ?? []), { file_type: fileType, storage_path: path } as MessageAttachment] } : m))
        )
      } catch {
        setFileError('Message sent, but the attachment could not be uploaded.')
      }
    }
  }

  async function handleSend() {
    const content = input.trim()
    if (!content || sending || !canSend) return

    const validationError = pendingFile ? validateAttachmentFile(pendingFile) : null
    if (validationError) {
      setFileError(validationError)
      return
    }

    setSending(true)
    setSendError(null)
    setFileError(null)

    const tempId = `temp-${crypto.randomUUID()}`
    const optimistic: ThreadMessage = {
      id: tempId,
      booking_id: transactionType === 'booking' ? transactionId : null,
      order_id: transactionType === 'order' ? transactionId : null,
      barter_agreement_id: transactionType === 'barter' ? transactionId : null,
      dispute_id: disputeId ?? null,
      sender_id: currentUserId,
      content,
      is_filtered: false,
      filter_reason: null,
      created_at: new Date().toISOString(),
      _pending: true,
      _tempId: tempId,
    }
    setMessages((prev) => [...prev, optimistic])
    setInput('')
    const file = pendingFile
    setPendingFile(null)

    try {
      await postMessage(content, tempId, file)
    } catch {
      setMessages((prev) => prev.map((m) => (m._tempId === tempId ? { ...m, _pending: false, _failed: true } : m)))
      setSendError('Could not send this message — please try again')
    } finally {
      setSending(false)
    }
  }

  async function handleRetry(msg: ThreadMessage) {
    if (!msg._tempId || sending) return
    setMessages((prev) => prev.map((m) => (m._tempId === msg._tempId ? { ...m, _pending: true, _failed: false } : m)))
    setSending(true)
    setSendError(null)
    try {
      await postMessage(msg.content, msg._tempId, null)
    } catch {
      setMessages((prev) => prev.map((m) => (m._tempId === msg._tempId ? { ...m, _pending: false, _failed: true } : m)))
    } finally {
      setSending(false)
    }
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const validationError = validateAttachmentFile(file)
    if (validationError) {
      setFileError(validationError)
      return
    }
    setFileError(null)
    setPendingFile(file)
  }

  const groups: { date: string; items: ThreadMessage[] }[] = []
  for (const msg of messages) {
    const d = dateSep(msg.created_at)
    const last = groups[groups.length - 1]
    if (!last || last.date !== d) groups.push({ date: d, items: [msg] })
    else last.items.push(msg)
  }

  const containerHeight = variant === 'embedded' ? 'h-96' : 'h-full'

  return (
    <div className={`flex flex-col ${containerHeight}`}>
      <div className={`flex-1 overflow-y-auto ${variant === 'embedded' ? 'space-y-3 py-2' : 'px-5 py-5 space-y-4 bg-[#FAF8F5] dark:bg-[#0F0A0A]'}`}>
        {loading ? (
          <p className="text-sm text-[#9B8B85] text-center py-8">Loading messages…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] text-center py-8">No messages yet.</p>
        ) : (
          groups.map(({ date, items }) => (
            <div key={date}>
              {variant === 'full' && (
                <div className="flex items-center gap-3 my-5">
                  <div className="h-px flex-1 bg-[#F2EDE8] dark:bg-[#2A1A1A]" />
                  <span className="text-[11px] text-[#9B8B85] uppercase tracking-[0.06em] px-2">{date}</span>
                  <div className="h-px flex-1 bg-[#F2EDE8] dark:bg-[#2A1A1A]" />
                </div>
              )}
              <div className="space-y-2">
                {items.map((msg) => {
                  const isMine = msg.sender_id === currentUserId
                  if (msg.is_filtered) {
                    return (
                      <div key={msg.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                        <div className="flex items-start gap-2 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-xs text-red-600 dark:text-red-400 max-w-xs">
                          <ShieldAlert size={13} className="shrink-0 mt-0.5" />
                          <div>
                            <p className="font-semibold">Message blocked</p>
                            <p>{msg.filter_reason ?? 'Content policy violation'}. Keep all contact info off Unity.</p>
                          </div>
                        </div>
                      </div>
                    )
                  }
                  return (
                    <div key={msg.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                      <div className="max-w-[80%]">
                        <div
                          className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                            isMine
                              ? `bg-[#8B1A1A] text-white rounded-br-sm ${msg._pending ? 'opacity-60' : ''} ${msg._failed ? 'opacity-70 border-2 border-red-400' : ''}`
                              : 'bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-bl-sm'
                          }`}
                        >
                          {msg.content}
                          {(msg.attachments ?? []).map((a, i) => (
                            <AttachmentChip key={a.id ?? i} attachment={a} />
                          ))}
                        </div>
                        <div className={`flex items-center gap-1.5 mt-1 ${isMine ? 'justify-end' : 'justify-start'}`}>
                          {msg._failed ? (
                            // eslint-disable-next-line react-hooks/refs -- handleRetry only ever runs from this click handler, never during render
                            <button onClick={() => handleRetry(msg)} className="flex items-center gap-1 text-[10px] text-red-500 hover:underline">
                              <RotateCw size={10} /> Failed — retry
                            </button>
                          ) : (
                            <span className="text-[10px] text-[#9B8B85]">{msg._pending ? 'Sending…' : formatTime(msg.created_at)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {canSend && (
        <div className={variant === 'embedded' ? 'pt-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A]' : 'px-5 py-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] shrink-0'}>
          {pendingFile && (
            <div className="flex items-center gap-2 mb-2 px-2.5 py-1.5 rounded-lg bg-[#F2EDE8] dark:bg-[#2A1A1A] text-xs text-[#6B5B55] dark:text-[#9B8B85] w-fit">
              <Paperclip size={11} />
              <span className="truncate max-w-[200px]">{pendingFile.name}</span>
              <button onClick={() => setPendingFile(null)} className="hover:text-red-500">
                <X size={11} />
              </button>
            </div>
          )}
          {fileError && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{fileError}</p>}
          {sendError && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{sendError}</p>}
          <div className="flex items-end gap-2">
            <label className="p-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] cursor-pointer transition-colors shrink-0">
              <Paperclip size={15} />
              <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden" onChange={handleFileSelected} disabled={sending} />
            </label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              placeholder="Type a message…"
              rows={1}
              maxLength={2000}
              className="flex-1 resize-none px-4 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#0F0A0A] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20 transition-colors max-h-28"
            />
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="p-2.5 rounded-xl bg-[#8B1A1A] text-white hover:bg-[#7A1616] transition-colors disabled:opacity-40 shrink-0"
            >
              <Send size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
