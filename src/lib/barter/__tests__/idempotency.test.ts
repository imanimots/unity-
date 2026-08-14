import { describe, it, expect } from 'vitest'
import {
  computeProposeBarterHash,
  computeCounterBarterOfferHash,
  computeAcceptBarterOfferHash,
  computeRejectBarterOfferHash,
  computeCancelBarterAgreementHash,
  computeMarkBarterProgressHash,
  computeConfirmBarterCompletionHash,
  computeAdminSetBarterHoldHash,
  computeAdminCancelBarterAgreementHash,
} from '../idempotency'

const ANCHOR_ID = '11111111-1111-1111-8111-111111111111'

const offerFields = {
  partyAListingIds: ['22222222-2222-2222-8222-222222222222'],
  partyBListingIds: ['33333333-3333-3333-8333-333333333333'],
  cashAdjustmentAmount: 500,
  deliveryMethod: 'meet_in_person',
  depositAmount: null,
  depositPayer: null,
  message: 'hello',
}

describe('computeProposeBarterHash', () => {
  it('matches its own documented formula for a listing anchor (Skills + Tasks widening)', () => {
    // Since the Skills + Tasks widening, this is a best-effort
    // route-level replay hash only -- it deliberately no longer mirrors
    // propose_barter()'s own jsonb::text formula byte-for-byte (see the
    // comment on OfferFieldsForHash in idempotency.ts). The RPC's own
    // hash remains the sole authoritative dedup guarantee.
    const hash = computeProposeBarterHash({ listingId: ANCHOR_ID }, offerFields)
    expect(hash).toBe('c4a02e4b0a1756258262eddb3fdec14a')
  })

  it('produces the same hash for identical repeated inputs', () => {
    const a = computeProposeBarterHash({ listingId: 'anchor-1' }, offerFields)
    const b = computeProposeBarterHash({ listingId: 'anchor-1' }, offerFields)
    expect(a).toBe(b)
  })

  it('produces a different hash when the offered items differ', () => {
    const a = computeProposeBarterHash({ listingId: 'anchor-1' }, offerFields)
    const b = computeProposeBarterHash({ listingId: 'anchor-1' }, { ...offerFields, partyBListingIds: ['44444444-4444-4444-8444-444444444444'] })
    expect(a).not.toBe(b)
  })

  it('produces a different hash for a skill/task anchor than an equivalent listing anchor', () => {
    const a = computeProposeBarterHash({ listingId: 'anchor-1' }, offerFields)
    const b = computeProposeBarterHash({ skillTaskPostId: 'anchor-1' }, offerFields)
    expect(a).not.toBe(b)
  })
})

describe('computeCounterBarterOfferHash', () => {
  it('matches its own documented formula for the same inputs', () => {
    // Same formula as propose's offerFieldsSuffix, with agreement_id as
    // the leading field -- this function's own signature (agreementId:
    // string) is unchanged by the Skills + Tasks widening.
    const hash = computeCounterBarterOfferHash(ANCHOR_ID, offerFields)
    expect(hash).toBe('50ff12fde862afebb06f2dc7106497da')
  })
})

describe('computeAcceptBarterOfferHash', () => {
  it('matches the exact md5 Postgres produces for agreement id + provider (Step 11 Phase 4)', () => {
    // select md5(coalesce(agreement_id::text, '') || '|' || coalesce(provider, ''))
    const hash = computeAcceptBarterOfferHash(ANCHOR_ID, 'mock')
    expect(hash).toBe('f36b378143f6cbd630bfff6efa8629ff')
  })
})

describe('computeRejectBarterOfferHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    const hash = computeRejectBarterOfferHash(ANCHOR_ID, 'not interested')
    expect(hash).toBe('6223c6b4608588b8448365049fbbd68e')
  })

  it('treats null and undefined the same as an empty string', () => {
    const a = computeRejectBarterOfferHash('agreement-1', null)
    const b = computeRejectBarterOfferHash('agreement-1', undefined)
    const c = computeRejectBarterOfferHash('agreement-1', '')
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})

describe('computeCancelBarterAgreementHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    const hash = computeCancelBarterAgreementHash(ANCHOR_ID, 'changed my mind')
    expect(hash).toBe('f8303f2af567bb72ddb43308ca09aedf')
  })
})

// ── Step 11 Phase 4 additions ──

describe('computeMarkBarterProgressHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    const hash = computeMarkBarterProgressHash(ANCHOR_ID, 'preparing')
    expect(hash).toBe('fc8e78974ea2e8059caabe516377598a')
  })
})

describe('computeConfirmBarterCompletionHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    const hash = computeConfirmBarterCompletionHash(ANCHOR_ID, 'looks good')
    expect(hash).toBe('840c126e39ad3c242b11a999fea500b3')
  })

  it('treats null and undefined the same as an empty string', () => {
    const a = computeConfirmBarterCompletionHash('agreement-1', null)
    const b = computeConfirmBarterCompletionHash('agreement-1', undefined)
    expect(a).toBe(b)
  })
})

describe('computeAdminSetBarterHoldHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    const hash = computeAdminSetBarterHoldHash(ANCHOR_ID, true, 'suspicious activity')
    expect(hash).toBe('b1982d0f881ac56b7fbbab22a81b5fba')
  })

  it('produces a different hash for hold=true vs hold=false', () => {
    const a = computeAdminSetBarterHoldHash('agreement-1', true, 'reason')
    const b = computeAdminSetBarterHoldHash('agreement-1', false, 'reason')
    expect(a).not.toBe(b)
  })
})

describe('computeAdminCancelBarterAgreementHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    const hash = computeAdminCancelBarterAgreementHash(ANCHOR_ID, 'policy violation')
    expect(hash).toBe('7c38e0f3a75d8d9c750e2798f7e8ecb6')
  })
})
