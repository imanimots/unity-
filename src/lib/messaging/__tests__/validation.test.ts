import { describe, it, expect } from 'vitest'
import { sendMessageSchema, listMessagesQuerySchema, attachmentRegisterSchema } from '../validation'

const VALID_ID = '11111111-1111-1111-8111-111111111111'
const OTHER_ID = '22222222-2222-2222-8222-222222222222'

describe('sendMessageSchema', () => {
  it('accepts a valid request with exactly one thread reference', () => {
    expect(sendMessageSchema.safeParse({ booking_id: VALID_ID, content: 'Hi' }).success).toBe(true)
    expect(sendMessageSchema.safeParse({ order_id: VALID_ID, content: 'Hi' }).success).toBe(true)
    expect(sendMessageSchema.safeParse({ barter_agreement_id: VALID_ID, content: 'Hi' }).success).toBe(true)
    expect(sendMessageSchema.safeParse({ dispute_id: VALID_ID, content: 'Hi' }).success).toBe(true)
  })

  it('rejects zero thread references', () => {
    expect(sendMessageSchema.safeParse({ content: 'Hi' }).success).toBe(false)
  })

  it('rejects two or more thread references', () => {
    expect(sendMessageSchema.safeParse({ booking_id: VALID_ID, order_id: OTHER_ID, content: 'Hi' }).success).toBe(false)
    expect(sendMessageSchema.safeParse({ booking_id: VALID_ID, dispute_id: OTHER_ID, content: 'Hi' }).success).toBe(false)
  })

  it('rejects empty content', () => {
    expect(sendMessageSchema.safeParse({ booking_id: VALID_ID, content: '' }).success).toBe(false)
    expect(sendMessageSchema.safeParse({ booking_id: VALID_ID, content: '   ' }).success).toBe(false)
  })

  it('rejects content over 2000 characters', () => {
    expect(sendMessageSchema.safeParse({ booking_id: VALID_ID, content: 'a'.repeat(2001) }).success).toBe(false)
    expect(sendMessageSchema.safeParse({ booking_id: VALID_ID, content: 'a'.repeat(2000) }).success).toBe(true)
  })

  it('accepts an optional idempotency key', () => {
    expect(sendMessageSchema.safeParse({ booking_id: VALID_ID, content: 'Hi', idempotency_key: 'regression-key-abc-123' }).success).toBe(true)
  })
})

describe('listMessagesQuerySchema', () => {
  it('accepts exactly one thread reference with optional pagination', () => {
    expect(listMessagesQuerySchema.safeParse({ booking_id: VALID_ID }).success).toBe(true)
    expect(listMessagesQuerySchema.safeParse({ dispute_id: VALID_ID, limit: '20' }).success).toBe(true)
  })

  it('rejects zero or multiple thread references', () => {
    expect(listMessagesQuerySchema.safeParse({}).success).toBe(false)
    expect(listMessagesQuerySchema.safeParse({ booking_id: VALID_ID, order_id: OTHER_ID }).success).toBe(false)
  })

  it('rejects a limit over 100', () => {
    expect(listMessagesQuerySchema.safeParse({ booking_id: VALID_ID, limit: '101' }).success).toBe(false)
    expect(listMessagesQuerySchema.safeParse({ booking_id: VALID_ID, limit: '100' }).success).toBe(true)
  })
})

describe('attachmentRegisterSchema', () => {
  it('accepts a valid registration request', () => {
    expect(attachmentRegisterSchema.safeParse({ storage_path: 'booking/x/y/z.jpg', file_type: 'image' }).success).toBe(true)
  })

  it('rejects an invalid file_type', () => {
    expect(attachmentRegisterSchema.safeParse({ storage_path: 'booking/x/y/z.exe', file_type: 'executable' }).success).toBe(false)
  })

  it('rejects an empty storage_path', () => {
    expect(attachmentRegisterSchema.safeParse({ storage_path: '', file_type: 'image' }).success).toBe(false)
  })
})
