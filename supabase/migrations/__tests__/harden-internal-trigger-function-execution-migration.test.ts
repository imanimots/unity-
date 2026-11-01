import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * E10 migration-contract test for
 * 20261101111500_harden_internal_trigger_function_execution.sql.
 *
 * E10 is deliberately grant-only. The 13 targets are existing
 * SECURITY DEFINER trigger/auth-hook functions which must continue to
 * execute through their bound database triggers but must not remain
 * directly callable over PostgREST by PUBLIC/anon/authenticated (or by
 * service_role when no direct server caller exists).
 *
 * LIMITATION: this test validates migration/source structure. It does
 * not execute PostgreSQL. Live advisor verification after the normal
 * GitHub-integrated Supabase deployment remains the release gate.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATION_PATH = join(
  REPO_ROOT,
  'supabase/migrations/20261101111500_harden_internal_trigger_function_execution.sql'
)
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const normalized = sql.replace(/\s+/g, ' ')

function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
}

const codeOnly = stripComments(sql)

type TargetSpec = {
  name: string
  source: string
  trigger: string
  table: string
}

const TARGETS: TargetSpec[] = [
  {
    name: 'bookings_check_availability_conflict',
    source: 'supabase/migrations/20260914101000_enforce_booking_listing_availability_integrity.sql',
    trigger: 'bookings_check_availability_conflict_trg',
    table: 'public.bookings',
  },
  {
    name: 'listing_availability_check_booking_conflict',
    source: 'supabase/migrations/20260914101000_enforce_booking_listing_availability_integrity.sql',
    trigger: 'listing_availability_check_booking_conflict_trg',
    table: 'public.listing_availability',
  },
  {
    name: 'compute_listing_risk_tier',
    source: 'supabase/migrations/20260720000002_risk_engine.sql',
    trigger: 'set_listing_risk_tier',
    table: 'public.listings',
  },
  {
    name: 'handle_new_user',
    source: 'supabase/migrations/20260613000001_initial_schema.sql',
    trigger: 'on_auth_user_created',
    table: 'auth.users',
  },
  {
    name: 'protect_barter_privileged_fields',
    source: 'supabase/migrations/20260810000005_barter_security.sql',
    trigger: 'protect_barter_privileged_fields_trg',
    table: 'public.barter_agreements',
  },
  {
    name: 'protect_booking_financial_fields',
    source: 'supabase/migrations/20260729000001_fix_rls_privilege_escalation.sql',
    trigger: 'protect_booking_financial_fields_trg',
    table: 'public.bookings',
  },
  {
    name: 'protect_booking_privileged_fields',
    source: 'supabase/migrations/20260730000006_booking_security.sql',
    trigger: 'protect_booking_privileged_fields_trg',
    table: 'public.bookings',
  },
  {
    name: 'protect_listing_privileged_fields',
    source: 'supabase/migrations/20260729000006_listing_security_hardening.sql',
    trigger: 'protect_listing_privileged_fields_trg',
    table: 'public.listings',
  },
  {
    name: 'protect_listing_requirements_privileged_fields',
    source: 'supabase/migrations/20260729000006_listing_security_hardening.sql',
    trigger: 'protect_listing_requirements_privileged_fields_trg',
    table: 'public.listing_requirements',
  },
  {
    name: 'protect_order_financial_fields',
    source: 'supabase/migrations/20260729000001_fix_rls_privilege_escalation.sql',
    trigger: 'protect_order_financial_fields_trg',
    table: 'public.orders',
  },
  {
    name: 'protect_order_privileged_fields',
    source: 'supabase/migrations/20260812000003_orders_schema_hardening.sql',
    trigger: 'protect_order_privileged_fields_trg',
    table: 'public.orders',
  },
  {
    name: 'protect_payment_privileged_fields',
    source: 'supabase/migrations/20260801000003_payment_security.sql',
    trigger: 'protect_payment_privileged_fields_trg',
    table: 'public.payments',
  },
  {
    name: 'protect_profile_privileged_fields',
    source: 'supabase/migrations/20260729000001_fix_rls_privilege_escalation.sql',
    trigger: 'protect_profile_privileged_fields_trg',
    table: 'public.profiles',
  },
]

describe('20261101111500_harden_internal_trigger_function_execution.sql (E10)', () => {
  it('1. accounts for exactly the 13 frozen E10 target functions', () => {
    expect(TARGETS).toHaveLength(13)
    expect(new Set(TARGETS.map((target) => target.name)).size).toBe(13)

    const revokes =
      codeOnly.match(/revoke all on function public\.[a-z0-9_]+\(\)/gi) ?? []
    expect(revokes).toHaveLength(13)
  })

  it('2. explicitly revokes PUBLIC, anon, authenticated, and service_role from every exact zero-argument signature', () => {
    for (const { name } of TARGETS) {
      expect(normalized, `${name}: missing exact four-role revoke`).toMatch(
        new RegExp(
          `revoke all on function public\\.${name}\\(\\) from public, anon, authenticated, service_role;`
        )
      )
    }
  })

  it('3. grants EXECUTE to none of the E10 targets -- no direct RPC caller is required', () => {
    for (const { name } of TARGETS) {
      expect(codeOnly, `${name}: unexpected EXECUTE grant`).not.toMatch(
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\(\\)`, 'i')
      )
    }
  })

  it('4. is privilege-only: no function bodies, triggers, policies, tables, or RLS state are changed', () => {
    expect(codeOnly).not.toMatch(/create\s+or\s+replace\s+function/i)
    expect(codeOnly).not.toMatch(/create\s+trigger|drop\s+trigger|alter\s+trigger/i)
    expect(codeOnly).not.toMatch(/create\s+policy|drop\s+policy|alter\s+policy/i)
    expect(codeOnly).not.toMatch(/create\s+table|alter\s+table|drop\s+table/i)
    expect(codeOnly).not.toMatch(/enable\s+row\s+level\s+security|disable\s+row\s+level\s+security/i)
    expect(codeOnly).not.toMatch(/alter\s+function/i)
  })

  it('5. every target is structurally proven to be an existing SECURITY DEFINER trigger function with fixed search_path=public', () => {
    for (const { name, source } of TARGETS) {
      const sourceSql = readFileSync(join(REPO_ROOT, source), 'utf-8')
      const functionIndex = sourceSql.indexOf(`create or replace function public.${name}()`)
      expect(functionIndex, `${name}: defining function not found in ${source}`).toBeGreaterThan(-1)

      const bodyStart = sourceSql.indexOf('as $$', functionIndex)
      expect(bodyStart, `${name}: function header terminator not found`).toBeGreaterThan(functionIndex)

      const header = sourceSql.slice(functionIndex, bodyStart)
      expect(header, `${name}: must return trigger`).toMatch(/returns\s+trigger/i)
      expect(header, `${name}: must remain SECURITY DEFINER`).toMatch(/security\s+definer/i)
      expect(header, `${name}: must have fixed search_path`).toMatch(/set\s+search_path\s*=\s*public/i)
    }
  })

  it('6. every target remains bound to its expected database trigger', () => {
    for (const { name, source, trigger, table } of TARGETS) {
      const sourceSql = readFileSync(join(REPO_ROOT, source), 'utf-8')
      expect(sourceSql, `${name}: missing CREATE TRIGGER ${trigger}`).toMatch(
        new RegExp(`create\\s+trigger\\s+${trigger}\\b`, 'i')
      )
      expect(sourceSql, `${name}: expected trigger table ${table} not found`).toMatch(
        new RegExp(
          `create\\s+trigger\\s+${trigger}[\\s\\S]{0,500}?on\\s+${table.replace('.', '\\.')}`,
          'i'
        )
      )
      expect(sourceSql, `${name}: trigger does not execute target function`).toMatch(
        new RegExp(
          `create\\s+trigger\\s+${trigger}[\\s\\S]{0,700}?execute\\s+procedure\\s+public\\.${name}\\(\\)`,
          'i'
        )
      )
    }
  })

  it('7. contains no dynamic SQL or unrelated E8/E9/Admin-Control-Centre object changes', () => {
    expect(codeOnly).not.toMatch(/\bexecute\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/i)
    expect(codeOnly).not.toMatch(
      /record_ad_impression|record_ad_click|save_listing_draft|finalize_kyc_document_upload|get_eligible_ads|is_barter_contribution_participant|is_dispute_participant|is_message_participant|support_case|admin_intelligence|security_definer_view/i
    )
  })
})
