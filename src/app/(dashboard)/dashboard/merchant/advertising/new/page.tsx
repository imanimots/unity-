'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

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

function money(cents: number, currency: string): string {
  return `${currency === 'ZAR' ? 'R' : currency + ' '}${(cents / 100).toFixed(2)}`
}

const PLACEMENT_LABEL: Record<string, string> = {
  homepage_banner: 'Homepage banner',
  search_loading_popup: 'Search loading popup',
  search_result: 'Sponsored search result',
  promoted_deals: 'Promoted deals',
}

export default function NewAdCampaignPage() {
  const router = useRouter()
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
      setError('Please complete every field before continuing.')
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
        setError(data.error ?? 'Could not create campaign')
        setSubmitting(false)
        return
      }
      router.push(`/dashboard/merchant/advertising/${data.id}`)
    } catch {
      setError('Something went wrong — please try again.')
      setSubmitting(false)
    }
  }, [advertiserId, packageId, listingId, endAt, router])

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <Link href="/dashboard/merchant/advertising" className="inline-flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#8B1A1A] mb-6">
        <ArrowLeft size={14} /> Back to advertising
      </Link>

      <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">New campaign</h1>
      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-8">
        Choose a package, pick which listing to promote, and set an end date. You&apos;ll fund the campaign on the next step.
      </p>

      {loading ? (
        <p className="text-sm text-[#9B8B85]">Loading…</p>
      ) : advertisers.length === 0 ? (
        <p className="text-sm text-[#9B8B85]">
          You need an advertising account first — go back and set one up.
        </p>
      ) : listings.length === 0 ? (
        <p className="text-sm text-[#9B8B85]">
          You don&apos;t have any active listings to advertise yet.
        </p>
      ) : (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">Listing to promote</label>
            <select
              value={listingId}
              onChange={(e) => setListingId(e.target.value)}
              className="w-full rounded-xl border border-[#E8E0D8] dark:border-[#2A1A1A] bg-transparent px-4 py-2.5 text-sm"
            >
              <option value="">Select a listing…</option>
              {listings.map((l) => (
                <option key={l.id} value={l.id}>{l.title}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">Package</label>
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
                        {PLACEMENT_LABEL[p.placement_type] ?? p.placement_type} · {p.placement_tier} tier · {p.impression_quota.toLocaleString()} impressions
                      </p>
                    </div>
                    <span className="text-sm font-bold text-[#8B1A1A]">{money(p.price_cents, p.currency)}</span>
                  </div>
                </button>
              ))}
              {packages.filter((p) => p.inventory_class === 'unity_marketplace').length === 0 && (
                <p className="text-sm text-[#9B8B85]">No packages are available right now.</p>
              )}
            </div>
            {selectedPackage && (
              <p className="text-xs text-[#9B8B85] mt-2">
                Higher tiers earn earlier, more visible placement — package guarantees only the approved impression allocation, never a guaranteed sale or click count.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">Campaign end date</label>
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
            {submitting ? 'Creating…' : 'Continue to funding'}
          </button>
        </div>
      )}
    </div>
  )
}
