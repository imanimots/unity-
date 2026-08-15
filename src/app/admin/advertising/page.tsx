'use client'

import { useState, useEffect, useCallback } from 'react'
import { Check, X, Ban, RotateCcw } from 'lucide-react'
import { Pill, StatCard, AdminPageHeader, secondaryButtonClass, primaryButtonClass, formatDateTime, formatMoney, newIdempotencyKey } from '@/components/admin/ui'

interface AdAdvertiser {
  id: string
  advertiser_type: 'unity' | 'external'
  display_name: string
  status: string
  created_at: string
}

interface AdCampaign {
  id: string
  advertiser_id: string
  status: string
  snapshot_placement_type: string
  snapshot_placement_tier: string
  snapshot_price_cents: number
  snapshot_currency: string
  delivered_impressions: number
  snapshot_impression_quota: number
  created_at: string
}

interface AdCreative {
  campaign_id: string
  headline: string
  image_url: string | null
  cta_text: string
  destination_url: string
  moderation_status: string
  created_at: string
}

interface AdPackage {
  id: string
  name: string
  inventory_class: string
  placement_type: string
  placement_tier: string
  price_cents: number
  currency: string
  impression_quota: number
  is_active: boolean
  is_test: boolean
}

const ADVERTISER_STATUS_STYLES: Record<string, string> = {
  pending_review: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  active: 'bg-green-100 text-green-700',
  suspended: 'bg-red-100 text-red-700',
  rejected: 'bg-[#F2EDE8] text-[#6B5B55]',
}

const CAMPAIGN_STATUS_STYLES: Record<string, string> = {
  draft: 'bg-[#F2EDE8] text-[#6B5B55]',
  funded: 'bg-blue-100 text-blue-700',
  pending_review: 'bg-amber-100 text-amber-700',
  active: 'bg-green-100 text-green-700',
  paused: 'bg-amber-100 text-amber-700',
  completed: 'bg-[#F2EDE8] text-[#6B5B55]',
  cancelled: 'bg-[#F2EDE8] text-[#9B8B85]',
  rejected: 'bg-red-100 text-red-700',
  suspended: 'bg-red-100 text-red-700',
}

type Tab = 'advertisers' | 'campaigns' | 'creatives' | 'packages'

export default function AdminAdvertisingPage() {
  const [tab, setTab] = useState<Tab>('advertisers')
  const [advertisers, setAdvertisers] = useState<AdAdvertiser[]>([])
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([])
  const [creatives, setCreatives] = useState<AdCreative[]>([])
  const [packages, setPackages] = useState<AdPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [advRes, campRes, creaRes, pkgRes] = await Promise.all([
        fetch('/api/admin/advertising/advertisers').then((r) => r.json()),
        fetch('/api/admin/advertising/campaigns').then((r) => r.json()),
        fetch('/api/admin/advertising/creatives').then((r) => r.json()),
        fetch('/api/admin/advertising/packages').then((r) => r.json()),
      ])
      setAdvertisers(advRes.advertisers ?? [])
      setCampaigns(campRes.campaigns ?? [])
      setCreatives(creaRes.creatives ?? [])
      setPackages(pkgRes.packages ?? [])
    } catch {
      setError('Could not load advertising data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const runAction = useCallback(
    async (path: string, id: string, reasonRequired: boolean) => {
      let reason: string | undefined
      if (reasonRequired) {
        reason = window.prompt('Reason (required):') ?? undefined
        if (!reason || !reason.trim()) return
      }
      setBusyId(id)
      setError(null)
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason, idempotencyKey: newIdempotencyKey() }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          setError(data.error ?? 'Action failed')
        } else {
          await load()
        }
      } finally {
        setBusyId(null)
      }
    },
    [load]
  )

  const pendingAdvertisers = advertisers.filter((a) => a.status === 'pending_review').length
  const pendingCampaigns = campaigns.filter((c) => c.status === 'pending_review').length
  const pendingCreatives = creatives.filter((c) => c.moderation_status === 'pending_review').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Trust & Safety" title="Advertising" />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="Advertisers pending" value={pendingAdvertisers} />
        <StatCard label="Campaigns pending" value={pendingCampaigns} />
        <StatCard label="Creatives pending" value={pendingCreatives} />
        <StatCard label="Packages" value={packages.length} />
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex gap-2 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
        {(['advertisers', 'campaigns', 'creatives', 'packages'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
              tab === t ? 'border-[#8B1A1A] text-[#8B1A1A]' : 'border-transparent text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-[#9B8B85]">Loading…</p>
      ) : (
        <>
          {tab === 'advertisers' && (
            <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {advertisers.map((a) => (
                    <tr key={a.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-0">
                      <td className="px-4 py-3 font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{a.display_name}</td>
                      <td className="px-4 py-3 capitalize text-[#6B5B55] dark:text-[#9B8B85]">{a.advertiser_type}</td>
                      <td className="px-4 py-3"><Pill value={a.status} styles={ADVERTISER_STATUS_STYLES} /></td>
                      <td className="px-4 py-3 text-[#6B5B55] dark:text-[#9B8B85]">{formatDateTime(a.created_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1.5">
                          {a.status === 'pending_review' && (
                            <>
                              <button disabled={busyId === a.id} onClick={() => runAction(`/api/admin/advertising/advertisers/${a.id}/approve`, a.id, false)} className={primaryButtonClass}>
                                <Check size={12} /> Approve
                              </button>
                              <button disabled={busyId === a.id} onClick={() => runAction(`/api/admin/advertising/advertisers/${a.id}/reject`, a.id, true)} className={secondaryButtonClass}>
                                <X size={12} /> Reject
                              </button>
                            </>
                          )}
                          {a.status !== 'suspended' && a.status !== 'rejected' && (
                            <button disabled={busyId === a.id} onClick={() => runAction(`/api/admin/advertising/advertisers/${a.id}/suspend`, a.id, true)} className={secondaryButtonClass}>
                              <Ban size={12} /> Suspend
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {advertisers.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-[#9B8B85]">No advertisers yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'campaigns' && (
            <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
                    <th className="px-4 py-3">Placement</th>
                    <th className="px-4 py-3">Tier</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Delivered</th>
                    <th className="px-4 py-3">Price</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-0">
                      <td className="px-4 py-3 font-medium text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{c.snapshot_placement_type.replace(/_/g, ' ')}</td>
                      <td className="px-4 py-3 capitalize text-[#6B5B55] dark:text-[#9B8B85]">{c.snapshot_placement_tier}</td>
                      <td className="px-4 py-3"><Pill value={c.status} styles={CAMPAIGN_STATUS_STYLES} /></td>
                      <td className="px-4 py-3 text-[#6B5B55] dark:text-[#9B8B85]">{c.delivered_impressions} / {c.snapshot_impression_quota}</td>
                      <td className="px-4 py-3 text-[#6B5B55] dark:text-[#9B8B85]">{formatMoney(c.snapshot_price_cents / 100, c.snapshot_currency)}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1.5">
                          {c.status === 'pending_review' && (
                            <>
                              <button disabled={busyId === c.id} onClick={() => runAction(`/api/admin/advertising/campaigns/${c.id}/approve`, c.id, false)} className={primaryButtonClass}>
                                <Check size={12} /> Approve
                              </button>
                              <button disabled={busyId === c.id} onClick={() => runAction(`/api/admin/advertising/campaigns/${c.id}/reject`, c.id, true)} className={secondaryButtonClass}>
                                <X size={12} /> Reject
                              </button>
                            </>
                          )}
                          {(c.status === 'active' || c.status === 'paused') && (
                            <button disabled={busyId === c.id} onClick={() => runAction(`/api/admin/advertising/campaigns/${c.id}/suspend`, c.id, true)} className={secondaryButtonClass}>
                              <Ban size={12} /> Suspend
                            </button>
                          )}
                          {c.status === 'suspended' && (
                            <button disabled={busyId === c.id} onClick={() => runAction(`/api/admin/advertising/campaigns/${c.id}/restore`, c.id, true)} className={secondaryButtonClass}>
                              <RotateCcw size={12} /> Restore
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {campaigns.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-[#9B8B85]">No campaigns yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'creatives' && (
            <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
                    <th className="px-4 py-3">Headline</th>
                    <th className="px-4 py-3">Destination</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {creatives.map((c) => (
                    <tr key={c.campaign_id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-0">
                      <td className="px-4 py-3 font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{c.headline}</td>
                      <td className="px-4 py-3 text-[#6B5B55] dark:text-[#9B8B85] truncate max-w-xs">{c.destination_url}</td>
                      <td className="px-4 py-3"><Pill value={c.moderation_status} styles={ADVERTISER_STATUS_STYLES} /></td>
                      <td className="px-4 py-3">
                        {c.moderation_status === 'pending_review' && (
                          <div className="flex gap-1.5">
                            <button disabled={busyId === c.campaign_id} onClick={() => runAction(`/api/admin/advertising/creatives/${c.campaign_id}/approve`, c.campaign_id, false)} className={primaryButtonClass}>
                              <Check size={12} /> Approve
                            </button>
                            <button disabled={busyId === c.campaign_id} onClick={() => runAction(`/api/admin/advertising/creatives/${c.campaign_id}/reject`, c.campaign_id, true)} className={secondaryButtonClass}>
                              <X size={12} /> Reject
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {creatives.length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-8 text-center text-[#9B8B85]">No external creatives yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'packages' && <PackagesTab packages={packages} onCreated={load} />}
        </>
      )}
    </div>
  )
}

function PackagesTab({ packages, onCreated }: { packages: AdPackage[]; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [inventoryClass, setInventoryClass] = useState<'unity_marketplace' | 'external'>('unity_marketplace')
  const [placementType, setPlacementType] = useState('search_result')
  const [placementTier, setPlacementTier] = useState('standard')
  const [positionBand, setPositionBand] = useState('')
  const [priceCents, setPriceCents] = useState('')
  const [impressionQuota, setImpressionQuota] = useState('')
  const [isTest, setIsTest] = useState(true)
  const [isActive, setIsActive] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    const price = Number(priceCents)
    const quota = Number(impressionQuota)
    if (!name.trim() || !positionBand.trim() || !Number.isFinite(price) || price < 0 || !Number.isFinite(quota) || quota < 1) {
      setError('Please complete every field with valid values.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/admin/advertising/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, inventoryClass, placementType, placementTier, positionBand,
          priceCents: price, impressionQuota: quota, currency: 'ZAR', isActive, isTest,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? 'Could not create package')
      } else {
        setName(''); setPositionBand(''); setPriceCents(''); setImpressionQuota('')
        onCreated()
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">New package</p>
        <p className="text-xs text-[#9B8B85]">No production Rand amounts are pre-filled — every commercial value is supplied explicitly here.</p>
        <div className="grid grid-cols-2 gap-3">
          <input className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm bg-transparent" placeholder="Name (e.g. [QA] Standard Search)" value={name} onChange={(e) => setName(e.target.value)} />
          <select className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm bg-transparent" value={inventoryClass} onChange={(e) => setInventoryClass(e.target.value as 'unity_marketplace' | 'external')}>
            <option value="unity_marketplace">Unity marketplace</option>
            <option value="external">External</option>
          </select>
          <select className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm bg-transparent" value={placementType} onChange={(e) => setPlacementType(e.target.value)}>
            <option value="homepage_banner">Homepage banner</option>
            <option value="search_loading_popup">Search loading popup</option>
            <option value="search_result">Sponsored search result</option>
            <option value="promoted_deals">Promoted deals</option>
          </select>
          <select className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm bg-transparent" value={placementTier} onChange={(e) => setPlacementTier(e.target.value)}>
            <option value="value">Value</option>
            <option value="standard">Standard</option>
            <option value="premium">Premium</option>
          </select>
          <input className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm bg-transparent" placeholder="Position band (e.g. slot-3)" value={positionBand} onChange={(e) => setPositionBand(e.target.value)} />
          <input className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm bg-transparent" placeholder="Price (cents)" value={priceCents} onChange={(e) => setPriceCents(e.target.value)} />
          <input className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm bg-transparent" placeholder="Impression quota" value={impressionQuota} onChange={(e) => setImpressionQuota(e.target.value)} />
          <div className="flex items-center gap-4 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} /> QA/test only</label>
          </div>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button disabled={submitting} onClick={submit} className={primaryButtonClass}>Create package</button>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Placement</th>
              <th className="px-4 py-3">Tier</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">Quota</th>
              <th className="px-4 py-3">Active</th>
            </tr>
          </thead>
          <tbody>
            {packages.map((p) => (
              <tr key={p.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-0">
                <td className="px-4 py-3 font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{p.name}{p.is_test ? ' (QA)' : ''}</td>
                <td className="px-4 py-3 capitalize text-[#6B5B55] dark:text-[#9B8B85]">{p.placement_type.replace(/_/g, ' ')}</td>
                <td className="px-4 py-3 capitalize text-[#6B5B55] dark:text-[#9B8B85]">{p.placement_tier}</td>
                <td className="px-4 py-3 text-[#6B5B55] dark:text-[#9B8B85]">{formatMoney(p.price_cents / 100, p.currency)}</td>
                <td className="px-4 py-3 text-[#6B5B55] dark:text-[#9B8B85]">{p.impression_quota.toLocaleString()}</td>
                <td className="px-4 py-3">{p.is_active ? 'Yes' : 'No'}</td>
              </tr>
            ))}
            {packages.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-[#9B8B85]">No packages configured yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
