import { describe, it, expect } from 'vitest'
import { validateAttachmentFile, isUnderAttachmentLimit, fileTypeFor, MAX_ATTACHMENT_SIZE_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from '../attachments'

function makeFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type })
}

describe('validateAttachmentFile', () => {
  it('accepts an allowed image under the size limit', () => {
    expect(validateAttachmentFile(makeFile('photo.jpg', 'image/jpeg', 1024))).toBeNull()
  })

  it('accepts a PDF under the size limit', () => {
    expect(validateAttachmentFile(makeFile('doc.pdf', 'application/pdf', 1024))).toBeNull()
  })

  it('rejects a disallowed MIME type', () => {
    expect(validateAttachmentFile(makeFile('clip.mp4', 'video/mp4', 1024))).not.toBeNull()
  })

  it('rejects a file over the size limit', () => {
    expect(validateAttachmentFile(makeFile('big.jpg', 'image/jpeg', MAX_ATTACHMENT_SIZE_BYTES + 1))).not.toBeNull()
  })

  it('accepts a file exactly at the size limit', () => {
    expect(validateAttachmentFile(makeFile('exact.jpg', 'image/jpeg', MAX_ATTACHMENT_SIZE_BYTES))).toBeNull()
  })
})

describe('isUnderAttachmentLimit', () => {
  it('allows sending while under the per-message cap', () => {
    expect(isUnderAttachmentLimit(0)).toBe(true)
    expect(isUnderAttachmentLimit(MAX_ATTACHMENTS_PER_MESSAGE - 1)).toBe(true)
  })

  it('blocks sending at or above the per-message cap', () => {
    expect(isUnderAttachmentLimit(MAX_ATTACHMENTS_PER_MESSAGE)).toBe(false)
    expect(isUnderAttachmentLimit(MAX_ATTACHMENTS_PER_MESSAGE + 1)).toBe(false)
  })
})

describe('fileTypeFor', () => {
  it('classifies images, pdfs, and everything else', () => {
    expect(fileTypeFor('image/png')).toBe('image')
    expect(fileTypeFor('application/pdf')).toBe('pdf')
    expect(fileTypeFor('application/msword')).toBe('document')
  })
})
