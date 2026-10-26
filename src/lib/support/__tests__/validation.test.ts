import { describe, it, expect } from 'vitest'
import {
  createSupportCaseSchema,
  updateSupportCaseStatusSchema,
  escalateSupportCaseSchema,
  resolveSupportCaseSchema,
  closeSupportCaseSchema,
  reopenSupportCaseSchema,
  addSupportCaseNoteSchema,
} from '../validation'

const UUID = '11111111-1111-4111-8111-111111111111'

describe('createSupportCaseSchema (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — creation validation (B)', () => {
  it('1. accepts a minimal valid case', () => {
    expect(createSupportCaseSchema.safeParse({ title: 'Help', category: 'general_other', customer_id: UUID }).success).toBe(true)
  })

  it('2. rejects an invalid category', () => {
    expect(createSupportCaseSchema.safeParse({ title: 'Help', category: 'not_real', customer_id: UUID }).success).toBe(false)
  })

  it('3. rejects an invalid priority', () => {
    expect(createSupportCaseSchema.safeParse({ title: 'Help', category: 'general_other', customer_id: UUID, priority: 'urgent-ish' }).success).toBe(false)
  })

  it('4. rejects when neither customer_id nor merchant_id is set', () => {
    expect(createSupportCaseSchema.safeParse({ title: 'Help', category: 'general_other' }).success).toBe(false)
  })

  it('5. accepts merchant_id alone (no customer_id)', () => {
    expect(createSupportCaseSchema.safeParse({ title: 'Help', category: 'general_other', merchant_id: UUID }).success).toBe(true)
  })

  it('6. rejects linked_entity_type without linked_entity_id', () => {
    expect(createSupportCaseSchema.safeParse({ title: 'Help', category: 'general_other', customer_id: UUID, linked_entity_type: 'booking' }).success).toBe(false)
  })

  it('7. rejects an invalid linked_entity_type', () => {
    expect(createSupportCaseSchema.safeParse({ title: 'Help', category: 'general_other', customer_id: UUID, linked_entity_type: 'spaceship', linked_entity_id: UUID }).success).toBe(false)
  })

  it('8. rejects a nonexistent (non-UUID) linked_entity_id', () => {
    expect(createSupportCaseSchema.safeParse({ title: 'Help', category: 'general_other', customer_id: UUID, linked_entity_type: 'booking', linked_entity_id: 'not-a-uuid' }).success).toBe(false)
  })

  it('9. rejects an empty title', () => {
    expect(createSupportCaseSchema.safeParse({ title: '', category: 'general_other', customer_id: UUID }).success).toBe(false)
  })

  it('10. rejects a title over 200 chars', () => {
    expect(createSupportCaseSchema.safeParse({ title: 'a'.repeat(201), category: 'general_other', customer_id: UUID }).success).toBe(false)
  })
})

describe('lifecycle action schemas (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — status workflow (D)', () => {
  it('1. update_support_case_status accepts only the three soft statuses', () => {
    expect(updateSupportCaseStatusSchema.safeParse({ target_status: 'open' }).success).toBe(true)
    expect(updateSupportCaseStatusSchema.safeParse({ target_status: 'in_progress' }).success).toBe(true)
    expect(updateSupportCaseStatusSchema.safeParse({ target_status: 'waiting_on_user' }).success).toBe(true)
    expect(updateSupportCaseStatusSchema.safeParse({ target_status: 'escalated' }).success).toBe(false)
    expect(updateSupportCaseStatusSchema.safeParse({ target_status: 'resolved' }).success).toBe(false)
    expect(updateSupportCaseStatusSchema.safeParse({ target_status: 'closed' }).success).toBe(false)
  })

  it('2. escalateSupportCaseSchema requires a non-empty reason', () => {
    expect(escalateSupportCaseSchema.safeParse({ reason: '' }).success).toBe(false)
    expect(escalateSupportCaseSchema.safeParse({}).success).toBe(false)
    expect(escalateSupportCaseSchema.safeParse({ reason: 'Legal threat' }).success).toBe(true)
  })

  it('3. resolveSupportCaseSchema requires a non-empty resolution_summary', () => {
    expect(resolveSupportCaseSchema.safeParse({}).success).toBe(false)
    expect(resolveSupportCaseSchema.safeParse({ resolution_summary: 'Refunded' }).success).toBe(true)
  })

  it('4. closeSupportCaseSchema allows an omitted reason (server enforces the resolved-vs-not-resolved requirement)', () => {
    expect(closeSupportCaseSchema.safeParse({}).success).toBe(true)
    expect(closeSupportCaseSchema.safeParse({ reason: 'Withdrawn' }).success).toBe(true)
  })

  it('5. reopenSupportCaseSchema requires a non-empty reason', () => {
    expect(reopenSupportCaseSchema.safeParse({}).success).toBe(false)
    expect(reopenSupportCaseSchema.safeParse({ reason: 'New evidence' }).success).toBe(true)
  })
})

describe('addSupportCaseNoteSchema (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — notes (E)', () => {
  it('1. rejects a blank note', () => {
    expect(addSupportCaseNoteSchema.safeParse({ note: '' }).success).toBe(false)
  })

  it('2. rejects an oversized note', () => {
    expect(addSupportCaseNoteSchema.safeParse({ note: 'a'.repeat(4001) }).success).toBe(false)
  })

  it('3. accepts a reasonable note', () => {
    expect(addSupportCaseNoteSchema.safeParse({ note: 'Called the customer back.' }).success).toBe(true)
  })
})
