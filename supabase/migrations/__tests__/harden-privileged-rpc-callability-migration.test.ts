import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * E9/E9-F1 migration-contract test for
 * 20261101090000_harden_privileged_rpc_callability.sql.
 *
 * This migration was amended in place for E9-F1 (never applied/pushed
 * under its original E9 form) -- see the migration's own two
 * "E9-F1 CORRECTION" header notes for the full rationale. Disposition:
 *   - save_listing_draft: grants only (unchanged from E9).
 *   - finalize_kyc_document_upload: NOT TOUCHED (unchanged from E9).
 *   - record_ad_impression: RECLASSIFIED to SERVER-ONLY (E9-F1) --
 *     schema change (idempotency_key column + unique index), body
 *     change (idempotency short-circuit after the campaign row lock,
 *     p_viewer_id trusted again since the only caller is now
 *     service_role), grants narrowed to service_role only.
 *   - record_ad_click: SERVER-ONLY, campaign-linkage check (unchanged
 *     from E9).
 *   - get_eligible_ads: NOT TOUCHED (unchanged from E9).
 *   - is_barter_contribution_participant / is_dispute_participant /
 *     is_message_participant: each gains a NEW one-argument,
 *     auth.uid()-deriving overload granted to authenticated only; the
 *     old two-argument overload is narrowed to service_role only
 *     (E9-F1); 6 dependent RLS policies updated to call the new
 *     one-argument overload.
 *
 * LIMITATION, stated per this codebase's own established convention:
 * this test parses SQL source text and asserts on its structure. It
 * does NOT execute the SQL against a real Postgres instance and
 * cannot literally prove live EXECUTE/RLS enforcement or concurrency
 * behavior -- no live database is available to this test environment.
 * This migration has not been applied by any phase; it reaches the
 * live database only via the project's GitHub-integrated Supabase
 * workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261101090000_harden_privileged_rpc_callability.sql')
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const normalized = sql.replace(/\s+/g, ' ')

function stripComments(source: string): string {
  return source.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
}
const codeOnly = stripComments(sql)

/** Extracts a function's body (between `as $$` and the matching `$$;`), for a specific arity (by counting commas in the immediately-following parameter list is unreliable with defaults, so this matches the Nth occurrence of the given name). */
function extractFunctionBody(source: string, name: string, occurrence = 0): string {
  const regex = new RegExp(`create or replace function public\\.${name}\\(`, 'g')
  const matches = [...source.matchAll(regex)]
  if (!matches[occurrence] || matches[occurrence].index === undefined) throw new Error(`${name}: occurrence ${occurrence} not found`)
  const defIdx = matches[occurrence].index as number
  const startIdx = source.indexOf('as $$', defIdx)
  if (startIdx === -1) throw new Error(`${name}: 'as $$' not found`)
  const endIdx = source.indexOf('$$;', startIdx + 5)
  if (endIdx === -1) throw new Error(`${name}: terminating $$; not found`)
  return source.slice(startIdx + 5, endIdx).trim()
}

const UNTOUCHED_FUNCTIONS = ['finalize_kyc_document_upload', 'get_eligible_ads']

describe('20261101090000_harden_privileged_rpc_callability.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E9 / E9-F1)', () => {
  it('1. the 2 untouched (already-justified) functions have no CREATE OR REPLACE FUNCTION and no GRANT/REVOKE statement in this migration at all', () => {
    for (const name of UNTOUCHED_FUNCTIONS) {
      expect(codeOnly, `${name}: unexpectedly redefined`).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`))
      expect(codeOnly, `${name}: unexpectedly granted/revoked`).not.toMatch(new RegExp(`(grant|revoke)[^;]*\\bpublic\\.${name}\\b`))
    }
  })

  it('2. save_listing_draft has no CREATE OR REPLACE FUNCTION in this migration -- grants/revokes only', () => {
    expect(codeOnly).not.toMatch(/create or replace function public\.save_listing_draft\(/)
  })

  it('3. save_listing_draft: PUBLIC, anon, and service_role are explicitly revoked; only authenticated is granted', () => {
    expect(normalized).toMatch(/revoke all on function public\.save_listing_draft\([^)]*\)\s*from public, anon, service_role;/)
    expect(normalized).toMatch(/grant execute on function public\.save_listing_draft\([^)]*\) to authenticated;/)
  })

  it('4. record_ad_impression: idempotency_key column and a matching partial unique index are added to ad_impressions', () => {
    expect(codeOnly).toMatch(/alter table public\.ad_impressions add column if not exists idempotency_key text;/)
    expect(codeOnly).toMatch(/create unique index if not exists ad_impressions_idempotency_idx\s*\n\s*on public\.ad_impressions\(campaign_id, idempotency_key\)\s*\n\s*where idempotency_key is not null;/)
  })

  it('5. record_ad_impression: the idempotency short-circuit happens AFTER the campaign row is locked (for update), not before -- closing the check-then-act race a pre-lock SELECT would leave open', () => {
    const body = extractFunctionBody(sql, 'record_ad_impression')
    const lockIdx = body.indexOf('for update;')
    const idempotencyIdx = body.indexOf("select * into v_existing from public.ad_impressions where campaign_id = p_campaign_id and idempotency_key = p_idempotency_key;")
    expect(lockIdx, 'campaign row lock not found').toBeGreaterThan(-1)
    expect(idempotencyIdx, 'idempotency check not found').toBeGreaterThan(-1)
    expect(idempotencyIdx).toBeGreaterThan(lockIdx)
  })

  it('6. record_ad_impression: an idempotent replay returns the existing row\'s id/countable without re-running eligibility checks or re-touching ad_campaigns', () => {
    const body = extractFunctionBody(sql, 'record_ad_impression')
    const idempotencyBlockMatch = body.match(/if p_idempotency_key is not null then\s*\n\s*select \* into v_existing from public\.ad_impressions where campaign_id = p_campaign_id and idempotency_key = p_idempotency_key;\s*\n\s*if found then\s*\n\s*return jsonb_build_object\('recorded', true, 'impression_id', v_existing\.id, 'countable', v_existing\.countable\);\s*\n\s*end if;\s*\n\s*end if;/)
    expect(idempotencyBlockMatch, 'idempotent short-circuit block not found in expected form').toBeTruthy()
  })

  it('7. record_ad_impression once again trusts p_viewer_id as a parameter (no auth.uid() derivation) -- safe now because only service_role may call it', () => {
    const body = extractFunctionBody(sql, 'record_ad_impression')
    expect(body).not.toMatch(/auth\.uid\(\)/)
    expect(body).toMatch(/if p_viewer_id is not null and p_viewer_id = v_advertiser\.owner_profile_id/)
    expect(body).toMatch(/values \(p_campaign_id, p_placement_type, p_viewer_id, p_reach_key, v_countable, v_exclusion, p_idempotency_key\)/)
  })

  it('8. record_ad_impression: PUBLIC, anon, and authenticated are explicitly revoked; only service_role is granted -- RECLASSIFIED to server-only', () => {
    expect(normalized).toMatch(/revoke all on function public\.record_ad_impression\([^)]*\)\s*from public, anon, authenticated;/)
    expect(normalized).toMatch(/grant execute on function public\.record_ad_impression\([^)]*\) to service_role;/)
    expect(normalized).not.toMatch(/grant execute on function public\.record_ad_impression\([^)]*\) to [^;]*\b(anon|authenticated)\b/)
  })

  it('9. record_ad_impression: other logic (reach_key requirement, eligibility checks, quota increment, campaign completion) is otherwise unchanged', () => {
    const body = extractFunctionBody(sql, 'record_ad_impression')
    expect(body).toMatch(/if p_reach_key is null or char_length\(trim\(p_reach_key\)\) = 0 then/)
    expect(body).toMatch(/if v_campaign\.delivered_impressions >= v_campaign\.snapshot_impression_quota then/)
    expect(body).toMatch(/v_new_delivered := v_campaign\.delivered_impressions \+ 1;/)
    expect(body).toMatch(/completion_reason = 'quota_reached'/)
  })

  it('10. record_ad_click independently verifies p_impression_id belongs to p_campaign_id before any mutation, positioned before the idempotency lookup and insert', () => {
    const body = extractFunctionBody(sql, 'record_ad_click')
    const checkIdx = body.search(/if not exists \(\s*select 1 from public\.ad_impressions\s*\n\s*where id = p_impression_id and campaign_id = p_campaign_id\s*\n\s*\) then\s*\n\s*raise exception 'impression does not belong to this campaign';/)
    const idempotencyIdx = body.indexOf('select * into v_existing from public.ad_clicks')
    const insertIdx = body.indexOf('insert into public.ad_clicks')
    expect(checkIdx, 'linkage check not found').toBeGreaterThan(-1)
    expect(checkIdx).toBeLessThan(idempotencyIdx)
    expect(checkIdx).toBeLessThan(insertIdx)
  })

  it('11. record_ad_click: PUBLIC, anon, and authenticated are explicitly revoked; only service_role is granted', () => {
    expect(normalized).toMatch(/revoke all on function public\.record_ad_click\([^)]*\)\s*from public, anon, authenticated;/)
    expect(normalized).toMatch(/grant execute on function public\.record_ad_click\([^)]*\) to service_role;/)
  })

  it('12. each participant helper gains a one-argument overload with no auth.uid() parameter, granted to authenticated only', () => {
    const oneArgSpecs: Record<string, RegExp> = {
      is_barter_contribution_participant: /\(ba\.party_a_id = auth\.uid\(\) or ba\.party_b_id = auth\.uid\(\)\)/,
      is_dispute_participant: /d\.raised_by = auth\.uid\(\)/,
      is_message_participant: /b\.renter_id = auth\.uid\(\) or b\.merchant_id = auth\.uid\(\)/,
    }
    for (const [name, pattern] of Object.entries(oneArgSpecs)) {
      const oneArgDefMatch = normalized.match(new RegExp(`create or replace function public\\.${name}\\(p_\\w+ uuid\\)\\s*returns boolean`))
      expect(oneArgDefMatch, `${name}: one-argument overload not found`).toBeTruthy()
      const body = extractFunctionBody(sql, name, 0)
      expect(body, `${name}: one-argument body missing expected auth.uid() predicate`).toMatch(pattern)
      expect(body, `${name}: one-argument body must never reference p_user_id`).not.toMatch(/p_user_id/)
      expect(normalized).toMatch(new RegExp(`revoke all on function public\\.${name}\\(uuid\\) from public, anon;`))
      expect(normalized).toMatch(new RegExp(`grant execute on function public\\.${name}\\(uuid\\) to authenticated;`))
    }
  })

  it('13. each participant helper\'s original two-argument overload is left undefined in this migration (its body is unchanged from the original schema -- only its grants change) but is narrowed to service_role only -- no authenticated/anon/public access remains on it', () => {
    for (const name of ['is_barter_contribution_participant', 'is_dispute_participant', 'is_message_participant']) {
      // The two-argument overload's BODY must not be redefined here -- it
      // is unchanged from its original defining migration; this
      // migration only adjusts its grants.
      expect(codeOnly, `${name}: two-argument overload unexpectedly redefined`).not.toMatch(
        new RegExp(`create or replace function public\\.${name}\\(p_\\w+ uuid, p_user_id uuid\\)`)
      )
      expect(normalized).toMatch(new RegExp(`revoke all on function public\\.${name}\\(uuid, uuid\\) from public, anon, authenticated;`))
      expect(normalized).toMatch(new RegExp(`grant execute on function public\\.${name}\\(uuid, uuid\\) to service_role;`))
      // No grant anywhere gives the two-argument overload to authenticated/anon/public.
      const grantLines = normalized.match(new RegExp(`grant execute on function public\\.${name}\\(uuid, uuid\\) to [^;]+;`, 'g')) ?? []
      expect(grantLines).toHaveLength(1)
      expect(grantLines[0]).toMatch(/to service_role;$/)
    }
  })

  it('14. all 6 dependent RLS policies are redefined (DROP POLICY IF EXISTS + CREATE POLICY) to call the new one-argument overload instead of passing auth.uid() as a second argument', () => {
    const policies: Array<{ name: string; table: string; pattern: RegExp }> = [
      { name: 'barter_contribution_details: participants read', table: 'barter_contribution_details', pattern: /using \(public\.is_barter_contribution_participant\(offer_item_id\)\);/ },
      { name: 'barter_contribution_milestones: participants read', table: 'barter_contribution_milestones', pattern: /using \(public\.is_barter_contribution_participant\(offer_item_id\)\);/ },
      { name: 'barter_milestone_evidence: participants read', table: 'barter_milestone_evidence', pattern: /using \(public\.is_barter_contribution_participant\(\s*\(select offer_item_id from public\.barter_contribution_milestones where id = milestone_id\)\s*\)\);/ },
      { name: 'dispute_history: parties read', table: 'dispute_history', pattern: /using \(public\.is_dispute_participant\(dispute_id\)\);/ },
      { name: 'dispute_evidence: parties read', table: 'dispute_evidence', pattern: /using \(public\.is_dispute_participant\(dispute_id\)\);/ },
      { name: 'message_attachments: parties read', table: 'message_attachments', pattern: /using \(public\.is_message_participant\(message_id\)\);/ },
    ]
    for (const { name, table, pattern } of policies) {
      expect(sql, `${name}: missing DROP POLICY IF EXISTS`).toMatch(new RegExp(`drop policy if exists "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" on public\\.${table};`))
      const createIdx = sql.indexOf(`create policy "${name}"`)
      expect(createIdx, `${name}: missing CREATE POLICY`).toBeGreaterThan(-1)
      const window = sql.slice(createIdx, createIdx + 400)
      expect(window, `${name}: policy predicate does not match the new one-argument form`).toMatch(pattern)
      // No policy anywhere still passes a second (auth.uid()) argument to any is_*_participant call.
      expect(window).not.toMatch(/is_\w+_participant\([^)]*,\s*auth\.uid\(\)\)/)
    }
  })

  it('15. no participant-helper policy anywhere in this migration still calls the two-argument form with an explicit auth.uid() second argument', () => {
    expect(codeOnly).not.toMatch(/is_barter_contribution_participant\([^)]+,\s*auth\.uid\(\)\)/)
    expect(codeOnly).not.toMatch(/is_dispute_participant\([^)]+,\s*auth\.uid\(\)\)/)
    expect(codeOnly).not.toMatch(/is_message_participant\([^)]+,\s*auth\.uid\(\)\)/)
  })

  it('16. every redefined function retains "security definer" and a fixed search_path', () => {
    for (const name of ['record_ad_impression', 'record_ad_click', 'is_barter_contribution_participant', 'is_dispute_participant', 'is_message_participant']) {
      const defIdx = sql.search(new RegExp(`create or replace function public\\.${name}\\(`))
      const header = sql.slice(defIdx, sql.indexOf('as $$', defIdx))
      expect(header, `${name}: missing security definer`).toMatch(/security definer/)
      expect(header, `${name}: missing fixed search_path`).toMatch(/set search_path = public/)
    }
  })

  it('17. no dynamic SQL exists anywhere in this migration (no EXECUTE/format/quote_ident/quote_literal)', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })

  it('18. no table, trigger, or RLS enable/disable statement exists in this migration beyond the one documented ad_impressions column addition and the 6 documented policy redefinitions', () => {
    expect(codeOnly).not.toMatch(/create table|create trigger|drop trigger|enable row level security|disable row level security/)
    const alterTableLines = codeOnly.match(/alter table [^\n]+/g) ?? []
    expect(alterTableLines).toHaveLength(1)
    expect(alterTableLines[0]).toMatch(/alter table public\.ad_impressions add column if not exists idempotency_key text;/)
    const dropPolicyLines = codeOnly.match(/drop policy if exists [^\n]+/g) ?? []
    expect(dropPolicyLines).toHaveLength(6)
  })

  it('19. this migration does not touch Support Centre, Intelligence, or E8 view objects -- scoped exclusively to the 8 named RPCs and their 6 dependent RLS policies', () => {
    expect(codeOnly).not.toMatch(/support_case|support_centre|intelligence_evaluation|admin_intelligence|security_definer_view|public_profiles|ad_packages_public|barter_locked_listings|rent_to_buy_locked_listings/i)
  })
})
