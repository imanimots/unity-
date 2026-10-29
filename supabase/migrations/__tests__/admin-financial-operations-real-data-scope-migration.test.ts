import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free regression guards over the raw migration SQL text -- same
// convention as admin-orders-real-data-scope-migration.test.ts and
// admin-payouts-real-data-scope-migration.test.ts. No database
// connection: this only proves the migration SOURCE defines a correctly
// Real-Data-scoped, keyset-pagination-safe RPC -- not that it has been
// applied anywhere (it has not -- this phase does not apply it).
const REPO_ROOT = join(__dirname, '../../..')
const migrationPath = join(REPO_ROOT, 'supabase/migrations/20261029090100_admin_financial_operations_real_data_scope.sql')
const sql = readFileSync(migrationPath, 'utf-8')

describe('D3-E-F1 admin-financial-operations-real-data-scope migration (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E-F1)', () => {
  it('1. defines exactly _admin_list_financial_operations -- no other function name', () => {
    expect(sql).toMatch(/create or replace function public\._admin_list_financial_operations\(/)
    const otherFnMatches = sql.match(/create or replace function public\.(?!_admin_list_financial_operations\b)\w+/g) ?? []
    expect(otherFnMatches).toHaveLength(0)
  })

  it('2. the signature carries a status filter plus a (ts, id) keyset cursor pair and a limit', () => {
    const sig = sql.slice(sql.indexOf('create or replace function public._admin_list_financial_operations('), sql.indexOf('returns table'))
    expect(sig).toMatch(/p_status text default null/)
    expect(sig).toMatch(/p_cursor_ts timestamptz default null/)
    expect(sig).toMatch(/p_cursor_id uuid default null/)
    expect(sig).toMatch(/p_limit int default \d+/)
  })

  it('3. the return shape carries all four parent-family id/reference columns -- not just booking/order', () => {
    const ret = sql.slice(sql.indexOf('returns table('), sql.indexOf('language sql'))
    expect(ret).toMatch(/booking_id uuid/)
    expect(ret).toMatch(/booking_reference text/)
    expect(ret).toMatch(/order_id uuid/)
    expect(ret).toMatch(/order_reference text/)
    expect(ret).toMatch(/barter_agreement_id uuid/)
    expect(ret).toMatch(/barter_agreement_reference text/)
    expect(ret).toMatch(/rent_to_buy_agreement_id uuid/)
  })

  it('4. language/stability/security/search_path declarations are present', () => {
    expect(sql).toMatch(/language sql\s*\nstable\s*\nsecurity definer\s*\nset search_path = public/)
  })

  it('5. booking provenance requires renter real AND merchant real AND listing non-test', () => {
    expect(sql).toMatch(/bp_renter\.data_classification = 'real' and bp_merchant\.data_classification = 'real' and bl\.is_test = false/)
  })

  it('6. order provenance requires buyer real AND seller real AND listing non-test', () => {
    expect(sql).toMatch(/op_buyer\.data_classification = 'real' and op_seller\.data_classification = 'real' and ol\.is_test = false/)
  })

  it('7. barter provenance requires both parties real, with no is_test/anchor_listing check (barter_agreements has no is_test column of its own)', () => {
    expect(sql).toMatch(/bap_a\.data_classification = 'real' and bap_b\.data_classification = 'real'/)
    const fnBodyOnly = sql.slice(sql.indexOf('as $$'))
    expect(fnBodyOnly).not.toMatch(/anchor_listing/)
  })

  it('8. rent_to_buy provenance requires the agreement non-test AND merchant real AND customer real', () => {
    expect(sql).toMatch(/rtb\.is_test = false and rtbp_merchant\.data_classification = 'real' and rtbp_customer\.data_classification = 'real'/)
  })

  it('9. every provenance branch is wrapped in coalesce(..., false) -- a NULL comparison (missing/unresolved parent) fails closed, never defaults to real', () => {
    const matches = sql.match(/coalesce\([^)]*data_classification[^)]*,\s*false\)/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(4)
  })

  it('10. every participant/listing/agreement join is a LEFT JOIN, never INNER -- a missing row must fail the WHERE via NULL, not be structurally excluded before classification can even be evaluated', () => {
    expect(sql).not.toMatch(/\binner join\b/i)
    expect(sql).toMatch(/left join public\.bookings b on b\.id = p\.booking_id/)
    expect(sql).toMatch(/left join public\.orders o on o\.id = p\.order_id/)
    expect(sql).toMatch(/left join public\.barter_agreements ba on ba\.id = p\.barter_agreement_id/)
    expect(sql).toMatch(/left join public\.rent_to_buy_agreements rtb on rtb\.id = p\.rent_to_buy_agreement_id/)
  })

  it('11. the Real Data predicate (base.is_real) is applied in the outer WHERE, before the keyset cursor predicate and before LIMIT', () => {
    const whereIdx = sql.indexOf('\n  where\n')
    const isRealIdx = sql.indexOf('base.is_real')
    const cursorIdx = sql.indexOf('p_cursor_ts is null or p_cursor_id is null')
    const limitIdx = sql.indexOf('limit p_limit;')
    expect(whereIdx).toBeGreaterThanOrEqual(0)
    expect(isRealIdx).toBeGreaterThan(whereIdx)
    expect(cursorIdx).toBeGreaterThan(isRealIdx)
    expect(limitIdx).toBeGreaterThan(cursorIdx)
  })

  it('12. the keyset cursor predicate reuses the exact (requested_at, id) descending tie-break the prior client-side `.or()` used', () => {
    expect(sql).toMatch(/\(base\.requested_at, base\.id\) < \(p_cursor_ts, p_cursor_id\)/)
    expect(sql).toMatch(/order by base\.requested_at desc, base\.id desc/)
  })

  it('13. the status filter preserves the existing "all"/null-means-unfiltered semantics', () => {
    expect(sql).toMatch(/\(p_status is null or p_status = 'all' or base\.status = p_status\)/)
  })

  it('14. grants restrict execution to service_role only', () => {
    expect(sql).toMatch(/revoke all on function public\._admin_list_financial_operations\([^)]*\) from public, anon, authenticated;/)
    expect(sql).toMatch(/grant execute on function public\._admin_list_financial_operations\([^)]*\) to service_role;/)
  })

  it('15. never uses a negative/<> classification comparison anywhere in the function body', () => {
    expect(sql).not.toMatch(/data_classification\s*(<>|!=)\s*'test'/)
    expect(sql).not.toMatch(/is_test\s*(<>|!=)\s*true/)
  })
})
