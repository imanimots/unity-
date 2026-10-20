'use client'

import { useState, useRef, useCallback } from 'react'
import { useRouter } from '@/i18n/navigation'
import { useTranslations, useLocale } from 'next-intl'
import { Camera, Upload, X, CheckCircle, Clock, Info, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { formatDate, formatDateTime } from '@/lib/i18n/format'
import type { Locale } from '@/i18n/locales'
import { validateBookingEvidenceFile, sanitizeBookingEvidenceExtension, bookingEvidenceFileType, ALLOWED_BOOKING_EVIDENCE_MIME_TYPES, MAX_BOOKING_EVIDENCE_SIZE_BYTES } from '@/lib/bookings/condition-evidence-upload'

interface PendingUpload {
  file: File
  preview: string
  timestamp: string
  status: 'pending' | 'uploading' | 'done' | 'error'
  error?: string
}

interface MediaUploadProps {
  bookingId: string
  userId: string
  stage: 'pre' | 'post'
  listingTitle: string
  backHref: string
}

/**
 * Real, durable pre-handover/post-return condition evidence for
 * ordinary rental bookings (P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I).
 * Uploads directly to the existing private `rental-media` bucket
 * (storage RLS enforces the {booking_id}/{uploader_uid}/ path prefix --
 * supabase/migrations/20260731000001_rental_media_participant_scoping.sql),
 * then registers each file via POST /api/bookings/[id]/evidence --
 * mirrors src/components/rent-to-buy/evidence-upload.tsx's real
 * browser-upload pattern exactly. A success state here means a real
 * storage object AND a real booking_condition_evidence row exist --
 * never a timer-only simulation.
 */
export function MediaUpload({ bookingId, userId, stage, listingTitle, backHref }: MediaUploadProps) {
  const router = useRouter()
  const t = useTranslations('rent.media')
  const locale = useLocale() as Locale
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploads, setUploads] = useState<PendingUpload[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const isPre = stage === 'pre'
  const evidenceStage = isPre ? 'pre_handover' : 'post_return'

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return
    const newUploads: PendingUpload[] = Array.from(files)
      // Client-side pre-check only -- convenience/UX, never the
      // security boundary (the bucket's own MIME allowlist/size limit
      // remain authoritative). A rejected file is simply never added,
      // so it can never reach Storage or the registration route.
      .filter((f) => validateBookingEvidenceFile(f) === null)
      .map((file) => ({
        file,
        preview: URL.createObjectURL(file),
        timestamp: formatDateTime(new Date(), locale),
        status: 'pending' as const,
      }))
    setUploads((prev) => [...prev, ...newUploads])
  }, [locale])

  const remove = (i: number) => {
    URL.revokeObjectURL(uploads[i].preview)
    setUploads((prev) => prev.filter((_, idx) => idx !== i))
  }

  const uploadOne = useCallback(async (upload: PendingUpload, index: number): Promise<boolean> => {
    const supabase = createClient()
    const fileType = bookingEvidenceFileType(upload.file.type)
    const ext = sanitizeBookingEvidenceExtension(upload.file.name)
    const path = `${bookingId}/${userId}/${evidenceStage}-${Date.now()}-${index}.${ext}`

    // Storage/registration failures never surface their raw
    // provider/server message to the user (bucket/path/policy
    // internals) -- a safe, generic message only.
    const { error: uploadError } = await supabase.storage.from('rental-media').upload(path, upload.file, { contentType: upload.file.type })
    if (uploadError) return false

    try {
      const res = await fetch(`/api/bookings/${bookingId}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storage_path: path, file_type: fileType, evidence_stage: evidenceStage }),
      })
      return res.ok
    } catch {
      return false
    }
  }, [bookingId, userId, evidenceStage])

  const submit = async () => {
    if (uploads.length === 0) return
    setSubmitting(true)

    const results = await Promise.all(
      uploads.map(async (upload, i) => {
        if (upload.status === 'done') return true
        const ok = await uploadOne(upload, i)
        return ok
      })
    )

    setUploads((prev) => prev.map((u, i) => (results[i] ? { ...u, status: 'done' } : { ...u, status: 'error', error: t('uploadFailedOne') })))
    setSubmitting(false)

    const allSucceeded = results.every(Boolean)
    if (allSucceeded) {
      setSubmitted(true)
      toast.success(t('uploadedToast', { stage: isPre ? t('preRental') : t('postRental') }))
      setTimeout(() => router.push(backHref), 1800)
    } else {
      toast.error(t('uploadFailedSome'))
    }
  }

  const successCount = uploads.filter((u) => u.status === 'done').length

  if (submitted) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center font-['Plus_Jakarta_Sans']">
        <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-4">
          <CheckCircle size={32} className="text-green-500" />
        </div>
        <h2 className="text-xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">{t('uploadedHeading')}</h2>
        <p className="text-sm text-[#9B8B85]">
          {t('uploadedDesc', { count: uploads.length })}
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 font-['Plus_Jakarta_Sans']">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-xs text-[#9B8B85] mb-2">
          <span className={`px-2 py-0.5 rounded-full font-medium ${
            isPre
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
          }`}>
            {isPre ? t('preRental') : t('postRental')}
          </span>
          <span>{t('bookingNumber', { ref: bookingId.slice(-6).toUpperCase() })}</span>
        </div>
        <h1 className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">
          {isPre ? t('documentCondition') : t('confirmReturn')}
        </h1>
        <p className="text-sm text-[#9B8B85] mt-1 line-clamp-1">{listingTitle}</p>
      </div>

      {/* Info banner */}
      <div className={`flex items-start gap-3 p-4 rounded-xl border mb-6 ${
        isPre
          ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-100 dark:border-blue-800'
          : 'bg-amber-50 dark:bg-amber-900/20 border-amber-100 dark:border-amber-800'
      }`}>
        <Info size={15} className={isPre ? 'text-blue-500 shrink-0 mt-0.5' : 'text-amber-500 shrink-0 mt-0.5'} />
        <p className={`text-sm ${isPre ? 'text-blue-700 dark:text-blue-300' : 'text-amber-700 dark:text-amber-300'}`}>
          {isPre ? t('preInfo') : t('postInfo')}
        </p>
      </div>

      {/* Timestamp notice */}
      <div className="flex items-center gap-2 text-xs text-[#9B8B85] mb-4">
        <Clock size={12} />
        <span>{t('timestampNotice', { date: formatDate(new Date(), locale) })}</span>
      </div>

      {/* Upload zone */}
      <div
        className="border-2 border-dashed border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-8 text-center cursor-pointer hover:border-[#8B1A1A]/50 dark:hover:border-[#8B1A1A]/50 transition-colors mb-4"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files) }}
      >
        <div className="w-12 h-12 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center mx-auto mb-3">
          <Camera size={22} className="text-[#9B8B85]" />
        </div>
        <p className="text-sm font-medium text-[#6B5B55] dark:text-[#9B8B85]">{t('clickToAdd')}</p>
        <p className="text-xs text-[#9B8B85] mt-1">{t('dragDropHint')}</p>
        <input
          ref={inputRef}
          type="file"
          accept={ALLOWED_BOOKING_EVIDENCE_MIME_TYPES.join(',')}
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
      </div>
      <p className="text-[11px] text-[#9B8B85] mb-4">{t('sizeLimitHint', { mb: MAX_BOOKING_EVIDENCE_SIZE_BYTES / 1024 / 1024 })}</p>

      {/* Preview grid */}
      {uploads.length > 0 && (
        <div className="mb-6">
          <p className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">
            {t('filesReady', { count: uploads.length })}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {uploads.map((u, i) => (
              <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] group">
                {u.file.type.startsWith('image/') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={u.preview} alt={`Upload ${i + 1}`} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Upload size={24} className="text-[#9B8B85]" />
                  </div>
                )}
                {/* Timestamp overlay */}
                <div className="absolute bottom-0 left-0 right-0 bg-[#1A0A0A]/70 text-white text-[9px] px-1.5 py-1 flex items-center gap-1">
                  <Clock size={8} /> {u.timestamp}
                </div>
                {u.status === 'error' && (
                  <div className="absolute top-1.5 left-1.5 flex items-center gap-1 bg-red-600/90 text-white text-[9px] px-1.5 py-0.5 rounded-full">
                    <AlertCircle size={9} /> {t('uploadFailedOne')}
                  </div>
                )}
                {u.status === 'done' && (
                  <div className="absolute top-1.5 left-1.5 flex items-center gap-1 bg-green-600/90 text-white text-[9px] px-1.5 py-0.5 rounded-full">
                    <CheckCircle size={9} />
                  </div>
                )}
                {/* Remove */}
                {u.status !== 'done' && (
                  <button
                    onClick={() => remove(i)}
                    className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-[#1A0A0A]/70 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {successCount > 0 && successCount < uploads.length && (
            <p className="text-xs text-[#8B1A1A] mt-2">{t('partialSuccess', { done: successCount, total: uploads.length })}</p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={() => router.push(backHref)}
          className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] font-medium rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors text-sm"
        >
          {t('cancel')}
        </button>
        <button
          onClick={submit}
          disabled={uploads.length === 0 || submitting || uploads.every((u) => u.status === 'done')}
          className="flex-[2] py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] disabled:opacity-40 transition-colors flex items-center justify-center gap-2 text-sm"
        >
          {submitting ? (
            <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('uploading')}</>
          ) : (
            <><CheckCircle size={15} /> {uploads.length > 0 ? t('submitFiles', { count: uploads.length }) : t('submitMedia')}</>
          )}
        </button>
      </div>
    </div>
  )
}
