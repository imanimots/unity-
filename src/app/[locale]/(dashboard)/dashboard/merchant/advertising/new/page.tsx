'use client'

import { useState, useEffect, useCallback } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import type { Locale } from '@/i18n/locales'
import { useRouter, Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { formatMoney } from '@/lib/i18n/format'

interface AdPackage {
  id: string
  name: string
  inventory_class: string
  placement_type: string
  placement_tier: string
  position_band: string | null
  price_cents: number
  currency: string
  impression_quota: number
}

interface MerchantListing {
  id: string
  title: string
  category: string
  daily_rate: number
}

interface AdAdvertiser {
  id: string
  advertiser_type: 'unity' | 'external'
  display_name: string
  status: string
}

export default function NewAdCampaignPage() {
  const router = useRouter()
  const locale = useLocale() as Locale
  const t = useTranslations('advertising.create')
  const tAd = useTranslations('advertising')
  const money = useCallback((cents: number, currency: string) => formatMoney(cents, currency, locale), [locale])
  const PLACEMENT_LABEL: Record<string, string> = {
    homepage_banner: t('placements.homepageBanner'),
    search_loading_popup: t('placements.searchLoadingPopup'),
    search_result: tAd('sponsoredSearchResult'),
    promoted_deals: t('placements.promotedDeals'),
  }
  const [advertisers, setAdvertisers] = useState<AdAdvertiser[]>([])
  const [packages, setPackages] = useState<AdPackage[]>([])
  const [listings, setListings] = useState<MerchantListing[]>([])
  const [loading, setLoading] = useState(true)

  const [advertiserId, setAdvertiserId] = useState('')
  const [packageId, setPackageId] = useState('')
  const [listingId, setListingId] = useState('')
  const [endAt, setEndAt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [tomorrow, setTomorrow] = useState('')

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTomorrow(new Date(Date.now() + 86400000).toISOString().slice(0, 10))

    async function load() {
      const [advRes, pkgRes, listRes] = await Promise.all([
        fetch('/api/advertising/advertisers').then((r) => r.json()),
        fetch('/api/advertising/packages').then((r) => r.json()),
        fetch('/api/advertising/merchant-listings').then((r) => r.json()),
      ])
      const adv: AdAdvertiser[] = (advRes.advertisers ?? []).filter((a: AdAdvertiser) => a.advertiser_type === 'unity')
      setAdvertisers(adv)
      if (adv.length > 0) setAdvertiserId(adv[0].id)
      setPackages(pkgRes.packages ?? [])
      setListings(listRes.listings ?? [])
      setLoading(false)
    }
    load()
  }, [])

  const selectedPackage = packages.find((p) => p.id === packageId)

  const submit = useCallback(async () => {
    setError(null)
    if (!advertiserId || !packageId || !listingId || !endAt) {
      setError(t('errors.completeAllFields'))
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/advertising/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          advertiserId,
          packageId,
          targetType: 'listing',
          listingId,
          endAt: new Date(endAt).toISOString(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('errors.couldNotCreate'))
        setSubmitting(false)
        return
      }
      router.push(`/dashboard/merchant/advertising/${data.id}`)
    } catch {
      setError(t('errors.generic'))
      setSubmitting(false)
    }
  }, [advertiserId, packageId, listingId, endAt, router, t])

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <Link href="/dashboard/merchant/advertising" className="inline-flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#8B1A1A] mb-6">
        <ArrowLeft size={14} /> {t('backToAdvertising')}
      </Link>

      <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">{t('heading')}</h1>
      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-8">
        {t('description')}
      </p>

      {loading ? (
        <p className="text-sm text-[#9B8B85]">{t('loading')}</p>
      ) : advertisers.length === 0 ? (
        <p className="text-sm text-[#9B8B85]">
          {t('noAdvertiserNotice')}
        </p>
      ) : listings.length === 0 ? (
        <p className="text-sm text-[#9B8B85]">
          {t('noListingsNotice')}
        </p>
      ) : (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">{t('listingLabel')}</label>
            <select
              value={listingId}
              onChange={(e) => setListingId(e.target.value)}
              className="w-full rounded-xl border border-[#E8E0D8] dark:border-[#2A1A1A] bg-transparent px-4 py-2.5 text-sm"
            >
              <option value="">{t('selectListingPlaceholder')}</option>
              {listings.map((l) => (
                <option key={l.id} value={l.id}>{l.title}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">{t('packageLabel')}</label>
            <div className="space-y-2">
              {packages.filter((p) => p.inventory_class === 'unity_marketplace').map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPackageId(p.id)}
                  className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
                    packageId === p.id ? 'border-[#8B1A1A] bg-[#8B1A1A]/5' : 'border-[#E8E0D8] dark:border-[#2A1A1A]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{p.name}</p>
                      <p className="text-xs text-[#9B8B85] mt-0.5">
                        {PLACEMENT_LABEL[p.placement_type] ?? p.placement_type} · {p.placement_tier} {t('tierSuffix')} · {p.impression_quota.toLocaleString(locale)} {t('impressionsSuffix')}
                      </p>
                    </div>
                    <span className="text-sm font-bold text-[#8B1A1A]">{money(p.price_cents, p.currency)}</span>
                  </div>
                </button>
              ))}
              {packages.filter((p) => p.inventory_class === 'unity_marketplace').length === 0 && (
                <p className="text-sm text-[#9B8B85]">{t('noPackagesNotice')}</p>
              )}
            </div>
            {selectedPackage && (
              <p className="text-xs text-[#9B8B85] mt-2">
                {t('tierGuaranteeNotice')}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">{t('endDateLabel')}</label>
            <input
              type="date"
              value={endAt}
              min={tomorrow}
              onChange={(e) => setEndAt(e.target.value)}
              className="w-full rounded-xl border border-[#E8E0D8] dark:border-[#2A1A1A] bg-transparent px-4 py-2.5 text-sm"
            />
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <button
            onClick={submit}
            disabled={submitting}
            className="w-full py-3 rounded-full text-sm font-semibold bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors disabled:opacity-50"
          >
            {submitting ? t('creating') : t('continueToFunding')}
          </button>
        </div>
      )}
    </div>
  )
}
