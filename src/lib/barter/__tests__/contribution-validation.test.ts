import { describe, it, expect } from 'vitest'
import { proposeBarterSchema, counterBarterOfferSchema } from '../validation'

// contributionMilestoneSchema, skillTaskContributionSchema, and
// depositTermSchema (src/lib/barter/validation.ts) are internal
// (unexported) building blocks of proposeBarterSchema/
// counterBarterOfferSchema's party_a_contributions/party_b_contributions/
// deposit_terms array fields. They are exercised here indirectly,
// through the exported parent schemas, exactly as the app itself uses
// them -- there is no other way to reach them from outside the module.

const ANCHOR_LISTING = '11111111-1111-1111-8111-111111111111'
const ANCHOR_SKILL_TASK = '99999999-9999-4999-8999-999999999999'
const PARTY_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PARTY_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const baseFields = {
  party_a_listing_ids: ['22222222-2222-2222-8222-222222222222'],
  party_b_listing_ids: [] as string[],
  delivery_method: 'meet_in_person' as const,
}

function validContribution(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'skill' as const,
    skill_task_post_id: '33333333-3333-3333-8333-333333333333',
    contribution_weight_percent: 100,
    milestones: [{ title: 'Session 1', sequence: 1, weight_percent: 100 }],
    ...overrides,
  }
}

describe('contributionMilestoneSchema (via party_a_contributions[].milestones)', () => {
  it('accepts a valid milestone with a positive sequence and weight_percent in (0,100]', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ milestones: [{ title: 'Step 1', sequence: 1, weight_percent: 100 }] })],
    })
    expect(result.success).toBe(true)
  })

  it('accepts weight_percent at the lower-exclusive-bound-adjacent value and the upper bound 100', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [
        validContribution({
          milestones: [
            { title: 'Step 1', sequence: 1, weight_percent: 0.01 },
            { title: 'Step 2', sequence: 2, weight_percent: 99.99 },
          ],
        }),
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects weight_percent = 0 (must be > 0)', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ milestones: [{ title: 'Step 1', sequence: 1, weight_percent: 0 }] })],
    })
    expect(result.success).toBe(false)
  })

  it('rejects weight_percent > 100', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ milestones: [{ title: 'Step 1', sequence: 1, weight_percent: 100.01 }] })],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a negative weight_percent', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ milestones: [{ title: 'Step 1', sequence: 1, weight_percent: -5 }] })],
    })
    expect(result.success).toBe(false)
  })

  it('rejects sequence = 0 (must be a positive integer)', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ milestones: [{ title: 'Step 1', sequence: 0, weight_percent: 100 }] })],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a negative sequence', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ milestones: [{ title: 'Step 1', sequence: -1, weight_percent: 100 }] })],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-integer sequence', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ milestones: [{ title: 'Step 1', sequence: 1.5, weight_percent: 100 }] })],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a missing milestone title', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ milestones: [{ sequence: 1, weight_percent: 100 }] })],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a contribution with zero milestones (at least one is required)', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ milestones: [] })],
    })
    expect(result.success).toBe(false)
  })
})

describe('skillTaskContributionSchema (via party_a_contributions/party_b_contributions)', () => {
  it('accepts a contribution referencing an existing post (skill_task_post_id set, no title required)', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution()],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a private/custom contribution (no skill_task_post_id) when a title is supplied', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ skill_task_post_id: undefined, title: 'Custom furniture assembly' })],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a private/custom contribution missing both skill_task_post_id and title (the refine)', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ skill_task_post_id: undefined, title: undefined })],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const titleIssue = result.error.issues.find((i) => i.path.includes('title'))
      expect(titleIssue).toBeDefined()
    }
  })

  it('rejects a private/custom contribution with an empty-string title (falsy, same as missing)', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ skill_task_post_id: undefined, title: '' })],
    })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid kind value', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ kind: 'item' })],
    })
    expect(result.success).toBe(false)
  })

  it('rejects contribution_weight_percent = 0 (must be > 0)', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ contribution_weight_percent: 0 })],
    })
    expect(result.success).toBe(false)
  })

  it('rejects contribution_weight_percent > 100', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ contribution_weight_percent: 100.5 })],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed skill_task_post_id uuid', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: [validContribution({ skill_task_post_id: 'not-a-uuid' })],
    })
    expect(result.success).toBe(false)
  })

  it('rejects more than 10 contributions on one side', () => {
    const contributions = Array.from({ length: 11 }, () => validContribution())
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      party_a_contributions: contributions,
    })
    expect(result.success).toBe(false)
  })
})

describe('depositTermSchema (via deposit_terms)', () => {
  function validDepositTerms(overrides: Record<string, unknown> = {}) {
    return [{ payer_id: PARTY_A_ID, amount: 500, release_basis: 'full_on_completion' as const, ...overrides }]
  }

  it('accepts a valid deposit term', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_terms: validDepositTerms(),
    })
    expect(result.success).toBe(true)
  })

  it('accepts both release_basis enum values', () => {
    for (const release_basis of ['full_on_completion', 'milestone_weighted']) {
      const result = proposeBarterSchema.safeParse({
        anchor_listing_id: ANCHOR_LISTING,
        ...baseFields,
        deposit_terms: validDepositTerms({ release_basis }),
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects an invalid release_basis value', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_terms: validDepositTerms({ release_basis: 'instant' }),
    })
    expect(result.success).toBe(false)
  })

  it('rejects amount = 0 (must be > 0)', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_terms: validDepositTerms({ amount: 0 }),
    })
    expect(result.success).toBe(false)
  })

  it('rejects a negative amount', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_terms: validDepositTerms({ amount: -100 }),
    })
    expect(result.success).toBe(false)
  })

  it('rejects an amount over 1,000,000', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_terms: validDepositTerms({ amount: 1_000_001 }),
    })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed payer_id uuid', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_terms: validDepositTerms({ payer_id: 'not-a-uuid' }),
    })
    expect(result.success).toBe(false)
  })

  it('rejects a currency code that is not exactly 3 characters', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_terms: validDepositTerms({ currency: 'ZARR' }),
    })
    expect(result.success).toBe(false)
  })

  it('rejects more than 2 deposit_terms rows', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_terms: [
        { payer_id: PARTY_A_ID, amount: 100, release_basis: 'full_on_completion' as const },
        { payer_id: PARTY_B_ID, amount: 100, release_basis: 'full_on_completion' as const },
        { payer_id: PARTY_A_ID, amount: 100, release_basis: 'full_on_completion' as const },
      ],
    })
    expect(result.success).toBe(false)
  })
})

describe('proposeBarterSchema anchor exactly-one-of refine', () => {
  it('accepts anchor_listing_id alone', () => {
    const result = proposeBarterSchema.safeParse({ anchor_listing_id: ANCHOR_LISTING, ...baseFields })
    expect(result.success).toBe(true)
  })

  it('accepts anchor_skill_task_post_id alone', () => {
    const result = proposeBarterSchema.safeParse({ anchor_skill_task_post_id: ANCHOR_SKILL_TASK, ...baseFields })
    expect(result.success).toBe(true)
  })

  it('rejects both anchor_listing_id and anchor_skill_task_post_id present together', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      anchor_skill_task_post_id: ANCHOR_SKILL_TASK,
      ...baseFields,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const anchorIssue = result.error.issues.find((i) => i.path.includes('anchor_listing_id'))
      expect(anchorIssue).toBeDefined()
    }
  })

  it('rejects neither anchor_listing_id nor anchor_skill_task_post_id present', () => {
    const result = proposeBarterSchema.safeParse({ ...baseFields })
    expect(result.success).toBe(false)
  })
})

describe('proposeBarterSchema legacyDepositNotCombinedWithTerms refine', () => {
  it('accepts legacy deposit fields alone (no deposit_terms)', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_required: true,
      deposit_amount: 500,
      deposit_payer: 'party_a',
    })
    expect(result.success).toBe(true)
  })

  it('accepts deposit_terms alone (no legacy fields)', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_terms: [{ payer_id: PARTY_A_ID, amount: 500, release_basis: 'full_on_completion' as const }],
    })
    expect(result.success).toBe(true)
  })

  it('rejects deposit_required=true combined with a non-empty deposit_terms array', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_required: true,
      deposit_amount: 500,
      deposit_payer: 'party_a',
      deposit_terms: [{ payer_id: PARTY_A_ID, amount: 500, release_basis: 'full_on_completion' as const }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const termsIssue = result.error.issues.find((i) => i.path.includes('deposit_terms'))
      expect(termsIssue).toBeDefined()
    }
  })

  it('rejects deposit_amount set (without deposit_required) combined with a non-empty deposit_terms array', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_amount: 500,
      deposit_terms: [{ payer_id: PARTY_A_ID, amount: 500, release_basis: 'full_on_completion' as const }],
    })
    expect(result.success).toBe(false)
  })

  it('accepts deposit_required=true combined with an empty deposit_terms array (not "non-empty")', () => {
    const result = proposeBarterSchema.safeParse({
      anchor_listing_id: ANCHOR_LISTING,
      ...baseFields,
      deposit_required: true,
      deposit_amount: 500,
      deposit_payer: 'party_a',
      deposit_terms: [],
    })
    expect(result.success).toBe(true)
  })

  it('applies the identical refine to counterBarterOfferSchema (no anchor field, same deposit rule)', () => {
    const result = counterBarterOfferSchema.safeParse({
      ...baseFields,
      deposit_required: true,
      deposit_amount: 500,
      deposit_payer: 'party_a',
      deposit_terms: [{ payer_id: PARTY_A_ID, amount: 500, release_basis: 'full_on_completion' as const }],
    })
    expect(result.success).toBe(false)
  })
})
