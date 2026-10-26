/**
 * Maps known RAISE EXCEPTION messages from the Support Centre RPCs
 * (supabase/migrations/20261026000000_support_centre_schema.sql) to a
 * user-safe message + HTTP status -- same convention as
 * src/lib/disputes/rpc-errors.ts and src/lib/admin/rpc-errors.ts.
 * Never forward a raw Postgres error to the client.
 */
export function mapSupportRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in as an administrator.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('title is required')) {
    return { status: 400, error: 'A title is required.' }
  }
  if (m.includes('a support case requires at least one of customer_id or merchant_id')) {
    return { status: 400, error: 'A support case must be linked to a customer or a merchant.' }
  }
  if (m.includes('linked_entity_type and linked_entity_id must be provided together')) {
    return { status: 400, error: 'A linked entity requires both a type and an id.' }
  }
  if (m.includes('assignee must be an admin')) {
    return { status: 400, error: 'The assignee must be an admin.' }
  }
  if (m.includes('support case not found')) {
    return { status: 404, error: 'Support case not found.' }
  }
  if (m.includes('note cannot be empty')) {
    return { status: 400, error: 'Note cannot be empty.' }
  }
  if (m.includes('use the dedicated escalate/resolve/close/reopen actions for this transition')) {
    return { status: 400, error: 'That status change requires a dedicated action (escalate, resolve, close, or reopen).' }
  }
  if (m.includes('this case must be reopened before its status can change again')) {
    return { status: 409, error: 'This case must be reopened before its status can change again.' }
  }
  if (m.includes('an escalation reason is required')) {
    return { status: 400, error: 'An escalation reason is required.' }
  }
  if (m.includes('only an active, non-escalated case can be escalated')) {
    return { status: 409, error: 'Only an active, non-escalated case can be escalated.' }
  }
  if (m.includes('a resolution summary is required')) {
    return { status: 400, error: 'A resolution summary is required.' }
  }
  if (m.includes('this case cannot be resolved from its current status')) {
    return { status: 409, error: 'This case cannot be resolved from its current status.' }
  }
  if (m.includes('this case is already closed')) {
    return { status: 409, error: 'This case is already closed.' }
  }
  if (m.includes('a reason is required to close a case that has not been resolved')) {
    return { status: 400, error: 'A reason is required to close a case that has not been resolved.' }
  }
  if (m.includes('a reason is required to reopen a case')) {
    return { status: 400, error: 'A reason is required to reopen a case.' }
  }
  if (m.includes('only a resolved or closed case can be reopened')) {
    return { status: 409, error: 'Only a resolved or closed case can be reopened.' }
  }
  if (m.includes('invalid input value for enum support_case_category')) {
    return { status: 400, error: 'Invalid category.' }
  }
  if (m.includes('invalid input value for enum support_case_priority')) {
    return { status: 400, error: 'Invalid priority.' }
  }
  if (m.includes('invalid input value for enum support_case_status')) {
    return { status: 400, error: 'Invalid status.' }
  }
  if (m.includes('invalid input value for enum support_linked_entity_type')) {
    return { status: 400, error: 'Invalid linked entity type.' }
  }
  if (m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}
