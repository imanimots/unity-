import { describe, it, expect } from 'vitest'
import { proposeBarterSchema, counterBarterOfferSchema, rejectBarterSchema, cancelBarterSchema, barterActionSchema } from '../validation'

const validBase = {
  anchor_listing_id: '11111111-1111-1111-8111-111111111111',
  party_a_listing_ids: ['22222222-2222-2222-8222-222222222222'],
  party_b_listing_ids: ['33333333-3333-3333-8333-333333333333'],
  delivery_method: 'meet_in_person' as const,
}

describe('proposeBarterSchema', () => {
  it('accepts a minimal valid Item<->Item proposal', () => {
    expect(proposeBarterSchema.safeParse(validBase).success).toBe(true)
  })

  it('accepts multiple listings on both sides', () => {
    const result = proposeBarterSchema.safeParse({
      ...validBase,
      party_a_listing_ids: ['a1111111-1111-1111-8111-111111111111', 'a2222222-2222-2222-8222-222222222222'],
      party_b_listing_ids: ['b1111111-1111-1111-8111-111111111111', 'b2222222-2222-2222-8222-222222222222', 'b3333333-3333-3333-8333-333333333333'],
    })
    expect(result.success).toBe(true)
  })

  // Skills + Tasks under Barter widening: a side may be purely
  // Skill/Task-based, so an empty listing array is no longer rejected
  // at the zod layer by itself -- "at least one contribution (item or
  // Skill/Task) per side" is enforced by the RPC instead (see the
  // offerFields comment in validation.ts). These two cases now assert
  // the schema accepts an empty listing array on its own.
  it('accepts an empty party_a_listing_ids array (Skill/Task contributions may fill that side instead)', () => {
    const result = proposeBarterSchema.safeParse({ ...validBase, party_a_listing_ids: [] })
    expect(result.success).toBe(true)
  })

  it('accepts an empty party_b_listing_ids array (Skill/Task contributions may fill that side instead)', () => {
    const result = proposeBarterSchema.safeParse({ ...validBase, party_b_listing_ids: [] })
    expect(result.success).toBe(true)
  })

  it('rejects a malformed uuid in the offered-listings array', () => {
    const result = proposeBarterSchema.safeParse({ ...validBase, party_b_listing_ids: ['not-a-uuid'] })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid delivery_method value', () => {
    const result = proposeBarterSchema.safeParse({ ...validBase, delivery_method: 'digital_delivery' })
    expect(result.success).toBe(false)
  })

  it('rejects deposit_required=true without an amount and payer', () => {
    const result = proposeBarterSchema.safeParse({ ...validBase, deposit_required: true })
    expect(result.success).toBe(false)
  })

  it('accepts deposit_required=true with a valid amount and payer', () => {
    const result = proposeBarterSchema.safeParse({ ...validBase, deposit_required: true, deposit_amount: 500, deposit_payer: 'party_a' })
    expect(result.success).toBe(true)
  })

  it('rejects a cash adjustment amount without a payer', () => {
    const result = proposeBarterSchema.safeParse({ ...validBase, cash_adjustment_amount: 200 })
    expect(result.success).toBe(false)
  })

  it('accepts a cash adjustment amount with a payer', () => {
    const result = proposeBarterSchema.safeParse({
      ...validBase,
      cash_adjustment_amount: 200,
      cash_adjustment_payer: '44444444-4444-4444-8444-444444444444',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an oversized message', () => {
    const result = proposeBarterSchema.safeParse({ ...validBase, message: 'a'.repeat(2001) })
    expect(result.success).toBe(false)
  })
})

describe('counterBarterOfferSchema', () => {
  it('accepts a valid counter-offer without an anchor_listing_id field', () => {
    const { anchor_listing_id: _anchor, ...counterFields } = validBase
    void _anchor
    expect(counterBarterOfferSchema.safeParse(counterFields).success).toBe(true)
  })
})

describe('rejectBarterSchema / cancelBarterSchema / barterActionSchema', () => {
  it('accept an empty body', () => {
    expect(rejectBarterSchema.safeParse({}).success).toBe(true)
    expect(cancelBarterSchema.safeParse({}).success).toBe(true)
    expect(barterActionSchema.safeParse({}).success).toBe(true)
  })

  it('reject an idempotency key shorter than 8 characters', () => {
    expect(barterActionSchema.safeParse({ idempotency_key: 'short' }).success).toBe(false)
  })
})
