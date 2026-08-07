import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireAuth } from '@/lib/supabase/require-admin'
import { listMyConversations } from '@/lib/messaging/conversations'
import { ChatUI } from './chat-ui'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'

// Always noindex (Unity SEO Pre-Launch Hardening, Part E) — an
// authenticated, per-user transaction-messaging page, not a public one.
// Set explicitly here (not inherited) since /chat lives under the shared
// (marketing) layout alongside pages that should stay indexable later.
export const metadata: Metadata = { title: 'Messages — Unity', robots: PERMANENT_NOINDEX }

export default async function ChatPage() {
  const requester = await requireAuth()
  if (!requester) redirect('/login?redirectTo=/chat')

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const conversations = supabase ? await listMyConversations(supabase, requester.userId) : []

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A]">
      <ChatUI conversations={conversations} currentUserId={requester.userId} />
    </div>
  )
}
