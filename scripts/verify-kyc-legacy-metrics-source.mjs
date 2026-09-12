#!/usr/bin/env node
/**
 * KYC Orphan Cleanup Phase B3M -- STATIC, SOURCE-ONLY verifier for the
 * durable legacy-finalization observability migration + route
 * instrumentation.
 *
 * Deliberately the opposite of scripts/verify-kyc-upload-intents-
 * schema.mjs, which is confirmed (by reading its own source) to shell
 * out to `npx supabase db query --linked` -- a live, CLI-mediated
 * database channel that remains forbidden under the current KYC
 * remediation's Supabase CLI ban. This script:
 *
 *   - reads local repository files only (fs.readFileSync)
 *   - never imports node:child_process
 *   - never runs `npx`, `supabase`, or any external process
 *   - never opens a network connection
 *   - never reads a database credential or connection string
 *
 * It can therefore run safely during B3M-B1, before the new migration
 * is ever applied -- it proves the MIGRATION FILE and ROUTE SOURCE say
 * the right thing. It does NOT and CANNOT prove the live database
 * reflects them; that remains a live-verification concern for B3M-B2,
 * explicitly out of scope here (see this script's own final summary
 * line: "DEEP LIVE PG_CATALOG VERIFICATION: NOT RUN / NOT PROVEN").
 *
 * Usage: node scripts/verify-kyc-legacy-metrics-source.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

let failures = 0
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : '')
  }
}

// ── Locate exactly one migration matching the expected suffix. ──
console.log('=== Migration file discovery ===')
const migrationsDir = path.join(REPO_ROOT, 'supabase', 'migrations')
const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('_add_kyc_legacy_finalize_metrics.sql'))
check('exactly one matching migration file exists', migrationFiles.length === 1, migrationFiles)

if (migrationFiles.length !== 1) {
  console.log(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}

const migrationPath = path.join(migrationsDir, migrationFiles[0])
const migrationSql = readFileSync(migrationPath, 'utf8')
console.log(`Using migration: ${migrationFiles[0]}`)

// Isolate just the CREATE TABLE column list -- the file's explanatory
// header comment legitimately *discusses* storage_path/user_id/etc. in
// prose (explaining what this table deliberately does NOT store), so
// scanning the whole file text for those tokens would false-positive
// on that prose. Only the actual column list matters here.
const createTableMatch = migrationSql.match(/create table if not exists public\.kyc_legacy_finalize_daily_metrics\s*\(([\s\S]*?)\);/i)
const tableColumnListText = createTableMatch ? createTableMatch[1] : ''

console.log('\n=== Table: kyc_legacy_finalize_daily_metrics ===')
check(
  'exact table name',
  /create table if not exists public\.kyc_legacy_finalize_daily_metrics/i.test(migrationSql)
)
check('column: bucket_date date primary key', /bucket_date\s+date\s+primary key/i.test(migrationSql))
check(
  'column: legacy_attempt_count bigint not null default 0',
  /legacy_attempt_count\s+bigint\s+not null\s+default 0/i.test(migrationSql)
)
check('non-negative check constraint', /check\s*\(\s*legacy_attempt_count\s*>=\s*0\s*\)/i.test(migrationSql))
check('column: created_at timestamptz', /created_at\s+timestamptz\s+not null\s+default now\(\)/i.test(migrationSql))
check('column: updated_at timestamptz', /updated_at\s+timestamptz\s+not null\s+default now\(\)/i.test(migrationSql))
check('CREATE TABLE column list located', tableColumnListText.length > 0)
check(
  'no extra identifying columns (user/document/path/mime/size/ip) in the actual column list',
  !/\b(user_id|document_id|storage_path|mime_type|file_size|ip_address|user_agent)\b/i.test(tableColumnListText)
)
check(
  'RLS enabled on the metrics table',
  /alter table public\.kyc_legacy_finalize_daily_metrics enable row level security/i.test(migrationSql)
)
check(
  'zero CREATE POLICY statements targeting the metrics table',
  !/create policy[^;]*kyc_legacy_finalize_daily_metrics/is.test(migrationSql)
)

console.log('\n=== Function: record_kyc_legacy_finalize_attempt ===')
check(
  'zero-argument function signature',
  /create or replace function public\.record_kyc_legacy_finalize_attempt\(\s*\)/i.test(migrationSql)
)
check('SECURITY DEFINER', /security definer/i.test(migrationSql))
check('search_path pinned to pg_catalog', /set search_path\s*=\s*pg_catalog/i.test(migrationSql))
check(
  'internal service_role caller guard present',
  /auth\.role\(\)\s+is\s+distinct\s+from\s+'service_role'/i.test(migrationSql) && /raise exception/i.test(migrationSql)
)
check(
  'caller guard is NULL-safe (IS DISTINCT FROM, never the NULL-unsafe <> form)',
  /auth\.role\(\)\s+is\s+distinct\s+from\s+'service_role'/i.test(migrationSql) &&
    !/auth\.role\(\)\s*<>\s*'service_role'/i.test(migrationSql)
)
check(
  'explicit UTC bucket derivation, not bare current_date',
  /at time zone 'utc'\)::date/i.test(migrationSql) && !/\bvalues\s*\(\s*current_date\b/i.test(migrationSql)
)
check(
  'atomic upsert: INSERT ... ON CONFLICT (bucket_date) DO UPDATE',
  /on conflict\s*\(\s*bucket_date\s*\)\s*do update/i.test(migrationSql)
)
check(
  'increments the existing count by exactly 1 (schema-qualified)',
  /legacy_attempt_count\s*=\s*public\.kyc_legacy_finalize_daily_metrics\.legacy_attempt_count\s*\+\s*1/i.test(migrationSql)
)

console.log('\n=== Function ACL ===')
check(
  'PUBLIC/anon/authenticated EXECUTE revoked in one statement',
  /revoke all on function public\.record_kyc_legacy_finalize_attempt\(\)\s*from\s*public\s*,\s*anon\s*,\s*authenticated/i.test(
    migrationSql
  )
)
check(
  'service_role EXECUTE granted',
  /grant execute on function public\.record_kyc_legacy_finalize_attempt\(\)\s*to\s*service_role/i.test(migrationSql)
)

console.log('\n=== Reporter: scripts/report-kyc-legacy-finalization-metrics.mjs ===')
const reporterPath = path.join(REPO_ROOT, 'scripts', 'report-kyc-legacy-finalization-metrics.mjs')
const reporterSource = readFileSync(reporterPath, 'utf8')
// Strip `//` line comments before scanning for actual code patterns --
// this file's own comments legitimately discuss `.limit()`/`.range()`
// in prose (explaining what is deliberately NOT used), which would
// otherwise false-positive a naive whole-file scan.
const reporterCodeOnly = reporterSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')

check(
  'imports buildObservationQueryBounds from the pure helper module',
  /import\s*\{[^}]*buildObservationQueryBounds[^}]*\}\s*from\s*['"]\.\/lib\/kyc-legacy-metrics-window\.mjs['"]/s.test(
    reporterSource
  )
)
check(
  'observation-window query is bounded by explicit gte/lte bucket_date, not a row-count limit',
  /\.gte\(\s*['"]bucket_date['"]\s*,\s*bounds\.gte\s*\)/.test(reporterSource) &&
    /\.lte\(\s*['"]bucket_date['"]\s*,\s*bounds\.lte\s*\)/.test(reporterSource)
)
check(
  'reporter never uses a row-count-based .limit()/.range() call anywhere (comments excluded)',
  !/\.(limit|range)\(/.test(reporterCodeOnly)
)
check(
  'a windowed-query error aborts before any streak computation (never falls through to computeObservationWindow)',
  (() => {
    const errIdx = reporterSource.indexOf('if (windowError)')
    const computeIdx = reporterSource.indexOf('computeObservationWindow({')
    if (errIdx === -1 || computeIdx === -1) return false
    if (errIdx >= computeIdx) return false
    return /return/.test(reporterSource.slice(errIdx, errIdx + 200))
  })()
)

// ── Route instrumentation: landmark ordering. Deliberately loose
// regexes (substring + indexOf ordering) rather than brittle
// whitespace-sensitive patterns -- the behavioral route tests are the
// stronger proof of actual ordering; this is a fast, static sanity
// check that the right landmarks exist in the right relative order. ──
console.log('\n=== Route: src/app/api/verification/documents/route.ts ===')
const routePath = path.join(REPO_ROOT, 'src', 'app', 'api', 'verification', 'documents', 'route.ts')
const routeSource = readFileSync(routePath, 'utf8')

const landmarks = [
  ["B2L intent-gate lookup (kyc_document_upload_intents select)", /from\(['"]kyc_document_upload_intents['"]\)/],
  ["intent-owned rejection (409)", /intentRows[^\n]*length > 0/],
  ["durable metric recorder call", /admin\.rpc\(['"]record_kyc_legacy_finalize_attempt['"]\)/],
  ["existing-row replay/conflict lookup", /from\(METADATA_TABLE\)[\s\S]{0,200}select\(/],
  ["Storage object info check", /storage\.from\(BUCKET\)\.info\(/],
  ["metadata insert", /from\(METADATA_TABLE\)[\s\S]{0,200}insert\(/],
]

const positions = landmarks.map(([label, re]) => {
  const m = routeSource.match(re)
  return { label, index: m ? routeSource.indexOf(m[0]) : -1 }
})

for (const p of positions) {
  check(`landmark present: ${p.label}`, p.index !== -1)
}

let inOrder = true
for (let i = 1; i < positions.length; i += 1) {
  if (positions[i - 1].index === -1 || positions[i].index === -1) continue
  if (positions[i].index <= positions[i - 1].index) inOrder = false
}
check(
  'landmarks appear in the required relative order',
  inOrder,
  positions.map((p) => `${p.label}@${p.index}`)
)

check(
  'metric RPC uses the existing admin (service-role) client, not a new client',
  /admin\.rpc\(['"]record_kyc_legacy_finalize_attempt['"]\)/.test(routeSource) && !/createClient\(/.test(routeSource)
)

check(
  'metric failure is fail-closed with a sanitized 503, not exposing DB error text',
  /metricError[\s\S]{0,300}status:\s*503/.test(routeSource)
)

console.log('\n=== Deliberately deferred to B3M-B2 (not run here) ===')
console.log('DEEP LIVE PG_CATALOG VERIFICATION: NOT RUN / NOT PROVEN')
console.log('(RLS flag, exact policy count, function owner, and live grantee lists require')
console.log(' either the banned Supabase CLI or an approved non-CLI equivalent that does not')
console.log(' yet exist in this repo -- see the B3M-A2 architecture report.)')

console.log(failures === 0 ? '\nAll static source checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
