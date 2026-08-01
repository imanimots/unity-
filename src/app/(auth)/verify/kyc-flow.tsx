'use client'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ShieldCheck, Upload, CheckCircle, ChevronRight, ChevronLeft,
  FileText, X, AlertCircle, Clock,
} from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { createClient } from '@/lib/supabase/client'

/**
 * Real, provider-neutral KYC submission flow -- replaces the prior
 * mock/localStorage version (src/hooks/use-kyc.ts, now removed). "Powered
 * by Sumsub" is gone; this is manual test verification (admin-only
 * wording says so explicitly) -- see docs/IDENTITY_VERIFICATION.md
 * "Test-mode wording".
 *
 * Document upload goes straight from the browser to the private
 * 'kyc-documents' Storage bucket using the user's own authenticated
 * session (folder-scoped RLS -- 20260804000001), then inserts the
 * identity_verification_documents metadata row directly (also
 * RLS-scoped to the caller's own user_id) -- the same direct-client
 * pattern Phase 2A already established for listing_media. No server
 * route exists for upload itself; only the final submit/resubmit call
 * goes through a service-role RPC.
 */

type DocType = 'identity_document' | 'proof_of_address'
type FormStep = 'details' | 'documents'

interface MeResponse {
  status: string
  legalFirstName: string | null
  legalSurname: string | null
  dateOfBirth: string | null
  idReferenceType: 'sa_id' | 'passport' | null
  idReferenceNumber: string | null
  nationality: string | null
  countryOfResidence: string | null
  residentialAddress: string | null
  userFeedback: string | null
  reviewCount: number
  documents: { documentType: DocType; uploadedAt: string }[]
}

const MIME_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }

function UploadZone({ label, file, onFile, uploaded }: { label: string; file: File | null; onFile: (f: File) => void; uploaded: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-[#9B8B85] mb-2">{label}</p>
      {file || uploaded ? (
        <div className="flex items-center gap-3 h-14 px-4 border border-[#8B1A1A]/30 bg-[#8B1A1A]/5 rounded-lg">
          <FileText size={18} className="text-[#8B1A1A] shrink-0" />
          <span className="text-sm text-[#8B1A1A] truncate flex-1">{file?.name ?? 'Already on file'}</span>
          {file && (
            <button onClick={() => ref.current && (ref.current.value = '')} className="text-[#9B8B85] hover:text-[#E03D2F] transition-colors">
              <X size={14} />
            </button>
          )}
        </div>
      ) : (
        <div
          onClick={() => ref.current?.click()}
          className="border-2 border-dashed border-[#E8E0D8] rounded-lg py-8 text-center cursor-pointer hover:border-[#8B1A1A]/50 hover:bg-white transition-colors"
        >
          <Upload size={22} className="mx-auto text-[#9B8B85] mb-2" />
          <p className="text-sm text-[#6B5B55]">Click to upload</p>
          <p className="text-xs text-[#9B8B85] mt-0.5">JPG, PNG or PDF, up to 10MB</p>
        </div>
      )}
      <input
        ref={ref}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
        }}
      />
    </div>
  )
}

function StatusBanner({
  icon: Icon,
  title,
  message,
  tone,
  onContinue,
}: {
  icon: typeof Clock
  title: string
  message: string
  tone: 'pending' | 'approved' | 'rejected'
  onContinue?: () => void
}) {
  const toneClasses = {
    pending: 'bg-[#F2EDE8] text-[#8B1A1A]',
    approved: 'bg-green-50 text-green-700',
    rejected: 'bg-red-50 text-red-700',
  }[tone]
  return (
    <div className="py-10 text-center space-y-6">
      <div className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto ${toneClasses}`}>
        <Icon size={36} />
      </div>
      <div>
        <h2 className="font-extrabold text-2xl uppercase tracking-tight text-[#1A0A0A] mb-2">{title}</h2>
        <p className="text-sm text-[#6B5B55]">{message}</p>
      </div>
      {onContinue && (
        <button
          onClick={onContinue}
          className="w-full h-12 flex items-center justify-center bg-[#8B1A1A] text-white font-extrabold text-sm uppercase tracking-[0.08em] rounded-lg hover:bg-[#7A1616] transition-colors"
        >
          CONTINUE TO UNITY
        </button>
      )}
    </div>
  )
}

function KycFlowInner() {
  const router = useRouter()
  const params = useSearchParams()
  const redirectTo = params.get('redirectTo') ?? '/dashboard/renter'
  const { user } = useAuth()

  const [loading, setLoading] = useState(true)
  const [me, setMe] = useState<MeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/verification/me')
      if (res.ok) {
        setMe(await res.json())
      } else {
        setError('Could not load your verification status')
      }
    } catch {
      setError('Could not load your verification status')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // ── Form state ──
  const [step, setStep] = useState<FormStep>('details')
  const [legalFirstName, setLegalFirstName] = useState('')
  const [legalSurname, setLegalSurname] = useState('')
  const [dateOfBirth, setDateOfBirth] = useState('')
  const [idReferenceType, setIdReferenceType] = useState<'sa_id' | 'passport'>('sa_id')
  const [idReferenceNumber, setIdReferenceNumber] = useState('')
  const [nationality, setNationality] = useState('')
  const [countryOfResidence, setCountryOfResidence] = useState('South Africa')
  const [residentialAddress, setResidentialAddress] = useState('')
  const [identityDoc, setIdentityDoc] = useState<File | null>(null)
  const [proofOfAddress, setProofOfAddress] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [agreedToVerificationTerms, setAgreedToVerificationTerms] = useState(false)

  useEffect(() => {
    if (!me) return
    // Pre-fills the form from the just-loaded /me response -- same
    // accepted class of finding as src/hooks/use-auth.ts / use-kyc.ts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLegalFirstName(me.legalFirstName ?? '')
    setLegalSurname(me.legalSurname ?? '')
    setDateOfBirth(me.dateOfBirth ?? '')
    setIdReferenceType(me.idReferenceType ?? 'sa_id')
    setIdReferenceNumber(me.idReferenceNumber ?? '')
    setNationality(me.nationality ?? '')
    setCountryOfResidence(me.countryOfResidence ?? 'South Africa')
    setResidentialAddress(me.residentialAddress ?? '')
  }, [me])

  const hasIdentityDocOnFile = me?.documents.some((d) => d.documentType === 'identity_document') ?? false
  const hasProofOfAddressOnFile = me?.documents.some((d) => d.documentType === 'proof_of_address') ?? false

  const canProceedDetails = legalFirstName.trim() && legalSurname.trim() && dateOfBirth && idReferenceNumber.trim() && nationality.trim() && residentialAddress.trim().length >= 10
  const canSubmit = (identityDoc || hasIdentityDocOnFile) && (proofOfAddress || hasProofOfAddressOnFile) && agreedToVerificationTerms

  async function uploadDocument(file: File, documentType: DocType) {
    if (!user) throw new Error('Not signed in')
    const supabase = createClient()
    const ext = MIME_EXT[file.type] ?? 'bin'
    const path = `${user.id}/${documentType}/${crypto.randomUUID()}.${ext}`

    const { error: uploadError } = await supabase.storage.from('kyc-documents').upload(path, file, { contentType: file.type })
    if (uploadError) throw new Error(`Could not upload ${documentType.replace('_', ' ')}`)

    const { error: insertError } = await supabase
      .from('identity_verification_documents')
      .insert({ user_id: user.id, document_type: documentType, storage_path: path, mime_type: file.type, file_size: file.size })
    if (insertError) throw new Error(`Could not record ${documentType.replace('_', ' ')}`)
  }

  async function handleSubmit() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (identityDoc) await uploadDocument(identityDoc, 'identity_document')
      if (proofOfAddress) await uploadDocument(proofOfAddress, 'proof_of_address')

      const isResubmit = me?.status === 'additional_information_required' || me?.status === 'rejected'
      const res = await fetch(isResubmit ? '/api/verification/resubmit' : '/api/verification/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          legal_first_name: legalFirstName,
          legal_surname: legalSurname,
          date_of_birth: dateOfBirth,
          id_reference_type: idReferenceType,
          id_reference_number: idReferenceNumber,
          nationality,
          country_of_residence: countryOfResidence,
          residential_address: residentialAddress,
          idempotency_key: crypto.randomUUID(),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Could not submit your verification')
      setDone(true)

      try {
        await fetch('/api/legal/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ policies: ['popia', 'verification-and-trust'], context: 'verification' }),
        })
      } catch {
        // best-effort -- the verification submission already succeeded
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not submit your verification')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <div className="py-16 text-center text-sm text-[#9B8B85]">Loading…</div>
  }

  if (error) {
    return <div className="py-16 text-center text-sm text-red-600">{error}</div>
  }

  if (done || me?.status === 'pending' || me?.status === 'under_review') {
    return (
      <StatusBanner
        icon={Clock}
        title="Verification Pending"
        message="Your identity verification is being reviewed. This is manual test verification for the public test — a real reviewer confirms your details."
        tone="pending"
        onContinue={() => router.push(redirectTo)}
      />
    )
  }

  if (me?.status === 'approved') {
    return (
      <StatusBanner
        icon={CheckCircle}
        title="Identity Verified"
        message="Your identity has been verified by Unity. You can now book items and list your own."
        tone="approved"
        onContinue={() => router.push(redirectTo)}
      />
    )
  }

  const needsAction = me?.status === 'additional_information_required' || me?.status === 'rejected'

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 mb-6 justify-center">
        <ShieldCheck size={14} className="text-[#8B1A1A]" />
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-[#9B8B85]">Manual test verification</span>
      </div>

      {needsAction && me?.userFeedback && (
        <div className="bg-amber-50 rounded-lg p-4 mb-6 flex items-start gap-2 text-left">
          <AlertCircle size={14} className="text-amber-700 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-800 mb-0.5">{me.status === 'rejected' ? 'Verification rejected' : 'More information needed'}</p>
            <p className="text-xs text-amber-700">{me.userFeedback}</p>
          </div>
        </div>
      )}

      {step === 'details' && (
        <div className="space-y-4">
          <div className="text-center mb-2">
            <h2 className="font-extrabold text-2xl uppercase tracking-tight text-[#1A0A0A] mb-2">Your details</h2>
            <p className="text-sm text-[#6B5B55]">Enter your legal identity information exactly as it appears on your ID.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Legal first name" value={legalFirstName} onChange={(e) => setLegalFirstName(e.target.value)} className="h-11 px-3 border border-[#E8E0D8] rounded-lg text-sm" />
            <input placeholder="Legal surname" value={legalSurname} onChange={(e) => setLegalSurname(e.target.value)} className="h-11 px-3 border border-[#E8E0D8] rounded-lg text-sm" />
          </div>
          <input type="date" placeholder="Date of birth" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} className="w-full h-11 px-3 border border-[#E8E0D8] rounded-lg text-sm" />
          <div className="grid grid-cols-2 gap-3">
            <select value={idReferenceType} onChange={(e) => setIdReferenceType(e.target.value as 'sa_id' | 'passport')} className="h-11 px-3 border border-[#E8E0D8] rounded-lg text-sm bg-white">
              <option value="sa_id">South African ID</option>
              <option value="passport">Passport</option>
            </select>
            <input placeholder="ID / passport number" value={idReferenceNumber} onChange={(e) => setIdReferenceNumber(e.target.value)} className="h-11 px-3 border border-[#E8E0D8] rounded-lg text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Nationality" value={nationality} onChange={(e) => setNationality(e.target.value)} className="h-11 px-3 border border-[#E8E0D8] rounded-lg text-sm" />
            <input placeholder="Country of residence" value={countryOfResidence} onChange={(e) => setCountryOfResidence(e.target.value)} className="h-11 px-3 border border-[#E8E0D8] rounded-lg text-sm" />
          </div>
          <textarea
            placeholder="Residential address"
            value={residentialAddress}
            onChange={(e) => setResidentialAddress(e.target.value)}
            rows={3}
            className="w-full px-3 py-2.5 border border-[#E8E0D8] rounded-lg text-sm"
          />

          <button
            disabled={!canProceedDetails}
            onClick={() => setStep('documents')}
            className="w-full h-12 flex items-center justify-center gap-2 bg-[#8B1A1A] text-white font-extrabold text-sm uppercase tracking-[0.08em] rounded-lg hover:bg-[#7A1616] transition-colors disabled:opacity-40"
          >
            Continue <ChevronRight size={16} />
          </button>
        </div>
      )}

      {step === 'documents' && (
        <div className="space-y-6">
          <div className="text-center mb-2">
            <h2 className="font-extrabold text-2xl uppercase tracking-tight text-[#1A0A0A] mb-2">Upload documents</h2>
            <p className="text-sm text-[#6B5B55]">Make sure all text is clearly visible and documents are not expired.</p>
          </div>

          <UploadZone label="Identity document *" file={identityDoc} onFile={setIdentityDoc} uploaded={hasIdentityDocOnFile && !needsAction} />
          <UploadZone label="Proof of address *" file={proofOfAddress} onFile={setProofOfAddress} uploaded={hasProofOfAddressOnFile && !needsAction} />

          <label className="flex items-start gap-2.5 text-xs text-[#6B5B55] cursor-pointer">
            <input
              type="checkbox"
              checked={agreedToVerificationTerms}
              onChange={(e) => setAgreedToVerificationTerms(e.target.checked)}
              className="mt-0.5 rounded border-[#E8E0D8] accent-[#8B1A1A] shrink-0"
            />
            <span>
              I confirm the information above is accurate, and I agree to Unity&apos;s{' '}
              <a href="/popia" target="_blank" rel="noopener noreferrer" className="text-[#8B1A1A] underline hover:no-underline">POPIA Notice</a>{' '}
              and <a href="/verification-and-trust" target="_blank" rel="noopener noreferrer" className="text-[#8B1A1A] underline hover:no-underline">Verification and Trust</a> terms for how this manual test verification is reviewed.
            </span>
          </label>

          {submitError && <p className="text-xs text-red-600">{submitError}</p>}

          <div className="flex gap-3 pt-1">
            <button
              onClick={() => setStep('details')}
              className="flex-1 h-12 flex items-center justify-center gap-1.5 border-2 border-[#E8E0D8] text-[#1A0A0A] font-semibold rounded-lg text-sm hover:bg-[#FAF8F5] transition-colors"
            >
              <ChevronLeft size={14} /> Back
            </button>
            <button
              disabled={!canSubmit || submitting}
              onClick={handleSubmit}
              className="flex-[2] h-12 flex items-center justify-center gap-2 bg-[#8B1A1A] text-white font-extrabold text-sm uppercase tracking-[0.08em] rounded-lg hover:bg-[#7A1616] transition-colors disabled:opacity-40"
            >
              {submitting ? 'Submitting…' : needsAction ? 'Resubmit' : 'Submit'} {!submitting && <ChevronRight size={16} />}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function KycFlow() {
  return (
    <Suspense>
      <KycFlowInner />
    </Suspense>
  )
}

