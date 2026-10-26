import { z } from 'zod'
import {
  SUPPORT_CASE_CATEGORIES,
  SUPPORT_CASE_PRIORITIES,
  SUPPORT_LINKED_ENTITY_TYPES,
} from '@/lib/support/types'

const idempotencyKeySchema = z.string().min(1).max(128).optional()
const uuidSchema = z.string().uuid()

export const createSupportCaseSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    category: z.enum(SUPPORT_CASE_CATEGORIES),
    priority: z.enum(SUPPORT_CASE_PRIORITIES).optional(),
    customer_id: uuidSchema.nullable().optional(),
    merchant_id: uuidSchema.nullable().optional(),
    linked_entity_type: z.enum(SUPPORT_LINKED_ENTITY_TYPES).nullable().optional(),
    linked_entity_id: uuidSchema.nullable().optional(),
    idempotency_key: idempotencyKeySchema,
  })
  .refine((v) => !!v.customer_id || !!v.merchant_id, {
    message: 'A support case requires at least one of customer_id or merchant_id',
    path: ['customer_id'],
  })
  .refine((v) => !!v.linked_entity_type === !!v.linked_entity_id, {
    message: 'linked_entity_type and linked_entity_id must be provided together',
    path: ['linked_entity_type'],
  })

export const assignSupportCaseSchema = z.object({
  assignee_admin_id: uuidSchema,
  idempotency_key: idempotencyKeySchema,
})

export const changeSupportCasePrioritySchema = z.object({
  priority: z.enum(SUPPORT_CASE_PRIORITIES),
  idempotency_key: idempotencyKeySchema,
})

export const updateSupportCaseStatusSchema = z.object({
  target_status: z.enum(['open', 'in_progress', 'waiting_on_user']),
  idempotency_key: idempotencyKeySchema,
})

export const escalateSupportCaseSchema = z.object({
  reason: z.string().min(1).max(1000),
  idempotency_key: idempotencyKeySchema,
})

export const resolveSupportCaseSchema = z.object({
  resolution_summary: z.string().min(1).max(2000),
  idempotency_key: idempotencyKeySchema,
})

export const closeSupportCaseSchema = z.object({
  reason: z.string().max(1000).nullable().optional(),
  idempotency_key: idempotencyKeySchema,
})

export const reopenSupportCaseSchema = z.object({
  reason: z.string().min(1).max(1000),
  idempotency_key: idempotencyKeySchema,
})

export const addSupportCaseNoteSchema = z.object({
  note: z.string().min(1).max(4000),
  idempotency_key: idempotencyKeySchema,
})
