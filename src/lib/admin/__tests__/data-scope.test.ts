import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  resolveAdminDataScope,
  isValidAdminDataScope,
  profileScopeFilterValue,
  classifyProfile,
  classifyEntityWithOwner,
  classifyEntityWithOwners,
  classifyOwnersOnly,
  isAdminSystemAuditTable,
} from '../data-scope'

const real = { data_classification: 'real' as const }
const test = { data_classification: 'test' as const }
const unknown = { data_classification: 'unknown' as const }

describe('data-scope: canonical real/test/unknown classification contract (category: ADMIN-CONTROL-CENTRE-BATCH-D3-B)', () => {
  it('1. real profile + is_test=false => REAL', () => {
    expect(classifyEntityWithOwner({ is_test: false }, real)).toBe('real')
  })

  it('2. real profile + is_test=true => TEST (explicit test evidence wins over a real owner)', () => {
    expect(classifyEntityWithOwner({ is_test: true }, real)).toBe('test')
  })

  it('3. test profile + is_test=false => TEST', () => {
    expect(classifyEntityWithOwner({ is_test: false }, test)).toBe('test')
  })

  it('4. test profile + is_test=true => TEST', () => {
    expect(classifyEntityWithOwner({ is_test: true }, test)).toBe('test')
  })

  it('5. unknown profile + is_test=false => UNKNOWN', () => {
    expect(classifyEntityWithOwner({ is_test: false }, unknown)).toBe('unknown')
  })

  it('6. unknown profile + is_test=true => TEST', () => {
    expect(classifyEntityWithOwner({ is_test: true }, unknown)).toBe('test')
  })

  it('7. unknown is never returned as REAL, across every is_test/owner combination', () => {
    for (const isTest of [true, false]) {
      for (const owner of [real, test, unknown]) {
        const result = classifyEntityWithOwner({ is_test: isTest }, owner)
        if (owner === unknown && !isTest) {
          expect(result).toBe('unknown')
        }
        expect(result === 'real' && owner === unknown).toBe(false)
      }
    }
  })

  it('8. test is never silently returned as REAL', () => {
    expect(classifyEntityWithOwner({ is_test: true }, real)).not.toBe('real')
    expect(classifyEntityWithOwner({ is_test: false }, test)).not.toBe('real')
  })

  it('9. explicit test evidence wins over profile real (entity-level flag takes precedence)', () => {
    expect(classifyEntityWithOwner({ is_test: true }, real)).toBe('test')
  })

  it('10. ALL scope is only ever reached by explicit caller choice', () => {
    expect(resolveAdminDataScope('all')).toBe('all')
    expect(profileScopeFilterValue('all')).toBeNull()
  })

  it('11. invalid or missing scope can never silently become ALL -- it resolves to the safe default (real)', () => {
    expect(resolveAdminDataScope(undefined)).toBe('real')
    expect(resolveAdminDataScope(null)).toBe('real')
    expect(resolveAdminDataScope('')).toBe('real')
    expect(resolveAdminDataScope('bogus')).toBe('real')
    expect(resolveAdminDataScope('ALL')).toBe('real')
    expect(isValidAdminDataScope('bogus')).toBe(false)
    expect(isValidAdminDataScope(undefined)).toBe(false)
  })

  it('12. no email-domain heuristic exists anywhere in this module\'s source', () => {
    const source = readFileSync(join(__dirname, '../data-scope.ts'), 'utf-8')
    expect(source).not.toMatch(/unitytest\.internal/)
    expect(source).not.toMatch(/unitytest\.co\.za/)
    expect(source).not.toMatch(/gmail\.com/)
    expect(source).not.toMatch(/email/i)
  })

  it('13. profileScopeFilterValue never emits a negative comparison contract -- real/test/unknown map to themselves as positive equality values', () => {
    expect(profileScopeFilterValue('real')).toBe('real')
    expect(profileScopeFilterValue('test')).toBe('test')
    expect(profileScopeFilterValue('unknown')).toBe('unknown')
  })

  it('14. classifyProfile treats a profile with no classification column selected as unknown, never real', () => {
    expect(classifyProfile({ data_classification: undefined })).toBe('unknown')
  })

  it('15. tables with no entity-level is_test column (bookings, orders, barter_agreements) classify purely from owner(s) via classifyOwnersOnly', () => {
    expect(classifyOwnersOnly([real])).toBe('real')
    expect(classifyOwnersOnly([test])).toBe('test')
    expect(classifyOwnersOnly([unknown])).toBe('unknown')
  })

  it('16. dual-owner tables (bookings: renter+merchant; orders: buyer+seller; reviews: reviewer+reviewee; rent_to_buy_agreements: merchant+customer) require BOTH owners real for REAL', () => {
    expect(classifyOwnersOnly([real, real])).toBe('real')
    expect(classifyOwnersOnly([real, unknown])).toBe('unknown')
    expect(classifyOwnersOnly([unknown, real])).toBe('unknown')
  })

  it('17. dual-owner tables: test evidence from EITHER owner makes the whole record test, never averaged or arbitrarily picked', () => {
    expect(classifyOwnersOnly([real, test])).toBe('test')
    expect(classifyOwnersOnly([test, real])).toBe('test')
    expect(classifyOwnersOnly([unknown, test])).toBe('test')
  })

  it('18. classifyEntityWithOwners generalizes classifyEntityWithOwner for the single-owner case', () => {
    expect(classifyEntityWithOwners({ is_test: false }, [real])).toBe(classifyEntityWithOwner({ is_test: false }, real))
  })

  it('19. isAdminSystemAuditTable recognizes only the three confirmed admin-action history tables, not business tables', () => {
    expect(isAdminSystemAuditTable('admin_action_history')).toBe(true)
    expect(isAdminSystemAuditTable('identity_verification_history')).toBe(true)
    expect(isAdminSystemAuditTable('user_account_history')).toBe(true)
    expect(isAdminSystemAuditTable('listings')).toBe(false)
    expect(isAdminSystemAuditTable('profiles')).toBe(false)
    expect(isAdminSystemAuditTable('bookings')).toBe(false)
  })

  it('20. D3-B-F1 vacuous-truth guard: zero owners + is_test=false => unknown, never real. Protects against accidental removal of the `ownerClassifications.length > 0` guard before `.every(...)`, which would otherwise let [].every(...) === true silently prove REAL for an entity with no resolved owner.', () => {
    expect(classifyEntityWithOwners({ is_test: false }, [])).toBe('unknown')
  })

  it('21. D3-B-F1 vacuous-truth guard: zero owners + is_test undefined (entity object omits the field entirely) => unknown. Absence of entity test evidence plus absence of owner provenance must never prove real.', () => {
    expect(classifyEntityWithOwners({} as { is_test: boolean }, [])).toBe('unknown')
  })

  it('22. D3-B-F1 vacuous-truth guard: zero owners + is_test=true => test. Explicit test evidence retains precedence even when no owner classifications are available at all.', () => {
    expect(classifyEntityWithOwners({ is_test: true }, [])).toBe('test')
  })
})
