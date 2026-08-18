'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Image as ImageIcon, Upload } from 'lucide-react'
import { validateEvidenceFile, uploadDisputeEvidence, MAX_EVIDENCE_SIZE_BYTES } from '@/lib/disputes/evidence'
import type { DisputeEvidence } from '@/types'

interface DisputeEvidencePanelLabels {
  title: string
  noEvidence: string
  uploadEvidence: string
  uploading: string
  couldNotRegister: string
  couldNotUpload: string
  errorUnsupportedType: string
  errorTooLarge: string
}

const DEFAULT_LABELS: DisputeEvidencePanelLabels = {
  title: 'Evidence',
  noEvidence: 'No evidence uploaded yet.',
  uploadEvidence: 'Upload evidence (image or PDF)',
  uploading: 'Uploading…',
  couldNotRegister: 'Could not register this evidence file',
  couldNotUpload: 'Could not upload this file — please try again',
  errorUnsupportedType: 'Unsupported file type — use JPG, PNG, WEBP, or PDF.',
  errorTooLarge: `File is too large — maximum ${MAX_EVIDENCE_SIZE_BYTES / 1024 / 1024}MB.`,
}

interface DisputeEvidencePanelProps {
  disputeId: string
  currentUserId: string
  evidence: DisputeEvidence[]
  /** Terminal disputes (resolved/closed/cancelled) no longer accept new evidence in the UI — the route itself also enforces this server-side. */
  canUpload: boolean
  /**
   * Rendered both inside [locale] (via DisputeDetailView) and inside
   * admin/disputes/[id]/page.tsx, which has no NextIntlClientProvider at
   * all -- so this takes server-resolved label overrides instead of
   * calling useTranslations() directly. Admin call sites don't pass this
   * and keep the English defaults.
   */
  labels?: Partial<DisputeEvidencePanelLabels>
}

export function DisputeEvidencePanel({ disputeId, currentUserId, evidence, canUpload, labels }: DisputeEvidencePanelProps) {
  const router = useRouter()
  const l = { ...DEFAULT_LABELS, ...labels }
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    const validationError = validateEvidenceFile(file)
    if (validationError) {
      setError(validationError === 'unsupported_type' ? l.errorUnsupportedType : l.errorTooLarge)
      return
    }

    setUploading(true)
    setError(null)
    try {
      const { path, fileType } = await uploadDisputeEvidence(disputeId, currentUserId, file)
      const res = await fetch(`/api/disputes/${disputeId}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storage_path: path, file_type: fileType, idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? l.couldNotRegister)
        return
      }
      router.refresh()
    } catch {
      setError(l.couldNotUpload)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">{l.title}</h2>

      {evidence.length === 0 ? (
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-4">{l.noEvidence}</p>
      ) : (
        <ul className="space-y-2 mb-4">
          {evidence.map((item) => (
            <li key={item.id} className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
              {item.file_type === 'image' ? <ImageIcon size={14} className="text-[#9B8B85]" /> : <FileText size={14} className="text-[#9B8B85]" />}
              <span className="truncate">{item.storage_path.split('/').pop()}</span>
            </li>
          ))}
        </ul>
      )}

      {canUpload && (
        <label className="flex items-center justify-center gap-2 py-2.5 border border-dashed border-[#E8E0D8] dark:border-[#2A1A1A] rounded-lg text-sm text-[#6B5B55] dark:text-[#9B8B85] cursor-pointer hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors">
          <Upload size={14} />
          {uploading ? l.uploading : l.uploadEvidence}
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden" onChange={handleFileSelected} disabled={uploading} />
        </label>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400 mt-2">{error}</p>}
    </div>
  )
}
