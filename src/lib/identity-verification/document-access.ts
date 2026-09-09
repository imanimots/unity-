import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { MIME_TO_EXTENSION } from './validation'

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

const KYC_DOCUMENT_TYPES = ['identity_document', 'proof_of_address'] as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LEAF_RE = /^([0-9a-f-]{36})\.([a-z0-9]+)$/i
const VALID_EXTENSIONS = new Set(Object.values(MIME_TO_EXTENSION))

export interface KycDocumentPathParseResult {
  ok: boolean
  /** Only present when ok -- the file extension parsed from the leaf segment. */
  extension?: string
}

/**
 * Sibling validator to buildKycDocumentPath() -- that function only
 * builds a trusted path; this is the smallest matching parser for
 * POST /api/verification/documents to re-establish trust in a
 * client-supplied path before treating it as authoritative (T2 in this
 * codebase's trust-level model). Exact grammar, not prefix-only:
 * {authenticatedUserId}/{documentType}/{uuid}.{extension}, exactly 3
 * segments, no traversal, no empty segments, canonical UUID-shaped leaf,
 * extension drawn from the same MIME_TO_EXTENSION set the bucket itself
 * enforces. Caller is responsible for the separate MIME-extension
 * consistency check (compare the returned extension against
 * MIME_TO_EXTENSION[claimed mime_type]) -- kept as a separate step since
 * it needs the request's claimed mime_type, not just the path.
 */
export function parseKycDocumentPath(
  path: string,
  expectedUserId: string,
  expectedDocumentType: 'identity_document' | 'proof_of_address'
): KycDocumentPathParseResult {
  if (!path || path !== path.trim()) return { ok: false }
  if (path.startsWith('/') || path.endsWith('/') || path.includes('..')) return { ok: false }

  const segments = path.split('/')
  if (segments.length !== 3) return { ok: false }
  if (segments.some((s) => s.length === 0)) return { ok: false }

  const [userSegment, typeSegment, filename] = segments
  if (userSegment !== expectedUserId) return { ok: false }
  if (typeSegment !== expectedDocumentType) return { ok: false }
  if (!KYC_DOCUMENT_TYPES.includes(typeSegment as (typeof KYC_DOCUMENT_TYPES)[number])) return { ok: false }

  const leafMatch = filename.match(LEAF_RE)
  if (!leafMatch) return { ok: false }
  const [, uuidPart, ext] = leafMatch
  if (!UUID_RE.test(uuidPart)) return { ok: false }

  const extension = ext.toLowerCase()
  if (!VALID_EXTENSIONS.has(extension)) return { ok: false }

  return { ok: true, extension }
}
