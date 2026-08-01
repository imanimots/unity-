import { createHash } from 'crypto'

/**
 * event_type + entity_id + recipient_user_id + template_version +
 * occurrence_key, exactly as the brief specifies. Reminders pass their own
 * occurrence key (e.g. "reminder-1") so a reminder and the original
 * payment-required email for the same booking/recipient/template-version
 * never collide -- each occurrence is its own idempotent unit. The default
 * occurrence key ('') covers every one-shot lifecycle event.
 */
export function computeEmailIdempotencyKey(
  eventType: string,
  relatedEntityId: string,
  recipientUserId: string,
  templateVersion: string,
  occurrenceKey = ''
): string {
  return createHash('md5').update(`${eventType}|${relatedEntityId}|${recipientUserId}|${templateVersion}|${occurrenceKey}`).digest('hex')
}
