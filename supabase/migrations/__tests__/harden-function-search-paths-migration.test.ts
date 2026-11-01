import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../..')
const MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261101130000_harden_function_search_paths.sql')
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ')

const TARGETS = [
  '_ad_campaign_funding_quotes_guard',
  '_assert_not_publication_frozen',
  '_booking_overlaps_availability_period',
  '_calculate_unity_commission',
  '_get_effective_merchant_plan_id',
  '_lock_and_count_active_supply',
  '_rent_to_buy_default_eligibility',
  '_rent_to_buy_rental_use_amount',
  '_validate_skill_task_content',
  '_validate_skill_task_post_transition',
  'enforce_dispute_message_consistency',
  'generate_barter_reference',
  'generate_booking_reference',
  'generate_order_reference',
  'match_knowledge_base',
  'prevent_row_mutation',
  'sanitize_category_metadata',
  'touch_affiliate_commission_updated_at',
  'touch_barter_agreement_updated_at',
  'touch_barter_contribution_milestone_updated_at',
  'touch_barter_skill_task_post_updated_at',
  'touch_booking_updated_at',
  'touch_dispute_updated_at',
  'touch_email_delivery_updated_at',
  'touch_escrow_transaction_updated_at',
  'touch_financial_workflow_updated_at',
  'touch_marketplace_request_updated_at',
  'touch_merchant_subscription_plan_updated_at',
  'touch_merchant_subscription_updated_at',
  'touch_payment_updated_at',
  'touch_personalization_settings_updated_at',
  'touch_rtb_agreement_updated_at',
  'touch_rtb_installment_updated_at',
  'touch_rtb_listing_terms_updated_at',
  'touch_rtb_return_case_updated_at',
  'touch_search_demand_aggregates_updated_at',
  'touch_unity_commission_updated_at',
  'validate_barter_deposit_term_payer',
] as const

describe('20261101130000_harden_function_search_paths.sql (E11)', () => {
  it('freezes exactly 38 unique targets', () => {
    expect(TARGETS).toHaveLength(38)
    expect(new Set(TARGETS).size).toBe(38)
  })

  it('contains exactly 38 ALTER FUNCTION statements and no body rewrites', () => {
    expect(codeOnly.match(/alter\s+function\s+public\.[^;]+;/gi) ?? []).toHaveLength(38)
    expect(codeOnly).not.toMatch(/create\s+(?:or\s+replace\s+)?function/i)
  })

  it('alters every frozen target exactly once', () => {
    for (const name of TARGETS) {
      const pattern = new RegExp('alter\\s+function\\s+public\\.' + name.replace(/[.*+?^$()|[\\]{}]/g, '\\$&') + '\\s*\\(', 'gi')
      expect(codeOnly.match(pattern) ?? [], name).toHaveLength(1)
    }
  })

  it('pins 37 to empty search_path and match_knowledge_base to public', () => {
    expect(normalized.match(/set search_path = '';/gi) ?? []).toHaveLength(37)
    expect(normalized.match(/set search_path = public;/gi) ?? []).toHaveLength(1)
    expect(normalized).toContain('alter function public.match_knowledge_base(public.vector, double precision, integer) set search_path = public;')
  })

  it('uses reconciled non-zero-argument signatures', () => {
    const required = [
      "alter function public._assert_not_publication_frozen(uuid) set search_path = '';",
      "alter function public._booking_overlaps_availability_period(timestamptz, timestamptz, date, date) set search_path = '';",
      "alter function public._calculate_unity_commission(text, numeric, integer) set search_path = '';",
      "alter function public._get_effective_merchant_plan_id(uuid) set search_path = '';",
      "alter function public._lock_and_count_active_supply(uuid) set search_path = '';",
      "alter function public._rent_to_buy_default_eligibility(public.rent_to_buy_agreements) set search_path = '';",
      "alter function public._rent_to_buy_rental_use_amount(public.rent_to_buy_agreements, timestamptz, timestamptz) set search_path = '';",
      "alter function public._validate_skill_task_content(text[]) set search_path = '';",
      "alter function public._validate_skill_task_post_transition(public.barter_skill_task_post_status, public.barter_skill_task_post_status, text) set search_path = '';",
      "alter function public.sanitize_category_metadata(text, boolean, jsonb) set search_path = '';"
    ]
    for (const statement of required) expect(normalized).toContain(statement)
  })

  it('is configuration-only and does not widen security', () => {
    expect(codeOnly).not.toMatch(/\bgrant\b|\brevoke\b/i)
    expect(codeOnly).not.toMatch(/security\s+definer|security\s+invoker/i)
    expect(codeOnly).not.toMatch(/create\s+policy|drop\s+policy|alter\s+policy/i)
    expect(codeOnly).not.toMatch(/create\s+trigger|drop\s+trigger|alter\s+trigger/i)
    expect(codeOnly).not.toMatch(/create\s+table|alter\s+table|drop\s+table/i)
    expect(codeOnly).not.toMatch(/create\s+view|alter\s+view|drop\s+view/i)
  })

  it('does not contain dynamic SQL or DML', () => {
    expect(codeOnly).not.toMatch(/\bexecute\b|format\s*\(|quote_ident|quote_literal|to_regclass|::\s*regclass/i)
    expect(codeOnly).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b/i)
  })

  it('does not touch E8/E9/E10 privileged surfaces', () => {
    expect(codeOnly).not.toMatch(/record_ad_impression|record_ad_click|save_listing_draft|finalize_kyc_document_upload|get_eligible_ads|is_barter_contribution_participant|is_dispute_participant|is_message_participant|bookings_check_availability_conflict|listing_availability_check_booking_conflict|protect_[a-z_]+_fields/i)
  })
})
