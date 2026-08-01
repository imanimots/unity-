import { describe, it, expect } from 'vitest'
import { validatePhotoFile, validateOwnershipProofFile } from '../storage'
import { MAX_PHOTO_SIZE_BYTES, MAX_OWNERSHIP_PROOF_SIZE_BYTES } from '../validation'

function makeFile(name: string, type: string, size: number): File {
  const blob = new Blob([new Uint8Array(Math.min(size, 1024))], { type })
  const file = new File([blob], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('validatePhotoFile', () => {
  it('accepts a valid JPEG under the size limit', () => {
    expect(validatePhotoFile(makeFile('a.jpg', 'image/jpeg', 1024))).toBeNull()
  })

  it('rejects an unsupported MIME type', () => {
    expect(validatePhotoFile(makeFile('a.gif', 'image/gif', 1024))).toMatch(/unsupported/i)
  })

  it('rejects a file over the size limit', () => {
    expect(validatePhotoFile(makeFile('a.jpg', 'image/jpeg', MAX_PHOTO_SIZE_BYTES + 1))).toMatch(/too large/i)
  })

  it('rejects an executable disguised with an image extension but wrong MIME type', () => {
    expect(validatePhotoFile(makeFile('a.jpg', 'application/x-msdownload', 1024))).toMatch(/unsupported/i)
  })
})

describe('validateOwnershipProofFile', () => {
  it('accepts a valid PDF under the size limit', () => {
    expect(validateOwnershipProofFile(makeFile('proof.pdf', 'application/pdf', 1024))).toBeNull()
  })

  it('accepts video/mp4 (matches the wizard copy + widened bucket config)', () => {
    expect(validateOwnershipProofFile(makeFile('proof.mp4', 'video/mp4', 1024))).toBeNull()
  })

  it('rejects a file over the size limit', () => {
    expect(validateOwnershipProofFile(makeFile('proof.pdf', 'application/pdf', MAX_OWNERSHIP_PROOF_SIZE_BYTES + 1))).toMatch(/too large/i)
  })

  it('rejects an unsupported type', () => {
    expect(validateOwnershipProofFile(makeFile('proof.exe', 'application/x-msdownload', 1024))).toMatch(/unsupported/i)
  })
})
