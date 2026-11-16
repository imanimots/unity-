'use client'

import { useState } from 'react'
import { Link, useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft, MapPin, Calendar, Clock, ShieldCheck } from 'lucide-react'
import { ProfileLink } from '@/components/shared/profile-link'
import { CATEGORIES } from '@/types'

interface Offer {
  id: string
  responder_id: string
  offer_type: string
  status: string
  amount: number | null
  currency: string
  message: string | null
  linked_listing_id: string | null
  created_at: string
}

interface RequestDetail {
  id: string
  transaction_type: 'buy' | 'rent' | 'barter'
  status: string
  title: string
  description: string | null
  category: string | null
  city: string | null
  province: string | null
  budget_min: number | null
  budget_max: number | null
  currency: string
  start_date: string | null
  end_date: string | null
  expires_at: string | null
  requester_id: string
}

interface Props {
  request: RequestDetail
  requesterName: string
  requesterVerified: boolean
  isOwner: boolean
  initialOffers: Offer[]
  currentUserId: string | null
}

/**
 * Step O/S/AC/AD -- request detail + the 4 response paths + owner
 * accept/decline + responder withdraw. A single client component
 * (server page handles auth/fetch/metadata) since the available
 * actions depend heavily on live client state (who's viewing, what
 * they've already submitted). E47 Phase 5: restyled to the same
 * detail-page card language as Listing Detail -- every fetch call,
 * state variable, and conditional below is unchanged from before.
 */
export function RequestDetailClient({ request, requesterName, requesterVerified, isOwner, initialOffers, currentUserId }: Props) {
  const router = useRouter()
  const t = useTranslations('lookingFor.detail')
  const tMode = useTranslations('marketplace.mode')
  const tStatus = useTranslations('lookingFor.status')
  const [offers, setOffers] = useState(initialOffers)
  const [showOfferForm, setShowOfferForm] = useState(false)
  const [offerType, setOfferType] = useState<'link_listing' | 'private_offer' | 'message_only'>('private_offer')
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const myOffer = offers.find((o) => o.responder_id === currentUserId)

  async function submitOffer(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/marketplace/requests/${request.id}/offers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offer_type: offerType,
          amount: amount ? Number(amount) : undefined,
          message: message || undefined,
          idempotency_key: crypto.randomUUID(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('couldNotSubmit'))
        return
      }
      router.refresh()
      setShowOfferForm(false)
    } catch {
      setError(t('networkError'))
    } finally {
      setBusy(false)
    }
  }

  async function acceptOffer(offerId: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/marketplace/offers/${offerId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('couldNotAccept'))
        return
      }
      router.refresh()
    } catch {
      setError(t('networkError'))
    } finally {
      setBusy(false)
    }
  }

  async function declineOffer(offerId: string) {
    setBusy(true)
    try {
      await fetch(`/api/marketplace/offers/${offerId}/decline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function withdrawOffer(offerId: string) {
    setBusy(true)
    try {
      await fetch(`/api/marketplace/offers/${offerId}/withdraw`, { method: 'POST' })
      setOffers((prev) => prev.filter((o) => o.id !== offerId))
    } finally {
      setBusy(false)
    }
  }

  const inputClass = 'w-full h-11 px-4 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30 focus:border-[#8B1A1A] transition-colors'
  const statusKey = request.status.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  const offerTypeLabel = (kind: string) => t(`offerTypes.${kind}` as 'offerTypes.private_offer')
  const offerStatusLabel = (status: string) => t(`offerStatus.${status}` as 'offerStatus.pending')
  const categoryLabel = CATEGORIES.find((c) => c.id === request.category)?.label ?? request.category

  const metaRows: { label: string; value: string }[] = []
  if (categoryLabel) metaRows.push({ label: t('category'), value: categoryLabel })
  if (request.city || request.province) metaRows.push({ label: t('location'), value: [request.city, request.province].filter(Boolean).join(', ') })
  if (request.budget_min || request.budget_max) metaRows.push({ label: t('budget'), value: `${request.currency} ${request.budget_min ?? 0}–${request.budget_max ?? '?'}` })
  if (request.start_date) metaRows.push({ label: t('dates'), value: `${request.start_date} – ${request.end_date}` })
  if (request.expires_at) metaRows.push({ label: t('expires'), value: new Date(request.expires_at).toLocaleDateString() })

  return (
    <div className="max-w-3xl space-y-8">
      <Link href="/listings?direction=looking-for" className="inline-flex items-center gap-1.5 text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">
        <ArrowLeft size={14} /> {t('backToRequests')}
      </Link>

      <div>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#6B5B55] bg-[#F2EDE8] px-2.5 py-1 rounded-full mb-4">
          <Clock size={11} /> {t('lookingToTransact', { type: tMode(request.transaction_type), status: tStatus(statusKey as 'active') })}
        </span>
        <h1 className="text-3xl lg:text-4xl font-extrabold text-[#1A0A0A] leading-tight mb-3">{request.title}</h1>
        <p className="text-sm text-[#6B5B55] flex items-center gap-1.5 flex-wrap">
          {t('postedByPrefix')} <ProfileLink userId={request.requester_id} displayName={requesterName} currentUserId={currentUserId} className="font-medium text-[#1A0A0A]" />
          {requesterVerified && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
              <ShieldCheck size={11} /> {t('verified')}
            </span>
          )}
        </p>
      </div>

      {request.description && (
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">{t('description')}</h2>
          <p className="text-base text-[#6B5B55] leading-relaxed">{request.description}</p>
        </div>
      )}

      {metaRows.length > 0 && (
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4 flex items-center gap-2">
            {(request.city || request.province) ? <MapPin size={14} /> : <Calendar size={14} />} {t('detailsHeading')}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {metaRows.map(({ label, value }) => (
              <div key={label} className="flex justify-between items-center px-4 py-3 bg-white rounded-xl border border-[#F2EDE8] text-sm">
                <span className="text-[#6B5B55]">{label}</span>
                <span className="font-medium text-[#1A0A0A]">{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!isOwner && currentUserId && ['active', 'offers_received'].includes(request.status) && !myOffer && (
        <div className="rounded-2xl border border-[#F2EDE8] bg-white p-5 sm:p-6">
          <h2 className="font-bold text-[#1A0A0A] mb-4">{t('respondToRequest')}</h2>
          {!showOfferForm ? (
            <button onClick={() => setShowOfferForm(true)} className="px-5 py-2.5 rounded-full font-semibold bg-[#8B1A1A] text-white hover:bg-[#7A1616] transition-colors">{t('respond')}</button>
          ) : (
            <form onSubmit={submitOffer} className="space-y-3 max-w-md">
              <div className="flex gap-2 flex-wrap">
                {(['private_offer', 'link_listing', 'message_only'] as const).map((kind) => (
                  <button key={kind} type="button" onClick={() => setOfferType(kind)} className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${offerType === kind ? 'bg-[#8B1A1A] text-white' : 'bg-[#F2EDE8] text-[#6B5B55] hover:bg-[#E8E0D8]'}`}>
                    {kind === 'private_offer' ? t('privateOffer') : kind === 'link_listing' ? t('linkListing') : t('messageOnly')}
                  </button>
                ))}
              </div>
              {offerType !== 'message_only' && (
                <input type="number" placeholder={t('amountPlaceholder')} value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} />
              )}
              <textarea placeholder={t('messagePlaceholder')} value={message} onChange={(e) => setMessage(e.target.value)} rows={3} className={`${inputClass} h-auto py-3`} />
              <button type="submit" disabled={busy} className="px-5 py-2.5 rounded-full font-semibold bg-[#8B1A1A] text-white hover:bg-[#7A1616] transition-colors disabled:opacity-50">{t('send')}</button>
            </form>
          )}
        </div>
      )}

      {!isOwner && myOffer && (
        <div className="rounded-2xl border border-[#F2EDE8] bg-white p-5 sm:p-6">
          <h2 className="font-bold text-[#1A0A0A] mb-3">{t('yourResponse')}</h2>
          <p className="text-sm text-[#6B5B55]">{t('statusLabel', { status: offerStatusLabel(myOffer.status) })}</p>
          {myOffer.status === 'pending' && (
            <button onClick={() => withdrawOffer(myOffer.id)} disabled={busy} className="mt-3 px-4 py-2 rounded-full text-sm font-semibold border border-[#E8E0D8] text-[#1A0A0A] hover:bg-[#F2EDE8] transition-colors disabled:opacity-50">{t('withdraw')}</button>
          )}
        </div>
      )}

      {isOwner && (
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">{t('responses', { count: offers.length })}</h2>
          {offers.length === 0 ? (
            <div className="rounded-2xl border border-[#F2EDE8] bg-white p-6 text-center">
              <p className="text-sm text-[#9B8B85]">{t('noResponses')}</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {offers.map((o) => (
                <li key={o.id} className="rounded-2xl border border-[#F2EDE8] bg-white p-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-[#1A0A0A]">{offerTypeLabel(o.offer_type)} · {offerStatusLabel(o.status)}</span>
                    {o.amount !== null && <span className="text-sm font-medium text-[#8B1A1A]">{o.currency} {o.amount}</span>}
                  </div>
                  {o.message && <p className="text-sm text-[#6B5B55] mt-2 leading-relaxed">{o.message}</p>}
                  {o.status === 'pending' && o.offer_type !== 'message_only' && (
                    <div className="flex gap-2 mt-4">
                      <button onClick={() => acceptOffer(o.id)} disabled={busy} className="px-4 py-1.5 rounded-full text-xs font-semibold bg-[#8B1A1A] text-white hover:bg-[#7A1616] transition-colors disabled:opacity-50">{t('accept')}</button>
                      <button onClick={() => declineOffer(o.id)} disabled={busy} className="px-4 py-1.5 rounded-full text-xs font-semibold border border-[#E8E0D8] text-[#1A0A0A] hover:bg-[#F2EDE8] transition-colors disabled:opacity-50">{t('decline')}</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
