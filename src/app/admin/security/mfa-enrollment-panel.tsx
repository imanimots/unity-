'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ShieldCheck, ShieldAlert, Loader2 } from 'lucide-react'

interface Factor {
  id: string
  status: 'verified' | 'unverified'
  factorType: string
  friendlyName?: string | null
}

/**
 * E47 Phase 2: the one missing piece of "MFA readiness" the prior
 * phase's rollout checklist assumed existed but never built -- an
 * actual place for an admin to enroll a factor. Uses Supabase Auth's
 * own MFA primitives exclusively (enroll/challengeAndVerify/unenroll),
 * no custom second-factor mechanism. This page itself is always
 * reachable and always safe: it never enforces anything on its own --
 * ADMIN_MFA_ENFORCED (src/lib/supabase/admin-mfa.ts) is a completely
 * separate switch, still off. Enrolling here does not change what any
 * admin, including the one enrolling, can currently access.
 */
export function MfaEnrollmentPanel() {
  const [factors, setFactors] = useState<Factor[]>([])
  const [loading, setLoading] = useState(true)
  const [enrolling, setEnrolling] = useState(false)
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [pendingFactorId, setPendingFactorId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const supabase = createClient()

  async function refreshFactors() {
    const { data, error: listError } = await supabase.auth.mfa.listFactors()
    if (listError) {
      setError(listError.message)
      return
    }
    // data.totp is VERIFIED-only by the SDK's own contract -- data.all is
    // every factor regardless of status. Using only .totp here meant an
    // abandoned/unverified enrollment attempt was invisible (and
    // therefore unremovable) through this UI, confirmed live: a second
    // enroll attempt failed with "a factor with this friendly name
    // already exists" while the panel showed zero enrolled factors.
    const all = [...(data?.all ?? [])].map((f) => ({ id: f.id, status: f.status, factorType: f.factor_type, friendlyName: f.friendly_name }))
    setFactors(all)
  }

  useEffect(() => {
    // Must run client-only (needs a real Supabase session) -- same
    // eslint-disable convention this codebase already uses for a
    // browser-only startup fetch (e.g. src/hooks/use-auth.ts).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshFactors().finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount, refreshFactors is stable enough for this page's lifetime
  }, [])

  async function startEnrollment() {
    setError(null)
    setMessage(null)
    setEnrolling(true)
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
    setEnrolling(false)
    if (enrollError || !data) {
      setError(enrollError?.message ?? 'Could not start enrollment')
      return
    }
    setPendingFactorId(data.id)
    setQrCode(data.totp.qr_code)
    setSecret(data.totp.secret)
  }

  async function verifyEnrollment() {
    if (!pendingFactorId) return
    setError(null)
    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: pendingFactorId })
    if (challengeError || !challengeData) {
      setError(challengeError?.message ?? 'Could not start verification challenge')
      return
    }
    const { error: verifyError } = await supabase.auth.mfa.verify({ factorId: pendingFactorId, challengeId: challengeData.id, code })
    if (verifyError) {
      setError(verifyError.message)
      return
    }
    setMessage('Factor verified and enrolled.')
    setQrCode(null)
    setSecret(null)
    setPendingFactorId(null)
    setCode('')
    await refreshFactors()
  }

  async function unenroll(factorId: string) {
    setError(null)
    setMessage(null)
    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId })
    if (unenrollError) {
      setError(unenrollError.message)
      return
    }
    setMessage('Factor removed.')
    await refreshFactors()
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[#9B8B85]">
        <Loader2 size={14} className="animate-spin" /> Loading your two-factor status…
      </div>
    )
  }

  const verifiedCount = factors.filter((f) => f.status === 'verified').length

  return (
    <div className="space-y-6">
      <div className={`flex items-center gap-2 px-4 py-3 rounded-xl border ${verifiedCount > 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
        {verifiedCount > 0 ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
        <span className="text-sm font-medium">
          {verifiedCount > 0 ? `${verifiedCount} verified factor${verifiedCount > 1 ? 's' : ''} enrolled` : 'No verified factor enrolled yet'}
        </span>
      </div>

      {error && <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}
      {message && <div className="px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm">{message}</div>}

      {factors.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Enrolled factors</p>
          {factors.map((f) => (
            <div key={f.id} className="flex items-center justify-between px-4 py-3 rounded-xl border border-[#F2EDE8] bg-white">
              <span className="text-sm text-[#1A0A0A]">{f.friendlyName || 'Authenticator app'} ({f.status})</span>
              <button onClick={() => unenroll(f.id)} className="text-sm text-[#8B1A1A] hover:underline">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {!qrCode ? (
        <button
          type="button"
          onClick={startEnrollment}
          disabled={enrolling}
          className="px-4 py-2.5 rounded-xl bg-[#8B1A1A] text-white text-sm font-semibold hover:bg-[#6B1414] transition-colors disabled:opacity-50"
        >
          {enrolling ? 'Starting…' : 'Enroll a new authenticator app'}
        </button>
      ) : (
        <div className="space-y-4 p-5 rounded-2xl border border-[#F2EDE8] bg-white">
          <p className="text-sm text-[#1A0A0A]">Scan this QR code with an authenticator app (e.g. Google Authenticator, 1Password), then enter the 6-digit code it generates.</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- this is a data: URI generated at runtime by Supabase Auth, not a static/optimizable asset */}
          <img src={qrCode} alt="MFA enrollment QR code" className="w-48 h-48" />
          {secret && <p className="text-xs text-[#9B8B85] break-all">Manual entry key: {secret}</p>}
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
              maxLength={6}
              className="w-32 px-3 py-2 rounded-lg border border-[#F2EDE8] bg-white text-[#1A0A0A] text-sm tracking-widest text-center"
            />
            <button
              type="button"
              onClick={verifyEnrollment}
              disabled={code.length !== 6}
              className="px-4 py-2 rounded-lg bg-[#8B1A1A] text-white text-sm font-medium disabled:opacity-40"
            >
              Verify and enroll
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-[#9B8B85]">
        Enrolling here does not currently require two-factor authentication to sign in — enforcement is a separate,
        not-yet-activated setting. This panel exists so administrators can enroll ahead of that change.
      </p>
    </div>
  )
}
