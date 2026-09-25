/**
 * Bounded raw-body reader for payment webhook routes (P5D-B, corrected
 * P5D-B.1).
 *
 * P5D-B.1 CORRECTION: the original version of this function returned
 * only a decoded `string` (`Buffer.concat(...).toString('utf-8')`),
 * which the HMAC verifier then re-encoded (`Buffer.from(str, 'utf-8')`)
 * before hashing. That decode/re-encode round-trip is only guaranteed
 * lossless for input that is ALREADY valid UTF-8 -- for a byte sequence
 * that is not (encoding corruption, a proxy re-encoding bug, a
 * genuinely malformed delivery), the lossy decode silently substitutes
 * U+FFFD replacement characters, and the re-encoded bytes then differ
 * from what the provider actually signed -- HMAC verification would
 * then fail for a delivery that was, in fact, correctly signed over the
 * true original bytes. A P5D-B-R read-only review caught this and
 * proved it empirically (a decode/re-encode round-trip is NOT
 * byte-identical for invalid UTF-8, confirmed via direct testing).
 *
 * This function now returns the literal received `Buffer` -- callers
 * that need HMAC verification hash these bytes directly, never a
 * decoded/re-encoded string. Decoding to a string (for JSON parsing)
 * must only happen AFTER authentication succeeds, and should use a
 * STRICT decoder (`fatal: true`) so a body containing invalid UTF-8 is
 * classified as "authenticated but malformed", never silently
 * corrected -- see orchestration/webhook-auth.ts and the webhook
 * route's own ordering.
 *
 * Genuinely provider-neutral -- nothing here is Peach-specific -- but
 * scoped inside src/lib/payments/ rather than a new generic top-level
 * module, since this repo has no existing generic HTTP-utilities
 * namespace and this is only used by the one payment webhook route
 * today.
 *
 * Does not trust `Content-Length` alone: a request that declares a
 * small Content-Length but streams more bytes than that is still caught
 * by the running byte count during the actual read, not just the
 * upfront header check -- Content-Length is an optimization (fail fast
 * without reading anything) never the sole enforcement.
 */

export type BoundedBodyResult = { ok: true; bytes: Buffer } | { ok: false; reason: 'content_length_exceeded' | 'body_exceeded_limit' }

export async function readBoundedRequestBody(request: Request, maxBytes: number): Promise<BoundedBodyResult> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength) {
    const parsed = Number(declaredLength)
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      return { ok: false, reason: 'content_length_exceeded' }
    }
  }

  const reader = request.body?.getReader()
  if (!reader) {
    // No readable stream exposed (some test doubles / edge runtimes) --
    // fall back to a single bounded read via arrayBuffer(), which still
    // yields the literal received bytes (never a decoded string), and
    // still enforces the limit after the fact rather than trusting the
    // caller.
    const arrayBuffer = await request.arrayBuffer()
    const bytes = Buffer.from(arrayBuffer)
    if (bytes.byteLength > maxBytes) {
      return { ok: false, reason: 'body_exceeded_limit' }
    }
    return { ok: true, bytes }
  }

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return { ok: false, reason: 'body_exceeded_limit' }
    }
    chunks.push(value)
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  return { ok: true, bytes }
}

/**
 * 64 KiB: no repository convention exists for this (confirmed by search
 * -- no route in this codebase sets an explicit body-size limit).
 * Derived from provider evidence instead: Peach's confirmed webhook
 * `content` object is a single payment/refund status record (payment_id,
 * status, amount, currency, an optional next_action with a redirect URL
 * and possibly nested three_ds_data/iframe_data sub-objects) --
 * realistically a few KB even with every optional field populated. 64
 * KiB is generous headroom over that while remaining far tighter than
 * Vercel's platform-level request-body ceiling, giving an
 * application-level fail-closed check against an oversized or malformed
 * delivery before any parsing/verification work is spent on it.
 */
export const ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024
