import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { getTranslations, getMessages, getLocale } from 'next-intl/server'
import { requireAuth } from '@/lib/supabase/require-admin'
import { listMyConversations } from '@/lib/messaging/conversations'
import { withLocalePrefix, type Locale } from '@/i18n/locales'
import { ChatUI } from './chat-ui'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'

// Always noindex (Unity SEO Pre-Launch Hardening, Part E) — an
// authenticated, per-user transaction-messaging page, not a public one.
// Set explicitly here (not inherited) since /chat lives under the shared
// (marketing) layout alongside pages that should stay indexable later.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('common.chat')
  return { title: t('metaTitle'), robots: PERMANENT_NOINDEX }
}

export default async function ChatPage() {
  const locale = (await getLocale()) as Locale
  const requester = await requireAuth()
  if (!requester) {
    const target = withLocalePrefix('/chat', locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const conversations = supabase ? await listMyConversations(supabase, requester.userId) : []

  // Narrowly scoped nested provider (same principle as the public
  // book/buy/listing-detail/looking-for pages) -- /chat is reachable only
  // by authenticated users but lives under the (marketing) layout, which
  // has no wide provider by design. Scoped to just the `common.chat`
  // namespace this client subtree actually needs.
  const messages = await getMessages()
  const scoped = { common: { chat: messages.common.chat } }

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A]">
      <NextIntlClientProvider messages={scoped}>
        <ChatUI conversations={conversations} currentUserId={requester.userId} locale={locale} />
      </NextIntlClientProvider>
    </div>
  )
}
