'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Upload, X, FileText, CheckCircle, Clock, Shield } from 'lucide-react'
import { toast } from 'sonner'
import { DISPUTE_REASONS } from '@/lib/mock/disputes'
import type { BookingStatus } from '@/types'

interface DisputeFormProps {
  bookingId: string
  listingTitle: string
  bookingStatus: BookingStatus
  merchantOrRenterName: string
  backHref: string
  existingDispute?: {
    id: string
    reason: string
    description: string
    status: string
    resolution: string | null
    created_at: string
  } | null
}

const DISPUTE_STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  open:         { label: 'Open',         color: 'text-amber-600 dark:text-amber-400', icon: <Clock size={14} /> },
  under_review: { label: 'Under review', color: 'text-blue-600 dark:text-blue-400',   icon: <Shield size={14} /> },
  resolved:     { label: 'Resolved',     color: 'text-green-600 dark:text-green-400', icon: <CheckCircle size={14} /> },
  escalated:    { label: 'Escalated',    color: 'text-[#E03D2F] dark:text-[#E03D2F]', icon: <AlertTriangle size={14} /> },
}

export function DisputeForm({
  bookingId, listingTitle, bookingStatus, merchantOrRenterName, backHref, existingDispute,
}: DisputeFormProps) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)

  const [reason, setReason] = useState('')
  const [description, setDescription] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [disputeRef] = useState(() => `DIS-${new Date().getFullYear()}-${Math.floor(Math.random() * 9000 + 1000)}`)

  const addFiles = (fl: FileList | null) => {
    if (!fl) return
    setFiles((prev) => [...prev, ...Array.from(fl)])
  }

  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i))

  const canSubmit = reason && description.length >= 30

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    await new Promise((r) => setTimeout(r, 1000))
    setSubmitting(false)
    setSubmitted(true)
    toast.success('Dispute submitted. Unity will respond within 2–3 business days.')
  }

  // If there's already a dispute, show its status
  if (existingDispute) {
    const sc = DISPUTE_STATUS_CONFIG[existingDispute.status] ?? DISPUTE_STATUS_CONFIG['open']
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 font-['Plus_Jakarta_Sans']">
        <div className="mb-6">
          <h1 className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">Dispute status</h1>
          <p className="text-sm text-[#9B8B85] mt-0.5 line-clamp-1">{listingTitle}</p>
        </div>

        <div className="bg-white dark:bg-[#1A1010] rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 space-y-5">
          {/* Ref + status */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#9B8B85]">Reference</p>
              <p className="font-mono font-bold text-[#1A0A0A] dark:text-[#F5F0ED] text-sm">
                {existingDispute.id.replace('dispute-', 'DIS-2026-')}
              </p>
            </div>
            <div className={`flex items-center gap-1.5 font-medium text-sm ${sc.color}`}>
              {sc.icon} {sc.label}
            </div>
          </div>

          {/* Details */}
          <div className="space-y-3 text-sm border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
            {[
              ['Reason',   existingDispute.reason],
              ['Filed on', new Date(existingDispute.created_at).toLocaleDateString('en-ZA', { dateStyle: 'long' })],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between">
                <span className="text-[#9B8B85]">{label}</span>
                <span className="font-medium text-[#6B5B55] dark:text-[#9B8B85] text-right max-w-[60%]">{value}</span>
              </div>
            ))}
          </div>

          {/* Description */}
          <div className="bg-[#FAF8F5] dark:bg-[#1A1010] rounded-xl p-4 border border-[#F2EDE8] dark:border-[#2A1A1A]">
            <p className="text-xs font-medium text-[#9B8B85] mb-2">Description</p>
            <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed">{existingDispute.description}</p>
          </div>

          {/* Resolution */}
          {existingDispute.resolution && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-4">
              <p className="text-xs font-bold text-green-700 dark:text-green-400 mb-1 flex items-center gap-1.5">
                <CheckCircle size={12} /> Resolution
              </p>
              <p className="text-sm text-green-700 dark:text-green-300 leading-relaxed">{existingDispute.resolution}</p>
            </div>
          )}

          {(existingDispute.status === 'open' || existingDispute.status === 'under_review') ? (
            <div className="flex items-center gap-2 text-xs text-[#9B8B85] bg-[#FAF8F5] dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-3">
              <Clock size={12} />
              <span>Unity investigates within 2–3 business days. You'll receive a notification when there's an update.</span>
            </div>
          ) : null}
        </div>

        <button
          onClick={() => router.push(backHref)}
          className="mt-4 w-full py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] font-medium rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors text-sm"
        >
          Back to bookings
        </button>
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center font-['Plus_Jakarta_Sans']">
        <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-4">
          <AlertTriangle size={32} className="text-amber-500" />
        </div>
        <h2 className="text-xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">Dispute submitted</h2>
        <p className="text-sm text-[#9B8B85] mb-3">
          Reference: <strong className="font-mono text-[#6B5B55] dark:text-[#9B8B85]">{disputeRef}</strong>
        </p>
        <p className="text-sm text-[#9B8B85] mb-8">
          Unity will investigate and respond within 2–3 business days. You can track your dispute in your booking.
        </p>

        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-5 mb-6 text-left space-y-2 text-sm">
          {[
            ['Booking',  listingTitle],
            ['Reason',   reason],
            ['Evidence', files.length > 0 ? `${files.length} file${files.length !== 1 ? 's' : ''} attached` : 'None'],
            ['Status',   'Open — under review'],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between">
              <span className="text-[#9B8B85]">{label}</span>
              <span className="font-medium text-[#6B5B55] dark:text-[#9B8B85] text-right">{value}</span>
            </div>
          ))}
        </div>

        <button
          onClick={() => router.push(backHref)}
          className="w-full py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors text-sm"
        >
          Back to bookings
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 font-['Plus_Jakarta_Sans']">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">Raise a dispute</h1>
        <p className="text-sm text-[#9B8B85] mt-0.5">{listingTitle} · with {merchantOrRenterName}</p>
      </div>

      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 mb-6 flex items-start gap-3 text-sm">
        <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-amber-700 dark:text-amber-300">
          Before raising a dispute, please try messaging the other party first. Unity mediates unresolved issues and will hold the deposit in escrow until resolved.
        </p>
      </div>

      <div className="space-y-5">
        {/* Reason */}
        <div>
          <label className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-1.5">
            Reason <span className="text-[#E03D2F]">*</span>
          </label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20"
          >
            <option value="">Select a reason…</option>
            {DISPUTE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-1.5">
            Description <span className="text-[#E03D2F]">*</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            placeholder="Describe the issue in detail — include what happened, when, and what outcome you're seeking (min 30 characters)…"
            className="w-full px-3.5 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20 resize-none"
          />
          <p className="text-xs text-[#9B8B85] mt-1 text-right">{description.length} chars</p>
        </div>

        {/* Evidence */}
        <div>
          <label className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-1.5">
            Evidence <span className="text-[#9B8B85] font-normal">(optional)</span>
          </label>
          <div
            className="border-2 border-dashed border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-6 text-center cursor-pointer hover:border-[#8B1A1A]/50 transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={20} className="mx-auto text-[#9B8B85] mb-2" />
            <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">Upload photos, videos, or documents</p>
            <p className="text-xs text-[#9B8B85] mt-0.5">JPG, PNG, PDF, MP4</p>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,video/mp4,application/pdf"
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
          </div>

          {files.length > 0 && (
            <div className="mt-3 space-y-2">
              {files.map((f, i) => (
                <div key={i} className="flex items-center gap-3 p-2.5 bg-[#FAF8F5] dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg">
                  <FileText size={14} className="text-[#9B8B85] shrink-0" />
                  <span className="text-sm text-[#6B5B55] dark:text-[#9B8B85] truncate flex-1">{f.name}</span>
                  <span className="text-xs text-[#9B8B85] shrink-0">{(f.size / 1024).toFixed(0)} KB</span>
                  <button
                    onClick={() => removeFile(i)}
                    className="text-[#9B8B85] hover:text-[#E03D2F] transition-colors shrink-0"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Submit */}
        <div className="flex gap-3 pt-2">
          <button
            onClick={() => router.push(backHref)}
            className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] font-medium rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="flex-[2] py-3 bg-[#8B1A1A] hover:bg-[#7A1616] disabled:opacity-50 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 text-sm"
          >
            {submitting ? (
              <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Submitting…</>
            ) : (
              <><AlertTriangle size={14} /> Submit dispute</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
