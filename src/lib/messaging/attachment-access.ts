import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Mirrors src/lib/disputes/evidence-access.ts / src/lib/rent-to-buy/evidence-access.ts
 * exactly -- same 120s TTL, same shape, same canonical private-document
 * pattern (Stack 1). Message attachments are a genuinely separate system
 * (different table, different bucket, different authorization primitive)
 * from dispute/RTB evidence, so this is its own file rather than a
 * reused import -- but the pattern itself is identical.
 *
 * Authorization is delegated entirely to the caller-supplied `asUser`
 * client (cookie-bound, session-scoped -- never service role):
 * message_attachments' own existing RLS ("message_attachments: parties
 * read", powered by is_message_participant(), and "message_attachments:
 * admin read") decides whether the row is visible at all. No
 * authorization logic is reimplemented here. The `(id, message_id)`
 * compound match is what stops an attachment id belonging to a
 * different message from being coerced into this message's route
 * param. There is no separate "thread id" parameter to mismatch against
 * -- thread membership is derived entirely from message_id via
 * is_message_participant(), never from a second, independently-trusted
 * value.
 */

const SIGNED_URL_TTL_SECONDS = 120

export interface AttachmentSignedUrlResult {
  url: string
  expiresAt: string
}

export async function getMessageAttachmentSignedUrl(
  asUser: SupabaseClient,
  admin: SupabaseClient,
  messageId: string,
  attachmentId: string
): Promise<AttachmentSignedUrlResult> {
  const { data: row, error } = await asUser
    .from('message_attachments')
    .select('id, storage_path')
    .eq('id', attachmentId)
    .eq('message_id', messageId)
    .maybeSingle()

  if (error || !row) {
    throw new Error('attachment_not_found')
  }

  const { data: signed, error: signError } = await admin.storage.from('chat-attachments').createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS)

  if (signError || !signed) {
    throw new Error('could_not_sign_url')
  }

  return { url: signed.signedUrl, expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString() }
}
