'use client'

import { useState, useEffect, useCallback, use } from 'react'
import Link from 'next/link'
import { ArrowLeft, Eye, ShieldCheck, ShieldX, AlertTriangle, ShieldQuestion } from 'lucide-react'

interface ReviewData {
  user: {
    id: string
    fullName: string | null
    role: string
    kycStatus: string
    unityScore: number | null
    accountCreatedAt: string
    accountCountry: string | null
  }
  verification: {
    status: string
    legalFirstName?: string | null
    legalSurname?: string | null
    dateOfBirth?: string | null
    idReferenceType?: string | null
    idReferenceNumber?: string | null
    nationality?: string | null
    countryOfResidence?: string | null
    residentialAddress?: string | null
    reviewerNotes?: string | null
    reasonCode?: string | null
    userFeedback?: string | null
    reviewCount?: number
    submittedAt?: string | null
    reviewedAt?: string | null
  }
  documents: { id: string; documentType: string; uploadedAt: string }[]
  history: { id: string; action_type: string; admin_id: string | null; previous_status: string | null; new_status: string | null; created_at: string }[]
}

function newIdempotencyKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `key-${Date.now()}-${Math.random()}`
}

export default function AdminVerificationReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: userId } = use(params)
  const [data, setData] = useState<ReviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [reasonCode, setReasonCode] = useState('')
  const [reviewerNotes, setReviewerNotes] = useState('')
  const [userFeedback, setUserFeedback] = useState('')
  const [documentUrls, setDocumentUrls] = useState<Record<string, { url: string; expiresAt: string }>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/verifications/${userId}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Could not load this verification')
      }
      setData(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this verification')
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const runAction = useCallback(
    async (endpoint: string, body: Record<string, unknown>) => {
      setActionPending(endpoint)
      setActionMessage(null)
      try {
        const res = await fetch(`/api/admin/verifications/${userId}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, idempotency_key: newIdempotencyKey() }),
        })
        const responseBody = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(responseBody.error ?? 'Action failed')
        setActionMessage({ type: 'success', text: 'Done.' })
        setReasonCode('')
        setReviewerNotes('')
        setUserFeedback('')
        await load()
      } catch (err) {
        setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Action failed' })
      } finally {
        setActionPending(null)
      }
    },
    [userId, load]
  )

  const viewDocument = useCallback(
    async (documentId: string) => {
      setActionPending(`doc:${documentId}`)
      try {
        const res = await fetch(`/api/admin/verifications/${userId}/document-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ document_id: documentId }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error ?? 'Could not generate a secure document link')
        setDocumentUrls((prev) => ({ ...prev, [documentId]: body }))
      } catch (err) {
        setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not generate a secure document link' })
      } finally {
        setActionPending(null)
      }
    },
    [userId]
  )

  if (loading) return <div className="p-8 text-sm text-[#9B8B85]">Loading…</div>
  if (error || !data) return <div className="p-8 text-sm text-red-600">{error ?? 'Not found'}</div>

  const { user, verification } = data

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-5xl">
      <Link href="/admin/verifications" className="inline-flex items-center gap-1.5 text-sm text-[#6B5B55] hover:text-[#8B1A1A]">
        <ArrowLeft size={14} /> Back to queue
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1 capitalize">{user.role}</p>
          <h1 className="text-2xl font-extrabold text-[#1A0A0A]">{user.fullName ?? user.id}</h1>
          <p className="text-sm text-[#6B5B55] mt-1">
            KYC status: <span className="font-medium capitalize">{user.kycStatus}</span> · Verification status: <span className="font-medium capitalize">{verification.status.replace(/_/g, ' ')}</span>
          </p>
        </div>
        <div className="px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-[11px] font-medium text-amber-700 uppercase tracking-[0.1em]">Manual test verification</div>
      </div>

      {actionMessage && (
        <div className={`px-4 py-3 rounded-lg text-sm ${actionMessage.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{actionMessage.text}</div>
      )}

      {/* ── Account details ── */}
      <section className="bg-white border border-[#F2EDE8] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A]">Account details</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div>
            <dt className="text-[#9B8B85]">Role</dt>
            <dd className="text-[#1A0A0A] capitalize">{user.role}</dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Unity Score</dt>
            <dd className="text-[#1A0A0A]">{user.unityScore ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Account created</dt>
            <dd className="text-[#1A0A0A]">{new Date(user.accountCreatedAt).toLocaleDateString('en-ZA')}</dd>
          </div>
          <div>
            <dt className="text-[#9B8B85]">Account country</dt>
            <dd className="text-[#1A0A0A]">{user.accountCountry ?? '—'}</dd>
          </div>
        </dl>
      </section>

      {/* ── Submitted legal identity information ── */}
      <section className="bg-white border border-[#F2EDE8] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A]">Submitted legal identity information</h2>
        {verification.status === 'not_started' ? (
          <p className="text-sm text-[#9B8B85]">No submission yet.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div>
              <dt className="text-[#9B8B85]">Legal name</dt>
              <dd className="text-[#1A0A0A]">
                {verification.legalFirstName} {verification.legalSurname}
              </dd>
            </div>
            <div>
              <dt className="text-[#9B8B85]">Date of birth</dt>
              <dd className="text-[#1A0A0A]">{verification.dateOfBirth}</dd>
            </div>
            <div>
              <dt className="text-[#9B8B85]">ID reference</dt>
              <dd className="text-[#1A0A0A] capitalize">
                {verification.idReferenceType?.replace('_', ' ')}: {verification.idReferenceNumber}
              </dd>
            </div>
            <div>
              <dt className="text-[#9B8B85]">Nationality</dt>
              <dd className="text-[#1A0A0A]">{verification.nationality}</dd>
            </div>
            <div>
              <dt className="text-[#9B8B85]">Country of residence</dt>
              <dd className="text-[#1A0A0A]">{verification.countryOfResidence}</dd>
            </div>
            <div>
              <dt className="text-[#9B8B85]">Residential address</dt>
              <dd className="text-[#1A0A0A]">{verification.residentialAddress}</dd>
            </div>
            <div>
              <dt className="text-[#9B8B85]">Prior review attempts</dt>
              <dd className="text-[#1A0A0A]">{verification.reviewCount ?? 0}</dd>
            </div>
            <div>
              <dt className="text-[#9B8B85]">Submitted</dt>
              <dd className="text-[#1A0A0A]">{verification.submittedAt ? new Date(verification.submittedAt).toLocaleString('en-ZA') : '—'}</dd>
            </div>
          </dl>
        )}
      </section>

      {/* ── Documents ── */}
      <section className="bg-white border border-[#F2EDE8] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A]">Submitted documents ({data.documents.length})</h2>
        {data.documents.length === 0 && <p className="text-sm text-[#9B8B85]">No documents uploaded.</p>}
        <div className="space-y-2">
          {data.documents.map((doc) => (
            <div key={doc.id} className="flex items-center gap-3">
              <span className="text-sm capitalize text-[#1A0A0A] w-40">{doc.documentType.replace(/_/g, ' ')}</span>
              <button
                onClick={() => viewDocument(doc.id)}
                disabled={actionPending === `doc:${doc.id}`}
                className="inline-flex items-center gap-1.5 border border-[#F2EDE8] text-[#6B5B55] hover:bg-[#F2EDE8] text-xs font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
              >
                <Eye size={12} /> View document (link expires in 2 min)
              </button>
              {documentUrls[doc.id] && (
                <a href={documentUrls[doc.id].url} target="_blank" rel="noreferrer" className="text-xs text-[#8B1A1A] underline">
                  Open
                </a>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Review actions ── */}
      <section className="bg-white border border-[#F2EDE8] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A]">Review</h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input placeholder="Reason code" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className="border border-[#F2EDE8] bg-transparent rounded-lg text-sm px-3 py-2" />
          <input placeholder="Reviewer notes (internal)" value={reviewerNotes} onChange={(e) => setReviewerNotes(e.target.value)} className="border border-[#F2EDE8] bg-transparent rounded-lg text-sm px-3 py-2" />
          <input placeholder="User-visible feedback" value={userFeedback} onChange={(e) => setUserFeedback(e.target.value)} className="border border-[#F2EDE8] bg-transparent rounded-lg text-sm px-3 py-2" />
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => runAction('/start', {})}
            disabled={!!actionPending}
            className="inline-flex items-center gap-1.5 border border-[#F2EDE8] text-[#6B5B55] hover:bg-[#F2EDE8] text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <ShieldQuestion size={13} /> Start review
          </button>
          <button
            onClick={() => runAction('/approve', { reason_code: reasonCode || null, reviewer_notes: reviewerNotes || null, user_feedback: userFeedback || null })}
            disabled={!!actionPending}
            className="inline-flex items-center gap-1.5 bg-green-600 text-white hover:bg-green-700 text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <ShieldCheck size={13} /> Approve
          </button>
          <button
            onClick={() => runAction('/reject', { reason_code: reasonCode || null, reviewer_notes: reviewerNotes || null, user_feedback: userFeedback || null })}
            disabled={!!actionPending}
            className="inline-flex items-center gap-1.5 bg-red-600 text-white hover:bg-red-700 text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <ShieldX size={13} /> Reject
          </button>
          <button
            onClick={() => runAction('/request-information', { reason_code: reasonCode || null, reviewer_notes: reviewerNotes || null, user_feedback: userFeedback || null })}
            disabled={!!actionPending}
            className="inline-flex items-center gap-1.5 bg-amber-100 text-amber-700 hover:bg-amber-200 text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <AlertTriangle size={13} /> Request more information
          </button>
        </div>
      </section>

      {/* ── Audit timeline ── */}
      <section className="bg-white border border-[#F2EDE8] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A]">Audit timeline</h2>
        {data.history.length === 0 && <p className="text-sm text-[#9B8B85]">No history yet.</p>}
        <ul className="space-y-2">
          {data.history.map((h) => (
            <li key={h.id} className="text-sm text-[#6B5B55]">
              <span className="font-medium text-[#1A0A0A] capitalize">{h.action_type.replace(/_/g, ' ')}</span> — {new Date(h.created_at).toLocaleString('en-ZA')}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
