import { describe, it, expect } from 'vitest'
import { validateBookingEvidenceFile, sanitizeBookingEvidenceExtension, bookingEvidenceFileType, MAX_BOOKING_EVIDENCE_SIZE_BYTES } from '../condition-evidence-upload'

function fakeFile(type: string, size: number, name = 'photo.jpg'): File {
  return { type, size, name } as unknown as File
}

describe('validateBookingEvidenceFile (category: P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I)', () => {
  it('1. accepts an in-limit JPEG', () => {
    expect(validateBookingEvidenceFile(fakeFile('image/jpeg', 1024))).toBeNull()
  })
  it('2. accepts an in-limit MP4', () => {
    expect(validateBookingEvidenceFile(fakeFile('video/mp4', 1024))).toBeNull()
  })
  it('3. rejects an unsupported MIME type', () => {
    expect(validateBookingEvidenceFile(fakeFile('application/pdf', 1024))).toBe('unsupported_type')
  })
  it('4. rejects an oversized file', () => {
    expect(validateBookingEvidenceFile(fakeFile('image/jpeg', MAX_BOOKING_EVIDENCE_SIZE_BYTES + 1))).toBe('too_large')
  })
  it('5. accepts a file exactly at the size limit', () => {
    expect(validateBookingEvidenceFile(fakeFile('image/jpeg', MAX_BOOKING_EVIDENCE_SIZE_BYTES))).toBeNull()
  })
})

describe('sanitizeBookingEvidenceExtension', () => {
  it('6. lowercases and strips non-alphanumeric characters', () => {
    expect(sanitizeBookingEvidenceExtension('photo.JPG')).toBe('jpg')
  })
  it('7. a path-traversal/injection attempt never survives into the sanitized extension -- no slash or dot in the result', () => {
    const result = sanitizeBookingEvidenceExtension('../../etc/passwd')
    expect(result).not.toMatch(/[./]/)
    expect(result).toMatch(/^[a-z0-9]+$/)
  })
  it('7b. a filename with no dot at all falls back to the whole (sanitized) name, never throwing', () => {
    expect(sanitizeBookingEvidenceExtension('noextension')).toBe('noextension')
  })
})

describe('bookingEvidenceFileType', () => {
  it('8. classifies video/* as video', () => {
    expect(bookingEvidenceFileType('video/mp4')).toBe('video')
  })
  it('9. classifies everything else as image', () => {
    expect(bookingEvidenceFileType('image/heic')).toBe('image')
  })
})
