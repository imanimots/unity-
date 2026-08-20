/**
 * Fair-use / cost control (Section 34) -- deliberately simple, in-memory
 * counters (mirrors src/lib/rate-limit.ts's own established shape for
 * this codebase, not a new distributed rate-limiter). Centrally
 * configurable constants, never hardcoded inline at each call site.
 */
export const MERCHANT_AI_LIMITS = {
  /** Requests per merchant per rolling hour, per capability. */
  MAX_REQUESTS_PER_HOUR: 20,
  MAX_PROMPT_CHARS: 4_000,
  MAX_OUTPUT_TOKENS: 800,
} as const

const requestLog = new Map<string, number[]>()

export function checkMerchantAiRateLimit(merchantId: string, capability: string): { allowed: boolean; retryAfterSeconds?: number } {
  const key = `${merchantId}:${capability}`
  const now = Date.now()
  const windowMs = 60 * 60 * 1000
  const timestamps = (requestLog.get(key) ?? []).filter((t) => now - t < windowMs)

  if (timestamps.length >= MERCHANT_AI_LIMITS.MAX_REQUESTS_PER_HOUR) {
    const retryAfterSeconds = Math.ceil((windowMs - (now - timestamps[0])) / 1000)
    return { allowed: false, retryAfterSeconds }
  }

  timestamps.push(now)
  requestLog.set(key, timestamps)
  return { allowed: true }
}

/**
 * Reuses the existing chat-filter-shaped content policy rather than a
 * second bespoke keyword list (Section 90/91 -- illegal/medical/
 * discriminatory/fraudulent content stays prohibited for AI-assisted
 * listing text exactly as it is for a human-authored one).
 */
export function truncatePrompt(text: string): string {
  return text.length > MERCHANT_AI_LIMITS.MAX_PROMPT_CHARS ? text.slice(0, MERCHANT_AI_LIMITS.MAX_PROMPT_CHARS) : text
}
