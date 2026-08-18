'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Image as ImageIcon, Upload } from 'lucide-react'
import { validateMilestoneEvidenceFile, uploadMilestoneEvidence } from '@/lib/barter/skill-task-evidence'
import type { BarterMilestoneEvidence } from '@/types'

export interface MilestoneEvidencePanelLabels {
  title: string
  noEvidence: string
  disclaimer: string
  uploadEvidence: string
  uploading: string
  couldNotRegister: string
  couldNotUpload: string
  errorUnsupportedType: string
  errorTooLarge: string
}

interface MilestoneEvidencePanelProps {
  agreementId: string
  milestoneId: string
  currentUserId: string
  evidence: BarterMilestoneEvidence[]
  canUpload: boolean
  /**
   * Rendered transitively inside admin/barter/[id]/page.tsx (via
   * ContributionMilestonesPanel), which has no NextIntlClientProvider at
   * all -- server-resolved label overrides instead of useTranslations().
   * Admin call sites omit this and keep the English literals below.
   */
  labels?: MilestoneEvidencePanelLabels
}

/**
 * Mirrors src/components/disputes/dispute-evidence-panel.tsx exactly --
 * same upload-then-register flow, same private-bucket, no public URL.
 * Shows the required evidence-disclaimer copy verbatim above the
 * upload control.
 */
export function MilestoneEvidencePanel({ agreementId, milestoneId, currentUserId, evidence, canUpload, labels }: MilestoneEvidencePanelProps) {
  const router = useRouter()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    const validationError = validateMilestoneEvidenceFile(file)
    if (validationError) {
      setError(
        validationError === 'unsupported_type'
          ? (labels?.errorUnsupportedType ?? 'Unsupported file type — use JPG, PNG, WEBP, or PDF.')
          : (labels?.errorTooLarge ?? 'File is too large.')
      )
      return
    }

    setUploading(true)
    setError(null)
    try {
      const { path, fileType } = await uploadMilestoneEvidence(milestoneId, currentUserId, file)
      const res = await fetch(`/api/barter/${agreementId}/milestones/${milestoneId}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storage_path: path, file_type: fileType, idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? labels?.couldNotRegister ?? 'Could not register this evidence file')
        return
      }
      router.refresh()
    } catch {
      setError(labels?.couldNotUpload ?? 'Could not upload this file — please try again')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85] mb-2">{labels?.title ?? 'Evidence'}</p>

      {evidence.length === 0 ? (
        <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mb-2">{labels?.noEvidence ?? 'No evidence uploaded yet.'}</p>
      ) : (
        <ul className="space-y-1.5 mb-2">
          {evidence.map((item) => (
            <li key={item.id} className="flex items-center gap-2 text-xs text-[#1A0A0A] dark:text-[#F5F0ED]">
              {item.file_type === 'image' ? <ImageIcon size={12} className="text-[#9B8B85]" /> : <FileText size={12} className="text-[#9B8B85]" />}
              <span className="truncate">{item.storage_path.split('/').pop()}</span>
            </li>
          ))}
        </ul>
      )}

      {canUpload && (
        <>
          <p className="text-[11px] text-[#9B8B85] mb-1.5">
            {labels?.disclaimer ?? "Only upload evidence that's genuinely relevant to this milestone. Evidence is visible to both parties and Unity admins, and cannot be deleted once uploaded."}
          </p>
          <label className="flex items-center justify-center gap-2 py-2 border border-dashed border-[#E8E0D8] dark:border-[#2A1A1A] rounded-lg text-xs text-[#6B5B55] dark:text-[#9B8B85] cursor-pointer hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors">
            <Upload size={13} />
            {uploading ? (labels?.uploading ?? 'Uploading…') : (labels?.uploadEvidence ?? 'Upload evidence (image or PDF)')}
            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden" onChange={handleFileSelected} disabled={uploading} />
          </label>
        </>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-1.5">{error}</p>}
    </div>
  )
}
