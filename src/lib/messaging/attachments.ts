import type { ThreadType } from './thread-resolution'

/**
 * Attachment upload helper -- mirrors src/lib/disputes/evidence.ts's
 * client-side upload pattern exactly, generalized to whichever thread
 * type the parent message belongs to. Object paths are
 * {threadType}/{threadId}/{uploaderUid}/{random}.{ext} -- matches the
 * storage RLS policies in
 * 20260815000001_message_attachments.sql, which dispatch on
 * foldername[1] and check foldername[2]/foldername[3] against the
 * relevant transaction and auth.uid().
 */

export const ALLOWED_ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 4

function sanitizedExtension(fileName: string): string {
  const raw = fileName.split('.').pop() ?? 'bin'
  const clean = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  return clean || 'bin'
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export function validateAttachmentFile(file: File): string | null {
  if (!(ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'Unsupported file type — use JPG, PNG, WEBP, or PDF.'
  }
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    return `File is too large — maximum ${MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024}MB.`
  }
  return null
}

/** Route-level cap check -- called with the existing attachment count for the message being sent to. */
export function isUnderAttachmentLimit(existingCount: number): boolean {
  return existingCount < MAX_ATTACHMENTS_PER_MESSAGE
}

export function fileTypeFor(mime: string): 'image' | 'pdf' | 'document' {
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  return 'document'
}

function buildAttachmentPath(threadType: ThreadType, threadId: string, uploaderId: string, file: File): string {
  return `${threadType}/${threadId}/${uploaderId}/${randomId()}.${sanitizedExtension(file.name)}`
}

export interface AttachmentUploadResult {
  path: string
  fileType: 'image' | 'pdf' | 'document'
}

/** Private bucket -- no public URL. Any authorized reader (thread participant/admin) generates a signed URL at read time. */
export async function uploadChatAttachment(
  threadType: ThreadType,
  threadId: string,
  uploaderId: string,
  file: File
): Promise<AttachmentUploadResult> {
  const { createClient } = await import('@/lib/supabase/client')
  const supabase = createClient()
  const path = buildAttachmentPath(threadType, threadId, uploaderId, file)

  const { error } = await supabase.storage.from('chat-attachments').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw new Error(`Attachment upload failed: ${error.message}`)

  return { path, fileType: fileTypeFor(file.type) }
}
