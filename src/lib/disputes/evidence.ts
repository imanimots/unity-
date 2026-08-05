/**
 * Dispute evidence upload helper — mirrors
 * src/lib/barter/offer-media.ts's client-side upload pattern exactly.
 * Object paths are {dispute_id}/{uploader_uid}/{random}.{ext} -- matches
 * the storage RLS policies in 20260814000005_dispute_evidence.sql,
 * which check foldername[1] against disputes.id and foldername[2]
 * against auth.uid().
 */

export const ALLOWED_EVIDENCE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const
export const MAX_EVIDENCE_SIZE_BYTES = 10 * 1024 * 1024

function sanitizedExtension(fileName: string): string {
  const raw = fileName.split('.').pop() ?? 'bin'
  const clean = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  return clean || 'bin'
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export function validateEvidenceFile(file: File): string | null {
  if (!(ALLOWED_EVIDENCE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'Unsupported file type — use JPG, PNG, WEBP, or PDF.'
  }
  if (file.size > MAX_EVIDENCE_SIZE_BYTES) {
    return `File is too large — maximum ${MAX_EVIDENCE_SIZE_BYTES / 1024 / 1024}MB.`
  }
  return null
}

function buildEvidencePath(disputeId: string, uploaderId: string, file: File): string {
  return `${disputeId}/${uploaderId}/${randomId()}.${sanitizedExtension(file.name)}`
}

export interface EvidenceUploadResult {
  path: string
  fileType: 'image' | 'pdf' | 'document'
}

function fileTypeFor(mime: string): 'image' | 'pdf' | 'document' {
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  return 'document'
}

/** Private bucket -- no public URL. Any authorized reader (dispute party/admin) generates a signed URL at read time. */
export async function uploadDisputeEvidence(disputeId: string, uploaderId: string, file: File): Promise<EvidenceUploadResult> {
  const { createClient } = await import('@/lib/supabase/client')
  const supabase = createClient()
  const path = buildEvidencePath(disputeId, uploaderId, file)

  const { error } = await supabase.storage.from('dispute-evidence').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw new Error(`Evidence upload failed: ${error.message}`)

  return { path, fileType: fileTypeFor(file.type) }
}
