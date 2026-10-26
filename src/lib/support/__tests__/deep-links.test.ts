import { describe, it, expect } from 'vitest'
import { buildSupportLinkedEntityHref } from '../deep-links'
import { SUPPORT_LINKED_ENTITY_TYPES } from '../types'

const ID = '11111111-1111-1111-1111-111111111111'

describe('buildSupportLinkedEntityHref (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — linked entities (I)', () => {
  it('1. every bounded entity type produces a valid, same-origin admin route (never an arbitrary/external URL)', () => {
    for (const type of SUPPORT_LINKED_ENTITY_TYPES) {
      const href = buildSupportLinkedEntityHref(type, ID)
      expect(href).not.toBeNull()
      expect(href).toMatch(/^\/admin\//)
      expect(href).not.toContain('http://')
      expect(href).not.toContain('https://')
    }
  })

  it('2. an unsupported/unknown entity type returns null -- never a broken or injected link', () => {
    // @ts-expect-error -- deliberately outside the bounded enum, mirroring an unmapped future type
    const href = buildSupportLinkedEntityHref('spaceship', ID)
    expect(href).toBeNull()
  })

  it('3. the raw id is embedded as-is, never used to construct a protocol/host (no injection surface)', () => {
    const maliciousId = 'javascript:alert(1)'
    const href = buildSupportLinkedEntityHref('customer', maliciousId)
    expect(href).toBe(`/admin/users/${maliciousId}`)
    expect(href?.startsWith('/admin/')).toBe(true)
  })
})
