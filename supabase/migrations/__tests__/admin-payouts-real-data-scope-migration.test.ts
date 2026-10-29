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

describe('D3-E-F1/F2 admin-payouts-real-data-scope migration (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E-F2)', () => {
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

  it('6. booking-branch merchant classification positive equality is present -- never a negative comparison', () => {
    expect(sql).toMatch(/base\.booking_id is not null and base\.merchant_classification = 'real'/)
    expect(sql).not.toMatch(/merchant_classification\s*(<>|!=)\s*'test'/)
  })

  it('7. booking-branch renter classification positive equality is present -- never a negative comparison', () => {
    expect(sql).toMatch(/base\.renter_classification = 'real'/)
    expect(sql).not.toMatch(/renter_classification\s*(<>|!=)\s*'test'/)
  })

  it('8. booking-branch listing is_test=false is present -- never a negative/<> comparison', () => {
    expect(sql).toMatch(/base\.listing_is_test = false/)
    expect(sql).not.toMatch(/listing_is_test\s*(<>|!=)\s*true/)
  })

  it('9. booking_id IS NULL is NOT an unconditional pass -- no merchant-only fallback remains for a null-booking payout', () => {
    expect(sql).not.toMatch(/base\.booking_id is null\s*\n\s*or \(base\.renter_classification/)
    // The only way a booking_id-null row can pass is via the separate RTB branch, which requires its own 3 positive checks.
    expect(sql).not.toMatch(/base\.merchant_classification = 'real'\s*\n\s*and \(\s*\n\s*base\.booking_id is null/)
  })

  it('10. the RTB branch is present, requiring rent_to_buy_agreement_id IS NOT NULL AND agreement.is_test=false AND RTB merchant real AND RTB customer real -- no merchant-only RTB shortcut remains', () => {
    expect(sql).toMatch(/base\.rent_to_buy_agreement_id is not null and base\.rtb_is_test = false and base\.rtb_merchant_classification = 'real' and base\.rtb_customer_classification = 'real'/)
    expect(sql).not.toMatch(/rtb_is_test\s*(<>|!=)\s*true/)
    expect(sql).not.toMatch(/rtb_merchant_classification\s*(<>|!=)\s*'test'/)
    expect(sql).not.toMatch(/rtb_customer_classification\s*(<>|!=)\s*'test'/)
  })

  it('11. the RTB merchant check is resolved via its own rent_to_buy_agreements.merchant_id join, never by reusing the payout\'s own merchant_id/pr join', () => {
    expect(sql).toMatch(/left join public\.profiles rtb_merchant on rtb_merchant\.id = rtb\.merchant_id/)
    expect(sql).toMatch(/rtb_merchant\.data_classification as rtb_merchant_classification/)
  })

  it('12. the two parent-family branches are combined with OR at the top level of the provenance predicate -- a row must satisfy one complete branch or the other, never a mix', () => {
    const provenanceStart = sql.indexOf('and (\n      (base.booking_id is not null')
    expect(provenanceStart).toBeGreaterThanOrEqual(0)
    const provenanceBlock = sql.slice(provenanceStart, sql.indexOf('order by base.created_at desc'))
    expect(provenanceBlock).toMatch(/\n\s*or\n/)
  })

  it('13. the provenance predicate sits in the outer WHERE, after the existing filters, and before ORDER BY/LIMIT', () => {
    const whereIdx = sql.indexOf('\n  where\n')
    const provenanceIdx = sql.indexOf('and (\n      (base.booking_id is not null')
    const orderByIdx = sql.indexOf('order by base.created_at desc, base.id desc')
    expect(whereIdx).toBeGreaterThanOrEqual(0)
    expect(provenanceIdx).toBeGreaterThan(whereIdx)
    expect(orderByIdx).toBeGreaterThan(provenanceIdx)
  })

  it('14. the base CTE LEFT JOINs profiles/bookings/listings/rent_to_buy_agreements (not INNER) -- a missing/unresolved row must fail the WHERE via NULL, not be structurally excluded before classification can even be evaluated', () => {
    expect(sql).toMatch(/left join public\.profiles pr on pr\.id = mp\.merchant_id/)
    expect(sql).toMatch(/left join public\.bookings b on b\.id = mp\.booking_id/)
    expect(sql).toMatch(/left join public\.listings l on l\.id = b\.listing_id/)
    expect(sql).toMatch(/left join public\.rent_to_buy_agreements rtb on rtb\.id = mp\.rent_to_buy_agreement_id/)
    expect(sql).toMatch(/left join public\.profiles rtb_customer on rtb_customer\.id = rtb\.customer_id/)
    expect(sql).not.toMatch(/\binner join\b/i)
  })

  it('15. a LEFT JOIN resolves the booking renter profile (the historical query never joined it at all)', () => {
    expect(sql).toMatch(/left join public\.profiles rp on rp\.id = b\.renter_id/)
  })

  it('16. a missing RTB agreement row fails closed structurally -- rtb_is_test/rtb_merchant_classification/rtb_customer_classification all resolve to NULL via the LEFT JOIN chain, which can never equal false/\'real\'', () => {
    expect(sql).toMatch(/rtb\.is_test as rtb_is_test/)
    // No COALESCE/default masks a NULL into a passing value for the RTB branch.
    expect(sql).not.toMatch(/coalesce\(rtb\.is_test/)
    expect(sql).not.toMatch(/coalesce\(rtb_merchant\.data_classification/)
    expect(sql).not.toMatch(/coalesce\(rtb_customer\.data_classification/)
  })

  it('17. the existing escaped ILIKE search behavior is preserved unchanged', () => {
    expect(sql).toContain(`replace(replace(replace(trim(p_search), '\\', '\\\\'), '%', '\\%'), '_', '\\_')`)
    expect(sql).toContain(`coalesce(base.merchant_name, '') ilike search_pattern.pattern escape '\\'`)
    expect(sql).toContain(`coalesce(base.listing_title, '') ilike search_pattern.pattern escape '\\'`)
    expect(sql).toContain(`coalesce(base.booking_reference, '') ilike search_pattern.pattern escape '\\'`)
    expect(sql).toContain(`coalesce(base.payout_reference, '') ilike search_pattern.pattern escape '\\'`)
  })

  it('18. the existing status filter is preserved unchanged', () => {
    expect(sql).toMatch(/\(p_status is null or p_status = 'all' or base\.status = p_status\)/)
  })

  it('19. the existing failed-only filter is preserved unchanged', () => {
    expect(sql).toMatch(/\(not p_failed_only or base\.status = 'failed'\)/)
  })

  it('20. the existing overdue-only filter (and its 48-hour threshold) is preserved unchanged', () => {
    expect(sql).toMatch(/\(not p_overdue_only or base\.is_overdue\)/)
    expect(sql).toMatch(/mp\.status = 'pending' and mp\.created_at < now\(\) - interval '48 hours'/)
    expect(sql).toMatch(/mp\.status = 'processing' and mp\.processing_started_at is not null and mp\.processing_started_at < now\(\) - interval '48 hours'/)
  })

  it('21. the existing dispute-related filter (and its EXISTS subquery) is preserved unchanged', () => {
    expect(sql).toMatch(/\(not p_dispute_related or base\.has_unresolved_dispute\)/)
    expect(sql).toMatch(/exists \(\s*\n\s*select 1 from public\.disputes d\s*\n\s*where d\.booking_id = mp\.booking_id and d\.status not in \('resolved', 'closed', 'cancelled'\)\s*\n\s*\)/)
  })

  it('22. the existing restricted-merchant filter is preserved unchanged', () => {
    expect(sql).toMatch(/\(not p_restricted_merchant or base\.merchant_restricted\)/)
    expect(sql).toMatch(/\(pr\.account_status in \('suspended', 'restricted'\)\) as merchant_restricted/)
  })

  it('23. the existing date-range filters are preserved unchanged', () => {
    expect(sql).toMatch(/\(p_date_from is null or base\.created_at >= p_date_from\)/)
    expect(sql).toMatch(/\(p_date_to is null or base\.created_at <= p_date_to\)/)
  })

  it('24. the final order by (created_at desc, id desc) and limit are preserved unchanged', () => {
    expect(sql).toMatch(/order by base\.created_at desc, base\.id desc\s*\n\s*limit p_limit;/)
  })

  it('25. existing grants (revoke public/anon/authenticated, grant service_role) are preserved', () => {
    expect(sql).toMatch(/revoke all on function public\._admin_list_merchant_payouts\([^)]*\) from public, anon, authenticated;/)
    expect(sql).toMatch(/grant execute on function public\._admin_list_merchant_payouts\([^)]*\) to service_role;/)
  })
})
