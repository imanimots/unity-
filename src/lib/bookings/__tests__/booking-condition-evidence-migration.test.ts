import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I: migration-contract test for
 * 20261021000000_booking_condition_evidence.sql.
 *
 * LIMITATION, stated explicitly per this codebase's own established
 * convention (see reconcile-adjustment-idempotency-migration.test.ts
 * and siblings): this test parses the migration's SQL source text and
 * asserts on its structure. It does NOT execute the SQL against a real
 * Postgres instance and does NOT prove RLS enforcement live -- no live
 * database is available to this test environment. What it DOES verify
 * directly from the text: the table/enum/index exist with the expected
 * shape, exactly two SELECT policies exist (parties, admin) and no
 * INSERT/UPDATE/DELETE policy exists for any client role, and the
 * storage bucket/policies for `rental-media` are NOT touched by this
 * migration (confirming the design decision to reuse the existing,
 * already-participant-scoped bucket rather than duplicating it).
 */

const MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261021000000_booking_condition_evidence.sql')

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf8')
}

describe('20261021000000_booking_condition_evidence.sql (category: P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I)', () => {
  it('1. defines the booking_evidence_stage enum with exactly pre_handover and post_return', () => {
    const sql = readMigration()
    expect(sql).toMatch(/create type booking_evidence_stage as enum \('pre_handover', 'post_return'\)/)
  })

  it('2. creates booking_condition_evidence with the required columns and FKs', () => {
    const sql = readMigration()
    expect(sql).toMatch(/create table if not exists public\.booking_condition_evidence/)
    expect(sql).toMatch(/booking_id\s+uuid not null references public\.bookings\(id\)/)
    expect(sql).toMatch(/uploaded_by\s+uuid not null references public\.profiles\(id\)/)
    expect(sql).toMatch(/evidence_stage\s+public\.booking_evidence_stage not null/)
    expect(sql).toMatch(/storage_path\s+text not null/)
    expect(sql).toMatch(/file_type\s+text not null check \(file_type in \('image', 'video'\)\)/)
    expect(sql).toMatch(/created_at\s+timestamptz not null default now\(\)/)
  })

  it('3. indexes (booking_id, evidence_stage)', () => {
    const sql = readMigration()
    expect(sql).toMatch(/create index if not exists booking_condition_evidence_booking_stage_idx\s+on public\.booking_condition_evidence\(booking_id, evidence_stage\)/)
  })

  it('4. enables RLS', () => {
    const sql = readMigration()
    expect(sql).toMatch(/alter table public\.booking_condition_evidence enable row level security/)
  })

  it('5. the parties-read policy checks real booking participancy (renter_id or merchant_id), not merely table membership', () => {
    const sql = readMigration()
    expect(sql).toMatch(/create policy "booking_condition_evidence: parties read"[\s\S]*?for select using \(\s*exists \(\s*select 1 from public\.bookings b\s*where b\.id = booking_condition_evidence\.booking_id\s*and \(b\.renter_id = auth\.uid\(\) or b\.merchant_id = auth\.uid\(\)\)/)
  })

  it('6. the admin-read policy checks a real admin role', () => {
    const sql = readMigration()
    expect(sql).toMatch(/create policy "booking_condition_evidence: admin read"[\s\S]*?profiles\.role = 'admin'/)
  })

  it('7. exactly two policies exist on this table, both SELECT -- no client INSERT/UPDATE/DELETE policy anywhere', () => {
    const sql = readMigration()
    const policyBlocks = sql.match(/create policy "booking_condition_evidence:[^"]*"/g) ?? []
    expect(policyBlocks).toHaveLength(2)
    expect(sql).not.toMatch(/create policy "booking_condition_evidence:[\s\S]*?for (insert|update|delete)/)
  })

  it('8. does not create a new storage bucket or touch rental-media storage policies -- the existing bucket/RLS is reused unchanged', () => {
    const sql = readMigration()
    expect(sql).not.toMatch(/insert into storage\.buckets/)
    expect(sql).not.toMatch(/create policy "storage rental-media/)
    expect(sql).not.toMatch(/drop policy/)
  })

  it('9. is read-only with respect to any OTHER existing table -- no ALTER/DROP of bookings or any pre-existing table', () => {
    const sql = readMigration()
    expect(sql).not.toMatch(/alter table public\.bookings/)
    expect(sql).not.toMatch(/drop table|drop column/i)
  })

  it('10. no unrelated DDL -- exactly one new table, one new enum, one new index', () => {
    const sql = readMigration()
    expect((sql.match(/create table if not exists/g) ?? []).length).toBe(1)
    expect((sql.match(/create type/g) ?? []).length).toBe(1)
    expect((sql.match(/create index if not exists/g) ?? []).length).toBe(1)
  })
})
