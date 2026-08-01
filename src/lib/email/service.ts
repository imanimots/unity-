import type { SupabaseClient } from '@supabase/supabase-js'
import { getEmailProvider } from './registry'
import { renderTemplate, getEmailTemplate, TemplateValidationError, type TemplateVars } from './templates/catalogue'
import { computeEmailIdempotencyKey } from './idempotency'
import { resolveUserEmail } from './resolve-recipient'
import { isRetryableEmailError } from './errors'

const EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'support@unitytest.co.za'
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || undefined

export type RelatedEntityType = 'booking' | 'listing' | 'identity_verification'

export interface SendTemplateRequest {
  eventType: string
  templateId: string
  recipientUserId: string
  relatedEntityType: RelatedEntityType
  relatedEntityId: string
  vars: TemplateVars
  /** Reminders (and any future repeatable event) pass their own occurrence key so each occurrence is independently idempotent. One-shot lifecycle events omit this. */
  occurrenceKey?: string
}

export type SendTemplateStatus = 'sent' | 'skipped_duplicate' | 'skipped_no_recipient_email' | 'failed_retryable' | 'failed_terminal'

export interface SendTemplateResult {
  status: SendTemplateStatus
  deliveryId: string | null
}

/**
 * The one trusted server-side dispatch entry point (Step 8) -- every
 * route that needs to send an email calls this, never a provider
 * directly. Never throws: every failure mode (missing recipient email,
 * template validation, provider error) is caught and turned into a
 * normalized result plus a durable delivery record, so a caller can
 * always safely `await sendTemplate(...)` without wrapping it -- though
 * call sites still wrap it defensively, matching the established
 * Step 5-7 "best-effort, never block the business transaction" pattern.
 *
 * The browser never reaches this function directly -- there is no public
 * route that accepts event_type/template_id/recipient_user_id from a
 * request body. Every call site constructs the request entirely from
 * server-verified data (the authenticated actor, and entity ids the route
 * itself already validated ownership of).
 */
export async function sendTemplate(admin: SupabaseClient, req: SendTemplateRequest): Promise<SendTemplateResult> {
  const def = getEmailTemplate(req.templateId)
  const templateVersion = def?.version ?? '0'

  const idempotencyKey = computeEmailIdempotencyKey(req.eventType, req.relatedEntityId, req.recipientUserId, templateVersion, req.occurrenceKey ?? '')

  const email = await resolveUserEmail(admin, req.recipientUserId)

  const { data: inserted, error: insertError } = await admin
    .from('email_deliveries')
    .insert({
      event_type: req.eventType,
      template_id: req.templateId,
      template_version: templateVersion,
      recipient_user_id: req.recipientUserId,
      recipient_email: email,
      related_entity_type: req.relatedEntityType,
      related_entity_id: req.relatedEntityId,
      template_vars: req.vars,
      idempotency_key: idempotencyKey,
      status: 'pending',
    })
    .select('id')
    .maybeSingle()

  if (insertError) {
    if (insertError.code === '23505') {
      // Unique violation on idempotency_key -- already dispatched, by this call or a concurrent one.
      return { status: 'skipped_duplicate', deliveryId: null }
    }
    console.error('[email.service] delivery insert failed', { eventType: req.eventType, templateId: req.templateId, error: insertError })
    return { status: 'failed_terminal', deliveryId: null }
  }
  if (!inserted) {
    console.error('[email.service] delivery insert returned no row', { eventType: req.eventType, templateId: req.templateId })
    return { status: 'failed_terminal', deliveryId: null }
  }

  const deliveryId: string = inserted.id

  if (!email) {
    await admin.from('email_deliveries').update({ status: 'failed_terminal', last_error: 'no recipient email on file', failed_at: new Date().toISOString() }).eq('id', deliveryId)
    return { status: 'skipped_no_recipient_email', deliveryId }
  }

  let rendered
  try {
    rendered = renderTemplate(req.templateId, req.vars)
  } catch (err) {
    const message = err instanceof TemplateValidationError ? err.message : 'template render error'
    console.error('[email.service] template validation failed', { templateId: req.templateId, message })
    await admin.from('email_deliveries').update({ status: 'failed_terminal', last_error: message, failed_at: new Date().toISOString() }).eq('id', deliveryId)
    return { status: 'failed_terminal', deliveryId }
  }

  return attemptProviderSend(admin, deliveryId, email, rendered, idempotencyKey)
}

async function attemptProviderSend(
  admin: SupabaseClient,
  deliveryId: string,
  email: string,
  rendered: { subject: string; html: string; text: string },
  idempotencyKey: string
): Promise<SendTemplateResult> {
  const provider = getEmailProvider()

  try {
    const result = await provider.sendTransactionalEmail({
      to: email,
      from: EMAIL_FROM_ADDRESS,
      replyTo: EMAIL_REPLY_TO,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey,
    })

    await admin
      .from('email_deliveries')
      .update({
        status: 'sent',
        provider: provider.name,
        provider_message_id: result.providerMessageId,
        sent_at: new Date().toISOString(),
        attempts: 1,
      })
      .eq('id', deliveryId)

    return { status: 'sent', deliveryId }
  } catch (err) {
    const retryable = isRetryableEmailError(err)
    const status: SendTemplateStatus = retryable ? 'failed_retryable' : 'failed_terminal'
    const safeMessage = err instanceof Error ? err.name : 'unknown provider error'

    console.error('[email.service] provider send failed', { deliveryId, provider: provider.name, errorName: safeMessage })

    await admin
      .from('email_deliveries')
      .update({
        status,
        provider: provider.name,
        last_error: safeMessage,
        failed_at: new Date().toISOString(),
        attempts: 1,
      })
      .eq('id', deliveryId)

    return { status, deliveryId }
  }
}

export interface RetrySweepResult {
  consideredCount: number
  sentCount: number
  stillFailingCount: number
}

/**
 * Re-attempts every currently failed_retryable delivery, oldest first.
 * Each call goes through retryDelivery() (below), which updates the same
 * row in place -- never inserts a duplicate. Used by
 * POST /api/internal/email/retry-failed.
 */
export async function retryAllFailedDeliveries(admin: SupabaseClient): Promise<RetrySweepResult> {
  const { data: candidates } = await admin.from('email_deliveries').select('id').eq('status', 'failed_retryable').order('created_at', { ascending: true })

  const rows = candidates ?? []
  let sentCount = 0
  let stillFailingCount = 0

  for (const row of rows) {
    const result = await retryDelivery(admin, row.id)
    if (result.status === 'sent') sentCount++
    else if (result.status === 'failed_retryable' || result.status === 'failed_terminal') stillFailingCount++
  }

  return { consideredCount: rows.length, sentCount, stillFailingCount }
}

export interface DeliveryStatusSummary {
  id: string
  eventType: string
  status: SendTemplateStatus | 'pending'
  attempts: number
  sentAt: string | null
  failedAt: string | null
}

/** Read-only status lookup -- used by admin tooling and tests, never exposes last_error or template_vars to a non-admin caller. */
export async function getDeliveryStatus(admin: SupabaseClient, deliveryId: string): Promise<DeliveryStatusSummary | null> {
  const { data } = await admin
    .from('email_deliveries')
    .select('id, event_type, status, attempts, sent_at, failed_at')
    .eq('id', deliveryId)
    .maybeSingle()
  if (!data) return null
  return {
    id: data.id,
    eventType: data.event_type,
    status: data.status,
    attempts: data.attempts,
    sentAt: data.sent_at,
    failedAt: data.failed_at,
  }
}

export async function emailHealthCheck() {
  return getEmailProvider().healthCheck()
}

/**
 * Re-attempts a single failed_retryable delivery in place -- re-renders
 * from the stored template_vars (never re-derives context from the
 * related entity, which could have changed; the original vars are the
 * safe, non-sensitive snapshot that was actually shown), updates the SAME
 * row (never inserts a new one), so a retry never produces a duplicate
 * delivery record.
 */
export async function retryDelivery(admin: SupabaseClient, deliveryId: string): Promise<SendTemplateResult> {
  const { data: delivery } = await admin
    .from('email_deliveries')
    .select('id, template_id, template_vars, recipient_email, recipient_user_id, status, idempotency_key, attempts')
    .eq('id', deliveryId)
    .maybeSingle()

  if (!delivery || delivery.status !== 'failed_retryable') {
    return { status: 'skipped_duplicate', deliveryId: null }
  }

  const email = delivery.recipient_email ?? (await resolveUserEmail(admin, delivery.recipient_user_id))
  if (!email) {
    await admin.from('email_deliveries').update({ status: 'failed_terminal', last_error: 'no recipient email on file', failed_at: new Date().toISOString() }).eq('id', deliveryId)
    return { status: 'skipped_no_recipient_email', deliveryId }
  }

  let rendered
  try {
    rendered = renderTemplate(delivery.template_id, delivery.template_vars as TemplateVars)
  } catch (err) {
    const message = err instanceof TemplateValidationError ? err.message : 'template render error'
    await admin.from('email_deliveries').update({ status: 'failed_terminal', last_error: message, failed_at: new Date().toISOString() }).eq('id', deliveryId)
    return { status: 'failed_terminal', deliveryId }
  }

  return attemptProviderSendRetry(admin, deliveryId, email, rendered, delivery.idempotency_key, delivery.attempts)
}

async function attemptProviderSendRetry(
  admin: SupabaseClient,
  deliveryId: string,
  email: string,
  rendered: { subject: string; html: string; text: string },
  idempotencyKey: string,
  previousAttempts: number
): Promise<SendTemplateResult> {
  const provider = getEmailProvider()
  try {
    const result = await provider.sendTransactionalEmail({
      to: email,
      from: EMAIL_FROM_ADDRESS,
      replyTo: EMAIL_REPLY_TO,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey,
    })
    await admin
      .from('email_deliveries')
      .update({
        status: 'sent',
        provider: provider.name,
        provider_message_id: result.providerMessageId,
        sent_at: new Date().toISOString(),
        attempts: previousAttempts + 1,
      })
      .eq('id', deliveryId)
    return { status: 'sent', deliveryId }
  } catch (err) {
    const retryable = isRetryableEmailError(err)
    const status: SendTemplateStatus = retryable ? 'failed_retryable' : 'failed_terminal'
    const safeMessage = err instanceof Error ? err.name : 'unknown provider error'
    await admin
      .from('email_deliveries')
      .update({ status, last_error: safeMessage, failed_at: new Date().toISOString(), attempts: previousAttempts + 1 })
      .eq('id', deliveryId)
    return { status, deliveryId }
  }
}
