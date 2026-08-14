/**
 * Skills + Tasks under Barter -- milestone evidence upload helper.
 * Mirrors src/lib/disputes/evidence.ts exactly: same three mime types,
 * same private-bucket pattern, same two-folder-segment path shape
 * ({milestone_id}/{uploader_uid}/{filename}), matching the storage RLS
 * policies in supabase/migrations/20260901000005_skills_tasks_barter_milestone_evidence.sql.
 */

export const ALLOWED_MILESTONE_EVIDENCE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const
export const MAX_MILESTONE_EVIDENCE_SIZE_BYTES = 10 * 1024 * 1024

function sanitizedExtension(fileName: string): string {
  const raw = fileName.split('.').pop() ?? 'bin'
  const clean = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  return clean || 'bin'
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export function validateMilestoneEvidenceFile(file: File): string | null {
  if (!(ALLOWED_MILESTONE_EVIDENCE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'Unsupported file type — use JPG, PNG, WEBP, or PDF.'
  }
  if (file.size > MAX_MILESTONE_EVIDENCE_SIZE_BYTES) {
    return `File is too large — maximum ${MAX_MILESTONE_EVIDENCE_SIZE_BYTES / 1024 / 1024}MB.`
  }
  return null
}

function buildEvidencePath(milestoneId: string, uploaderId: string, file: File): string {
  return `${milestoneId}/${uploaderId}/${randomId()}.${sanitizedExtension(file.name)}`
}

export interface MilestoneEvidenceUploadResult {
  path: string
  fileType: 'image' | 'pdf' | 'document'
}

function fileTypeFor(mime: string): 'image' | 'pdf' | 'document' {
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  return 'document'
}

/** Private bucket -- no public URL. Any authorized reader (agreement party/admin) generates a signed URL at read time. */
export async function uploadMilestoneEvidence(milestoneId: string, uploaderId: string, file: File): Promise<MilestoneEvidenceUploadResult> {
  const { createClient } = await import('@/lib/supabase/client')
  const supabase = createClient()
  const path = buildEvidencePath(milestoneId, uploaderId, file)

  const { error } = await supabase.storage.from('barter-milestone-evidence').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw new Error(`Evidence upload failed: ${error.message}`)

  return { path, fileType: fileTypeFor(file.type) }
}
