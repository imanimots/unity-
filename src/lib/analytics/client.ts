'use client'

import type { AnalyticsEventName, AnalyticsEntityType } from './events'
import { getOrCreateSessionId } from './session'
import { sanitizeRoutePath } from './validation'

export interface TrackEventOptions {
  entityType?: AnalyticsEntityType
  entityId?: string
  metadata?: Record<string, string | number | boolean | null>
}

function newEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Fire-and-forget first-party event tracking (Section 16). Never
 * throws into the caller, never blocks navigation/checkout/signup --
 * every failure mode (no `window`, no `fetch`, a network error, a
 * non-2xx response) is swallowed. Prefers `navigator.sendBeacon` (so
 * the event still reaches the server even if the page is about to
 * navigate away or unload) and falls back to `fetch` with
 * `keepalive: true`.
 */
export function trackEvent(eventName: AnalyticsEventName, options: TrackEventOptions = {}): void {
  try {
    if (typeof window === 'undefined') return

    const payload = {
      eventId: newEventId(),
      eventName,
      sessionId: getOrCreateSessionId(),
      routePath: sanitizeRoutePath(window.location?.pathname) ?? undefined,
      entityType: options.entityType,
      entityId: options.entityId,
      metadata: options.metadata ?? {},
    }

    const body = JSON.stringify(payload)

    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' })
      navigator.sendBeacon('/api/analytics/events', blob)
      return
    }

    if (typeof fetch === 'function') {
      fetch('/api/analytics/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {
        // Never surfaced to the caller -- analytics must never affect the UI.
      })
    }
  } catch {
    // trackEvent() must never throw into the caller's render/handler path.
  }
}
