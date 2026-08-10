import { describe, it, expect } from 'vitest'
import {
  computeOpenDisputeHash,
  computeAssignDisputeHash,
  computeDisputeIdOnlyHash,
  computeRequestDisputeEvidenceHash,
  computeResolveDisputeHash,
  computeCancelDisputeHash,
  computeRegisterDisputeEvidenceHash,
} from '../idempotency'

const DISPUTE_ID = '11111111-1111-1111-8111-111111111111'
const BOOKING_ID = '22222222-2222-2222-8222-222222222222'
const ADMIN_ID = '33333333-3333-3333-8333-333333333333'

describe('computeOpenDisputeHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    // select md5(booking_id::text || '|' || order_id::text || '|' || barter_agreement_id::text || '|' || rent_to_buy_agreement_id::text || '|' || title || '|' || reason || '|' || description || '|' || requested_resolution)
    // Phase 5 widened this formula with a rent_to_buy_agreement_id segment
    // (see supabase/migrations/20260827000004_rtb_widening.sql's
    // open_dispute() replacement) -- expected value recomputed to match.
    expect(computeOpenDisputeHash(BOOKING_ID, null, null, 'Item damaged', 'damaged', 'It arrived broken.', 'A refund.')).toBe(
      '736307fb95f321c7da44359024440485'
    )
  })

  it('produces a different hash when only the transaction reference changes', () => {
    const a = computeOpenDisputeHash(BOOKING_ID, null, null, 'Item damaged', 'damaged', 'It arrived broken.', 'A refund.')
    const b = computeOpenDisputeHash(null, BOOKING_ID, null, 'Item damaged', 'damaged', 'It arrived broken.', 'A refund.')
    expect(a).not.toBe(b)
  })
})

describe('computeAssignDisputeHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    expect(computeAssignDisputeHash(DISPUTE_ID, ADMIN_ID)).toBe('dd21bfabdac65732eaa60644b1cc3f7a')
  })
})

describe('computeDisputeIdOnlyHash', () => {
  it('matches the exact md5 Postgres produces for a bare dispute id', () => {
    expect(computeDisputeIdOnlyHash(DISPUTE_ID)).toBe('5055ce00d3b3d9eb0c951f54d20d928f')
  })
})

describe('computeRequestDisputeEvidenceHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    expect(computeRequestDisputeEvidenceHash(DISPUTE_ID, 'please add photos')).toBe('bfd1c8dcd44d2cbe82927483372853b6')
  })

  it('treats null and undefined the same as an empty string', () => {
    const a = computeRequestDisputeEvidenceHash(DISPUTE_ID, null)
    const b = computeRequestDisputeEvidenceHash(DISPUTE_ID, undefined)
    expect(a).toBe(b)
  })
})

describe('computeResolveDisputeHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    expect(computeResolveDisputeHash(DISPUTE_ID, 'favor_raiser', 'refund issued')).toBe('981b33ba96392f29bc5a3939f9a07fdf')
  })
})

describe('computeCancelDisputeHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    expect(computeCancelDisputeHash(DISPUTE_ID, 'changed my mind')).toBe('f8303f2af567bb72ddb43308ca09aedf')
  })
})

describe('computeRegisterDisputeEvidenceHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    expect(computeRegisterDisputeEvidenceHash(DISPUTE_ID, `${DISPUTE_ID}/user/file.jpg`, 'image')).toBe('897c49ec0fa1be84faf45e52d03f1df5')
  })
})
