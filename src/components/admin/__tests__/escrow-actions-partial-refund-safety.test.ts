import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * E25: partial escrow refunds are not currently supported (see
 * docs/ESCROW_ARCHITECTURE.md's "Known limitations" section) -- no
 * transition anywhere accepts the resulting 'partially_refunded'
 * status as a source, so the admin UI must no longer invite an
 * arbitrary refund amount that the orchestrator and database RPC will
 * now always reject for anything other than the full held principal.
 *
 * There is no React/jsdom test harness in this repo (no
 * @testing-library/react dependency exists), so this is a source-text
 * invariant check, not a runtime render test -- the same "structural
 * proof, transparently disclosed" standard already used elsewhere in
 * this codebase (e.g. the RTB evidence-upload error-safety test).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const componentSource = readFileSync(join(__dirname, '../escrow-actions.tsx'), 'utf8')

describe('EscrowActions -- partial-refund input safety', () => {
  it('no longer prompts for an arbitrary refund amount', () => {
    expect(componentSource).not.toMatch(/window\.prompt\(['"]Refund amount/)
  })

  it('accepts principalAmount as a required prop', () => {
    expect(componentSource).toMatch(/principalAmount: number/)
    expect(componentSource).toMatch(/EscrowActions\(\{ escrowId, status, defaultReleaseTo, principalAmount \}: Props\)/)
  })

  it('the refund action always sends the full principalAmount, never a user-typed amount', () => {
    const refundBlockStart = componentSource.indexOf("if (action === 'refund')")
    const refundBlockEnd = componentSource.indexOf('\n    }', refundBlockStart)
    const refundBlock = componentSource.slice(refundBlockStart, refundBlockEnd)
    expect(refundBlock).toMatch(/body\.amount = principalAmount/)
    expect(refundBlock).not.toMatch(/window\.prompt\([^)]*amount/i)
  })

  it('confirms the exact full amount with the admin before submitting (no silent full-amount submission)', () => {
    const refundBlockStart = componentSource.indexOf("if (action === 'refund')")
    const refundBlockEnd = componentSource.indexOf('\n    }', refundBlockStart)
    const refundBlock = componentSource.slice(refundBlockStart, refundBlockEnd)
    expect(refundBlock).toMatch(/window\.confirm\(/)
  })

  it('still requires a reason for the refund action, unchanged', () => {
    const refundBlockStart = componentSource.indexOf("if (action === 'refund')")
    const refundBlockEnd = componentSource.indexOf('\n    }', refundBlockStart)
    const refundBlock = componentSource.slice(refundBlockStart, refundBlockEnd)
    expect(refundBlock).toMatch(/window\.prompt\(['"]Reason for this refund/)
    expect(refundBlock).toMatch(/if \(!reason \|\| !reason\.trim\(\)\) return/)
  })

  it('the release and cancel action flows are untouched', () => {
    expect(componentSource).toMatch(/window\.prompt\('Recipient profile id to release funds to \(required\):', defaultReleaseTo \?\? ''\)/)
    expect(componentSource).toMatch(/window\.prompt\('Reason for cancelling this never-funded escrow transaction \(required\):'\)/)
  })
})
