import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Proves the KYC Orphan Cleanup Phase B1 client conversion cannot
 * silently regress back to a direct client insert: the product flow
 * must register an uploaded document via POST /api/verification/documents,
 * never via a direct `.from('identity_verification_documents').insert(...)`
 * call from the browser. Source-text invariant, matching the established
 * convention (see
 * src/components/rent-to-buy/__tests__/evidence-upload-error-safety.test.ts)
 * for this repo's "no React/jsdom harness" limitation.
 *
 * The database owner-insert RLS policy itself is deliberately left
 * unchanged (B2 is a separate, later, optional decision) -- this test
 * only proves the *product client* no longer exercises it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const componentSource = readFileSync(join(__dirname, '../kyc-flow.tsx'), 'utf8')

describe('KycFlow -- server-side document registration (category: KYC Orphan Cleanup Phase B1)', () => {
  it('no longer directly inserts into identity_verification_documents', () => {
    expect(componentSource).not.toMatch(/\.from\(\s*['"]identity_verification_documents['"]\s*\)\s*\.insert/)
  })

  it('registers the uploaded document via POST /api/verification/documents', () => {
    expect(componentSource).toMatch(/fetch\(\s*['"]\/api\/verification\/documents['"]/)
  })

  it('still uploads directly to Storage from the browser (upload path unchanged by B1)', () => {
    expect(componentSource).toMatch(/supabase\.storage\.from\(\s*['"]kyc-documents['"]\s*\)\.upload/)
  })

  it('registration call still sends exactly the persisted client metadata fields', () => {
    expect(componentSource).toMatch(/document_type:\s*documentType/)
    expect(componentSource).toMatch(/storage_path:\s*path/)
    expect(componentSource).toMatch(/mime_type:\s*file\.type/)
    expect(componentSource).toMatch(/file_size:\s*file\.size/)
  })
})
