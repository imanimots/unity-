import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free regression guards over the raw migration SQL text -- same
// convention as admin-orders-real-data-scope-migration.test.ts. No
// database connection: this only proves the migration SOURCE preserves
// _admin_list_merchant_payouts' existing contract while adding Real
// Data provenance -- not that it has been applied anywhere (it has
// not -- this phase does not apply it).
const REPO_ROOT = join(__dirname, '../../..')
const migrationPath = join(REPO_ROOT, 'supabase/migrations/20261029090000_admin_payouts_real_data_scope.sql')
const sql = readFileSync(migrationPath, 'utf-8')

const PRIOR_MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20260904000022_admin_payout_search_relational.sql')
const priorSql = readFileSync(PRIOR_MIGRATION_PATH, 'utf-8')

describe('D3-E-F1 admin-payouts-real-data-scope migration (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E-F1)', () => {
  it('1. does not edit the historical prior migration -- this is a new, separate file', () => {
    expect(priorSql).not.toMatch(/data_classification/)
    expect(priorSql).not.toMatch(/D3-E/)
  })

  it('2. redefines exactly _admin_list_merchant_payouts -- no other function name', () => {
    expect(sql).toMatch(/create or replace function public\._admin_list_merchant_payouts\(/)
    const otherFnMatches = sql.match(/create or replace function public\.(?!_admin_list_merchant_payouts\b)\w+/g) ?? []
    expect(otherFnMatches).toHaveLength(0)
  })

  it('3. the function signature (parameter list, including defaults) is byte-identical to the prior migration', () => {
    const priorSig = priorSql.slice(priorSql.indexOf('create or replace function public._admin_list_merchant_payouts('), priorSql.indexOf('returns table'))
    const newSig = sql.slice(sql.indexOf('create or replace function public._admin_list_merchant_payouts('), sql.indexOf('returns table'))
    expect(newSig).toBe(priorSig)
  })

  it('4. the return table contract is byte-identical to the prior migration', () => {
    const priorReturn = priorSql.slice(priorSql.indexOf('returns table('), priorSql.indexOf('language sql'))
    const newReturn = sql.slice(sql.indexOf('returns table('), sql.indexOf('language sql'))
    expect(newReturn).toBe(priorReturn)
  })

  it('5. language/stability/security/search_path declarations are preserved', () => {
    expect(sql).toMatch(/language sql\s*\nstable\s*\nsecurity definer\s*\nset search_path = public/)
  })

  it('6. merchant classification positive equality is present -- never a negative comparison', () => {
    expect(sql).toMatch(/base\.merchant_classification = 'real'/)
    expect(sql).not.toMatch(/merchant_classification\s*(<>|!=)\s*'test'/)
  })

  it('7. renter classification positive equality is present -- never a negative comparison', () => {
    expect(sql).toMatch(/base\.renter_classification = 'real'/)
    expect(sql).not.toMatch(/renter_classification\s*(<>|!=)\s*'test'/)
  })

  it('8. listing is_test=false is present for booking-linked payouts -- never a negative/<> comparison', () => {
    expect(sql).toMatch(/base\.listing_is_test = false/)
    expect(sql).not.toMatch(/listing_is_test\s*(<>|!=)\s*true/)
  })

  it('9. a payout with no booking_id is allowed through on merchant-real alone (booking_id IS NULL short-circuits the renter/listing check)', () => {
    expect(sql).toMatch(/base\.booking_id is null\s*\n\s*or \(base\.renter_classification = 'real' and base\.listing_is_test = false\)/)
  })

  it('10. the provenance predicates sit in the outer WHERE, after the existing filters, and before ORDER BY/LIMIT', () => {
    const whereIdx = sql.indexOf('\n  where\n')
    const provenanceIdx = sql.indexOf("and base.merchant_classification = 'real'")
    const orderByIdx = sql.indexOf('order by base.created_at desc, base.id desc')
    expect(whereIdx).toBeGreaterThanOrEqual(0)
    expect(provenanceIdx).toBeGreaterThan(whereIdx)
    expect(orderByIdx).toBeGreaterThan(provenanceIdx)
  })

  it('11. the base CTE LEFT JOINs profiles/bookings/listings (not INNER) -- a missing/unresolved row must fail the WHERE via NULL, not be structurally excluded before classification can even be evaluated', () => {
    expect(sql).toMatch(/left join public\.profiles pr on pr\.id = mp\.merchant_id/)
    expect(sql).toMatch(/left join public\.bookings b on b\.id = mp\.booking_id/)
    expect(sql).toMatch(/left join public\.listings l on l\.id = b\.listing_id/)
  })

  it('12. a new LEFT JOIN resolves the booking renter profile (the historical query never joined it at all)', () => {
    expect(sql).toMatch(/left join public\.profiles rp on rp\.id = b\.renter_id/)
  })

  it('13. the existing escaped ILIKE search behavior is preserved unchanged', () => {
    expect(sql).toContain(`replace(replace(replace(trim(p_search), '\\', '\\\\'), '%', '\\%'), '_', '\\_')`)
    expect(sql).toContain(`coalesce(base.merchant_name, '') ilike search_pattern.pattern escape '\\'`)
    expect(sql).toContain(`coalesce(base.listing_title, '') ilike search_pattern.pattern escape '\\'`)
    expect(sql).toContain(`coalesce(base.booking_reference, '') ilike search_pattern.pattern escape '\\'`)
    expect(sql).toContain(`coalesce(base.payout_reference, '') ilike search_pattern.pattern escape '\\'`)
  })

  it('14. the existing status filter is preserved unchanged', () => {
    expect(sql).toMatch(/\(p_status is null or p_status = 'all' or base\.status = p_status\)/)
  })

  it('15. the existing failed-only filter is preserved unchanged', () => {
    expect(sql).toMatch(/\(not p_failed_only or base\.status = 'failed'\)/)
  })

  it('16. the existing overdue-only filter (and its 48-hour threshold) is preserved unchanged', () => {
    expect(sql).toMatch(/\(not p_overdue_only or base\.is_overdue\)/)
    expect(sql).toMatch(/mp\.status = 'pending' and mp\.created_at < now\(\) - interval '48 hours'/)
    expect(sql).toMatch(/mp\.status = 'processing' and mp\.processing_started_at is not null and mp\.processing_started_at < now\(\) - interval '48 hours'/)
  })

  it('17. the existing dispute-related filter (and its EXISTS subquery) is preserved unchanged', () => {
    expect(sql).toMatch(/\(not p_dispute_related or base\.has_unresolved_dispute\)/)
    expect(sql).toMatch(/exists \(\s*\n\s*select 1 from public\.disputes d\s*\n\s*where d\.booking_id = mp\.booking_id and d\.status not in \('resolved', 'closed', 'cancelled'\)\s*\n\s*\)/)
  })

  it('18. the existing restricted-merchant filter is preserved unchanged', () => {
    expect(sql).toMatch(/\(not p_restricted_merchant or base\.merchant_restricted\)/)
    expect(sql).toMatch(/\(pr\.account_status in \('suspended', 'restricted'\)\) as merchant_restricted/)
  })

  it('19. the existing date-range filters are preserved unchanged', () => {
    expect(sql).toMatch(/\(p_date_from is null or base\.created_at >= p_date_from\)/)
    expect(sql).toMatch(/\(p_date_to is null or base\.created_at <= p_date_to\)/)
  })

  it('20. the final order by (created_at desc, id desc) and limit are preserved unchanged', () => {
    expect(sql).toMatch(/order by base\.created_at desc, base\.id desc\s*\n\s*limit p_limit;/)
  })

  it('21. existing grants (revoke public/anon/authenticated, grant service_role) are preserved', () => {
    expect(sql).toMatch(/revoke all on function public\._admin_list_merchant_payouts\([^)]*\) from public, anon, authenticated;/)
    expect(sql).toMatch(/grant execute on function public\._admin_list_merchant_payouts\([^)]*\) to service_role;/)
  })
})
