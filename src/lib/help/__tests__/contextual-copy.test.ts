import { describe, it, expect } from 'vitest'
import { CONTEXTUAL_COPY, MESSAGING_SAFETY_NOTICE, ACCOUNT_STATUS_NOTICE } from '../contextual-copy'
import { HELP_TASKS } from '../task-registry'
import { LEARN_ARTICLES } from '../learn-registry'

const REAL_SLUGS = new Set([...HELP_TASKS.map((t) => t.slug), ...LEARN_ARTICLES.map((a) => a.slug)])

function slugFromHref(href: string): string {
  return href.replace(/^\/help\//, '')
}

describe('contextual copy library', () => {
  it('every CONTEXTUAL_COPY learnMoreHref resolves to a real Help route', () => {
    const dangling = Object.entries(CONTEXTUAL_COPY)
      .filter(([, entry]) => !REAL_SLUGS.has(slugFromHref(entry.learnMoreHref)))
      .map(([key]) => key)
    expect(dangling).toEqual([])
  })

  it('every CONTEXTUAL_COPY entry has non-empty label and text', () => {
    const empty = Object.entries(CONTEXTUAL_COPY)
      .filter(([, entry]) => !entry.label.trim() || !entry.text.trim())
      .map(([key]) => key)
    expect(empty).toEqual([])
  })

  it('messaging safety notice resolves to a real Help route', () => {
    expect(REAL_SLUGS.has(slugFromHref(MESSAGING_SAFETY_NOTICE.learnMoreHref))).toBe(true)
  })

  it('account status notices (restricted + suspended) resolve to real Help routes', () => {
    for (const status of Object.keys(ACCOUNT_STATUS_NOTICE) as Array<keyof typeof ACCOUNT_STATUS_NOTICE>) {
      expect(REAL_SLUGS.has(slugFromHref(ACCOUNT_STATUS_NOTICE[status].learnMoreHref))).toBe(true)
    }
  })

  it('no CONTEXTUAL_COPY text claims a deferred provider is live', () => {
    const bannedClaims = /peach is|payfast is|tradesafe is live|bob go is live|sumsub is/i
    for (const [key, entry] of Object.entries(CONTEXTUAL_COPY)) {
      expect(entry.text, key).not.toMatch(bannedClaims)
    }
  })
})
