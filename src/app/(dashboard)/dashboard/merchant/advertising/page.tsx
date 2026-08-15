'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus } from 'lucide-react'

interface AdCampaign {
  id: string
  status: string
  snapshot_placement_type: string
  snapshot_placement_tier: string
  snapshot_price_cents: number
  snapshot_currency: string
  delivered_impressions: number
  snapshot_impression_quota: number
  end_at: string | null
  created_at: string
}

interface AdAdvertiser {
  id: string
  advertiser_type: 'unity' | 'external'
  display_name: string
  status: string
  balance: { balance_cents: number; currency: string } | null
}

function money(cents: number, currency: string): string {
  return `${currency === 'ZAR' ? 'R' : currency + ' '}${(cents / 100).toFixed(2)}`
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', funded: 'Funded', pending_review: 'Pending review', active: 'Active',
  paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled', rejected: 'Rejected', suspended: 'Suspended',
}

export default function MerchantAdvertisingPage() {
  const [advertisers, setAdvertisers] = useState<AdAdvertiser[] | null>(null)
  const [campaigns, setCampaigns] = useState<AdCampaign[] | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [advRes, campRes] = await Promise.all([
      fetch('/api/advertising/advertisers').then((r) => r.json()),
      fetch('/api/advertising/campaigns').then((r) => r.json()),
    ])
    setAdvertisers(advRes.advertisers ?? [])
    setCampaigns(campRes.campaigns ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const createUnityAdvertiser = async () => {
    await fetch('/api/advertising/advertisers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ advertiserType: 'unity', displayName: 'My advertising account' }),
    })
    load()
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <Link href="/dashboard/merchant" className="inline-flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#8B1A1A] mb-6">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">Advertising</h1>
      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-8">
        Buy Sponsored placement for your eligible listings. Fixed prepaid packages — no per-click or per-impression billing.
      </p>

      {loading ? (
        <p className="text-sm text-[#9B8B85]">Loading…</p>
      ) : !advertisers || advertisers.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-[#E8E0D8] dark:border-[#2A1A1A] rounded-2xl">
          <p className="text-[#6B5B55] dark:text-[#9B8B85] mb-4">Set up your advertising account to get started.</p>
          <button onClick={createUnityAdvertiser} className="px-5 py-2.5 rounded-full text-sm font-semibold bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors">
            Set up advertising account
          </button>
        </div>
      ) : (
        <>
          {advertisers[0].balance && (
            <div className="mb-8 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] px-5 py-4">
              <p className="text-xs text-[#9B8B85] mb-0.5">Advertising Balance</p>
              <p className="text-lg font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">
                {money(advertisers[0].balance.balance_cents, advertisers[0].balance.currency)}
              </p>
              <p className="text-xs text-[#9B8B85] mt-1">
                Credited from underdelivered campaigns. Reusable for future Unity advertising only — not withdrawable as cash.
              </p>
            </div>
          )}

          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">Your campaigns</h2>
            <Link href="/dashboard/merchant/advertising/new" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors">
              <Plus size={14} /> New campaign
            </Link>
          </div>

          {!campaigns || campaigns.length === 0 ? (
            <p className="text-sm text-[#9B8B85] py-8 text-center">No campaigns yet.</p>
          ) : (
            <div className="space-y-3">
              {campaigns.map((c) => (
                <Link
                  key={c.id}
                  href={`/dashboard/merchant/advertising/${c.id}`}
                  className="block border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-5 py-4 hover:border-[#8B1A1A] transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] text-sm">
                        {c.snapshot_placement_type.replace(/_/g, ' ')} · {c.snapshot_placement_tier}
                      </p>
                      <p className="text-xs text-[#9B8B85] mt-0.5">
                        {c.delivered_impressions} / {c.snapshot_impression_quota} impressions delivered · {money(c.snapshot_price_cents, c.snapshot_currency)}
                      </p>
                    </div>
                    <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]">
                      {STATUS_LABEL[c.status] ?? c.status}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
