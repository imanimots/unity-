'use client'

import { useState, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import {
  ShieldCheck, Upload, Camera, CheckCircle,
  ChevronRight, ChevronLeft, FileText, X, AlertCircle,
} from 'lucide-react'
import { useKyc } from '@/hooks/use-kyc'

type DocType = 'sa_id' | 'passport' | 'drivers'
type Step = 'type' | 'document' | 'selfie' | 'processing' | 'done'

const DOC_LABELS: Record<DocType, string> = {
  sa_id:    'South African ID Card',
  passport: 'Passport',
  drivers:  "Driver's Licence",
}

const STEPS: Step[] = ['type', 'document', 'selfie']
const STEP_LABELS: Record<string, string> = {
  type:     'Choose document',
  document: 'Upload document',
  selfie:   'Take selfie',
}

function UploadZone({
  label, file, onFile, accept = 'image/*',
}: {
  label: string
  file: File | null
  onFile: (f: File) => void
  accept?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-[#9B8B85] mb-2">{label}</p>
      {file ? (
        <div className="flex items-center gap-3 h-14 px-4 border border-[#8B1A1A]/30 bg-[#8B1A1A]/5 rounded-lg">
          <FileText size={18} className="text-[#8B1A1A] shrink-0" />
          <span className="text-sm text-[#8B1A1A] truncate flex-1">{file.name}</span>
          <button
            onClick={() => ref.current && (ref.current.value = '')}
            className="text-[#9B8B85] hover:text-[#E03D2F] transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div
          onClick={() => ref.current?.click()}
          className="border-2 border-dashed border-[#E8E0D8] rounded-lg py-8 text-center cursor-pointer hover:border-[#8B1A1A]/50 hover:bg-white transition-colors"
        >
          <Upload size={22} className="mx-auto text-[#9B8B85] mb-2" />
          <p className="text-sm text-[#6B5B55]">Click to upload</p>
          <p className="text-xs text-[#9B8B85] mt-0.5">JPG, PNG or PDF</p>
        </div>
      )}
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }}
      />
    </div>
  )
}

function KycFlowInner() {
  const router = useRouter()
  const params = useSearchParams()
  const redirectTo = params.get('redirectTo') ?? '/dashboard/renter'
  const { approve } = useKyc()

  const [step, setStep] = useState<Step>('type')
  const [docType, setDocType] = useState<DocType | null>(null)
  const [docFront, setDocFront] = useState<File | null>(null)
  const [docBack, setDocBack] = useState<File | null>(null)
  const [selfie, setSelfie] = useState<File | null>(null)

  const canProceedDoc = docFront !== null && (docType !== 'sa_id' || docBack !== null)
  const canProceedSelfie = selfie !== null

  function startProcessing() {
    setStep('processing')
    setTimeout(() => {
      approve()
      setStep('done')
    }, 2500)
  }

  const activeStepIndex = STEPS.indexOf(step)

  return (
    <div className="w-full">
      {/* Step progress — shown during active steps */}
      {step !== 'done' && step !== 'processing' && (
        <div className="flex items-center justify-center gap-3 mb-8">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-3">
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-extrabold transition-all ${
                    step === s
                      ? 'bg-[#8B1A1A] text-white'
                      : i < activeStepIndex
                        ? 'bg-[#8B1A1A]/20 text-[#8B1A1A]'
                        : 'bg-[#E8E0D8] text-[#9B8B85]'
                  }`}
                >
                  {i < activeStepIndex ? <CheckCircle size={14} /> : i + 1}
                </div>
                <span className={`text-[9px] font-medium uppercase tracking-wider hidden sm:block ${
                  step === s ? 'text-[#8B1A1A]' : 'text-[#9B8B85]'
                }`}>
                  {STEP_LABELS[s]}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`h-px w-10 mb-4 transition-colors ${
                  i < activeStepIndex ? 'bg-[#8B1A1A]/40' : 'bg-[#E8E0D8]'
                }`} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Sumsub badge */}
      <div className="flex items-center gap-2 mb-6 justify-center">
        <ShieldCheck size={14} className="text-[#8B1A1A]" />
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-[#9B8B85]">Powered by Sumsub</span>
      </div>

      {/* Step 1: document type */}
      {step === 'type' && (
        <div className="space-y-6">
          <div className="text-center mb-2">
            <h2 className="font-extrabold text-2xl uppercase tracking-tight text-[#1A0A0A] mb-2">
              CHOOSE DOCUMENT
            </h2>
            <p className="text-sm text-[#6B5B55]">
              Unity requires identity verification to keep the community safe.
            </p>
          </div>

          <div className="space-y-3">
            {(['sa_id', 'passport', 'drivers'] as DocType[]).map((d) => (
              <button
                key={d}
                onClick={() => setDocType(d)}
                className={`w-full flex items-center justify-between h-14 px-5 rounded-lg border-2 text-left transition-all ${
                  docType === d
                    ? 'border-[#8B1A1A] bg-[#FAF8F5]'
                    : 'border-[#E8E0D8] bg-white hover:border-[#8B1A1A]/40 hover:bg-[#FAF8F5]'
                }`}
              >
                <span className="text-sm font-semibold text-[#1A0A0A]">{DOC_LABELS[d]}</span>
                {docType === d && <CheckCircle size={16} className="text-[#8B1A1A] shrink-0" />}
              </button>
            ))}
          </div>

          <button
            disabled={!docType}
            onClick={() => setStep('document')}
            className="w-full h-12 flex items-center justify-center gap-2 bg-[#8B1A1A] text-white font-extrabold text-sm uppercase tracking-[0.08em] rounded-lg hover:bg-[#7A1616] transition-colors disabled:opacity-40"
          >
            Continue <ChevronRight size={16} />
          </button>
        </div>
      )}

      {/* Step 2: document upload */}
      {step === 'document' && (
        <div className="space-y-6">
          <div className="text-center mb-2">
            <h2 className="font-extrabold text-2xl uppercase tracking-tight text-[#1A0A0A] mb-2">
              UPLOAD DOCUMENT
            </h2>
            <p className="text-sm text-[#6B5B55]">
              Make sure all text is clearly visible and the document is not expired.
            </p>
          </div>

          <UploadZone
            label={docType === 'sa_id' ? 'Front of ID card *' : 'Document photo *'}
            file={docFront}
            onFile={setDocFront}
          />
          {docType === 'sa_id' && (
            <UploadZone label="Back of ID card *" file={docBack} onFile={setDocBack} />
          )}

          <div className="flex gap-3 pt-1">
            <button
              onClick={() => setStep('type')}
              className="flex-1 h-12 flex items-center justify-center gap-1.5 border-2 border-[#E8E0D8] text-[#1A0A0A] font-semibold rounded-lg text-sm hover:bg-[#FAF8F5] transition-colors"
            >
              <ChevronLeft size={14} /> Back
            </button>
            <button
              disabled={!canProceedDoc}
              onClick={() => setStep('selfie')}
              className="flex-[2] h-12 flex items-center justify-center gap-2 bg-[#8B1A1A] text-white font-extrabold text-sm uppercase tracking-[0.08em] rounded-lg hover:bg-[#7A1616] transition-colors disabled:opacity-40"
            >
              Continue <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Step 3: selfie */}
      {step === 'selfie' && (
        <div className="space-y-6">
          <div className="text-center mb-2">
            <h2 className="font-extrabold text-2xl uppercase tracking-tight text-[#1A0A0A] mb-2">
              TAKE A SELFIE
            </h2>
            <p className="text-sm text-[#6B5B55]">
              Hold your document next to your face. Make sure both are clearly visible.
            </p>
          </div>

          <div className="bg-[#F2EDE8] rounded-lg p-4 space-y-2">
            {[
              'Look directly at the camera',
              'Good lighting — no shadows',
              'Remove glasses or hat',
              'Hold your document open and clearly visible',
            ].map((tip) => (
              <div key={tip} className="flex items-center gap-2.5 text-xs text-[#6B5B55]">
                <CheckCircle size={12} className="text-[#8B1A1A] shrink-0" />
                {tip}
              </div>
            ))}
          </div>

          <UploadZone label="Selfie with document *" file={selfie} onFile={setSelfie} accept="image/*" />

          <div className="flex items-center gap-2 text-xs text-[#9B8B85]">
            <Camera size={13} />
            <span>Or use your webcam — selfie capture coming soon.</span>
          </div>

          <div className="flex gap-3 pt-1">
            <button
              onClick={() => setStep('document')}
              className="flex-1 h-12 flex items-center justify-center gap-1.5 border-2 border-[#E8E0D8] text-[#1A0A0A] font-semibold rounded-lg text-sm hover:bg-[#FAF8F5] transition-colors"
            >
              <ChevronLeft size={14} /> Back
            </button>
            <button
              disabled={!canProceedSelfie}
              onClick={startProcessing}
              className="flex-[2] h-12 flex items-center justify-center gap-2 bg-[#8B1A1A] text-white font-extrabold text-sm uppercase tracking-[0.08em] rounded-lg hover:bg-[#7A1616] transition-colors disabled:opacity-40"
            >
              Submit <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Processing */}
      {step === 'processing' && (
        <div className="py-12 text-center space-y-6">
          <div className="w-20 h-20 rounded-full bg-[#F2EDE8] flex items-center justify-center mx-auto">
            <div className="w-10 h-10 border-4 border-[#E8E0D8] border-t-[#8B1A1A] rounded-full animate-spin" />
          </div>
          <div>
            <h2 className="font-extrabold text-2xl uppercase tracking-tight text-[#1A0A0A] mb-2">
              VERIFYING
            </h2>
            <p className="text-sm text-[#9B8B85]">This only takes a moment…</p>
          </div>
          <div className="flex flex-col gap-2.5 text-xs text-[#9B8B85]">
            {[
              'Checking document authenticity',
              'Running biometric match',
              'Cross-referencing against databases',
            ].map((item) => (
              <div key={item} className="flex items-center justify-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-[#8B1A1A] animate-pulse" />
                {item}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Done */}
      {step === 'done' && (
        <div className="py-10 text-center space-y-6">
          <div className="w-20 h-20 rounded-full bg-[#F2EDE8] flex items-center justify-center mx-auto">
            <CheckCircle size={40} className="text-[#8B1A1A]" />
          </div>
          <div>
            <h2 className="font-extrabold text-2xl uppercase tracking-tight text-[#1A0A0A] mb-2">
              IDENTITY VERIFIED
            </h2>
            <p className="text-sm text-[#6B5B55]">
              Your account is now fully verified. You can book items and list your own.
            </p>
          </div>
          <div className="bg-[#F2EDE8] rounded-lg p-4 text-xs text-[#9B8B85] flex items-start gap-2 text-left">
            <AlertCircle size={13} className="shrink-0 mt-0.5" />
            <span>Mock mode — verification is simulated. In production, Sumsub reviews documents within minutes.</span>
          </div>
          <button
            onClick={() => router.push(redirectTo)}
            className="w-full h-12 flex items-center justify-center bg-[#8B1A1A] text-white font-extrabold text-sm uppercase tracking-[0.08em] rounded-lg hover:bg-[#7A1616] transition-colors"
          >
            CONTINUE TO UNITY
          </button>
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
