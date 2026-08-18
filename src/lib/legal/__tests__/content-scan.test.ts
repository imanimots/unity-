import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../../..')

function allTsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allTsxFiles(full))
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * Forbidden claim patterns, per Step 7's inventory. Deliberately does NOT
 * flag "escrow" as a bare word -- the legal pages themselves correctly use
 * it to explicitly DENY the arrangement ("does not provide a licensed
 * escrow service", "does not describe payment handling as escrow"). What
 * must never appear is escrow used as an affirmative claim -- captured
 * below as phrases, not the bare word.
 */
const FORBIDDEN_AFFIRMATIVE_CLAIMS: RegExp[] = [
  /held in escrow/i,
  /escrow[- ]protected/i,
  /^escrow payments?$/im, // heading-style "ESCROW PAYMENTS" trust badge
  /secure escrow/i,
  /regulated trust account/i,
  /guaranteed payment/i,
  /guaranteed rental/i,
  /fully insured/i,
  /sumsub verified/i,
  /peach secured/i,
  /payfast protected/i,
  /zero risk/i,
  /fraud[- ]proof/i,
  /government verified/i,
  /bank verified/i,
]

const MARKETING_AND_APP_DIRS = [
  join(REPO_ROOT, 'src/app/[locale]/(marketing)'),
  join(REPO_ROOT, 'src/app/[locale]/(dashboard)'),
  join(REPO_ROOT, 'src/app/[locale]/(auth)'),
  join(REPO_ROOT, 'src/app/admin'),
  join(REPO_ROOT, 'src/app/[locale]/layout.tsx'),
  join(REPO_ROOT, 'src/components'),
  join(REPO_ROOT, 'src/lib/assistant'),
  join(REPO_ROOT, 'src/lib/mock'),
]

function collectFiles(paths: string[]): string[] {
  const out: string[] = []
  for (const p of paths) {
    try {
      const files = allTsxFiles(p)
      out.push(...files)
    } catch {
      out.push(p) // p was itself a file (e.g. layout.tsx)
    }
  }
  return out
}

describe('content scan: no unsupported claims remain (category: Content)', () => {
  const files = collectFiles(MARKETING_AND_APP_DIRS)

  it('10. no forbidden affirmative claim appears anywhere in app/component/assistant source', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file.includes('__tests__') || file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
      const content = readFileSync(file, 'utf-8')
      for (const pattern of FORBIDDEN_AFFIRMATIVE_CLAIMS) {
        if (pattern.test(content)) offenders.push(`${file}: ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('11. the assistant knowledge base and chat route contain no PayFast-is-live claim', () => {
    const chatRoute = readFileSync(join(REPO_ROOT, 'src/app/api/assistant/chat/route.ts'), 'utf-8')
    const seedData = readFileSync(join(REPO_ROOT, 'src/lib/assistant/seed-data.ts'), 'utf-8')
    expect(chatRoute).not.toMatch(/Unity uses PayFast/i)
    expect(seedData).not.toMatch(/Unity uses PayFast/i)
  })

  it('12. the assistant does not claim a live selfie/biometric KYC step that does not exist', () => {
    const seedData = readFileSync(join(REPO_ROOT, 'src/lib/assistant/seed-data.ts'), 'utf-8')
    expect(seedData).not.toMatch(/live selfie/i)
  })

  it('13. the assistant does not state an invented cancellation-fee percentage', () => {
    const chatRoute = readFileSync(join(REPO_ROOT, 'src/app/api/assistant/chat/route.ts'), 'utf-8')
    const seedData = readFileSync(join(REPO_ROOT, 'src/lib/assistant/seed-data.ts'), 'utf-8')
    expect(chatRoute).not.toMatch(/50%/)
    expect(seedData).not.toMatch(/up to 50%/i)
  })
})

describe('content scan: every legal page is marked draft in its own rendered badge source (category: Content)', () => {
  const LEGAL_PAGE_DIR_NAMES = [
    'terms', 'privacy', 'popia', 'rental-terms', 'payments-and-deposits',
    'cancellations', 'refunds', 'disputes', 'prohibited-items',
    'delivery-and-handover', 'verification-and-trust', 'contact',
  ]

  it('14. every legal page route file exists', () => {
    for (const slug of LEGAL_PAGE_DIR_NAMES) {
      const path = join(REPO_ROOT, `src/app/[locale]/(marketing)/${slug}/page.tsx`)
      expect(() => readFileSync(path, 'utf-8'), slug).not.toThrow()
    }
  })

  it('15. every legal page renders via LegalPageLayout, which shows the draft badge sourced from the registry', () => {
    for (const slug of LEGAL_PAGE_DIR_NAMES) {
      const path = join(REPO_ROOT, `src/app/[locale]/(marketing)/${slug}/page.tsx`)
      const content = readFileSync(path, 'utf-8')
      expect(content, slug).toMatch(/LegalPageLayout/)
      expect(content, slug).toMatch(/getLegalDocument\('.+'\)/)
    }
  })

  it('16. every legal page sets a canonical route in its metadata', () => {
    for (const slug of LEGAL_PAGE_DIR_NAMES) {
      const path = join(REPO_ROOT, `src/app/[locale]/(marketing)/${slug}/page.tsx`)
      const content = readFileSync(path, 'utf-8')
      expect(content, slug).toMatch(/alternates:\s*{\s*canonical:/)
    }
  })
})
