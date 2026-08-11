import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'

export const reportProfileSchema = z.object({
  reason: z.enum(['harassment', 'scam_fraud', 'inappropriate_content', 'impersonation', 'spam', 'other']),
  description: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export type ReportProfileRequest = z.infer<typeof reportProfileSchema>
