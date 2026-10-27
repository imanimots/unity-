'use client'

/**
 * First-party, browser-local analytics session id (Section 6). A
 * random UUID, never derived from device/browser attributes, never
 * encoding a user/email identity, rotated after 30 minutes of
 * inactivity. Not a permanent advertising identifier -- it exists only
 * to group this browser's own behavioral events into one funnel-shaped
 * session, and it rotates on its own.
 *
 * Same SSR-safety shape as src/lib/personalization/anonymous.ts:
 * `typeof window === 'undefined'` is a real, reachable condition (this
 * module is 'use client' but can still execute during server
 * rendering of the importing component), and every function here must
 * degrade safely rather than throw.
 */
const SESSION_STORAGE_KEY = 'unity_analytics_session_v1'
const INACTIVITY_ROTATION_MS = 30 * 60 * 1000

interface StoredSession {
  id: string
  lastActivity: number
}

function readStoredSession(): StoredSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (typeof parsed.id !== 'string' || typeof parsed.lastActivity !== 'number') return null
    return { id: parsed.id, lastActivity: parsed.lastActivity }
  } catch {
    return null
  }
}

function writeStoredSession(session: StoredSession): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  } catch {
    // Storage full/unavailable (private browsing, quota) -- the caller
    // still gets a valid session id for this call, it just won't persist.
  }
}

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Extremely old browsers only -- never reached in this codebase's
  // supported target, but trackEvent() must still never throw.
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Returns the current session id, creating one if none exists or
 * rotating it if the last recorded activity is older than the
 * inactivity window. Updates the stored `lastActivity` on every call.
 * Never throws; returns a fresh, non-persisted id if `window` is
 * unavailable (SSR) or storage access fails.
 */
export function getOrCreateSessionId(): string {
  try {
    const now = Date.now()
    const existing = readStoredSession()
    if (existing && now - existing.lastActivity < INACTIVITY_ROTATION_MS) {
      writeStoredSession({ id: existing.id, lastActivity: now })
      return existing.id
    }
    const id = newSessionId()
    writeStoredSession({ id, lastActivity: now })
    return id
  } catch {
    return newSessionId()
  }
}
