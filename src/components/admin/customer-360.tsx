'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import {
  Pill,
  ACCOUNT_STATUS_STYLES,
  AdminPageHeader,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  newIdempotencyKey,
  formatDateTime,
} from '@/components/admin/ui'

const KYC_STYLES: Record<string, string> = {
  none: 'bg-[#F2EDE8] text-[#6B5B55]',
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

interface AdminUserDetail {
  profile: {
    id: string
    fullName: string | null
    displayName: string | null
    phone: string | null
    role: string
    kycStatus: string
    accountStatus: string
    statusReason: string | null
    statusChangedAt: string | null
    unityScore: number
    createdAt: string
  }
  verification: { status: string; reviewedAt: string | null } | null
  listingsCount: number
  bookingsAsRenterCount: number
  bookingsAsMerchantCount: number
  disputeCount: number
  ordersCount: number
  barterCount: number
  rentToBuyCount: number
  lookingForCount: number
  reviewsCount: number
  openSupportCaseCount: number
  recentSupportCases: Array<{ id: string; caseNumber: string; title: string; status: string; priority: string; createdAt: string }>
  accountHistory: Array<{
    id: string
    actionType: string
    previousStatus: string
    newStatus: string
    userReason: string | null
    internalNote: string | null
    adminId: string
    createdAt: string
  }>
  notes: Array<{ id: string; note: string; adminId: string; createdAt: string }>
}

interface AuthInfo {
  authUserExists: true
  erased: false
  email: string | null
  emailConfirmedAt: string | null
  phone: string | null
  phoneConfirmedAt: string | null
  lastSignInAt: string | null
  createdAt: string | null
  updatedAt: string | null
  bannedUntil: string | null
  mfaFactorCount: number
  mfaVerifiedFactorCount: number
  lastRecoveryEmailSentAt: string | null
  lastConfirmationEmailSentAt: string | null
}

/**
 * ADMIN-CONTROL-CENTRE-BATCH-A1-P1-REMEDIATION: the server (GET /api/
 * admin/users/[id]/auth-info) returns exactly this shape for an erased
 * profile -- no email/phone/metadata field exists on it at all. This is
 * read, not computed client-side: the protection is already enforced
 * before the response ever reaches this component.
 */
interface ErasedAuthInfo {
  authUserExists: true
  erased: true
}

const NOT_AVAILABLE = 'NOT AVAILABLE VIA CURRENT AUTH API'

/** One shared implementation for both /admin/users/[id] (Customer 360) and /admin/merchants/[id] (Merchant 360) -- a merchant is the same profile/user record, just with an extra Merchant section (mode='merchant'). Never duplicates the full domain interfaces it links out to (bookings/orders/barter/RTB/disputes/payouts/subscriptions) -- those stay on their own existing pages. */
export function Customer360({ userId, mode }: { userId: string; mode: 'customer' | 'merchant' }) {
  const router = useRouter()
  const [detail, setDetail] = useState<AdminUserDetail | null>(null)
  const [authInfo, setAuthInfo] = useState<AuthInfo | ErasedAuthInfo | { authUserExists: false } | null>(null)
  const [loading, setLoading] = useState(true)
  const [authLoading, setAuthLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [reasonInput, setReasonInput] = useState('')
  const [noteInput, setNoteInput] = useState('')
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null)
  const [creatingCase, setCreatingCase] = useState(false)
  const [createCaseError, setCreateCaseError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/users/${userId}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load this profile')
      }
      setDetail(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this profile')
    } finally {
      setLoading(false)
    }
  }, [userId])

  const loadAuthInfo = useCallback(async () => {
    setAuthLoading(true)
    try {
      const res = await fetch(`/api/admin/users/${userId}/auth-info`)
      if (!res.ok) {
        setAuthInfo({ authUserExists: false })
        return
      }
      setAuthInfo(await res.json())
    } catch {
      setAuthInfo({ authUserExists: false })
    } finally {
      setAuthLoading(false)
    }
  }, [userId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    loadAuthInfo()
  }, [load, loadAuthInfo])

  async function performAction(action: 'restrict' | 'suspend' | 'restore') {
    setActionPending(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/admin/users/${userId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_reason: reasonInput || null, idempotency_key: newIdempotencyKey() }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Action failed')
      }
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setActionPending(false)
    }
  }

  async function performErase() {
    if (!window.confirm('This permanently anonymizes this account and cannot be undone. Continue?')) return
    setActionPending(true)
    setActionError(null)
    setCleanupNotice(null)
    try {
      const res = await fetch(`/api/admin/users/${userId}/erase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ internal_note: reasonInput || null, idempotency_key: newIdempotencyKey() }),
      })
      const b = await res.json().catch(() => ({}))
      if (res.status === 409 && b.status === 'blocked') {
        throw new Error(`Cannot erase yet — this account currently has: ${(b.reasons ?? []).join(', ')}`)
      }
      if (!res.ok) throw new Error(b.error ?? 'Action failed')
      if (b.cleanup_status === 'pending') {
        setCleanupNotice(`Account erased. Cleanup still pending: ${(b.pending_cleanup ?? []).join(', ')} — retry below.`)
      } else {
        setCleanupNotice('Account erased. Cleanup complete.')
      }
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setActionPending(false)
    }
  }

  async function performRetryCleanup() {
    setActionPending(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/admin/users/${userId}/retry-cleanup`, { method: 'POST' })
      const b = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(b.error ?? 'Retry failed')
      setCleanupNotice(b.cleanup_status === 'pending' ? `Still pending: ${(b.pending_cleanup ?? []).join(', ')}` : 'Cleanup complete.')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      setActionPending(false)
    }
  }

  async function submitNote() {
    if (!noteInput.trim()) return
    setActionPending(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/admin/users/${userId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: noteInput.trim(), idempotency_key: newIdempotencyKey() }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not add note')
      }
      setNoteInput('')
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not add note')
    } finally {
      setActionPending(false)
    }
  }

  async function createSupportCase(category: string, defaultTitle: string) {
    const title = window.prompt('Case title', defaultTitle)
    if (!title || !title.trim()) return
    setCreatingCase(true)
    setCreateCaseError(null)
    try {
      const res = await fetch('/api/admin/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          category,
          ...(mode === 'merchant' ? { merchant_id: userId } : { customer_id: userId }),
          linked_entity_type: mode === 'merchant' ? 'merchant' : 'customer',
          linked_entity_id: userId,
          idempotency_key: newIdempotencyKey(),
        }),
      })
      const b = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(b.error ?? 'Could not create support case')
      router.push(`/admin/support/${b.id}`)
    } catch (err) {
      setCreateCaseError(err instanceof Error ? err.message : 'Could not create support case')
    } finally {
      setCreatingCase(false)
    }
  }

  if (loading) return <div className="p-8 text-sm text-[#9B8B85]">Loading…</div>
  if (error || !detail) return <div className="p-8 text-sm text-red-600">{error ?? 'Not found'}</div>

  const backHref = mode === 'merchant' ? '/admin/merchants' : '/admin/users'
  const backLabel = mode === 'merchant' ? 'Back to merchants' : 'Back to users'
  const isMerchant = detail.profile.role === 'merchant' || detail.profile.role === 'both'

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-5xl">
      <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#8B1A1A]">
        <ArrowLeft size={14} /> {backLabel}
      </Link>

      <AdminPageHeader eyebrow={mode === 'merchant' ? 'Merchant 360' : 'Customer 360'} title={detail.profile.fullName ?? detail.profile.displayName ?? detail.profile.id.slice(0, 8)} />

      {/* ── Account ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Account</h2>
        <div className="flex gap-2 flex-wrap">
          <Pill value={detail.profile.role} styles={{}} />
          <Pill value={detail.profile.kycStatus} styles={KYC_STYLES} />
          <Pill value={detail.profile.accountStatus} styles={ACCOUNT_STATUS_STYLES} />
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          <div><dt className="text-[#9B8B85]">User ID</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED] font-mono text-xs">{detail.profile.id}</dd></div>
          <div><dt className="text-[#9B8B85]">Phone</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{detail.profile.phone ?? 'No phone on file'}</dd></div>
          <div><dt className="text-[#9B8B85]">Unity Score</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{detail.profile.unityScore.toFixed(1)}</dd></div>
          <div><dt className="text-[#9B8B85]">Created</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(detail.profile.createdAt)}</dd></div>
          {detail.profile.statusReason ? (
            <div className="col-span-2"><dt className="text-[#9B8B85]">Status reason</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{detail.profile.statusReason}</dd></div>
          ) : null}
        </dl>
        {detail.verification ? (
          <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">
            KYC review: <span className="capitalize font-medium">{detail.verification.status.replace(/_/g, ' ')}</span>
            {detail.verification.reviewedAt ? ` — reviewed ${formatDateTime(detail.verification.reviewedAt)}` : ''} ·{' '}
            <Link href={`/admin/verifications/${userId}`} className="text-[#8B1A1A] underline">Open verification detail</Link>
          </p>
        ) : null}
      </section>

      {/* ── Auth & Access ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Auth & Access</h2>
        {authLoading ? (
          <p className="text-sm text-[#9B8B85]">Loading…</p>
        ) : !authInfo || authInfo.authUserExists === false ? (
          <p className="text-sm text-red-600">No matching auth user found for this profile id.</p>
        ) : authInfo.erased ? (
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">
            This account is erased. Auth & Access details (including email and phone) are not shown for erased accounts — the server never fetches them for an erased profile.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
              <div><dt className="text-[#9B8B85]">Email</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{authInfo.email ?? '—'}</dd></div>
              <div><dt className="text-[#9B8B85]">Email confirmed</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{authInfo.emailConfirmedAt ? formatDateTime(authInfo.emailConfirmedAt) : 'Not confirmed'}</dd></div>
              <div><dt className="text-[#9B8B85]">Phone (auth)</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{authInfo.phone || '—'}</dd></div>
              <div><dt className="text-[#9B8B85]">Phone confirmed</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{authInfo.phoneConfirmedAt ? formatDateTime(authInfo.phoneConfirmedAt) : 'Not confirmed'}</dd></div>
              <div><dt className="text-[#9B8B85]">Last successful sign-in</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{authInfo.lastSignInAt ? formatDateTime(authInfo.lastSignInAt) : 'Never'}</dd></div>
              <div><dt className="text-[#9B8B85]">Auth user created</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(authInfo.createdAt)}</dd></div>
              <div><dt className="text-[#9B8B85]">Ban state</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{authInfo.bannedUntil ? `Banned until ${formatDateTime(authInfo.bannedUntil)}` : 'Not banned'}</dd></div>
              <div><dt className="text-[#9B8B85]">MFA factors</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{authInfo.mfaFactorCount} ({authInfo.mfaVerifiedFactorCount} verified)</dd></div>
              <div><dt className="text-[#9B8B85]">Last recovery email sent</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{authInfo.lastRecoveryEmailSentAt ? formatDateTime(authInfo.lastRecoveryEmailSentAt) : '—'}</dd></div>
              <div><dt className="text-[#9B8B85]">Last confirmation email sent</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{authInfo.lastConfirmationEmailSentAt ? formatDateTime(authInfo.lastConfirmationEmailSentAt) : '—'}</dd></div>
              <div><dt className="text-[#9B8B85]">Failed login attempts</dt><dd className="text-[#9B8B85] text-xs">{NOT_AVAILABLE}</dd></div>
              <div><dt className="text-[#9B8B85]">Active sessions</dt><dd className="text-[#9B8B85] text-xs">{NOT_AVAILABLE}</dd></div>
            </dl>
            <p className="text-[11px] text-[#9B8B85]">
              Read-only this phase — no auth actions (password recovery, resend verification, session revocation) are available here yet; those are deferred to a later security-hardening phase.
            </p>
            <button
              disabled={creatingCase}
              onClick={() => createSupportCase('account_access', `Account access — ${detail.profile.fullName ?? detail.profile.displayName ?? userId.slice(0, 8)}`)}
              className={secondaryButtonClass}
            >
              Create account access support case
            </button>
          </>
        )}
      </section>

      {/* ── Marketplace ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Marketplace</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryLink label="Listings" value={detail.listingsCount} href="/admin/listings" />
          <SummaryLink label="Bookings (renter)" value={detail.bookingsAsRenterCount} href={`/admin/bookings?userId=${userId}`} />
          <SummaryLink label="Bookings (merchant)" value={detail.bookingsAsMerchantCount} href={`/admin/bookings?userId=${userId}`} />
          <SummaryLink label="Orders" value={detail.ordersCount} href={`/admin/orders?buyerId=${userId}`} />
          <SummaryLink label="Barter trades" value={detail.barterCount} href="/admin/barter" />
          <SummaryLink label="Rent-to-Buy" value={detail.rentToBuyCount} href="/admin/rent-to-buy" />
          <SummaryLink label="Looking For" value={detail.lookingForCount} href="/admin/marketplace-requests" />
        </div>
        <p className="text-[11px] text-[#9B8B85]">Counts link to the existing module. Bookings and Orders filter directly to this user; Barter/Rent-to-Buy/Looking For open the module for now (no participant filter wired yet).</p>
      </section>

      {/* ── Trust & Safety ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Trust & Safety</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <SummaryLink label="Disputes" value={detail.disputeCount} href={`/admin/disputes?userId=${userId}`} />
          <SummaryLink label="Reviews" value={detail.reviewsCount} href="/admin/reviews" />
        </div>
      </section>

      {/* ── Support ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Support</h2>
          <button disabled={creatingCase} onClick={() => createSupportCase('general_other', '')} className={secondaryButtonClass}>
            Create support case
          </button>
        </div>
        {createCaseError ? <p className="text-xs text-red-600">{createCaseError}</p> : null}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <SummaryLink label="Open cases" value={detail.openSupportCaseCount} href={`/admin/support?userId=${userId}`} />
        </div>
        {detail.recentSupportCases.length > 0 ? (
          <ul className="space-y-1.5">
            {detail.recentSupportCases.map((c) => (
              <li key={c.id}>
                <Link href={`/admin/support/${c.id}`} className="flex items-center justify-between gap-3 text-sm bg-[#FAF8F5] dark:bg-[#1A1010] rounded-lg px-3 py-2 hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors">
                  <span className="truncate text-[#1A0A0A] dark:text-[#F5F0ED]">{c.caseNumber} — {c.title}</span>
                  <span className="text-[#9B8B85] capitalize whitespace-nowrap">{c.status.replace(/_/g, ' ')}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[#9B8B85]">No support cases yet.</p>
        )}
        <Link href={`/admin/support?userId=${userId}`} className="text-xs text-[#8B1A1A] underline">View all related cases</Link>
      </section>

      {/* ── Financial ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Financial</h2>
        <p className="text-xs text-[#9B8B85]">Monitoring data only — no live payment execution exists in this environment.</p>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/admin/financial-operations" className="text-[#8B1A1A] underline">Payments</Link>
          {isMerchant ? (
            <>
              <Link href={`/admin/payouts?merchantId=${userId}`} className="text-[#8B1A1A] underline">Payouts</Link>
              <Link href={`/admin/subscriptions/${userId}`} className="text-[#8B1A1A] underline">Subscription</Link>
            </>
          ) : null}
          <Link href="/admin/affiliates" className="text-[#8B1A1A] underline">Affiliate activity</Link>
        </div>
      </section>

      {/* ── Privacy ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Privacy</h2>
        <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
          Erasure state: <span className="font-medium capitalize">{detail.profile.accountStatus === 'erased' ? 'Erased' : 'Not erased'}</span>
        </p>
        {cleanupNotice ? <p className="text-xs text-amber-700 dark:text-amber-400">{cleanupNotice}</p> : null}
        {detail.profile.accountStatus === 'erased' ? (
          <button disabled={actionPending} onClick={performRetryCleanup} className={secondaryButtonClass}>Retry cleanup</button>
        ) : null}
      </section>

      {/* ── Account actions ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#8B1A1A]/20 dark:border-[#8B1A1A]/30 rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#8B1A1A]">Account action</h2>
        {actionError ? <p className="text-xs text-red-600">{actionError}</p> : null}
        <input
          type="text"
          placeholder="Reason (shown to the user, if applicable)"
          value={reasonInput}
          onChange={(e) => setReasonInput(e.target.value)}
          className={`w-full ${inputClass}`}
        />
        <div className="flex gap-2 flex-wrap">
          {detail.profile.accountStatus !== 'restricted' ? (
            <button disabled={actionPending} onClick={() => performAction('restrict')} className={secondaryButtonClass}>Restrict</button>
          ) : null}
          {detail.profile.accountStatus !== 'suspended' ? (
            <button disabled={actionPending} onClick={() => performAction('suspend')} className={primaryButtonClass}>Suspend</button>
          ) : null}
          {detail.profile.accountStatus !== 'active' && detail.profile.accountStatus !== 'erased' ? (
            <button disabled={actionPending} onClick={() => performAction('restore')} className={secondaryButtonClass}>Restore to active</button>
          ) : null}
          {detail.profile.accountStatus !== 'erased' ? (
            <button disabled={actionPending} onClick={performErase} className="px-3 py-2 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-700 transition-colors">
              Erase account
            </button>
          ) : null}
        </div>
      </section>

      {/* ── History ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Account history</h2>
        {detail.accountHistory.length === 0 ? (
          <p className="text-xs text-[#9B8B85]">No status changes recorded.</p>
        ) : (
          <ul className="space-y-2">
            {detail.accountHistory.map((h) => (
              <li key={h.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">
                <span className="font-medium capitalize">{h.actionType}</span> ({h.previousStatus} → {h.newStatus}) — {formatDateTime(h.createdAt)}
                {h.userReason ? <div>Reason: {h.userReason}</div> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-[#9B8B85]">
          A full cross-domain timeline is deferred to a later Unified Audit phase — see <Link href="/admin/audit" className="underline">the audit log</Link> for admin actions on other entities.
        </p>
      </section>

      {/* ── Notes ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Internal notes</h2>
        {detail.notes.map((n) => (
          <div key={n.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85] bg-[#FAF8F5] dark:bg-[#1A1010] rounded-lg px-3 py-2">
            {n.note}
            <div className="text-[10px] text-[#9B8B85] mt-1">{formatDateTime(n.createdAt)}</div>
          </div>
        ))}
        <textarea placeholder="Add an internal note…" value={noteInput} onChange={(e) => setNoteInput(e.target.value)} className={`w-full ${inputClass}`} rows={2} />
        <button disabled={actionPending || !noteInput.trim()} onClick={submitNote} className={secondaryButtonClass}>Add note</button>
      </section>
    </div>
  )
}

function SummaryLink({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link href={href} className="bg-[#FAF8F5] dark:bg-[#1A1010] rounded-lg py-2 px-2 text-center hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors block">
      <p className="text-lg font-bold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{value}</p>
      <p className="text-[10px] uppercase text-[#9B8B85]">{label}</p>
    </Link>
  )
}
