'use client'

import type { PersonalizationEntityType, PersonalizationKind, PersonalizationMode, PersonalizationViewRecord } from './types'

/**
 * Anonymous personalization stays entirely browser-local (Section 14).
 * No server-side anonymous identity is ever created. Bounded first-party
 * localStorage only -- no cookies, no fingerprinting, no cross-device
 * linkage.
 */
const STORAGE_KEY = 'unity_personalization_v1'

/** V1 bounds (Section 15): document the actual chosen limits. */
const MAX_EVENTS = 100
const RETENTION_DAYS = 45

export interface AnonymousViewEvent {
  entityType: PersonalizationEntityType
  entityId: string
  mode: PersonalizationMode | null
  category: string | null
  kind: PersonalizationKind | null
  province: string | null
  city: string | null
  viewedAt: string
}

interface AnonymousStore {
  events: AnonymousViewEvent[]
  /** Set once a merge into an authenticated account has happened, so a
   * second sign-in in the same browser does not re-import the same
   * buffer (Section 40: "must be idempotent"). Cleared events remain
   * absent, not re-derivable, once marked. */
  mergedAt: string | null
}

function emptyStore(): AnonymousStore {
  return { events: [], mergedAt: null }
}

function readStore(): AnonymousStore {
  if (typeof window === 'undefined') return emptyStore()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw) as Partial<AnonymousStore>
    if (!Array.isArray(parsed.events)) return emptyStore()
    return { events: parsed.events, mergedAt: parsed.mergedAt ?? null }
  } catch {
    return emptyStore()
  }
}

function writeStore(store: AnonymousStore) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Storage full/unavailable (private browsing, quota) -- personalization
    // degrades to the generic experience silently, never breaks the page.
  }
}

function pruneExpired(events: AnonymousViewEvent[]): AnonymousViewEvent[] {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  return events.filter((e) => new Date(e.viewedAt).getTime() >= cutoff)
}

/** Records a meaningful view. Deduplicates by (entityType, entityId): a
 * repeat view bumps viewedAt to the front rather than appending a new
 * row, which is what naturally bounds growth from reloads (Section 58). */
export function recordAnonymousView(event: Omit<AnonymousViewEvent, 'viewedAt'>): void {
  if (typeof window === 'undefined') return
  const store = readStore()
  const now = new Date().toISOString()
  const withoutDuplicate = store.events.filter((e) => !(e.entityType === event.entityType && e.entityId === event.entityId))
  const next = pruneExpired([{ ...event, viewedAt: now }, ...withoutDuplicate]).slice(0, MAX_EVENTS)
  writeStore({ events: next, mergedAt: store.mergedAt })
}

export function getAnonymousViews(): AnonymousViewEvent[] {
  const store = readStore()
  return pruneExpired(store.events)
}

/** Section 61: anonymous "Clear recent activity" -- no account required. */
export function clearAnonymousHistory(): void {
  if (typeof window === 'undefined') return
  writeStore(emptyStore())
}

/** Converts the local buffer into the shape the aggregate view table /
 * merge RPC expects (Section 40). Never mutates local state. */
export function buildAnonymousViewRecords(): PersonalizationViewRecord[] {
  const events = getAnonymousViews()
  return events.map((e) => ({
    entityType: e.entityType,
    entityId: e.entityId,
    mode: e.mode,
    category: e.category,
    kind: e.kind,
    province: e.province,
    city: e.city,
    viewCount: 1,
    lastViewedAt: e.viewedAt,
  }))
}

/** Idempotency guard (Section 40/41): call once, right after a
 * successful merge-into-account call, so a second login in the same
 * browser (or a page reload mid-session) never re-imports. */
export function markAnonymousHistoryMerged(): void {
  if (typeof window === 'undefined') return
  const store = readStore()
  writeStore({ events: store.events, mergedAt: new Date().toISOString() })
}

export function hasUnmergedAnonymousHistory(): boolean {
  const store = readStore()
  return store.mergedAt === null && store.events.length > 0
}

export const ANONYMOUS_PERSONALIZATION_STORAGE_KEY = STORAGE_KEY
export const ANONYMOUS_PERSONALIZATION_MAX_EVENTS = MAX_EVENTS
export const ANONYMOUS_PERSONALIZATION_RETENTION_DAYS = RETENTION_DAYS
