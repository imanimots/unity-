import { redirect } from 'next/navigation'
import { requireAuth } from '@/lib/supabase/require-admin'
import { listMyConversations } from '@/lib/messaging/conversations'
import { ChatUI } from './chat-ui'

export const metadata = { title: 'Messages — Unity' }

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
