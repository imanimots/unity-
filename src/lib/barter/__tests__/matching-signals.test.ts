import { describe, it, expect } from 'vitest'
import { deliveryModeCompatible, computeCompatibilityCount, sortByCompatibilityDesc } from '../matching'

describe('deliveryModeCompatible', () => {
  it('is compatible when both sides are remote', () => {
    expect(deliveryModeCompatible('remote', 'remote')).toBe(true)
  })

  it('is compatible when both sides are in_person', () => {
    expect(deliveryModeCompatible('in_person', 'in_person')).toBe(true)
  })

  it('is incompatible when one side is remote and the other is in_person', () => {
    expect(deliveryModeCompatible('remote', 'in_person')).toBe(false)
    expect(deliveryModeCompatible('in_person', 'remote')).toBe(false)
  })

  it('is compatible whenever either side is "either"', () => {
    expect(deliveryModeCompatible('either', 'remote')).toBe(true)
    expect(deliveryModeCompatible('remote', 'either')).toBe(true)
    expect(deliveryModeCompatible('either', 'in_person')).toBe(true)
    expect(deliveryModeCompatible('in_person', 'either')).toBe(true)
    expect(deliveryModeCompatible('either', 'either')).toBe(true)
  })

  it('is compatible when either side is null (unknown, not excluded)', () => {
    expect(deliveryModeCompatible(null, 'remote')).toBe(true)
    expect(deliveryModeCompatible('remote', null)).toBe(true)
    expect(deliveryModeCompatible(null, null)).toBe(true)
    expect(deliveryModeCompatible(null, 'in_person')).toBe(true)
  })
})

describe('computeCompatibilityCount', () => {
  it('counts zero true signals', () => {
    expect(computeCompatibilityCount({ categoryMatch: false, locationMatch: false })).toBe(0)
  })

  it('counts all true signals', () => {
    expect(computeCompatibilityCount({ categoryMatch: true, deliveryModeCompatible: true, locationMatch: true })).toBe(3)
  })

  it('counts a mix of true/false signals', () => {
    expect(computeCompatibilityCount({ categoryMatch: true, deliveryModeCompatible: false, locationMatch: true })).toBe(2)
  })

  it('returns 0 for an empty signals object', () => {
    expect(computeCompatibilityCount({})).toBe(0)
  })
})

interface Candidate {
  id: string
  created_at: string
  compatibilityCount: number
}

describe('sortByCompatibilityDesc', () => {
  it('sorts strictly by compatibilityCount descending', () => {
    const items: Candidate[] = [
      { id: 'a', created_at: '2026-01-01T00:00:00Z', compatibilityCount: 1 },
      { id: 'b', created_at: '2026-01-01T00:00:00Z', compatibilityCount: 3 },
      { id: 'c', created_at: '2026-01-01T00:00:00Z', compatibilityCount: 2 },
    ]
    const sorted = sortByCompatibilityDesc(items)
    expect(sorted.map((i) => i.id)).toEqual(['b', 'c', 'a'])
  })

  it('tie-breaks equal compatibilityCount by created_at descending (freshest first)', () => {
    const items: Candidate[] = [
      { id: 'old', created_at: '2026-01-01T00:00:00Z', compatibilityCount: 2 },
      { id: 'new', created_at: '2026-06-01T00:00:00Z', compatibilityCount: 2 },
      { id: 'mid', created_at: '2026-03-01T00:00:00Z', compatibilityCount: 2 },
    ]
    const sorted = sortByCompatibilityDesc(items)
    expect(sorted.map((i) => i.id)).toEqual(['new', 'mid', 'old'])
  })

  it('tie-breaks equal compatibilityCount AND equal created_at by id ascending', () => {
    const items: Candidate[] = [
      { id: 'c', created_at: '2026-01-01T00:00:00Z', compatibilityCount: 2 },
      { id: 'a', created_at: '2026-01-01T00:00:00Z', compatibilityCount: 2 },
      { id: 'b', created_at: '2026-01-01T00:00:00Z', compatibilityCount: 2 },
    ]
    const sorted = sortByCompatibilityDesc(items)
    expect(sorted.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('applies compatibilityCount first, then created_at, then id, in that priority order', () => {
    const items: Candidate[] = [
      { id: 'z', created_at: '2026-01-01T00:00:00Z', compatibilityCount: 1 },
      { id: 'y', created_at: '2020-01-01T00:00:00Z', compatibilityCount: 5 },
      { id: 'x', created_at: '2026-06-01T00:00:00Z', compatibilityCount: 5 },
    ]
    const sorted = sortByCompatibilityDesc(items)
    // x and y both have compatibilityCount 5 -> x (newer created_at) first, then y; z last (lower count).
    expect(sorted.map((i) => i.id)).toEqual(['x', 'y', 'z'])
  })

  it('does not mutate the input array', () => {
    const items: Candidate[] = [
      { id: 'b', created_at: '2026-01-01T00:00:00Z', compatibilityCount: 1 },
      { id: 'a', created_at: '2026-01-01T00:00:00Z', compatibilityCount: 2 },
    ]
    const original = [...items]
    sortByCompatibilityDesc(items)
    expect(items).toEqual(original)
  })

  it('returns an empty array unchanged', () => {
    expect(sortByCompatibilityDesc([])).toEqual([])
  })
})
