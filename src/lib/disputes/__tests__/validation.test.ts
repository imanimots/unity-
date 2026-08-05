import { describe, it, expect } from 'vitest'
import {
  openDisputeSchema,
  disputeEvidenceRegisterSchema,
  disputeMessageSchema,
  assignDisputeSchema,
  requestDisputeEvidenceSchema,
  resolveDisputeSchema,
  cancelDisputeSchema,
  disputeActionSchema,
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
