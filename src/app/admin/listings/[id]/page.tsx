'use client'

import { useState, useEffect, useCallback, use } from 'react'
import Link from 'next/link'
import { ArrowLeft, Eye, ShieldCheck, ShieldX, ShieldQuestion, CheckCircle2, XCircle, AlertTriangle, PauseCircle, PlayCircle } from 'lucide-react'

interface ReviewData {
  listing: {
    id: string
    title: string
    category: string
    description: string | null
    condition: string | null
    knownDefects: string | null
    wearDescription: string | null
    dailyRate: number
    weeklyRate: number | null
    replacementValue: number | null
    availableFrom: string | null
    province: string | null
    city: string | null
    status: string
    riskTier: 'low' | 'medium' | 'high'
    merchantId: string
    merchantName: string | null
    merchantKycStatus: string
    merchantUnityScore: number | null
    merchantSince: string | null
    createdAt: string
  }
  media: { id: string; url: string; type: string; shot_type: string | null }[]
  ownershipEvidence: { id: string; createdAt: string }[]
  privateDetails: { purchaseDate: string | null; purchasePrice: number | null; retailerOrSeller: string | null; serialNumber: string | null } | null
  requirements: Record<string, unknown> | null
  declarations: { declaration_type: string; accepted: boolean; accepted_at: string }[]
  moderation: { moderation_status: string; moderation_notes: string | null; rejection_reason: string | null; moderated_by: string | null; moderated_at: string | null }
  ownershipVerification: { status: string; reviewer_notes: string | null; merchant_feedback: string | null; reviewed_by: string | null; reviewed_at: string | null }
  riskRequirements: { ownershipVerificationRequired: boolean; depositRequired: boolean; insuranceRequired: boolean; manualReviewRequired: boolean }
  completeness: { isComplete: boolean; missingFields: string[]; blockingIssues: string[]; warnings: string[] }
  activationEligibility: { eligible: boolean; reasons: string[] }
  history: { id: string; change_reason: string; old_values: unknown; new_values: unknown; created_at: string }[]
  adminActionHistory: { id: string; action_type: string; reason_code: string | null; internal_note: string | null; merchant_feedback: string | null; created_at: string }[]
}

function newIdempotencyKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `key-${Date.now()}-${Math.random()}`
}

export default function AdminListingReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: listingId } = use(params)
  const [data, setData] = useState<ReviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [reasonCode, setReasonCode] = useState('')
  const [internalNote, setInternalNote] = useState('')
  const [merchantFeedback, setMerchantFeedback] = useState('')

  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, { url: string; expiresAt: string }>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/listings/${listingId}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Could not load this listing')
      }
      setData(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this listing')
    } finally {
      setLoading(false)
    }
  }, [listingId])

  useEffect(() => {
    // Same accepted class of finding as src/hooks/use-auth.ts / use-kyc.ts --
    // setLoading(true) runs synchronously as load()'s first statement.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const runAction = useCallback(
    async (endpoint: string, body: Record<string, unknown>) => {
      setActionPending(endpoint)
      setActionMessage(null)
      try {
        const res = await fetch(`/api/admin/listings/${listingId}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, idempotency_key: newIdempotencyKey() }),
        })
        const responseBody = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(responseBody.error ?? 'Action failed')
        }
        setActionMessage({ type: 'success', text: 'Done.' })
        setReasonCode('')
        setInternalNote('')
        setMerchantFeedback('')
        await load()
      } catch (err) {
        setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Action failed' })
      } finally {
        setActionPending(null)
      }
    },
    [listingId, load]
  )

  const viewEvidence = useCallback(
    async (mediaId: string) => {
      setActionPending(`evidence:${mediaId}`)
      try {
        const res = await fetch(`/api/admin/listings/${listingId}/evidence-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ media_id: mediaId }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error ?? 'Could not generate a secure evidence link')
        setEvidenceUrls((prev) => ({ ...prev, [mediaId]: body }))
      } catch (err) {
        setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not generate a secure evidence link' })
      } finally {
        setActionPending(null)
      }
    },
    [listingId]
  )

  if (loading) return <div className="p-8 text-sm text-[#9B8B85]">Loading…</div>
  if (error || !data) return <div className="p-8 text-sm text-red-600">{error ?? 'Not found'}</div>

  const { listing, moderation, ownershipVerification, riskRequirements, completeness, activationEligibility } = data

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-5xl">
      <Link href="/admin/listings" className="inline-flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#8B1A1A]">
        <ArrowLeft size={14} /> Back to queue
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
            {listing.category} · {listing.riskTier} risk
          </p>
          <h1 className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">{listing.title}</h1>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-1">
            {listing.merchantName ?? listing.merchantId} · status: <span className="font-medium capitalize">{listing.status}</span>
          </p>
        </div>
        <div className="px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-[11px] font-medium text-amber-700 uppercase tracking-[0.1em]">
          Manual test verification
        </div>
      </div>

      {actionMessage && (
        <div className={`px-4 py-3 rounded-lg text-sm ${actionMessage.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {actionMessage.text}
        </div>
      )}

      {/* ── Public listing information ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Public listing information</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div>
            <dt className="text-[#9B8B85]">Condition</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{listing.condition ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Known defects</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{listing.knownDefects ?? 'None declared'}</dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Daily rate</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">R{listing.dailyRate?.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Replacement value</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{listing.replacementValue ? `R${listing.replacementValue.toLocaleString()}` : '—'}</dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Location</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">
              {listing.city ?? '—'}, {listing.province ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Available from</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{listing.availableFrom ?? '—'}</dd>
          </div>
        </dl>
        <div>
          <dt className="text-[#9B8B85] text-sm">Description</dt>
          <dd className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-pre-wrap">{listing.description ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-[#9B8B85] text-sm mb-1">Declarations accepted</dt>
          <dd className="flex flex-wrap gap-1.5">
            {data.declarations.filter((d) => d.accepted).map((d) => (
              <span key={d.declaration_type} className="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700 capitalize">
                {d.declaration_type.replace(/_/g, ' ')}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-[#9B8B85] text-sm mb-1">Public photos ({data.media.length})</dt>
          <dd className="flex flex-wrap gap-2">
            {data.media.map((m) => (
              // eslint-disable-next-line @next/next/no-img-element -- Supabase storage host isn't in next.config's image remotePatterns; out of scope to add here for an admin-only thumbnail grid.
              <img key={m.id} src={m.url} alt="" className="w-20 h-20 object-cover rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A]" />
            ))}
          </dd>
        </div>
      </section>

      {/* ── Private merchant evidence ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Private merchant evidence</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div>
            <dt className="text-[#9B8B85]">Purchase date</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{data.privateDetails?.purchaseDate ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Purchase price</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{data.privateDetails?.purchasePrice ? `R${data.privateDetails.purchasePrice.toLocaleString()}` : '—'}</dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Retailer / seller</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{data.privateDetails?.retailerOrSeller ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Serial number</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{data.privateDetails?.serialNumber ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Merchant KYC status</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{listing.merchantKycStatus}</dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Merchant Unity Score</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{listing.merchantUnityScore ?? '—'}</dd>
          </div>
        </dl>

        <div>
          <dt className="text-[#9B8B85] text-sm mb-1">Ownership proof files ({data.ownershipEvidence.length})</dt>
          <dd className="space-y-2">
            {data.ownershipEvidence.length === 0 && <p className="text-sm text-[#9B8B85]">No ownership proof uploaded.</p>}
            {data.ownershipEvidence.map((ev) => (
              <div key={ev.id} className="flex items-center gap-3">
                <button
                  onClick={() => viewEvidence(ev.id)}
                  disabled={actionPending === `evidence:${ev.id}`}
                  className="inline-flex items-center gap-1.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] text-xs font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                >
                  <Eye size={12} /> View evidence (link expires in 2 min)
                </button>
                {evidenceUrls[ev.id] && (
                  <a href={evidenceUrls[ev.id].url} target="_blank" rel="noreferrer" className="text-xs text-[#8B1A1A] underline">
                    Open
                  </a>
                )}
              </div>
            ))}
          </dd>
        </div>
      </section>

      {/* ── Risk and completeness ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Risk and completeness</h2>
        <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
          Risk tier: <span className="font-medium capitalize">{listing.riskTier}</span> · Ownership verification required:{' '}
          <span className="font-medium">{riskRequirements.ownershipVerificationRequired ? 'Yes' : 'No'}</span> · Deposit required:{' '}
          <span className="font-medium">{riskRequirements.depositRequired ? 'Yes' : 'No'}</span> · Insurance required:{' '}
          <span className="font-medium">{riskRequirements.insuranceRequired ? 'Yes' : 'No'}</span>
        </p>
        {completeness.blockingIssues.length > 0 && (
          <div className="text-sm text-red-700 bg-red-50 rounded-lg p-3">
            <p className="font-medium mb-1">Blocking issues</p>
            <ul className="list-disc list-inside space-y-0.5">
              {completeness.blockingIssues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          </div>
        )}
        {activationEligibility.reasons.length > 0 && (
          <div className="text-sm text-amber-700 bg-amber-50 rounded-lg p-3">
            <p className="font-medium mb-1">Not yet eligible for activation</p>
            <ul className="list-disc list-inside space-y-0.5">
              {activationEligibility.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ── Ownership verification actions ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Ownership verification</h2>
        <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
          Current status: <span className="font-medium capitalize">{ownershipVerification.status.replace(/_/g, ' ')}</span>
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input placeholder="Reason code" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className="border border-[#F2EDE8] dark:border-[#2A1A1A] bg-transparent rounded-lg text-sm px-3 py-2" />
          <input placeholder="Reviewer notes (internal)" value={internalNote} onChange={(e) => setInternalNote(e.target.value)} className="border border-[#F2EDE8] dark:border-[#2A1A1A] bg-transparent rounded-lg text-sm px-3 py-2" />
          <input placeholder="Merchant-visible feedback" value={merchantFeedback} onChange={(e) => setMerchantFeedback(e.target.value)} className="border border-[#F2EDE8] dark:border-[#2A1A1A] bg-transparent rounded-lg text-sm px-3 py-2" />
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => runAction('/ownership/start', {})}
            disabled={!!actionPending}
            className="inline-flex items-center gap-1.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] hover:bg-[#F2EDE8] text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <ShieldQuestion size={13} /> Start review
          </button>
          <button
            onClick={() => runAction('/ownership/approve', { reason_code: reasonCode || null, reviewer_notes: internalNote || null, merchant_feedback: merchantFeedback || null })}
            disabled={!!actionPending}
            className="inline-flex items-center gap-1.5 bg-green-600 text-white hover:bg-green-700 text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <ShieldCheck size={13} /> Verify ownership
          </button>
          <button
            onClick={() => runAction('/ownership/reject', { reason_code: reasonCode || null, reviewer_notes: internalNote || null, merchant_feedback: merchantFeedback || null })}
            disabled={!!actionPending}
            className="inline-flex items-center gap-1.5 bg-red-600 text-white hover:bg-red-700 text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <ShieldX size={13} /> Reject ownership
          </button>
          <button
            onClick={() => runAction('/ownership/request-evidence', { reason_code: reasonCode || null, reviewer_notes: internalNote || null, merchant_feedback: merchantFeedback || null })}
            disabled={!!actionPending}
            className="inline-flex items-center gap-1.5 bg-amber-100 text-amber-700 hover:bg-amber-200 text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <AlertTriangle size={13} /> Request more evidence
          </button>
        </div>
      </section>

      {/* ── Moderation actions ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Moderation</h2>
        <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
          Current status: <span className="font-medium capitalize">{moderation.moderation_status.replace(/_/g, ' ')}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => runAction('/moderation/approve', { reason_code: reasonCode || null, internal_note: internalNote || null, merchant_feedback: merchantFeedback || null })}
            disabled={!!actionPending}
            className="inline-flex items-center gap-1.5 bg-green-600 text-white hover:bg-green-700 text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <CheckCircle2 size={13} /> Approve moderation
          </button>
          <button
            onClick={() => runAction('/moderation/reject', { reason_code: reasonCode || null, internal_note: internalNote || null, merchant_feedback: merchantFeedback || null })}
            disabled={!!actionPending}
            className="inline-flex items-center gap-1.5 bg-red-600 text-white hover:bg-red-700 text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <XCircle size={13} /> Reject listing
          </button>
          <button
            onClick={() => runAction('/request-changes', { reason_code: reasonCode || null, internal_note: internalNote || null, merchant_feedback: merchantFeedback || null })}
            disabled={!!actionPending}
            className="inline-flex items-center gap-1.5 bg-blue-100 text-blue-700 hover:bg-blue-200 text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <AlertTriangle size={13} /> Request changes
          </button>
        </div>
      </section>

      {/* ── Activation / suspension ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Activation</h2>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => runAction('/activate', {})}
            disabled={!!actionPending || !activationEligibility.eligible}
            className="inline-flex items-center gap-1.5 bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg disabled:opacity-40"
          >
            <PlayCircle size={13} /> Activate listing
          </button>
          <button
            onClick={() => runAction('/suspend', { reason_code: reasonCode || null, internal_note: internalNote || null, merchant_feedback: merchantFeedback || null })}
            disabled={!!actionPending || listing.status !== 'active'}
            className="inline-flex items-center gap-1.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] hover:bg-[#F2EDE8] text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-40"
          >
            <PauseCircle size={13} /> Suspend listing
          </button>
        </div>
      </section>

      {/* ── Audit timeline ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Audit timeline</h2>
        <ul className="space-y-2">
          {data.history.map((h) => (
            <li key={h.id} className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">
              <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{h.change_reason.replace(/_/g, ' ')}</span> — {new Date(h.created_at).toLocaleString('en-ZA')}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
