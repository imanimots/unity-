import { describe, it, expect } from 'vitest'
import { computeSendMessageHash, computeRegisterAttachmentHash } from '../idempotency'

describe('computeSendMessageHash', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeSendMessageHash('booking', 'b-1', null, 'Hi there')
    const b = computeSendMessageHash('booking', 'b-1', null, 'Hi there')
    expect(a).toBe(b)
  })

  it('differs when content differs', () => {
    const a = computeSendMessageHash('booking', 'b-1', null, 'Hi there')
    const b = computeSendMessageHash('booking', 'b-1', null, 'Hi there!')
    expect(a).not.toBe(b)
  })

  it('differs when the thread differs', () => {
    const a = computeSendMessageHash('booking', 'b-1', null, 'Hi there')
    const b = computeSendMessageHash('booking', 'b-2', null, 'Hi there')
    expect(a).not.toBe(b)
  })

  it('treats an undefined dispute id the same as null', () => {
    const a = computeSendMessageHash('booking', 'b-1', null, 'Hi there')
    const b = computeSendMessageHash('booking', 'b-1', undefined, 'Hi there')
    expect(a).toBe(b)
  })
})

describe('computeRegisterAttachmentHash', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeRegisterAttachmentHash('m-1', 'booking/x/y/z.jpg', 'image')
    const b = computeRegisterAttachmentHash('m-1', 'booking/x/y/z.jpg', 'image')
    expect(a).toBe(b)
  })

  it('differs when the storage path differs', () => {
    const a = computeRegisterAttachmentHash('m-1', 'booking/x/y/z.jpg', 'image')
    const b = computeRegisterAttachmentHash('m-1', 'booking/x/y/w.jpg', 'image')
    expect(a).not.toBe(b)
  })
})
