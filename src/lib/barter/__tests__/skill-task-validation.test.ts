import { describe, it, expect } from 'vitest'
import {
  saveSkillTaskPostDraftSchema,
  updateSkillTaskPostSchema,
  skillTaskLifecycleActionSchema,
  reportSkillTaskPostSchema,
  adminSuspendSkillTaskPostSchema,
  adminRestoreSkillTaskPostSchema,
  scheduleMilestoneSchema,
  confirmMilestoneScheduleSchema,
  completeMilestoneSchema,
  createBarterReviewSchema,
  registerMilestoneEvidenceSchema,
} from '../skill-task-validation'

describe('saveSkillTaskPostDraftSchema', () => {
  it('accepts an empty object (all fields optional at draft stage)', () => {
    expect(saveSkillTaskPostDraftSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a fully populated valid draft', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({
      kind: 'skill',
      direction: 'available',
      title: 'Guitar lessons',
      description: 'Beginner-friendly acoustic guitar lessons',
      category_slug: 'music',
      delivery_mode: 'either',
      province: 'Gauteng',
      city: 'Johannesburg',
      exclusions: 'No electric guitar',
      materials_arrangement: 'Bring your own guitar',
      evidence_expectations: 'Photos of progress',
      desired_exchange_notes: 'Open to skill swaps',
      wants_item: false,
      wants_skill: true,
      wants_task: false,
      wants_cash_adjustment: false,
      availability_notes: 'Weekends only',
      preferred_start_date: '2026-09-01',
      preferred_start_time: '10:00',
      deadline: '2026-12-01',
      expected_duration_notes: 'About 6 weeks',
      milestone_templates: [{ title: 'First session', sequence: 1, weight_percent: 100 }],
      idempotency_key: 'a'.repeat(16),
    })
    expect(result.success).toBe(true)
  })

  it('rejects an invalid kind enum value', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ kind: 'item' })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid direction enum value', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ direction: 'wanted' })
    expect(result.success).toBe(false)
  })

  it('rejects an empty-string title', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ title: '' })
    expect(result.success).toBe(false)
  })

  it('rejects a title over 200 characters', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ title: 'a'.repeat(201) })
    expect(result.success).toBe(false)
  })

  it('rejects an empty-string description', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ description: '' })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid delivery_mode value', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ delivery_mode: 'hybrid' })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed preferred_start_date', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ preferred_start_date: 'not-a-date' })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed deadline', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ deadline: '01/12/2026' })
    expect(result.success).toBe(false)
  })

  it('rejects more than 20 milestone templates', () => {
    const templates = Array.from({ length: 21 }, (_, i) => ({ title: `Step ${i}`, sequence: i + 1, weight_percent: 5 }))
    const result = saveSkillTaskPostDraftSchema.safeParse({ milestone_templates: templates })
    expect(result.success).toBe(false)
  })

  it('rejects a milestone template with weight_percent <= 0', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ milestone_templates: [{ title: 'Step 1', sequence: 1, weight_percent: 0 }] })
    expect(result.success).toBe(false)
  })

  it('rejects a milestone template with weight_percent > 100', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ milestone_templates: [{ title: 'Step 1', sequence: 1, weight_percent: 101 }] })
    expect(result.success).toBe(false)
  })

  it('rejects a milestone template with a non-positive sequence', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ milestone_templates: [{ title: 'Step 1', sequence: 0, weight_percent: 50 }] })
    expect(result.success).toBe(false)
  })

  it('rejects a milestone template missing a title', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ milestone_templates: [{ sequence: 1, weight_percent: 100 }] })
    expect(result.success).toBe(false)
  })

  it('rejects an idempotency_key shorter than 8 characters', () => {
    const result = saveSkillTaskPostDraftSchema.safeParse({ idempotency_key: 'short' })
    expect(result.success).toBe(false)
  })
})

describe('updateSkillTaskPostSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    expect(updateSkillTaskPostSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a partial valid update', () => {
    const result = updateSkillTaskPostSchema.safeParse({ title: 'Updated title', city: 'Cape Town' })
    expect(result.success).toBe(true)
  })

  it('does not accept kind/direction at all -- immutable post-publish fields are not part of this schema', () => {
    // update_barter_skill_task_post() never accepts kind/direction (plan
    // Round 6: immutable once a post has ever left draft) -- confirming
    // the schema has no such keys by checking a payload that supplies
    // them still succeeds (they're simply stripped/ignored, not present
    // in the schema's shape at all) while the resulting parsed object
    // does not carry them through.
    const result = updateSkillTaskPostSchema.safeParse({ title: 'x', kind: 'task', direction: 'looking_for' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).kind).toBeUndefined()
      expect((result.data as Record<string, unknown>).direction).toBeUndefined()
    }
  })

  it('rejects an empty-string title', () => {
    const result = updateSkillTaskPostSchema.safeParse({ title: '' })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid delivery_mode value', () => {
    const result = updateSkillTaskPostSchema.safeParse({ delivery_mode: 'in-person' })
    expect(result.success).toBe(false)
  })

  it('rejects a description over 3000 characters', () => {
    const result = updateSkillTaskPostSchema.safeParse({ description: 'a'.repeat(3001) })
    expect(result.success).toBe(false)
  })
})

describe('skillTaskLifecycleActionSchema', () => {
  it('accepts an empty object', () => {
    expect(skillTaskLifecycleActionSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a valid idempotency_key', () => {
    expect(skillTaskLifecycleActionSchema.safeParse({ idempotency_key: 'a'.repeat(10) }).success).toBe(true)
  })

  it('rejects an idempotency_key that is too long', () => {
    expect(skillTaskLifecycleActionSchema.safeParse({ idempotency_key: 'a'.repeat(129) }).success).toBe(false)
  })
})

describe('reportSkillTaskPostSchema', () => {
  it('accepts every documented reason enum value', () => {
    const reasons = ['harassment', 'scam_fraud', 'inappropriate_content', 'impersonation', 'spam', 'prohibited_content', 'other']
    for (const reason of reasons) {
      expect(reportSkillTaskPostSchema.safeParse({ reason }).success).toBe(true)
    }
  })

  it('rejects a missing reason', () => {
    expect(reportSkillTaskPostSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an invalid reason value', () => {
    expect(reportSkillTaskPostSchema.safeParse({ reason: 'not_a_real_reason' }).success).toBe(false)
  })

  it('accepts an optional description', () => {
    expect(reportSkillTaskPostSchema.safeParse({ reason: 'spam', description: 'Posting the same thing repeatedly' }).success).toBe(true)
  })

  it('rejects an oversized description', () => {
    expect(reportSkillTaskPostSchema.safeParse({ reason: 'spam', description: 'a'.repeat(1001) }).success).toBe(false)
  })
})

describe('adminSuspendSkillTaskPostSchema', () => {
  it('accepts a valid reason', () => {
    expect(adminSuspendSkillTaskPostSchema.safeParse({ reason: 'Policy violation' }).success).toBe(true)
  })

  it('rejects a missing reason (reason is required for admin suspend)', () => {
    expect(adminSuspendSkillTaskPostSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an empty-string reason', () => {
    expect(adminSuspendSkillTaskPostSchema.safeParse({ reason: '' }).success).toBe(false)
  })

  it('rejects an oversized reason', () => {
    expect(adminSuspendSkillTaskPostSchema.safeParse({ reason: 'a'.repeat(1001) }).success).toBe(false)
  })
})

describe('adminRestoreSkillTaskPostSchema', () => {
  it('accepts a valid reason', () => {
    expect(adminRestoreSkillTaskPostSchema.safeParse({ reason: 'False positive, restoring' }).success).toBe(true)
  })

  it('rejects a missing reason (reason is required for admin restore)', () => {
    expect(adminRestoreSkillTaskPostSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an empty-string reason', () => {
    expect(adminRestoreSkillTaskPostSchema.safeParse({ reason: '' }).success).toBe(false)
  })
})

describe('scheduleMilestoneSchema', () => {
  const valid = { scheduled_at: '2026-09-01T10:00:00Z', scheduled_city: 'Durban', scheduled_province: 'KwaZulu-Natal' }

  it('accepts a fully valid payload', () => {
    expect(scheduleMilestoneSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects a missing scheduled_at', () => {
    const { scheduled_at: _omit, ...rest } = valid
    void _omit
    expect(scheduleMilestoneSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects a non-datetime scheduled_at', () => {
    expect(scheduleMilestoneSchema.safeParse({ ...valid, scheduled_at: '2026-09-01' }).success).toBe(false)
  })

  it('rejects an empty-string scheduled_city', () => {
    expect(scheduleMilestoneSchema.safeParse({ ...valid, scheduled_city: '' }).success).toBe(false)
  })

  it('rejects an empty-string scheduled_province', () => {
    expect(scheduleMilestoneSchema.safeParse({ ...valid, scheduled_province: '' }).success).toBe(false)
  })

  it('rejects a missing scheduled_city entirely', () => {
    const { scheduled_city: _omit, ...rest } = valid
    void _omit
    expect(scheduleMilestoneSchema.safeParse(rest).success).toBe(false)
  })
})

describe('confirmMilestoneScheduleSchema', () => {
  it('accepts an empty object', () => {
    expect(confirmMilestoneScheduleSchema.safeParse({}).success).toBe(true)
  })

  it('rejects a non-string idempotency_key', () => {
    expect(confirmMilestoneScheduleSchema.safeParse({ idempotency_key: 12345 }).success).toBe(false)
  })
})

describe('completeMilestoneSchema', () => {
  it('accepts an empty object', () => {
    expect(completeMilestoneSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a valid idempotency_key', () => {
    expect(completeMilestoneSchema.safeParse({ idempotency_key: 'b'.repeat(12) }).success).toBe(true)
  })
})

describe('createBarterReviewSchema', () => {
  it('accepts a valid rating with a comment', () => {
    expect(createBarterReviewSchema.safeParse({ rating: 5, comment: 'Great experience' }).success).toBe(true)
  })

  it('accepts a valid rating with no comment', () => {
    expect(createBarterReviewSchema.safeParse({ rating: 3 }).success).toBe(true)
  })

  it('rejects a missing rating', () => {
    expect(createBarterReviewSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a rating of 0 (below the 1-5 range)', () => {
    expect(createBarterReviewSchema.safeParse({ rating: 0 }).success).toBe(false)
  })

  it('rejects a rating of 6 (above the 1-5 range)', () => {
    expect(createBarterReviewSchema.safeParse({ rating: 6 }).success).toBe(false)
  })

  it('rejects a non-integer rating', () => {
    expect(createBarterReviewSchema.safeParse({ rating: 4.5 }).success).toBe(false)
  })

  it('rejects an oversized comment', () => {
    expect(createBarterReviewSchema.safeParse({ rating: 5, comment: 'a'.repeat(2001) }).success).toBe(false)
  })
})

describe('registerMilestoneEvidenceSchema', () => {
  const valid = { storage_path: 'milestone-1/user-1/photo.jpg', file_type: 'image' as const }

  it('accepts a fully valid payload', () => {
    expect(registerMilestoneEvidenceSchema.safeParse(valid).success).toBe(true)
  })

  it('accepts every documented file_type enum value', () => {
    for (const file_type of ['image', 'pdf', 'document']) {
      expect(registerMilestoneEvidenceSchema.safeParse({ ...valid, file_type }).success).toBe(true)
    }
  })

  it('rejects a missing storage_path', () => {
    const { storage_path: _omit, ...rest } = valid
    void _omit
    expect(registerMilestoneEvidenceSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects an empty-string storage_path', () => {
    expect(registerMilestoneEvidenceSchema.safeParse({ ...valid, storage_path: '' }).success).toBe(false)
  })

  it('rejects an invalid file_type value', () => {
    expect(registerMilestoneEvidenceSchema.safeParse({ ...valid, file_type: 'video' }).success).toBe(false)
  })

  it('rejects a negative display_order', () => {
    expect(registerMilestoneEvidenceSchema.safeParse({ ...valid, display_order: -1 }).success).toBe(false)
  })

  it('rejects a display_order over 100', () => {
    expect(registerMilestoneEvidenceSchema.safeParse({ ...valid, display_order: 101 }).success).toBe(false)
  })

  it('accepts a display_order at the boundary values 0 and 100', () => {
    expect(registerMilestoneEvidenceSchema.safeParse({ ...valid, display_order: 0 }).success).toBe(true)
    expect(registerMilestoneEvidenceSchema.safeParse({ ...valid, display_order: 100 }).success).toBe(true)
  })
})
