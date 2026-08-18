import { redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowLeft, Repeat } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { BarterStatusBadge } from '@/components/barter/barter-status-badge'
import { triggerBarterLazyExpirySweep } from '@/lib/barter/lazy-expiry'
import { withLocalePrefix, type Locale } from '@/i18n/locales'
import { formatDate } from '@/lib/i18n/format'
import type { BarterAgreement } from '@/types'

export const metadata = { title: 'My Trades — Unity' }

export default async function BarterInboxPage() {
  const requester = await requireAuth()
  const locale = (await getLocale()) as Locale
  if (!requester) {
    const target = withLocalePrefix('/dashboard/barter', locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }
  const t = await getTranslations('barter')
  const tCommon = await getTranslations('common')

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url && serviceKey) {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    await triggerBarterLazyExpirySweep(createServiceClient(url, serviceKey))
  }

  const { data } = supabase
    ? await supabase
        .from('barter_agreements')
        .select('*, anchor_listing:listings(title)')
        .or(`party_a_id.eq.${requester.userId},party_b_id.eq.${requester.userId}`)
        .order('proposed_at', { ascending: false })
    : { data: [] as (BarterAgreement & { anchor_listing?: { title: string } })[] }

  const agreements = (data ?? []) as (BarterAgreement & { anchor_listing?: { title: string } })[]

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> {tCommon('dashboard.back')}
        </Link>
      </div>

      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{t('tradesTitle')}</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">{t('tradesTitle')}</h1>
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-3">
          {t('tradeCount', { count: agreements.length })}
        </p>
      </div>

      {agreements.length === 0 ? (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-16 text-center">
          <Repeat size={36} className="mx-auto text-[#9B8B85] mb-4" />
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{t('noTrades')}</p>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-6">{t('noTradesDesc')}</p>
          <Link href="/listings?mode=barter" className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors">
            {t('browseListings')}
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {agreements.map((a) => (
            <Link
              key={a.id}
              href={`/dashboard/barter/${a.id}`}
              className="block bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 hover:border-[#8B1A1A]/40 transition-colors"
            >
              <div className="flex items-start justify-between gap-2 flex-wrap mb-1">
                <span className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                  {t('tradeReference', { reference: a.agreement_reference })}
                  {a.anchor_listing?.title && <span className="font-normal text-[#6B5B55] dark:text-[#9B8B85]"> · {a.anchor_listing.title}</span>}
                </span>
                <BarterStatusBadge status={a.status} />
              </div>
              <p className="text-xs text-[#9B8B85]">
                {t('proposedOn', { date: formatDate(a.proposed_at, locale) })}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
