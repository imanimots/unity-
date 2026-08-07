#!/usr/bin/env node
/**
 * Permanent regression check for Unity SEO Pre-Launch Hardening.
 * Mirrors every other verify-*.mjs script's safety gate and shape.
 *
 * Three kinds of checks, run together:
 *   - Live DB checks (1-3): query the dev Supabase project directly,
 *     matching getListings()'s real filter exactly.
 *   - Live HTTP checks (6-17): fetch routes from the running dev server
 *     (NEXT_PUBLIC_APP_URL, default http://localhost:3000) and inspect
 *     response headers / raw HTML text. Requires `npm run dev` already
 *     running.
 *   - Source checks (4, 5, 18, 19, 20): grep the repository directly.
 *
 * FAIL-CLOSED, not fail-open: every DB/HTTP check goes through
 * evaluateQueryResult()/safeFetchText() (scripts/lib/fail-closed.mjs)
 * first. A query error, a missing column, a malformed/null/undefined
 * result, or a network failure is always reported as a FAILED check --
 * never silently coerced into a passing one. See
 * scripts/lib/__tests__/fail-closed.test.mjs for unit coverage of this
 * specific failure mode.
 *
 * Check 3 (a normal, non-test listing stays visible) creates a single,
 * clearly-labelled temporary fixture and deletes it immediately after
 * -- it never flips or otherwise repurposes an existing QA/DEMO
 * listing's classification, even briefly.
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: node scripts/verify-seo-prelaunch-safety.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { evaluateQueryResult, safeFetchText } from './lib/fail-closed.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

function assertSafeToRun() {
  const problems = []
  if (process.env.NODE_ENV === 'production') problems.push('NODE_ENV must not be "production"')
  if (process.env.QA_SEED_ENABLED !== 'true') problems.push('QA_SEED_ENABLED must be exactly "true"')
  if (process.env.QA_SEED_CONFIRM !== 'UNITY_DEV_ONLY') problems.push('QA_SEED_CONFIRM must be exactly "UNITY_DEV_ONLY"')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const expectedRef = process.env.QA_SEED_PROJECT_REF
  if (!url) problems.push('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (url) {
    const ref = new URL(url).hostname.split('.')[0]
    if (!expectedRef) problems.push('QA_SEED_PROJECT_REF is not set')
    else if (ref !== expectedRef) problems.push(`Supabase project ref "${ref}" does not match QA_SEED_PROJECT_REF "${expectedRef}"`)
  }
  if (problems.length) {
    console.error('verify-seo-prelaunch-safety aborted -- unsafe to run:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
}
assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

if (!SERVICE_KEY) {
  console.error('verify-seo-prelaunch-safety aborted -- SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}

/** Fail-closed wrapper around a Supabase query result -- see scripts/lib/fail-closed.mjs. assertFn may be async and is always awaited. */
async function dbCheck(label, result, opts, assertFn) {
  const evaluated = evaluateQueryResult(result, opts)
  if (!evaluated.ok) {
    failures++
    console.error(`  FAIL ${label} (fail-closed: ${evaluated.reason})`)
    return
  }
  await assertFn(evaluated.data)
}

async function fetchText(path) {
  return safeFetchText(`${APP_URL}${path}`, { redirect: 'manual' })
}

/** Fail-closed wrapper around an HTTP fetch result -- see scripts/lib/fail-closed.mjs. */
function httpCheck(label, result, assertFn) {
  if (!result.ok) {
    failures++
    console.error(`  FAIL ${label} (fail-closed: HTTP request failed -- ${result.reason})`)
    return
  }
  assertFn(result)
}

function grepSrc(pattern, { dirs = ['src'], extensions = ['.ts', '.tsx'] } = {}) {
  const matches = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__') continue
        walk(full)
      } else if (extensions.includes(extname(full))) {
        const content = readFileSync(full, 'utf8')
        if (pattern.test(content)) matches.push(full.replace(REPO_ROOT + '/', ''))
        pattern.lastIndex = 0
      }
    }
  }
  for (const d of dirs) walk(join(REPO_ROOT, d))
  return matches
}

console.log(`=== Unity SEO Pre-Launch Safety — checking against ${APP_URL} ===\n`)

// ── 1-3: live DB — test-fixture isolation ──
console.log('--- Test fixture isolation (live DB) ---')
{
  const qaResult = await admin.from('listings').select('id, title').eq('status', 'active').eq('is_test', false).ilike('title', '[QA]%')
  await dbCheck('1. [QA] listings are excluded from the public query (status=active, is_test=false)', qaResult, { expectArray: true }, (qaPublic) => {
    check('1. [QA] listings are excluded from the public query (status=active, is_test=false)', qaPublic.length === 0, qaPublic)
  })

  const demoResult = await admin.from('listings').select('id, title').eq('status', 'active').eq('is_test', false).ilike('title', '[DEMO]%')
  await dbCheck('2. [DEMO] fixtures are excluded from the public query', demoResult, { expectArray: true }, (demoPublic) => {
    check('2. [DEMO] fixtures are excluded from the public query', demoPublic.length === 0, demoPublic)
  })

  // Prove the filter's "included" direction with a brand-new, clearly-
  // labelled temporary fixture -- never by flipping or otherwise
  // repurposing an existing QA/DEMO listing's classification, even
  // briefly. Cleaned up (deleted) unconditionally before this block ends.
  const merchantLookupResult = await admin.from('listings').select('merchant_id').ilike('title', '[QA]%').limit(1).maybeSingle()
  await dbCheck('3-setup. locate a QA merchant id to own the temporary validation fixture', merchantLookupResult, { expectArray: false }, async (merchantRow) => {
    if (!merchantRow) {
      failures++
      console.error('  FAIL 3. no QA merchant available to own a temporary validation fixture', {})
      return
    }

    const tempTitle = `[SEO-VALIDATION-TEMP] ${Date.now()}`
    const insertResult = await admin
      .from('listings')
      .insert({
        merchant_id: merchantRow.merchant_id,
        country_id: 'ZA',
        category: 'tech',
        condition: 'good',
        daily_rate: 150,
        min_rental_days: 1,
        deposit_required: false,
        status: 'active',
        risk_tier: 'low',
        ownership_verified: false,
        condition_confirmed: true,
        title: tempTitle,
        is_test: false,
      })
      .select('id')
      .single()

    await dbCheck('3-setup. create the temporary validation fixture', insertResult, { expectArray: false }, async (inserted) => {
      const tempId = inserted.id
      try {
        const visibleResult = await admin.from('listings').select('id').eq('id', tempId).eq('status', 'active').eq('is_test', false).maybeSingle()
        await dbCheck('3. a normal (is_test=false) listing remains visible to the public query', visibleResult, { expectArray: false }, (visibleRow) => {
          check('3. a normal (is_test=false) listing remains visible to the public query', !!visibleRow, { tempId })
        })
      } finally {
        // Cleanup runs even if the visibility assertion above failed --
        // a synthetic fixture must never be left behind regardless of
        // check outcome.
        const deleteResult = await admin.from('listings').delete().eq('id', tempId)
        check('3b. the temporary validation fixture was deleted (cleanup)', !deleteResult.error, deleteResult.error ?? {})
      }
    })
  })
}

// ── 4-6: fabricated ratings / misleading claims (source + live) ──
console.log('\n--- Fabricated ratings and misleading claims ---')
{
  const fabricationHits = grepSrc(/Math\.floor\(score \* 8/, { dirs: ['src/components'] })
  check('4. the fabricated review-count formula is gone from listing-card.tsx', fabricationHits.length === 0, fabricationHits)

  const thousandsHits = grepSrc(/thousands of items|thousands\b/i, { dirs: ['src/app', 'src/components'] })
  check('5. no hardcoded "thousands of items" claim remains', thousandsHits.length === 0, thousandsHits)

  // A real, non-tautological check -- the homepage itself has no
  // checkout copy, so the authoritative assertion is the source grep:
  // simulated-payment disclosure text must exist in at least one
  // checkout-adjacent surface.
  const disclosureHits = grepSrc(/payments are simulated|no real money/i, { dirs: ['src/components', 'src/app'] })
  check('6. test-mode checkout disclosure exists in at least one checkout-adjacent surface', disclosureHits.length > 0, disclosureHits)
}

// ── 7-17: live HTTP — indexation control ──
console.log('\n--- Indexation control (live HTTP — requires `npm run dev` running) ---')
{
  const home = await fetchText('/')
  httpCheck('7. root deployment serves noindex while SEO_INDEXING_ENABLED is not "true"', home, (r) => {
    check('7. root deployment serves noindex while SEO_INDEXING_ENABLED is not "true"', /name="robots"\s+content="[^"]*noindex/i.test(r.text), { snippet: r.text.slice(0, 30) })
  })

  const login = await fetchText('/login')
  httpCheck('8a. /login is noindex', login, (r) => check('8a. /login is noindex', /name="robots"\s+content="[^"]*noindex/i.test(r.text), {}))
  const register = await fetchText('/register')
  httpCheck('8b. /register is noindex', register, (r) => check('8b. /register is noindex', /name="robots"\s+content="[^"]*noindex/i.test(r.text), {}))

  const apiRes = await fetchText('/api/listings')
  httpCheck('9a. /api responses carry X-Robots-Tag: noindex', apiRes, (r) => check('9a. /api responses carry X-Robots-Tag: noindex', /noindex/i.test(r.headers.get('x-robots-tag') ?? ''), { header: r.headers.get('x-robots-tag') }))
  const dashRes = await fetchText('/dashboard/renter')
  httpCheck('9b. /dashboard responses carry X-Robots-Tag: noindex', dashRes, (r) => check('9b. /dashboard responses carry X-Robots-Tag: noindex', /noindex/i.test(r.headers.get('x-robots-tag') ?? ''), { header: r.headers.get('x-robots-tag') }))
  const adminRes = await fetchText('/admin')
  httpCheck('9c. /admin responses carry X-Robots-Tag: noindex', adminRes, (r) => check('9c. /admin responses carry X-Robots-Tag: noindex', /noindex/i.test(r.headers.get('x-robots-tag') ?? ''), { header: r.headers.get('x-robots-tag') }))

  const terms = await fetchText('/terms')
  httpCheck('10. a draft legal page (/terms) is noindex', terms, (r) => check('10. a draft legal page (/terms) is noindex', /name="robots"\s+content="[^"]*noindex/i.test(r.text), {}))

  const robotsTxt = await fetchText('/robots.txt')
  httpCheck('11. robots.txt returns 200 with real directives', robotsTxt, (r) => {
    check('11. robots.txt returns 200 with real directives', r.status === 200 && /user-agent/i.test(r.text), { status: r.status })
    check('12. robots.txt does not blanket-disallow the entire public site', !/user-agent:\s*\*[\s\S]{0,20}disallow:\s*\/\s*$/im.test(r.text), { snippet: r.text.slice(0, 200) })
    check('12b. robots.txt disallows genuinely private infrastructure', /disallow:\s*\/dashboard\//i.test(r.text) && /disallow:\s*\/admin\//i.test(r.text) && /disallow:\s*\/api\//i.test(r.text), {})
  })

  const sitemapXml = await fetchText('/sitemap.xml')
  httpCheck('13. sitemap contains no [QA]/[DEMO] test listing reference', sitemapXml, (r) => {
    check('13. sitemap contains no [QA]/[DEMO] test listing reference', !/\[qa\]|\[demo\]/i.test(r.text), {})
    check('14. sitemap contains no private route', !/\/dashboard|\/admin|\/login|\/register/i.test(r.text), { snippet: r.text.slice(0, 300) })
  })

  httpCheck('15. meta keywords absent from the homepage', home, (r) => check('15. meta keywords absent from the homepage', !/name="keywords"/i.test(r.text), {}))
  httpCheck('16. html lang is en-ZA', home, (r) => check('16. html lang is en-ZA', /<html[^>]*\slang="en-ZA"/i.test(r.text), {}))
  httpCheck('17. twitter:card is summary_large_image on the homepage', home, (r) => check('17. twitter:card is summary_large_image on the homepage', /name="twitter:card"\s+content="summary_large_image"/i.test(r.text), {}))
}

// ── 18-20: affiliate links / structured data (source) ──
console.log('\n--- Affiliate link semantics and structured data (source) ---')
{
  // No Unity-rendered <a> anchor tied to an affiliate ref currently
  // exists (confirmed by audit — the only affiliate-link surface is a
  // copy-to-clipboard plain-text block, which is not an anchor). This
  // check guards the invariant: any future anchor built from an
  // affiliate/ref link must carry sponsored semantics.
  const affiliateAnchors = grepSrc(/<a\s+[^>]*href=\{[^}]*\bref\b[^}]*\}(?![^>]*rel=)/i, { dirs: ['src/components', 'src/app'] })
  check('18. no Unity-rendered affiliate-linked <a> anchor lacks rel="sponsored"', affiliateAnchors.length === 0, affiliateAnchors)

  const ldJsonHits = grepSrc(/application\/ld\+json/i, { dirs: ['src'] })
  check('19. no Product/AggregateRating JSON-LD is emitted anywhere', ldJsonHits.length === 0, ldJsonHits)

  const localBusinessHits = grepSrc(/LocalBusiness/i, { dirs: ['src'] })
  check('20. no LocalBusiness schema exists anywhere', localBusinessHits.length === 0, localBusinessHits)
}

console.log('\n=== SUMMARY ===')
if (failures === 0) {
  console.log('ALL CHECKS PASSED')
  process.exit(0)
} else {
  console.log(`${failures} CHECK(S) FAILED`)
  process.exit(1)
}
