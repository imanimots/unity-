import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Proves the exact defect fixed in this phase cannot silently regress:
 * RTB evidence upload's Storage-failure/catch-all path must never read
 * a caught error's own .message (which could contain a raw Supabase
 * provider string -- RLS policy wording, bucket/path internals, or a
 * bare network error) into anything user-facing.
 *
 * There is no React/jsdom test harness in this repo (see
 * src/lib/rent-to-buy/__tests__/evidence-upload.test.ts's own note on
 * the equivalent F4 "no network call on invalid file" limitation), so
 * this is a source-text invariant check, not a runtime render test --
 * the same "structural proof, transparently disclosed" standard
 * already accepted for that prior phase. It's a stronger guarantee
 * than re-injecting a handful of example dangerous strings into a
 * mocked call: no matter what the underlying error's message actually
 * says (Postgres RLS violation, storage path, "Failed to fetch", or
 * anything else), this file structurally cannot read it, because
 * nothing in the source ever dereferences .message on a caught/storage
 * error at all.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const componentSource = readFileSync(join(__dirname, '../evidence-upload.tsx'), 'utf8')

describe('RentToBuyEvidenceUpload -- Storage/catch-all error safety', () => {
  it('never reads uploadError.message', () => {
    expect(componentSource).not.toMatch(/uploadError\.message/)
  })

  it('never reads .message on any caught error variable', () => {
    // Matches e.g. `err.message`, `error.message`, `e.message` -- any
    // short catch-variable identifier followed by .message.
    expect(componentSource).not.toMatch(/\b(err|error|e)\.message\b/)
  })

  it('never coerces a caught error to a string for display (String(err), `${err}`, etc.)', () => {
    expect(componentSource).not.toMatch(/String\(\s*(err|error|e)\s*\)/)
    expect(componentSource).not.toMatch(/\$\{\s*(err|error|e)\s*\}/)
  })

  it('the catch block is bare (no bound error variable) -- matches the established dispute/barter evidence-panel convention', () => {
    expect(componentSource).toMatch(/}\s*catch\s*{/)
    expect(componentSource).not.toMatch(/catch\s*\(\s*\w+\s*\)/)
  })

  it('Storage failure and the catch-all both resolve to the safe, localized couldNotUpload message', () => {
    const occurrences = componentSource.match(/t\('errors\.couldNotUpload'\)/g) ?? []
    expect(occurrences.length).toBe(2) // the uploadError branch + the catch-all
  })

  it('registration failure still shows the server-authored safe message, unchanged from prior behavior', () => {
    expect(componentSource).toMatch(/body\.error \?\? t\('errors\.generic'\)/)
  })
})
