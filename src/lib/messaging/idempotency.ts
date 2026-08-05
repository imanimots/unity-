import { createHash } from 'crypto'
import { checkIdempotentReplay } from '@/lib/bookings/idempotency'
export { checkIdempotentReplay }

/**
 * Route-level idempotency for messaging -- neither send nor attachment
 * registration is an RPC, so both hashes are computed here rather than
 * mirrored from SQL (contrast src/lib/disputes/idempotency.ts, which
 * mirrors RPC formulas). Same idempotency_keys table, reused directly.
 */

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeSendMessageHash(threadType: string, threadId: string, disputeId: string | null | undefined, content: string): string {
  return md5(`${threadType}|${threadId}|${disputeId ?? ''}|${content}`)
}

export function computeRegisterAttachmentHash(messageId: string, storagePath: string, fileType: string): string {
  return md5(`${messageId}|${storagePath}|${fileType}`)
}
