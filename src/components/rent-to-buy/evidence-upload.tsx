'use client'

import { useState } from 'react'
import { useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'

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
    setUploading(true)
    setError(null)
    try {
      const supabase = createClient()
      const fileType = file.type.startsWith('video/') ? 'video' : file.type === 'application/pdf' ? 'pdf' : 'image'
      const ext = file.name.split('.').pop() ?? 'bin'
      const path = `${agreementId}/${userId}/${evidenceType}-${Date.now()}.${ext}`

      const { error: uploadError } = await supabase.storage.from('rent-to-buy-evidence').upload(path, file, { contentType: file.type })
      if (uploadError) throw new Error(uploadError.message)

      const res = await fetch(`/api/rent-to-buy/agreements/${agreementId}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storage_path: path, file_type: fileType, evidence_type: evidenceType }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? t('errors.generic'))

      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold uppercase tracking-wide text-[#6B5B55] dark:text-[#9B8B85]">{label}</label>
      <input
        type="file"
        accept="image/*,video/*,application/pdf"
        disabled={uploading}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleFile(file)
        }}
        className="text-xs text-[#1A0A0A] dark:text-[#F5F0ED]"
      />
      {uploading && <p className="text-xs text-[#9B8B85]">{t('uploadEvidence')}…</p>}
      {error && <p className="text-xs text-[#8B1A1A]">{error}</p>}
    </div>
  )
}
