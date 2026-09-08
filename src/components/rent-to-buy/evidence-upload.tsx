'use client'

import { useState } from 'react'
import { useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { validateRentToBuyEvidenceFile, ALLOWED_RTB_EVIDENCE_MIME_TYPES, MAX_RTB_EVIDENCE_SIZE_BYTES } from '@/lib/rent-to-buy/evidence-upload'

interface Props {
  agreementId: string
  userId: string
  evidenceType: 'pre_handover' | 'post_handover_receipt' | 'pre_return' | 'post_return'
  label: string
}

/**
 * Uploads directly to the private rent-to-buy-evidence bucket (storage
 * RLS enforces the {agreement_id}/{uploader_uid}/ path prefix), then
 * registers the row via the server route -- mirrors the KYC document
 * upload flow's own browser-client storage pattern exactly, and the
 * real dispute_evidence-shaped architecture this domain reuses (Rule 5).
 */
export function RentToBuyEvidenceUpload({ agreementId, userId, evidenceType, label }: Props) {
  const router = useRouter()
  const t = useTranslations('rtb')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFile = async (file: File) => {
    // Client-side pre-check only -- convenience/UX, never the security
    // boundary (the bucket's own MIME allowlist/size limit remain
    // authoritative). Rejected here means Storage upload and evidence
    // registration are never called at all, and the loading state never
    // flips on for a file that was always going to be rejected.
    const validationError = validateRentToBuyEvidenceFile(file)
    if (validationError) {
      setError(validationError === 'unsupported_type' ? t('errors.unsupportedType') : t('errors.tooLarge', { mb: MAX_RTB_EVIDENCE_SIZE_BYTES / 1024 / 1024 }))
      return
    }

    setUploading(true)
    setError(null)
    try {
      const supabase = createClient()
      const fileType = file.type.startsWith('video/') ? 'video' : file.type === 'application/pdf' ? 'pdf' : 'image'
      const ext = file.name.split('.').pop() ?? 'bin'
      const path = `${agreementId}/${userId}/${evidenceType}-${Date.now()}.${ext}`

      // Storage failure never surfaces its raw provider message to the
      // user (bucket/path/policy internals) -- a safe, generic message
      // only, matching dispute-evidence-panel.tsx/milestone-evidence-panel.tsx's
      // established bare-catch convention for this exact failure class.
      const { error: uploadError } = await supabase.storage.from('rent-to-buy-evidence').upload(path, file, { contentType: file.type })
      if (uploadError) {
        setError(t('errors.couldNotUpload'))
        return
      }

      const res = await fetch(`/api/rent-to-buy/agreements/${agreementId}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storage_path: path, file_type: fileType, evidence_type: evidenceType }),
      })
      const body = await res.json().catch(() => ({}))
      // The registration route already returns only hand-authored,
      // user-safe error strings (never raw DB/internal errors -- see
      // src/app/api/rent-to-buy/agreements/[id]/evidence/route.ts) --
      // shown as-is, unchanged from prior behavior.
      if (!res.ok) {
        setError(body.error ?? t('errors.generic'))
        return
      }

      router.refresh()
    } catch {
      // Network/unexpected failures (e.g. a rejected fetch) -- same safe
      // generic message as a Storage failure, never the raw error.
      setError(t('errors.couldNotUpload'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold uppercase tracking-wide text-[#6B5B55] dark:text-[#9B8B85]">{label}</label>
      <input
        type="file"
        accept={ALLOWED_RTB_EVIDENCE_MIME_TYPES.join(',')}
        disabled={uploading}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleFile(file)
        }}
        className="text-xs text-[#1A0A0A] dark:text-[#F5F0ED]"
      />
      {uploading && <p className="text-xs text-[#9B8B85]">{t('uploadEvidence')}…</p>}
      {error && <p role="alert" className="text-xs text-[#8B1A1A]">{error}</p>}
    </div>
  )
}
