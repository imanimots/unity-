import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free regression guards over the raw migration SQL text -- same
// convention as src/lib/payments/__tests__/webhook-inbox-migration.test.ts.
// No database connection, no Supabase CLI: this only proves the
// migration SOURCE contains the invariants D2 requires, not that it has
// been applied anywhere (it has not -- Section 9/36 of the brief).
const REPO_ROOT = join(__dirname, '../../..')
const migrationPath = join(REPO_ROOT, 'supabase/migrations/20261027145645_analytics_events_foundation.sql')
const sql = readFileSync(migrationPath, 'utf-8')

describe('D2 analytics_events foundation migration invariants (category: ADMIN-CONTROL-CENTRE-BATCH-D2)', () => {
  it('1. creates the analytics_events table', () => {
    expect(sql).toMatch(/create table if not exists public\.analytics_events/)
  })

  it('2. event_name is allowlisted by a CHECK constraint covering exactly the 16 implemented event names', () => {
    const names = [
      'page_view', 'signup_started', 'signup_completed', 'search_started', 'search_results_viewed',
      'search_zero_results', 'search_refined', 'listing_viewed', 'listing_creation_started', 'listing_published',
      'rental_checkout_started', 'booking_created', 'order_checkout_started', 'order_created', 'kyc_started', 'kyc_submitted',
    ]
    const checkSection = sql.slice(sql.indexOf('event_name'), sql.indexOf('event_version'))
    for (const name of names) {
      expect(checkSection, `expected event_name CHECK to list '${name}'`).toMatch(new RegExp(`'${name}'`))
    }
    // Nothing fabricated (e.g. the brief's own explicitly-excluded "payment_completed"/"escrow_funded").
    expect(checkSection).not.toMatch(/'payment_completed'/)
    expect(checkSection).not.toMatch(/'escrow_funded'/)
    expect(checkSection).not.toMatch(/'favorite_added'/)
    expect(checkSection).not.toMatch(/'contact_owner_clicked'/)
  })

  it('3. event_id is a required, unique uuid (the ingestion idempotency boundary)', () => {
    expect(sql).toMatch(/event_id\s+uuid not null/)
    expect(sql).toMatch(/create unique index if not exists analytics_events_event_id_key on public\.analytics_events\(event_id\)/)
  })

  it('4. event_version defaults to 1 and must be positive', () => {
    expect(sql).toMatch(/event_version\s+smallint not null default 1 check \(event_version > 0\)/)
  })

  it('5. session_id is nullable (server-originated events have none) and is a uuid column', () => {
    expect(sql).toMatch(/session_id\s+uuid,/)
  })

  it('6. actor_state is constrained to exactly the four documented states', () => {
    expect(sql).toMatch(/actor_state is null or actor_state in \('anonymous', 'authenticated', 'merchant', 'admin'\)/)
  })

  it('7. route_path is bounded to 200 characters', () => {
    expect(sql).toMatch(/route_path is null or char_length\(route_path\) <= 200/)
  })

  it('8. entity_type is constrained to listing/booking/order only', () => {
    expect(sql).toMatch(/entity_type is null or entity_type in \('listing', 'booking', 'order'\)/)
  })

  it('9. metadata is a non-null jsonb column defaulting to an empty object', () => {
    expect(sql).toMatch(/metadata\s+jsonb not null default '\{\}'::jsonb/)
  })

  it('10. data_classification is the three-state model, defaulting to "unknown" (never silently "real")', () => {
    expect(sql).toMatch(/data_classification\s+text not null default 'unknown' check \(data_classification in \('real', 'test', 'unknown'\)\)/)
  })

  it('11. occurred_at and received_at both default to now() -- never a client-supplied value', () => {
    expect(sql).toMatch(/occurred_at\s+timestamptz not null default now\(\)/)
    expect(sql).toMatch(/received_at\s+timestamptz not null default now\(\)/)
  })

  it('12. the five documented query-shape indexes all exist', () => {
    expect(sql).toMatch(/create index if not exists analytics_events_occurred_at_idx on public\.analytics_events\(occurred_at\)/)
    expect(sql).toMatch(/create index if not exists analytics_events_event_name_occurred_at_idx on public\.analytics_events\(event_name, occurred_at\)/)
    expect(sql).toMatch(/create index if not exists analytics_events_session_id_occurred_at_idx on public\.analytics_events\(session_id, occurred_at\)/)
    expect(sql).toMatch(/create index if not exists analytics_events_classification_occurred_at_idx on public\.analytics_events\(data_classification, occurred_at\)/)
    expect(sql).toMatch(/create index if not exists analytics_events_entity_idx on public\.analytics_events\(entity_type, entity_id, occurred_at\)/)
  })

  it('13. RLS is enabled on analytics_events', () => {
    expect(sql).toMatch(/alter table public\.analytics_events enable row level security/)
  })

  it('14. there is no broad anon/authenticated SELECT or INSERT policy -- only an admin-scoped read policy exists', () => {
    const policySection = sql.slice(sql.indexOf('enable row level security'), sql.indexOf('create or replace function public.record_analytics_event'))
    expect(policySection).toMatch(/create policy "analytics_events: admin read"/)
    expect(policySection).toMatch(/profiles\.role = 'admin'/)
    // No policy here grants insert/update/delete to anyone -- writes go only through the SECURITY DEFINER RPC below.
    expect(policySection).not.toMatch(/for insert/)
    expect(policySection).not.toMatch(/for update/)
    expect(policySection).not.toMatch(/for delete/)
  })

  it('15. record_analytics_event is SECURITY DEFINER, guards on service_role, and is granted only to service_role', () => {
    const fnStart = sql.indexOf('create or replace function public.record_analytics_event')
    const fnBody = sql.slice(fnStart, sql.indexOf('$$;', fnStart) + 3)
    expect(fnBody).toMatch(/security definer/)
    expect(fnBody).toMatch(/set search_path = public/)
    expect(fnBody).toMatch(/if auth\.role\(\) <> 'service_role' then/)
    expect(sql).toMatch(/revoke all on function public\.record_analytics_event\([^)]*\) from public, anon, authenticated/)
    expect(sql).toMatch(/grant execute on function public\.record_analytics_event\([^)]*\) to service_role/)
  })

  it('16. record_analytics_event inserts with ON CONFLICT (event_id) DO NOTHING -- idempotent ingestion', () => {
    const fnStart = sql.indexOf('create or replace function public.record_analytics_event')
    const fnBody = sql.slice(fnStart, sql.indexOf('$$;', fnStart) + 3)
    expect(fnBody).toMatch(/on conflict \(event_id\) do nothing/)
  })

  it('17. cleanup_analytics_events is also service_role only and guards on service_role inside the function body', () => {
    const fnStart = sql.indexOf('create or replace function public.cleanup_analytics_events')
    const fnBody = sql.slice(fnStart, sql.indexOf('$$;', fnStart) + 3)
    expect(fnBody).toMatch(/security definer/)
    expect(fnBody).toMatch(/if auth\.role\(\) <> 'service_role' then/)
    expect(sql).toMatch(/revoke all on function public\.cleanup_analytics_events\(interval\) from public, anon, authenticated/)
    expect(sql).toMatch(/grant execute on function public\.cleanup_analytics_events\(interval\) to service_role/)
  })

  it('18. no DDL in this file ever grants anon or authenticated anything on this table or its functions', () => {
    expect(sql).not.toMatch(/grant .* to (anon|authenticated)/)
  })
})
