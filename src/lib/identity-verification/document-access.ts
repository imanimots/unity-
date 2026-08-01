import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

/**
 * Mirrors src/lib/listings/evidence-access.ts (Step 3) exactly -- signed
 * URLs, never a permanent link, never stored. Documents live at
 * {user_id}/{document_type}/{uuid}.{ext} in the private 'kyc-documents'
 * bucket (20260804000001).
 */

const SIGNED_URL_TTL_SECONDS = 120

export interface DocumentSignedUrlResult {
  url: string
  expiresAt: string
}

/** Called only from an already-admin-gated route -- does not re-check admin status itself, same trust boundary as getOwnershipEvidenceSignedUrl. */
export async function getIdentityDocumentSignedUrl(admin: SupabaseClient, userId: string, documentId: string): Promise<DocumentSignedUrlResult> {
  const { data: docRow, error } = await admin
    .from('identity_verification_documents')
    .select('id, storage_path')
    .eq('id', documentId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error || !docRow) {
    throw new Error('document_not_found')
  }

  const { data: signed, error: signError } = await admin.storage.from('kyc-documents').createSignedUrl(docRow.storage_path, SIGNED_URL_TTL_SECONDS)

  if (signError || !signed) {
    throw new Error('could_not_sign_url')
  }

  return { url: signed.signedUrl, expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString() }
}

export interface DocumentSummary {
  id: string
  documentType: 'identity_document' | 'proof_of_address'
  uploadedAt: string
}

/**
 * "Current" documents only -- the latest row per document_type. The
 * table is append-only (a replacement is a new row, never an update --
 * see 20260804000001's header), so this dedup happens in application
 * code, the exact pattern Step 3 settled on for listing_declarations
 * after finding a plain upsert can't coexist with a hard immutability
 * trigger.
 */
export async function listCurrentIdentityDocuments(admin: SupabaseClient, userId: string): Promise<DocumentSummary[]> {
  const { data } = await admin
    .from('identity_verification_documents')
    .select('id, document_type, uploaded_at')
    .eq('user_id', userId)
    .order('uploaded_at', { ascending: false })

  const latestByType = new Map<string, DocumentSummary>()
  for (const row of data ?? []) {
    if (!latestByType.has(row.document_type)) {
      latestByType.set(row.document_type, { id: row.id, documentType: row.document_type, uploadedAt: row.uploaded_at })
    }
  }
  return Array.from(latestByType.values())
}

/** {user_id}/{document_type}/{uuid}.{ext} -- server-generated, never client-supplied, matching the required storage path convention. */
export function buildKycDocumentPath(userId: string, documentType: 'identity_document' | 'proof_of_address', extension: string): string {
  return `${userId}/${documentType}/${randomUUID()}.${extension}`
}
