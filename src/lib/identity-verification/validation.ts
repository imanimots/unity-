import { z } from 'zod'

/**
 * Mirrors src/lib/listings/admin-validation.ts's shape (Step 3). Document
 * upload constants match the 'kyc-documents' bucket config
 * (20260804000001) -- kept in sync manually, same as every other
 * bucket/validation pair in this codebase (e.g.
 * MAX_OWNERSHIP_PROOF_SIZE_BYTES in src/lib/listings/validation.ts).
 */

export const ALLOWED_KYC_DOCUMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const
export const MAX_KYC_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024 // matches the bucket's file_size_limit
export const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

const idempotencyKeySchema = z.string().min(1).max(128).optional()
const reasonCodeSchema = z.string().min(1).max(100).nullable().optional()
const noteSchema = z.string().max(2000).nullable().optional()

export const identitySubmissionSchema = z.object({
  legal_first_name: z.string().trim().min(1).max(100),
  legal_surname: z.string().trim().min(1).max(100),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be in YYYY-MM-DD format'),
  id_reference_type: z.enum(['sa_id', 'passport']),
  id_reference_number: z.string().trim().min(4).max(50),
  nationality: z.string().trim().min(1).max(100),
  country_of_residence: z.string().trim().min(1).max(100),
  residential_address: z.string().trim().min(10).max(500),
  idempotency_key: idempotencyKeySchema,
})

export const startReviewSchema = z.object({ idempotency_key: idempotencyKeySchema })

export const identityDecisionSchema = z.object({
  reason_code: reasonCodeSchema,
  reviewer_notes: noteSchema,
  user_feedback: noteSchema,
  idempotency_key: idempotencyKeySchema,
})

export const documentUrlSchema = z.object({ document_id: z.string().uuid() })

export const documentUploadRecordSchema = z.object({
  document_type: z.enum(['identity_document', 'proof_of_address']),
  storage_path: z.string().min(1).max(500),
  mime_type: z.enum(ALLOWED_KYC_DOCUMENT_MIME_TYPES),
  file_size: z.number().int().positive().max(MAX_KYC_DOCUMENT_SIZE_BYTES),
})
