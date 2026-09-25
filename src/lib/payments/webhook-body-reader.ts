/**
 * Bounded raw-body reader for payment webhook routes (P5D-B).
 *
 * Preserves exact delivered bytes (required for HMAC verification --
 * see orchestration/webhook-auth.ts) while capping how much of a
 * request body this server will ever buffer, before any JSON parsing or
 * authentication is attempted. Genuinely provider-neutral -- nothing
 * here is Peach-specific -- but scoped inside src/lib/payments/ rather
 * than a new generic top-level module, since this repo has no existing
 * generic HTTP-utilities namespace and this is only used by the one
 * payment webhook route today.
 *
 * Does not trust `Content-Length` alone: a request that declares a
 * small Content-Length but streams more bytes than that is still caught
 * by the running byte count during the actual read, not just the
 * upfront header check -- Content-Length is an optimization (fail fast
 * without reading anything) never the sole enforcement.
 */

export type BoundedBodyResult = { ok: true; body: string } | { ok: false; reason: 'content_length_exceeded' | 'body_exceeded_limit' }

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
    // fall back to a single bounded read, still enforcing the limit
    // after the fact rather than trusting the caller.
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
      return { ok: false, reason: 'body_exceeded_limit' }
    }
    return { ok: true, body: text }
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

  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf-8')
  return { ok: true, body }
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
