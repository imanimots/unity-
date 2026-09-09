import { describe, it, expect } from 'vitest'
import { parseKycDocumentPath } from '../document-access'

/**
 * Pure unit tests for the exact-grammar KYC path validator (Orphan
 * Cleanup Phase B1) -- {authenticatedUserId}/{documentType}/{uuid}.{ext}.
 * No mocks needed -- parseKycDocumentPath has zero I/O.
 */

const USER_ID = '22222222-2222-2222-2222-222222222222'
const OTHER_USER_ID = '99999999-9999-9999-9999-999999999999'
const LEAF_UUID = '33333333-3333-3333-3333-333333333333'

describe('parseKycDocumentPath', () => {
  it('accepts a valid identity_document JPEG path', () => {
    const result = parseKycDocumentPath(`${USER_ID}/identity_document/${LEAF_UUID}.jpg`, USER_ID, 'identity_document')
    expect(result.ok).toBe(true)
    expect(result.extension).toBe('jpg')
  })

  it('accepts a valid proof_of_address PDF path', () => {
    const result = parseKycDocumentPath(`${USER_ID}/proof_of_address/${LEAF_UUID}.pdf`, USER_ID, 'proof_of_address')
    expect(result.ok).toBe(true)
    expect(result.extension).toBe('pdf')
  })

  it('rejects a path belonging to a different user', () => {
    const result = parseKycDocumentPath(`${OTHER_USER_ID}/identity_document/${LEAF_UUID}.jpg`, USER_ID, 'identity_document')
    expect(result.ok).toBe(false)
  })

  it('rejects a document-type segment mismatch against the claimed document_type', () => {
    const result = parseKycDocumentPath(`${USER_ID}/proof_of_address/${LEAF_UUID}.jpg`, USER_ID, 'identity_document')
    expect(result.ok).toBe(false)
  })

  it('rejects a leading slash', () => {
    const result = parseKycDocumentPath(`/${USER_ID}/identity_document/${LEAF_UUID}.jpg`, USER_ID, 'identity_document')
    expect(result.ok).toBe(false)
  })

  it('rejects a trailing slash', () => {
    const result = parseKycDocumentPath(`${USER_ID}/identity_document/${LEAF_UUID}.jpg/`, USER_ID, 'identity_document')
    expect(result.ok).toBe(false)
  })

  it('rejects an empty segment (double slash)', () => {
    const result = parseKycDocumentPath(`${USER_ID}//${LEAF_UUID}.jpg`, USER_ID, 'identity_document')
    expect(result.ok).toBe(false)
  })

  it('rejects an extra nested segment', () => {
    const result = parseKycDocumentPath(`${USER_ID}/identity_document/extra/${LEAF_UUID}.jpg`, USER_ID, 'identity_document')
    expect(result.ok).toBe(false)
  })

  it('rejects a `.` traversal-style segment', () => {
    const result = parseKycDocumentPath(`${USER_ID}/./${LEAF_UUID}.jpg`, USER_ID, 'identity_document')
    expect(result.ok).toBe(false)
  })

  it('rejects a `..` traversal segment', () => {
    const result = parseKycDocumentPath(`${USER_ID}/../identity_document/${LEAF_UUID}.jpg`, USER_ID, 'identity_document')
    expect(result.ok).toBe(false)
  })

  it('rejects a malformed (non-UUID-shaped) filename', () => {
    const result = parseKycDocumentPath(`${USER_ID}/identity_document/not-a-real-uuid.jpg`, USER_ID, 'identity_document')
    expect(result.ok).toBe(false)
  })

  it('rejects a disallowed extension', () => {
    const result = parseKycDocumentPath(`${USER_ID}/identity_document/${LEAF_UUID}.exe`, USER_ID, 'identity_document')
    expect(result.ok).toBe(false)
  })

  it('rejects a missing extension', () => {
    const result = parseKycDocumentPath(`${USER_ID}/identity_document/${LEAF_UUID}`, USER_ID, 'identity_document')
    expect(result.ok).toBe(false)
  })

  it('is a path-grammar check only -- MIME/extension consistency is the caller\'s separate responsibility', () => {
    // parseKycDocumentPath has no mime_type parameter at all; the route
    // itself cross-checks MIME_TO_EXTENSION[mime_type] against the
    // returned extension as its own explicit second step.
    const result = parseKycDocumentPath(`${USER_ID}/identity_document/${LEAF_UUID}.png`, USER_ID, 'identity_document')
    expect(result.ok).toBe(true)
    expect(result.extension).toBe('png')
  })
})
