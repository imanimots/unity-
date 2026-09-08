import { describe, it, expect } from 'vitest'
import { validateRentToBuyEvidenceFile, MAX_RTB_EVIDENCE_SIZE_BYTES, ALLOWED_RTB_EVIDENCE_MIME_TYPES } from '../evidence-upload'
import enZA from '@/i18n/messages/en-ZA/rtb.json'
import afZA from '@/i18n/messages/af-ZA/rtb.json'
import zuZA from '@/i18n/messages/zu-ZA/rtb.json'

function makeFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type })
}

describe('validateRentToBuyEvidenceFile', () => {
  describe('allowed MIME types', () => {
    it('accepts image/jpeg', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('photo.jpg', 'image/jpeg', 1024))).toBeNull()
    })
    it('accepts image/png', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('photo.png', 'image/png', 1024))).toBeNull()
    })
    it('accepts image/webp', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('photo.webp', 'image/webp', 1024))).toBeNull()
    })
    it('accepts video/mp4', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('clip.mp4', 'video/mp4', 1024))).toBeNull()
    })
    it('accepts application/pdf', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('doc.pdf', 'application/pdf', 1024))).toBeNull()
    })
  })

  describe('prohibited MIME types', () => {
    it('rejects image/svg+xml', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('image.svg', 'image/svg+xml', 1024))).toBe('unsupported_type')
    })
    it('rejects text/html', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('page.html', 'text/html', 1024))).toBe('unsupported_type')
    })
    it('rejects application/javascript', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('script.js', 'application/javascript', 1024))).toBe('unsupported_type')
    })
    it('rejects application/octet-stream (not explicitly allow-listed by the bucket)', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('file.bin', 'application/octet-stream', 1024))).toBe('unsupported_type')
    })
    it('does not use the filename extension to override an invalid MIME type', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('fake.jpg', 'text/html', 1024))).toBe('unsupported_type')
    })
  })

  describe('size boundary (matches the bucket file_size_limit of 20 * 1024 * 1024 bytes exactly)', () => {
    it('accepts a file one byte under the limit', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('under.jpg', 'image/jpeg', MAX_RTB_EVIDENCE_SIZE_BYTES - 1))).toBeNull()
    })
    it('accepts a file exactly at the limit', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('exact.jpg', 'image/jpeg', MAX_RTB_EVIDENCE_SIZE_BYTES))).toBeNull()
    })
    it('rejects a file one byte over the limit', () => {
      expect(validateRentToBuyEvidenceFile(makeFile('over.jpg', 'image/jpeg', MAX_RTB_EVIDENCE_SIZE_BYTES + 1))).toBe('too_large')
    })
  })

  it('exposes the exact allowed MIME set the bucket enforces server-side', () => {
    expect(ALLOWED_RTB_EVIDENCE_MIME_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf'])
  })

  it('exposes the exact byte boundary (20MB, 1024-based)', () => {
    expect(MAX_RTB_EVIDENCE_SIZE_BYTES).toBe(20 * 1024 * 1024)
  })
})

describe('rtb.errors -- safe user-facing message content, all locales', () => {
  for (const [locale, messages] of [['en-ZA', enZA], ['af-ZA', afZA], ['zu-ZA', zuZA]] as const) {
    it(`${locale}: couldNotUpload/unsupportedType/tooLarge/generic all exist and are non-empty strings`, () => {
      expect(typeof messages.errors.couldNotUpload).toBe('string')
      expect(messages.errors.couldNotUpload.length).toBeGreaterThan(0)
      expect(typeof messages.errors.unsupportedType).toBe('string')
      expect(typeof messages.errors.tooLarge).toBe('string')
      expect(typeof messages.errors.generic).toBe('string')
    })

    it(`${locale}: couldNotUpload never contains raw provider/technical vocabulary`, () => {
      const lower = messages.errors.couldNotUpload.toLowerCase()
      for (const forbidden of ['supabase', 'storage', 'bucket', 'rls', 'policy', 'rent-to-buy-evidence', 'row-level security']) {
        expect(lower).not.toContain(forbidden)
      }
    })

    it(`${locale}: the Storage-failure message stays distinct from the client-validation messages (never collapsed together)`, () => {
      const { couldNotUpload, unsupportedType, tooLarge } = messages.errors
      expect(couldNotUpload).not.toBe(unsupportedType)
      expect(couldNotUpload).not.toBe(tooLarge)
      expect(unsupportedType).not.toBe(tooLarge)
    })
  }

  it('en-ZA: couldNotUpload matches the established cross-domain wording (dispute/barter evidence panels)', () => {
    expect(enZA.errors.couldNotUpload).toBe('Could not upload this file — please try again')
  })
})
