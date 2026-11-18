import { describe, it, expect } from 'vitest'
import { parseKycDocumentPath, getIdentityDocumentSignedUrl } from '../document-access'
import type { SupabaseClient } from '@supabase/supabase-js'

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

describe('getIdentityDocumentSignedUrl (category: Platform Improvement Programme Phase 1 item 5)', () => {
  const ADMIN_ID = '11111111-1111-1111-1111-111111111111'
  const DOCUMENT_ID = '44444444-4444-4444-4444-444444444444'

  function fakeAdmin(opts: { docRow?: unknown; signError?: boolean } = {}) {
    const insertCalls: unknown[] = []
    // 'docRow' in opts, not `opts.docRow ?? default` -- a test passing
    // `docRow: null` to simulate "not found" must not be silently
    // overridden by the default, which `??` would do (null ?? x === x).
    const resolvedDocRow = 'docRow' in opts ? opts.docRow : { id: DOCUMENT_ID, storage_path: `${USER_ID}/identity_document/x.jpg` }
    const client = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: resolvedDocRow, error: null }) }),
          }),
        }),
        insert: (payload: unknown) => {
          insertCalls.push({ table, payload })
          return Promise.resolve({ data: null, error: null })
        },
      }),
      storage: {
        from: () => ({
          createSignedUrl: () =>
            opts.signError
              ? Promise.resolve({ data: null, error: { message: 'sign failed' } })
              : Promise.resolve({ data: { signedUrl: 'https://signed.example/doc' }, error: null }),
        }),
      },
    }
    return { client: client as unknown as SupabaseClient, insertCalls }
  }

  it('1. writes one row to admin_kyc_document_access_log with the admin/user/document ids before returning the signed URL', async () => {
    const { client, insertCalls } = fakeAdmin()
    const result = await getIdentityDocumentSignedUrl(client, ADMIN_ID, USER_ID, DOCUMENT_ID)
    expect(result.url).toBe('https://signed.example/doc')
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]).toEqual({
      table: 'admin_kyc_document_access_log',
      payload: { admin_id: ADMIN_ID, user_id: USER_ID, document_id: DOCUMENT_ID },
    })
  })

  it('2. does not log an access when the document is not found', async () => {
    const { client, insertCalls } = fakeAdmin({ docRow: null })
    await expect(getIdentityDocumentSignedUrl(client, ADMIN_ID, USER_ID, DOCUMENT_ID)).rejects.toThrow('document_not_found')
    expect(insertCalls).toHaveLength(0)
  })

  it('3. does not log an access when signing the URL fails', async () => {
    const { client, insertCalls } = fakeAdmin({ signError: true })
    await expect(getIdentityDocumentSignedUrl(client, ADMIN_ID, USER_ID, DOCUMENT_ID)).rejects.toThrow('could_not_sign_url')
    expect(insertCalls).toHaveLength(0)
  })
})
