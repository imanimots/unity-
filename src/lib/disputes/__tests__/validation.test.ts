import { describe, it, expect } from 'vitest'
import {
  openDisputeSchema,
  disputeEvidenceRegisterSchema,
  disputeMessageSchema,
  assignDisputeSchema,
  requestDisputeEvidenceSchema,
  resolveDisputeSchema,
  completeDisputeFinancialDispositionSchema,
  cancelDisputeSchema,
  disputeActionSchema,
  validateBookingFinancialDisposition,
} from '../validation'

const VALID_ID = '11111111-1111-1111-8111-111111111111'

describe('openDisputeSchema', () => {
  const base = { title: 'Item damaged', description: 'It arrived broken.', requested_resolution: 'A refund.' }

  it('accepts a valid request with exactly one transaction reference', () => {
    expect(openDisputeSchema.safeParse({ ...base, booking_id: VALID_ID }).success).toBe(true)
    expect(openDisputeSchema.safeParse({ ...base, order_id: VALID_ID }).success).toBe(true)
    expect(openDisputeSchema.safeParse({ ...base, barter_agreement_id: VALID_ID }).success).toBe(true)
  })

  it('rejects zero transaction references', () => {
    expect(openDisputeSchema.safeParse({ ...base }).success).toBe(false)
  })

  it('rejects two or more transaction references', () => {
    expect(openDisputeSchema.safeParse({ ...base, booking_id: VALID_ID, order_id: VALID_ID }).success).toBe(false)
  })

  it('rejects a missing title/description/requested_resolution', () => {
    expect(openDisputeSchema.safeParse({ booking_id: VALID_ID, description: 'x', requested_resolution: 'y' }).success).toBe(false)
    expect(openDisputeSchema.safeParse({ booking_id: VALID_ID, title: 'x', requested_resolution: 'y' }).success).toBe(false)
    expect(openDisputeSchema.safeParse({ booking_id: VALID_ID, title: 'x', description: 'y' }).success).toBe(false)
  })
})

describe('disputeEvidenceRegisterSchema', () => {
  it('accepts a valid registration', () => {
    expect(disputeEvidenceRegisterSchema.safeParse({ storage_path: `${VALID_ID}/user/file.jpg`, file_type: 'image' }).success).toBe(true)
  })

  it('rejects an invalid file_type', () => {
    expect(disputeEvidenceRegisterSchema.safeParse({ storage_path: 'a/b/c.exe', file_type: 'executable' }).success).toBe(false)
  })
})

describe('disputeMessageSchema', () => {
  it('accepts a valid message', () => {
    expect(disputeMessageSchema.safeParse({ content: 'hello' }).success).toBe(true)
  })

  it('rejects an empty message', () => {
    expect(disputeMessageSchema.safeParse({ content: '' }).success).toBe(false)
    expect(disputeMessageSchema.safeParse({ content: '   ' }).success).toBe(false)
  })
})

describe('assignDisputeSchema', () => {
  it('requires a valid assignee uuid', () => {
    expect(assignDisputeSchema.safeParse({ assignee_admin_id: VALID_ID }).success).toBe(true)
    expect(assignDisputeSchema.safeParse({ assignee_admin_id: 'not-a-uuid' }).success).toBe(false)
  })
})

describe('requestDisputeEvidenceSchema / disputeActionSchema accept an empty body', () => {
  it('note is optional', () => {
    expect(requestDisputeEvidenceSchema.safeParse({}).success).toBe(true)
  })
  it('disputeActionSchema accepts an empty body', () => {
    expect(disputeActionSchema.safeParse({}).success).toBe(true)
  })
})

describe('resolveDisputeSchema', () => {
  it('accepts every valid outcome value', () => {
    for (const outcome of ['favor_raiser', 'favor_respondent', 'mutual_agreement', 'manual_settlement']) {
      expect(resolveDisputeSchema.safeParse({ outcome }).success).toBe(true)
    }
  })

  it('rejects an invalid outcome', () => {
    expect(resolveDisputeSchema.safeParse({ outcome: 'coin_flip' }).success).toBe(false)
  })
})

describe('cancelDisputeSchema', () => {
  it('accepts an empty body', () => {
    expect(cancelDisputeSchema.safeParse({}).success).toBe(true)
  })
})

describe('resolveDisputeSchema -- E28 financial disposition fields', () => {
  it('accepts a request with no disposition fields (order/barter/RTB resolution path, unaffected)', () => {
    expect(resolveDisputeSchema.safeParse({ outcome: 'favor_respondent' }).success).toBe(true)
  })

  it('accepts every disposition type with a positive amount and a reason', () => {
    for (const financial_disposition_type of ['refund_required', 'manual_financial_settlement']) {
      const result = resolveDisputeSchema.safeParse({
        outcome: 'favor_raiser',
        financial_disposition_type,
        financial_disposition_amount: 500,
        financial_disposition_reason: 'Partial refund agreed with both parties.',
      })
      expect(result.success).toBe(true)
    }
  })

  it('accepts no_financial_adjustment with a reason and no amount', () => {
    expect(
      resolveDisputeSchema.safeParse({
        outcome: 'favor_respondent',
        financial_disposition_type: 'no_financial_adjustment',
        financial_disposition_reason: 'Merchant fulfilled all obligations; no adjustment warranted.',
      }).success
    ).toBe(true)
  })

  it('rejects a non-positive disposition amount and an invalid disposition type', () => {
    expect(
      resolveDisputeSchema.safeParse({
        outcome: 'favor_raiser',
        financial_disposition_type: 'refund_required',
        financial_disposition_amount: 0,
        financial_disposition_reason: 'x',
      }).success
    ).toBe(false)
    expect(
      resolveDisputeSchema.safeParse({
        outcome: 'favor_raiser',
        financial_disposition_type: 'customer_always_wins',
        financial_disposition_reason: 'x',
      }).success
    ).toBe(false)
  })
})

describe('completeDisputeFinancialDispositionSchema', () => {
  it('accepts an empty body', () => {
    expect(completeDisputeFinancialDispositionSchema.safeParse({}).success).toBe(true)
  })

  it('accepts optional completion notes', () => {
    expect(completeDisputeFinancialDispositionSchema.safeParse({ completion_notes: 'Confirmed via PayFast dashboard.' }).success).toBe(true)
  })
})

/**
 * E28: pure, DB-free tests for validateBookingFinancialDisposition --
 * covers the brief's own required matrix: a financially ambiguous
 * booking outcome can never silently resolve without an explicit
 * disposition, for every outcome including favor_respondent (a party
 * may win without a monetary remedy being appropriate, but the
 * decision itself must still be explicit). Order/barter/RTB
 * disputes (isBookingDispute=false) are never subject to this rule
 * regardless of what fields happen to be present.
 */
describe('validateBookingFinancialDisposition', () => {
  it('never requires a disposition for a non-booking dispute, even with every field missing', () => {
    expect(validateBookingFinancialDisposition(false, {})).toBeNull()
  })

  it('requires a disposition_type for a booking dispute', () => {
    expect(validateBookingFinancialDisposition(true, { financial_disposition_reason: 'x' })).toMatch(/financial disposition is required/i)
  })

  it('requires a reason for a booking dispute, even for no_financial_adjustment', () => {
    expect(validateBookingFinancialDisposition(true, { financial_disposition_type: 'no_financial_adjustment' })).toMatch(/reason is required/i)
  })

  it('rejects an amount on no_financial_adjustment', () => {
    expect(
      validateBookingFinancialDisposition(true, {
        financial_disposition_type: 'no_financial_adjustment',
        financial_disposition_reason: 'Merchant fulfilled obligations.',
        financial_disposition_amount: 100,
      })
    ).toMatch(/must not include an amount/i)
  })

  it('accepts a valid no_financial_adjustment disposition -- favor_respondent does not mandate a refund', () => {
    expect(
      validateBookingFinancialDisposition(true, {
        financial_disposition_type: 'no_financial_adjustment',
        financial_disposition_reason: 'Merchant fulfilled all obligations; no adjustment warranted.',
      })
    ).toBeNull()
  })

  it('requires an amount for refund_required', () => {
    expect(
      validateBookingFinancialDisposition(true, {
        financial_disposition_type: 'refund_required',
        financial_disposition_reason: 'Renter was overcharged.',
      })
    ).toMatch(/amount is required/i)
  })

  it('requires an amount for manual_financial_settlement', () => {
    expect(
      validateBookingFinancialDisposition(true, {
        financial_disposition_type: 'manual_financial_settlement',
        financial_disposition_reason: 'Mutually agreed partial settlement.',
      })
    ).toMatch(/amount is required/i)
  })

  it('accepts a valid refund_required disposition', () => {
    expect(
      validateBookingFinancialDisposition(true, {
        financial_disposition_type: 'refund_required',
        financial_disposition_amount: 250,
        financial_disposition_reason: 'Renter was overcharged.',
      })
    ).toBeNull()
  })

  it('accepts a valid manual_financial_settlement disposition -- mutual_agreement/manual_settlement outcomes require an explicit admin-entered amount, never parsed from notes', () => {
    expect(
      validateBookingFinancialDisposition(true, {
        financial_disposition_type: 'manual_financial_settlement',
        financial_disposition_amount: 400,
        financial_disposition_reason: 'Mutually agreed partial settlement outside the refund path.',
      })
    ).toBeNull()
  })
})
