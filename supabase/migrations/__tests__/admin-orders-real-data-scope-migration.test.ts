import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free regression guards over the raw migration SQL text -- same
// convention as src/lib/payments/__tests__/webhook-inbox-migration.test.ts.
// No database connection: this only proves the migration SOURCE
// preserves _admin_list_orders_page's existing contract while adding
// Real Data provenance -- not that it has been applied anywhere (it
// has not -- this phase does not apply it).
const REPO_ROOT = join(__dirname, '../../..')
const migrationPath = join(REPO_ROOT, 'supabase/migrations/20261028090000_admin_orders_real_data_scope.sql')
const sql = readFileSync(migrationPath, 'utf-8')

const PRIOR_MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20260904000026_admin_orders_relational_pagination.sql')
const priorSql = readFileSync(PRIOR_MIGRATION_PATH, 'utf-8')

function functionBody(source: string, name: string): string {
  const marker = `create or replace function public.${name}`
  const idx = source.indexOf(marker)
  expect(idx, `expected to find "${marker}"`).toBeGreaterThanOrEqual(0)
  return source.slice(idx).split('\n$$;')[0] + '\n$$;'
}

describe('D3-D-F1 admin-orders-real-data-scope migration (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D-F1)', () => {
  it('1. does not edit the historical prior migration -- this is a new, separate file', () => {
    expect(priorSql).not.toMatch(/data_classification/)
    expect(priorSql).not.toMatch(/D3-D/)
  })

  it('2. redefines exactly _admin_list_orders_page -- no other function name', () => {
    expect(sql).toMatch(/create or replace function public\._admin_list_orders_page\(/)
    const otherFnMatches = sql.match(/create or replace function public\.(?!_admin_list_orders_page\b)\w+/g) ?? []
    expect(otherFnMatches).toHaveLength(0)
  })

  it('3. the function signature (parameter list) is byte-identical to the prior migration', () => {
    const priorSig = priorSql.slice(priorSql.indexOf('create or replace function public._admin_list_orders_page('), priorSql.indexOf('returns table'))
    const newSig = sql.slice(sql.indexOf('create or replace function public._admin_list_orders_page('), sql.indexOf('returns table'))
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

  it('6. buyer classification positive equality is present -- never a negative comparison', () => {
    expect(sql).toMatch(/bp\.data_classification = 'real'/)
    expect(sql).not.toMatch(/bp\.data_classification\s*(<>|!=)\s*'test'/)
  })

  it('7. seller classification positive equality is present -- never a negative comparison', () => {
    expect(sql).toMatch(/sp\.data_classification = 'real'/)
    expect(sql).not.toMatch(/sp\.data_classification\s*(<>|!=)\s*'test'/)
  })

  it('8. listing is_test=false is present -- never a negative/<> comparison', () => {
    expect(sql).toMatch(/l\.is_test = false/)
    expect(sql).not.toMatch(/l\.is_test\s*(<>|!=)\s*true/)
  })

  it('9. the three provenance predicates sit inside the `base` CTE\'s own WHERE clause, immediately after its LEFT JOINs -- the outer query (FROM base, search_pattern) never references bp/sp/l, so a predicate there would be an invalid out-of-scope alias reference', () => {
    const baseStart = sql.indexOf('base as (')
    const baseEnd = sql.indexOf(')\n  select\n    base.id')
    expect(baseStart).toBeGreaterThanOrEqual(0)
    expect(baseEnd).toBeGreaterThan(baseStart)
    const baseBody = sql.slice(baseStart, baseEnd)
    expect(baseBody).toMatch(/bp\.data_classification = 'real'/)
    expect(baseBody).toMatch(/sp\.data_classification = 'real'/)
    expect(baseBody).toMatch(/l\.is_test = false/)

    const outerQuery = sql.slice(baseEnd)
    expect(outerQuery).not.toMatch(/\bbp\./)
    expect(outerQuery).not.toMatch(/\bsp\./)
    expect(outerQuery.replace(/base\.\w+/g, '')).not.toMatch(/\bl\./)
  })

  it('10. the base CTE still LEFT JOINs listings/profiles (not INNER) -- a missing row must fail the WHERE via NULL, not be structurally excluded before classification can even be evaluated', () => {
    const fnBody = functionBody(sql, '_admin_list_orders_page')
    expect(fnBody).toMatch(/left join public\.listings l on l\.id = o\.listing_id/)
    expect(fnBody).toMatch(/left join public\.profiles bp on bp\.id = o\.buyer_id/)
    expect(fnBody).toMatch(/left join public\.profiles sp on sp\.id = o\.seller_id/)
  })

  it('11. the existing keyset cursor predicate is preserved unchanged', () => {
    expect(sql).toMatch(/p_cursor_created_at is null or p_cursor_id is null\s*\n\s*or \(base\.created_at, base\.id\) < \(p_cursor_created_at, p_cursor_id\)/)
  })

  it('12. the existing escaped ILIKE search behavior is preserved unchanged', () => {
    expect(sql).toContain(`replace(replace(replace(trim(p_search), '\\', '\\\\'), '%', '\\%'), '_', '\\_')`)
    expect(sql).toContain(`order_reference ilike search_pattern.pattern escape '\\'`)
  })

  it('13. the existing payment-status EXISTS filter is preserved unchanged', () => {
    expect(sql).toMatch(/exists \(\s*\n\s*select 1 from public\.payments pay\s*\n\s*where pay\.order_id = base\.id\s*\n\s*and pay\.payment_type = 'order_payment'\s*\n\s*and pay\.status::text = p_payment_status\s*\n\s*\)/)
  })

  it('14. the existing dispute EXISTS filter is preserved unchanged', () => {
    expect(sql).toMatch(/exists \(select 1 from public\.disputes d where d\.order_id = base\.id\) = p_disputed/)
  })

  it('15. p_limit is preserved and still applied via LIMIT', () => {
    expect(sql).toMatch(/limit p_limit;/)
  })

  it('16. the final order by (created_at desc, id desc) is preserved unchanged', () => {
    expect(sql).toMatch(/order by base\.created_at desc, base\.id desc/)
  })

  it('17. existing grants (revoke public/anon/authenticated, grant service_role) are preserved', () => {
    expect(sql).toMatch(/revoke all on function public\._admin_list_orders_page\([^)]*\) from public, anon, authenticated;/)
    expect(sql).toMatch(/grant execute on function public\._admin_list_orders_page\([^)]*\) to service_role;/)
  })
})
