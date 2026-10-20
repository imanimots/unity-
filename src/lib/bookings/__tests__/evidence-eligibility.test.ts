import { describe, it, expect } from 'vitest'
import { canUploadConditionEvidence } from '../evidence-eligibility'

describe('canUploadConditionEvidence (category: P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I)', () => {
  describe('pre_handover', () => {
    it('1. allowed when accepted', () => {
      expect(canUploadConditionEvidence('accepted', 'pre_handover')).toBe(true)
    })
    it('2. allowed when active', () => {
      expect(canUploadConditionEvidence('active', 'pre_handover')).toBe(true)
    })
    it('3. rejected when requested (booking not yet confirmed)', () => {
      expect(canUploadConditionEvidence('requested', 'pre_handover')).toBe(false)
    })
    it('4. rejected once return_pending', () => {
      expect(canUploadConditionEvidence('return_pending', 'pre_handover')).toBe(false)
    })
    it('5. rejected once completed', () => {
      expect(canUploadConditionEvidence('completed', 'pre_handover')).toBe(false)
    })
    it('6. rejected when cancelled', () => {
      expect(canUploadConditionEvidence('cancelled_by_renter', 'pre_handover')).toBe(false)
    })
  })

  describe('post_return', () => {
    it('7. allowed when return_pending', () => {
      expect(canUploadConditionEvidence('return_pending', 'post_return')).toBe(true)
    })
    it('8. allowed when returned', () => {
      expect(canUploadConditionEvidence('returned', 'post_return')).toBe(true)
    })
    it('9. allowed when completed', () => {
      expect(canUploadConditionEvidence('completed', 'post_return')).toBe(true)
    })
    it('10. allowed when disputed (evidence often most needed exactly here)', () => {
      expect(canUploadConditionEvidence('disputed', 'post_return')).toBe(true)
    })
    it('11. rejected when still active (return not yet initiated)', () => {
      expect(canUploadConditionEvidence('active', 'post_return')).toBe(false)
    })
    it('12. rejected when requested', () => {
      expect(canUploadConditionEvidence('requested', 'post_return')).toBe(false)
    })
  })

  it('13. an unknown/garbage status is rejected for both stages, not permissively allowed', () => {
    expect(canUploadConditionEvidence('not_a_real_status', 'pre_handover')).toBe(false)
    expect(canUploadConditionEvidence('not_a_real_status', 'post_return')).toBe(false)
  })
})
