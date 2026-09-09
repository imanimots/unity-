import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Proves the KYC Orphan Cleanup client conversion cannot silently
 * regress: neither back to a direct client insert into
 * identity_verification_documents (Phase B1's own invariant), nor back
 * to a client-generated Storage path (Phase B3A's own invariant -- the
 * product flow must create a staged upload intent BEFORE uploading,
 * using the server-generated path it returns, and finalize by
 * intent_id only). Source-text invariant, matching the established
 * convention (see
 * src/components/rent-to-buy/__tests__/evidence-upload-error-safety.test.ts)
 * for this repo's "no React/jsdom harness" limitation.
 *
 * The database owner-insert RLS policy itself is deliberately left
 * unchanged (B2 is a separate, later, optional decision) -- this test
 * only proves the *product client* no longer exercises it, and now
 * also that it never builds its own KYC path client-side.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const componentSource = readFileSync(join(__dirname, '../kyc-flow.tsx'), 'utf8')

describe('KycFlow -- server-side document registration (category: KYC Orphan Cleanup Phase B1)', () => {
  it('no longer directly inserts into identity_verification_documents', () => {
    expect(componentSource).not.toMatch(/\.from\(\s*['"]identity_verification_documents['"]\s*\)\s*\.insert/)
  })

  it('still uploads directly to Storage from the browser (upload path unchanged by B1/B3A)', () => {
    expect(componentSource).toMatch(/supabase\.storage\.from\(\s*['"]kyc-documents['"]\s*\)\.upload/)
  })
})

describe('KycFlow -- staged upload intent adoption (category: KYC Orphan Cleanup Phase B3A)', () => {
  it('creates an upload intent before ever uploading to Storage', () => {
    const intentCallIndex = componentSource.indexOf("fetch('/api/verification/documents/intents'")
    const uploadCallIndex = componentSource.indexOf("supabase.storage.from('kyc-documents').upload")
    expect(intentCallIndex).toBeGreaterThan(-1)
    expect(uploadCallIndex).toBeGreaterThan(-1)
    expect(intentCallIndex).toBeLessThan(uploadCallIndex)
  })

  it('intent creation request sends the claimed document_type/mime_type/file_size, never a storage_path', () => {
    const bodyLineMatch = componentSource.match(/body:\s*JSON\.stringify\(\{\s*document_type:\s*documentType[^}]*\}\)/)
    expect(bodyLineMatch).not.toBeNull()
    const bodyLine = bodyLineMatch?.[0] ?? ''
    expect(bodyLine).toMatch(/mime_type:\s*file\.type/)
    expect(bodyLine).toMatch(/file_size:\s*file\.size/)
    expect(bodyLine).not.toMatch(/storage_path/)
  })

  it('uploads to the server-returned storage_path, never a client-generated one', () => {
    expect(componentSource).toMatch(/const\s*{\s*intent_id:\s*intentId,\s*storage_path:\s*path\s*}\s*=\s*await\s+intentRes\.json\(\)/)
    // No client-side path construction for the intent flow -- no
    // crypto.randomUUID()-based path template remains in this file.
    expect(componentSource).not.toMatch(/\$\{user\.id\}\/\$\{documentType\}\/\$\{crypto\.randomUUID\(\)\}/)
  })

  it('finalizes using intent_id only, never resupplying document_type/storage_path/mime_type/file_size', () => {
    const finalizeCallIndex = componentSource.lastIndexOf("fetch('/api/verification/documents'")
    const finalizeCallBlock = componentSource.slice(finalizeCallIndex, finalizeCallIndex + 300)
    expect(finalizeCallBlock).toMatch(/intent_id:\s*intentId/)
    expect(finalizeCallBlock).not.toMatch(/document_type|storage_path|mime_type|file_size/)
  })

  it('still submits/resubmits through the existing, unmodified later KYC workflow', () => {
    expect(componentSource).toMatch(/\/api\/verification\/submit/)
    expect(componentSource).toMatch(/\/api\/verification\/resubmit/)
  })
})
