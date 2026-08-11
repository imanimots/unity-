'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ProfileLink } from '@/components/shared/profile-link'

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
 * they've already submitted).
 */
export function RequestDetailClient({ request, requesterName, requesterVerified, isOwner, initialOffers, currentUserId }: Props) {
  const router = useRouter()
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
        setError(data.error ?? 'Could not submit offer')
        return
      }
      router.refresh()
      setShowOfferForm(false)
    } catch {
      setError('Network error')
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
        setError(data.error ?? 'Could not accept offer')
        return
      }
      router.refresh()
    } catch {
      setError('Network error')
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

  const inputClass = 'w-full h-11 px-4 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010]'

  return (
    <div className="max-w-3xl space-y-8">
      <section>
        <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] mb-3">
          Looking to {request.transaction_type} · {request.status}
        </span>
        <h1 className="text-3xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">{request.title}</h1>
        <p className="text-sm text-[#9B8B85] mb-4">
          Posted by <ProfileLink userId={request.requester_id} displayName={requesterName} currentUserId={currentUserId} />{' '}
          {requesterVerified && <span className="text-green-600">· Verified</span>}
        </p>
        {request.description && <p className="text-[#6B5B55] dark:text-[#9B8B85] mb-4">{request.description}</p>}
        <dl className="grid grid-cols-2 gap-4 text-sm">
          {request.category && (<><dt className="text-[#9B8B85]">Category</dt><dd>{request.category}</dd></>)}
          {(request.city || request.province) && (<><dt className="text-[#9B8B85]">Location</dt><dd>{[request.city, request.province].filter(Boolean).join(', ')}</dd></>)}
          {(request.budget_min || request.budget_max) && (<><dt className="text-[#9B8B85]">Budget</dt><dd>{request.currency} {request.budget_min ?? 0}–{request.budget_max ?? '?'}</dd></>)}
          {request.start_date && (<><dt className="text-[#9B8B85]">Dates</dt><dd>{request.start_date} – {request.end_date}</dd></>)}
          {request.expires_at && (<><dt className="text-[#9B8B85]">Expires</dt><dd>{new Date(request.expires_at).toLocaleDateString()}</dd></>)}
        </dl>
      </section>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {!isOwner && currentUserId && ['active', 'offers_received'].includes(request.status) && !myOffer && (
        <section>
          <h2 className="font-bold text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">Respond to this request</h2>
          {!showOfferForm ? (
            <button onClick={() => setShowOfferForm(true)} className="px-5 py-2.5 rounded-full font-semibold bg-[#8B1A1A] text-white">Respond</button>
          ) : (
            <form onSubmit={submitOffer} className="space-y-3 max-w-md">
              <div className="flex gap-2">
                {(['private_offer', 'link_listing', 'message_only'] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setOfferType(t)} className={`px-3 py-1.5 rounded-full text-xs font-semibold ${offerType === t ? 'bg-[#8B1A1A] text-white' : 'bg-[#F2EDE8] dark:bg-[#2A1A1A]'}`}>
                    {t === 'private_offer' ? 'Private offer' : t === 'link_listing' ? 'Link a listing' : 'Just message'}
                  </button>
                ))}
              </div>
              {offerType !== 'message_only' && (
                <input type="number" placeholder="Amount (ZAR)" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} />
              )}
              <textarea placeholder="Message" value={message} onChange={(e) => setMessage(e.target.value)} rows={3} className={`${inputClass} h-auto py-3`} />
              <button type="submit" disabled={busy} className="px-5 py-2.5 rounded-full font-semibold bg-[#8B1A1A] text-white disabled:opacity-50">Send</button>
            </form>
          )}
        </section>
      )}

      {!isOwner && myOffer && (
        <section>
          <h2 className="font-bold text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">Your response</h2>
          <p className="text-sm">Status: {myOffer.status}</p>
          {myOffer.status === 'pending' && (
            <button onClick={() => withdrawOffer(myOffer.id)} disabled={busy} className="mt-2 px-4 py-2 rounded-full text-sm font-semibold border border-[#E8E0D8] dark:border-[#2A1A1A]">Withdraw</button>
          )}
        </section>
      )}

      {isOwner && (
        <section>
          <h2 className="font-bold text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">Responses ({offers.length})</h2>
          {offers.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No responses yet.</p>
          ) : (
            <ul className="space-y-3">
              {offers.map((o) => (
                <li key={o.id} className="p-4 rounded-xl border border-[#E8E0D8] dark:border-[#2A1A1A]">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">{o.offer_type.replace('_', ' ')} · {o.status}</span>
                    {o.amount !== null && <span className="text-sm">{o.currency} {o.amount}</span>}
                  </div>
                  {o.message && <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-1">{o.message}</p>}
                  {o.status === 'pending' && o.offer_type !== 'message_only' && (
                    <div className="flex gap-2 mt-3">
                      <button onClick={() => acceptOffer(o.id)} disabled={busy} className="px-4 py-1.5 rounded-full text-xs font-semibold bg-[#8B1A1A] text-white disabled:opacity-50">Accept</button>
                      <button onClick={() => declineOffer(o.id)} disabled={busy} className="px-4 py-1.5 rounded-full text-xs font-semibold border border-[#E8E0D8] dark:border-[#2A1A1A]">Decline</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
