#!/usr/bin/env node
/**
 * Permanent regression check for Unity i18n (Internationalization /
 * Localization), Phase 2 implementation. Mirrors every other
 * verify-*.mjs script's shape and fail-closed convention.
 *
 * Scope note (read before extending): this script honestly verifies what
 * has actually been implemented so far -- routing/config/formatting
 * infrastructure, dictionary structural integrity, and the specific
 * terminology/economics safety invariants the implementation prompt
 * requires. It does NOT assert full page-by-page UI translation coverage
 * or full 87-template email translation coverage, because neither is
 * complete yet (see the i18n closure report for the exact done/remaining
 * breakdown). Do not silently mark this script "all clean" as proof of
 * full-catalogue completeness -- read the SUMMARY section's own caveats.
 *
 * Requires `npm run dev` already running on NEXT_PUBLIC_APP_URL
 * (default http://localhost:3000) for the ROUTING/SEARCH sections.
 *
 * Usage: node scripts/verify-i18n.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { safeFetchText } from './lib/fail-closed.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

let failures = 0
let skipped = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}
function skip(label, reason) {
  skipped++
  console.log(`  SKIP ${label} (${reason})`)
}

async function fetchText(path) {
  return safeFetchText(`${APP_URL}${path}`, { redirect: 'manual' })
}
function httpCheck(label, result, assertFn) {
  if (!result.ok) {
    failures++
    console.error(`  FAIL ${label} (fail-closed: HTTP request failed -- ${result.reason})`)
    return
  }
  assertFn(result.text, result.status, result.headers)
}

const NAMESPACES = ['common','navigation','auth','marketplace','buy','rent','barter','skills','tasks','lookingFor','rtb','advertising','merchant','errors','emails','legal','personalization']
const LOCALES = ['en-ZA', 'af-ZA', 'zu-ZA']

function loadMessages(locale, ns) {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'src/i18n/messages', locale, `${ns}.json`), 'utf8'))
}
function collectKeys(obj, prefix = '') {
  let out = []
  for (const k of Object.keys(obj).sort()) {
    const path = prefix ? `${prefix}.${k}` : k
    const v = obj[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) out = out.concat(collectKeys(v, path))
    else out.push(path)
  }
  return out
}

console.log('=== Unity i18n Phase 2 -- checking against', APP_URL, '===\n')

console.log('--- CONFIG ---')
{
  const localesSrc = readFileSync(join(REPO_ROOT, 'src/i18n/locales.ts'), 'utf8')
  check('1. enabled locale set is exactly en-ZA/af-ZA/zu-ZA', /LOCALES = \['en-ZA', 'af-ZA', 'zu-ZA'\]/.test(localesSrc))
  check('2. default locale is en-ZA', /DEFAULT_LOCALE: Locale = 'en-ZA'/.test(localesSrc))
  check('3. localeDetection is disabled (no automatic redirect of existing English URLs)', /localeDetection: false/.test(readFileSync(join(REPO_ROOT, 'src/i18n/routing.ts'), 'utf8')))
  check('4. af-ZA URL prefix is the short form /af, not /af-ZA', /'af-ZA': '\/af'/.test(localesSrc))
  check('5. zu-ZA URL prefix is the short form /zu, not /zu-ZA', /'zu-ZA': '\/zu'/.test(localesSrc))
}

console.log('\n--- DICTIONARIES ---')
{
  let allNamespacesExist = true
  for (const loc of LOCALES) for (const ns of NAMESPACES) {
    if (!existsSync(join(REPO_ROOT, 'src/i18n/messages', loc, `${ns}.json`))) allNamespacesExist = false
  }
  check('6. all 17 namespaces exist for all 3 locales (51 files)', allNamespacesExist)

  let parityOk = true
  const mismatches = []
  for (const ns of NAMESPACES) {
    const enKeys = collectKeys(loadMessages('en-ZA', ns))
    for (const loc of LOCALES) {
      const keys = collectKeys(loadMessages(loc, ns))
      const missing = enKeys.filter((k) => !keys.includes(k))
      const extra = keys.filter((k) => !enKeys.includes(k))
      if (missing.length || extra.length) { parityOk = false; mismatches.push({ ns, loc, missing, extra }) }
    }
  }
  check('7. every locale has identical key structure to en-ZA in every namespace (no missing/stale keys)', parityOk, { mismatches })

  let noRawEnglishLeftInAfZu = true
  // Heuristic, not exhaustive: values that are byte-identical to en-ZA AND
  // contain at least one alphabetic character are flagged, EXCLUDING known
  // legitimate identical-by-design values (brand name, ICU tokens, etc.)
  // Genuine Afrikaans cognates/loanwords that are correctly identical to
  // English are not translation gaps -- flagging them would pressure a
  // translator into inventing an artificial difference. Curated, not
  // blanket -- isiZulu has none of these (its orthography differs enough
  // that a genuine cognate would still normally take an "i-"/"u-" prefix,
  // e.g. "i-imeyili", so an unprefixed English-identical string there is
  // still worth flagging).
  const ALLOWED_IDENTICAL = new Set([
    'Unity', 'CTR', 'R{amount}', 'POPIA', 'Filter', 'Platform', 'Item', 'Elite', 'Pro', 'Thabo Nkosi',
    // Afrikaans cognates confirmed against this dictionary's own established
    // usage (e.g. "Betalingstatus" already compounds "status" unchanged) --
    // not translation gaps.
    'Status', 'Status: {status}',
    // "week" is spelled identically in Afrikaans, unlike "day"→"dag" --
    // the "/wk" abbreviation is a genuine cognate, not a missed translation.
    '· {amount}/wk',
    // "Elite" is an existing subscription-tier brand name (see the bare
    // 'Elite' entry above) -- af-ZA correctly keeps it unchanged inside
    // this compound Unity Score threshold label too ("4.5+ (Elite)"),
    // exactly as "Pro"/"Elite" already stay unchanged elsewhere in
    // af-ZA's own established usage. zu-ZA does NOT get this exception --
    // it correctly prefixes to "4.5+ (I-Elite)" per this dictionary's own
    // established i-/u- loanword convention, so an unprefixed match there
    // would still be a genuine gap.
    '4.5+ (Elite)',
  ])
  const identicalFindings = []
  for (const ns of NAMESPACES) {
    const en = loadMessages('en-ZA', ns)
    for (const loc of ['af-ZA', 'zu-ZA']) {
      const other = loadMessages(loc, ns)
      const enKeys = collectKeys(en)
      for (const key of enKeys) {
        const enVal = key.split('.').reduce((o, k) => o?.[k], en)
        const otherVal = key.split('.').reduce((o, k) => o?.[k], other)
        if (typeof enVal === 'string' && enVal === otherVal && /[a-zA-Z]{3,}/.test(enVal) && !ALLOWED_IDENTICAL.has(enVal)) {
          identicalFindings.push({ ns, loc, key, value: enVal })
        }
      }
    }
  }
  check('8. no untranslated (byte-identical-to-English) string sneaks into af-ZA/zu-ZA', identicalFindings.length === 0, { identicalFindings })
}

console.log('\n--- BARTER TERMINOLOGY SAFETY ---')
{
  for (const loc of LOCALES) {
    const skills = loadMessages(loc, 'skills')
    const tasks = loadMessages(loc, 'tasks')
    const marketplace = loadMessages(loc, 'marketplace')
    check(`9. [${loc}] Skill and Task labels are distinct words`, skills.label !== tasks.label, { skill: skills.label, task: tasks.label })
    check(`10. [${loc}] Available and Looking For are distinct words`, marketplace.direction.available !== marketplace.direction.lookingFor)
    check(`11. [${loc}] Available Skill summary does not equal Looking For Skill summary`, skills.available.summary !== skills.lookingFor.summary)
    check(`12. [${loc}] Available Task summary does not equal Looking For Task summary`, tasks.available.summary !== tasks.lookingFor.summary)
    check(`13. [${loc}] no monetary symbol/word leaks into Skill/Task labels`, !/\bR\d|price|Intel|commission/i.test(JSON.stringify(skills) + JSON.stringify(tasks)))
  }
  for (const loc of LOCALES) {
    const barter = loadMessages(loc, 'barter')
    check(`14. [${loc}] barter dictionary states zero commission`, !!barter.zeroCommissionNotice)
  }
}

console.log('\n--- ADVERTISING DISCLOSURE SAFETY ---')
{
  const PROHIBITED = [/^recommended$/i, /^featured$/i, /^popular$/i, /^top pick$/i]
  for (const loc of LOCALES) {
    const ad = loadMessages(loc, 'advertising')
    check(`15. [${loc}] Sponsored disclosure label exists`, typeof ad.sponsoredLabel === 'string' && ad.sponsoredLabel.length > 0)
    check(`16. [${loc}] Sponsored label is not a soft synonym (Recommended/Featured/Popular/Top Pick)`, !PROHIBITED.some((re) => re.test(ad.sponsoredLabel)))
  }
  const cardSrc = readFileSync(join(REPO_ROOT, 'src/components/listings/listing-card.tsx'), 'utf8')
  check("17. listing-card.tsx renders the translated Sponsored label (not a hardcoded 'Sponsored' string)", cardSrc.includes("tAdvertising('sponsoredLabel')") && !/>\s*Sponsored\s*</.test(cardSrc))
}

console.log('\n--- EMAIL IDEMPOTENCY UNCHANGED ---')
{
  const idempotencySrc = readFileSync(join(REPO_ROOT, 'src/lib/email/idempotency.ts'), 'utf8')
  check('18. computeEmailIdempotencyKey does not take a locale parameter', !/locale/i.test(idempotencySrc))
  const serviceSrc = readFileSync(join(REPO_ROOT, 'src/lib/email/service.ts'), 'utf8')
  check('19. resolved_locale is written to email_deliveries as a snapshot', /resolved_locale:\s*resolvedLocale/.test(serviceSrc))
  check('20. resolveRecipientLocale is called independently per recipient (not derived from the triggering actor)', /resolveRecipientLocale\(admin, req\.recipientUserId\)/.test(serviceSrc))
}

console.log('\n--- MONEY / FORMATTING INVARIANTS ---')
{
  const formatSrc = readFileSync(join(REPO_ROOT, 'src/lib/i18n/format.ts'), 'utf8')
  check('21. centralized formatMoney takes integer cents (never a float rand amount) as its primary input', /formatMoney\(cents: number/.test(formatSrc))
  check('22. currency stays ZAR (no exchange-rate/multi-currency conversion logic present)', !/exchangeRate|convertCurrency|USD.*ZAR.*rate/i.test(formatSrc))
  check('23. formatDate/formatDateTime explicitly pin Africa/Johannesburg (language never changes the business timezone)', (formatSrc.match(/Africa\/Johannesburg/g) ?? []).length >= 2)
}

console.log('\n--- ROUTING (live HTTP) ---')
{
  await httpCheck('24. /listings (default locale) returns 200 with no redirect', await fetchText('/listings'), (_t, status) => {
    check('24. /listings (default locale) returns 200 with no redirect', status === 200, { status })
  })
  await httpCheck('25. /af/listings (Afrikaans) returns 200', await fetchText('/af/listings'), (_t, status) => {
    check('25. /af/listings (Afrikaans) returns 200', status === 200, { status })
  })
  await httpCheck('26. /zu/listings (isiZulu) returns 200', await fetchText('/zu/listings'), (_t, status) => {
    check('26. /zu/listings (isiZulu) returns 200', status === 200, { status })
  })
  await httpCheck('27. / carries html lang="en-ZA"', await fetchText('/'), (text) => {
    check('27. / carries html lang="en-ZA"', /<html[^>]*lang="en-ZA"/.test(text))
  })
  await httpCheck('28. /af carries html lang="af-ZA"', await fetchText('/af'), (text) => {
    check('28. /af carries html lang="af-ZA"', /<html[^>]*lang="af-ZA"/.test(text))
  })
  await httpCheck('29. /zu carries html lang="zu-ZA"', await fetchText('/zu'), (text) => {
    check('29. /zu carries html lang="zu-ZA"', /<html[^>]*lang="zu-ZA"/.test(text))
  })
  await httpCheck('30. there is no separate /en route (default locale has no visible prefix)', await fetchText('/en'), (_t, status) => {
    check('30. there is no separate /en route (default locale has no visible prefix)', status === 404 || status >= 300, { status })
  })
  await httpCheck('31. /admin stays en-ZA (never locale-prefixed, admin excluded from [locale] segment)', await fetchText('/admin'), (text, status) => {
    check('31. /admin stays en-ZA (never locale-prefixed, admin excluded from [locale] segment)', status === 200 ? /<html[^>]*lang="en-ZA"/.test(text) : [301, 302, 307, 308].includes(status))
  })
  await httpCheck('32. /dashboard (unauthenticated) redirects to unprefixed /login', await fetchText('/dashboard'), (_t, status, headers) => {
    const location = headers?.get?.('location') ?? ''
    check('32. /dashboard (unauthenticated) redirects to unprefixed /login', [301, 302, 307, 308].includes(status) && /\/login/.test(location) && !/\/(af|zu)\/login/.test(location), { status, location })
  })
  await httpCheck('33. /af/dashboard (unauthenticated) redirects to /af/login (locale stays sticky through auth redirect)', await fetchText('/af/dashboard'), (_t, status, headers) => {
    const location = headers?.get?.('location') ?? ''
    check('33. /af/dashboard (unauthenticated) redirects to /af/login (locale stays sticky through auth redirect)', [301, 302, 307, 308].includes(status) && /\/af\/login/.test(location), { status, location })
  })
}

console.log('\n--- SEARCH NEUTRALITY (organic ranking unaffected by UI locale) ---')
{
  const paths = ['/listings?q=camera', '/af/listings?q=camera', '/zu/listings?q=camera']
  const results = []
  for (const p of paths) {
    const r = await fetchText(p)
    results.push(r.ok ? r.status : null)
  }
  check('34. the same organic search query returns 200 identically across all 3 locale prefixes (structural parity -- full ID/order/score/cursor equivalence requires an authenticated data-level test, see closure report)', results.every((s) => s === 200), { results })
  const searchRankingMigration = readFileSync(join(REPO_ROOT, 'supabase/migrations/20260902000004_search_ranking_rpcs.sql'), 'utf8')
  check("35. Search Ranking RPC migration file is untouched by this phase (still present, not deleted/renamed)", searchRankingMigration.length > 0)
  const cursorSrc = readFileSync(join(REPO_ROOT, 'src/lib/search/cursor.ts'), 'utf8')
  check('36. search cursor context hash does not include locale', !/locale/i.test(cursorSrc))
}

console.log('\n--- SEO SAFETY ---')
{
  check('37. SEO_INDEXING_ENABLED is unset/false', process.env.SEO_INDEXING_ENABLED !== 'true')
  check('38. SEO_MARKETPLACE_INDEXING_ENABLED is unset/false', process.env.SEO_MARKETPLACE_INDEXING_ENABLED !== 'true')
  await httpCheck('39. /af/dashboard carries X-Robots-Tag noindex (locale-prefixed private routes stay noindex)', await fetchText('/af/dashboard'), (_t, _s, headers) => {
    check('39. /af/dashboard carries X-Robots-Tag noindex (locale-prefixed private routes stay noindex)', (headers?.get?.('x-robots-tag') ?? '').includes('noindex'))
  })
}

console.log('\n--- LEGAL FALLBACK ---')
{
  for (const loc of LOCALES) {
    const legal = loadMessages(loc, 'legal')
    check(`40. [${loc}] legal.englishAuthoritative key exists (English stays sole authoritative legal text)`, typeof legal.englishAuthoritative === 'string' && legal.englishAuthoritative.length > 0)
  }
  const layoutSrc = readFileSync(join(REPO_ROOT, 'src/components/legal/legal-page-layout.tsx'), 'utf8')
  check('40b. LegalPageLayout (shared by all 12 legal pages) actually renders the translationNotice banner for non-default locales', /locale !== 'en-ZA'[\s\S]*?t\('translationNotice'\)/.test(layoutSrc))
  check('40c. LegalPageLayout never wraps the legal body (`children`) in a translation call -- authoritative English prose is passed through untouched', !/t\(['"`]?children/.test(layoutSrc))
}

console.log('\n--- DATABASE / AUTHORITY UNCHANGED ---')
{
  const migrationSrc = readFileSync(join(REPO_ROOT, 'supabase/migrations/20260904000001_i18n_locale_preferences.sql'), 'utf8')
  check('41. migration is additive only (ADD COLUMN, no ALTER on existing enum/status columns)', /add column/i.test(migrationSrc) && !/alter type|drop column/i.test(migrationSrc))
  check('42. preferred_locale is CHECK-constrained to the exact 3-locale allowlist (never an arbitrary string)', /check \(preferred_locale is null or preferred_locale in \('en-ZA', 'af-ZA', 'zu-ZA'\)\)/.test(migrationSrc))
  check('43. resolved_locale is CHECK-constrained identically', /check \(resolved_locale is null or resolved_locale in \('en-ZA', 'af-ZA', 'zu-ZA'\)\)/.test(migrationSrc))
  check('44. migration performs no backfill (no UPDATE statement)', !/^\s*update\s/im.test(migrationSrc))
}

console.log('\n--- PUBLIC PROFILE PRIVACY ---')
{
  const viewSrc = readFileSync(join(REPO_ROOT, 'supabase/migrations/20260831000001_profiles_privacy_boundary.sql'), 'utf8')
  check('45. public_profiles view (explicit column list) does not select preferred_locale', !/preferred_locale/.test(viewSrc))
}

console.log('\n--- LOCALE-AWARE REDIRECTS ---')
{
  const merchantLayoutSrc = readFileSync(join(REPO_ROOT, 'src/app/[locale]/(dashboard)/dashboard/merchant/layout.tsx'), 'utf8')
  check("50a. merchant-dashboard layout's non-merchant redirect uses the locale-aware @/i18n/navigation redirect (not plain next/navigation)", /from '@\/i18n\/navigation'/.test(merchantLayoutSrc) && /redirect\(\{\s*href:/.test(merchantLayoutSrc))
  check('50b. that redirect explicitly resolves and passes the current locale (getLocale())', /getLocale\(\)/.test(merchantLayoutSrc) && /locale\s*\}\)|locale,?\s*\}\)/.test(merchantLayoutSrc))

  const proxySrc = readFileSync(join(REPO_ROOT, 'src/lib/supabase/proxy.ts'), 'utf8')
  check('50c. the merchant-only-path proxy redirect also preserves locale (withLocalePrefix)', /withLocalePrefix\('\/dashboard\/renter', locale\)/.test(proxySrc))
}

console.log('\n--- VERIFIED BADGE (localized without a dictionary leak) ---')
{
  const cardSrc = readFileSync(join(REPO_ROOT, 'src/components/listings/listing-card.tsx'), 'utf8')
  check('51a. ListingCard receives the Verified label as a server-resolved prop (not useTranslations client-side)', /verifiedLabel\?:\s*string/.test(cardSrc) && !/=\s*useTranslations\(['"]common['"]\)/.test(cardSrc))
  check('51b. the badge only renders when both ownership_verified AND a label were actually provided (never an unconditional prop)', /listing\.ownership_verified\s*&&\s*verifiedLabel/.test(cardSrc))
  for (const loc of LOCALES) {
    const common = loadMessages(loc, 'common')
    check(`51c. [${loc}] common.verified translation exists (source of the server-resolved prop)`, typeof common.verified === 'string' && common.verified.length > 0)
  }
}

console.log('\n--- ADMIN STAYS ENGLISH ---')
{
  const adminLayoutSrc = readFileSync(join(REPO_ROOT, 'src/app/admin/layout.tsx'), 'utf8')
  check('46. admin/layout.tsx hardcodes lang="en-ZA" (not locale-dynamic)', /lang="en-ZA"/.test(adminLayoutSrc))
  check('47. admin is excluded from the [locale] segment (no [locale] in its path)', !existsSync(join(REPO_ROOT, 'src/app/[locale]/admin')))
}

console.log('\n--- EMAIL COVERAGE MANIFEST (real, deterministic -- no broad skip) ---')
{
  // Source-level parse of the real catalogue file, matching this repo's
  // established verify-*.mjs convention of grepping repository source
  // directly (e.g. verify-seo-prelaunch-safety.mjs checks 4/5/18-20)
  // rather than dynamically importing TS application code with path
  // aliases into a plain-Node script. Same ground truth as
  // src/lib/email/coverage-manifest.ts (both read catalogue.ts's real
  // `id:`/`localeVariants:` structure) -- kept as two independent
  // implementations deliberately, so a bug in one is unlikely to be
  // mirrored in the other.
  const catalogueSrc = readFileSync(join(REPO_ROOT, 'src/lib/email/templates/catalogue.ts'), 'utf8')
  const idMatches = [...catalogueSrc.matchAll(/id: '([a-z0-9-]+)'/g)]
  const totalTemplates = idMatches.length
  let fullyCompleteCount = 0
  const incompleteIds = []
  for (let i = 0; i < idMatches.length; i++) {
    const start = idMatches[i].index
    const end = i + 1 < idMatches.length ? idMatches[i + 1].index : catalogueSrc.length
    const block = catalogueSrc.slice(start, end)
    const hasAf = /localeVariants:[\s\S]*?'af-ZA':/.test(block)
    const hasZu = /localeVariants:[\s\S]*?'zu-ZA':/.test(block)
    if (hasAf && hasZu) fullyCompleteCount++
    else incompleteIds.push(idMatches[i][1])
  }

  check('48a. email coverage manifest source (catalogue.ts) enumerates a real, non-empty template list', totalTemplates > 0)
  check('48b. every template id is unique (no accidental duplicate/drift)', new Set(idMatches.map((m) => m[1])).size === totalTemplates)
  check(
    `48c. every catalogue template has real af-ZA/zu-ZA localeVariants -- full catalogue completion (${fullyCompleteCount}/${totalTemplates})`,
    fullyCompleteCount === totalTemplates && totalTemplates === 87 && incompleteIds.length === 0
  )
  if (incompleteIds.length > 0) {
    console.log(`  INFO: ${incompleteIds.length} template ids remain en-ZA-only: ${incompleteIds.slice(0, 5).join(', ')}, …`)
  }

  // 48d -- subject/body/CTA per-locale content is real (not a copy of
  // en-ZA's subject/build functions reused verbatim), checked at the
  // source level via brace-depth matching (regex alone can't safely span
  // nested object literals): every af-ZA/zu-ZA block supplies its own
  // `subject:` and `build:` functions.
  function matchBalancedBrace(src, openBraceIndex) {
    let depth = 0
    for (let i = openBraceIndex; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) return src.slice(openBraceIndex, i + 1)
      }
    }
    return null
  }
  let missingSubjectOrBuild = []
  for (let i = 0; i < idMatches.length; i++) {
    const start = idMatches[i].index
    const end = i + 1 < idMatches.length ? idMatches[i + 1].index : catalogueSrc.length
    const block = catalogueSrc.slice(start, end)
    const lvIdx = block.indexOf('localeVariants:')
    let afOk = false
    let zuOk = false
    if (lvIdx !== -1) {
      const afIdx = block.indexOf("'af-ZA':", lvIdx)
      const zuIdx = block.indexOf("'zu-ZA':", lvIdx)
      if (afIdx !== -1) {
        const afOpenBrace = block.indexOf('{', afIdx)
        const afBlock = matchBalancedBrace(block, afOpenBrace)
        afOk = !!afBlock && /subject:/.test(afBlock) && /build:/.test(afBlock)
      }
      if (zuIdx !== -1) {
        const zuOpenBrace = block.indexOf('{', zuIdx)
        const zuBlock = matchBalancedBrace(block, zuOpenBrace)
        zuOk = !!zuBlock && /subject:/.test(zuBlock) && /build:/.test(zuBlock)
      }
    }
    if (!afOk || !zuOk) missingSubjectOrBuild.push(idMatches[i][1])
  }
  check('48d. every af-ZA/zu-ZA locale variant supplies its own subject() and build() functions (real per-locale content, not a shared stub)', missingSubjectOrBuild.length === 0)

  // 48e -- CTA links are locale-prefixed by the shared shell, not built ad
  // hoc per template (the render-time check lives in
  // src/lib/email/__tests__/i18n-locale.test.ts checks 8/9; this is the
  // structural source-level guarantee that the mechanism exists at all).
  const sharedSrc = readFileSync(join(REPO_ROOT, 'src/lib/email/templates/shared.ts'), 'utf8')
  check('48e. the shared email shell applies withLocalePrefix() to internal links (CTA + legal footer), not a hardcoded/unprefixed absoluteUrl', /withLocalePrefix\(/.test(sharedSrc))
  check(
    '48f. <html lang> in rendered emails is driven by the resolved recipient locale, not hardcoded "en"',
    /const locale = input\.locale \?\? 'en-ZA'/.test(sharedSrc) && /<html lang="\$\{locale\}">/.test(sharedSrc)
  )
  check('48g. shell chrome (footer/support line/brand tagline/test-mode notice) is locale-aware, not hardcoded English shared across every email', /SHELL_STRINGS/.test(sharedSrc) && /'af-ZA':\s*\{[\s\S]*?questionsContact/.test(sharedSrc) && /'zu-ZA':\s*\{[\s\S]*?questionsContact/.test(sharedSrc))
}

console.log('\n--- PAGE-COVERAGE STRUCTURAL CHECK (real, deterministic -- no broad skip) ---')
{
  // Real page-coverage manifest (src/i18n/page-coverage-manifest.ts) is the
  // single source of truth here -- every route under [locale] is
  // explicitly classified 'wired' | 'shared-layout' | 'unwired'. This
  // check (a) proves the manifest cannot silently drift from the real
  // route tree (same guarantee as src/i18n/__tests__/page-coverage-manifest.test.ts,
  // implemented independently here via source parsing, matching this
  // repo's verify-*.mjs convention) and (b) reports the real, current
  // localized/total ratio -- never a fabricated 61/61.
  const manifestSrc = readFileSync(join(REPO_ROOT, 'src/i18n/page-coverage-manifest.ts'), 'utf8')
  const entryMatches = [...manifestSrc.matchAll(/\{ path: '([^']+)', status: '(wired|shared-layout|unwired)'/g)]
  const manifestPaths = new Set(entryMatches.map((m) => m[1]))

  function countRealPages(dir, base = '') {
    let out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = base ? `${base}/${entry.name}` : entry.name
      if (entry.isDirectory()) out = out.concat(countRealPages(full, rel))
      else if (entry.name === 'page.tsx') out.push(rel)
    }
    return out
  }
  const realPages = countRealPages(join(REPO_ROOT, 'src/app/[locale]'))
  const unclassified = realPages.filter((p) => !manifestPaths.has(p))
  const stale = [...manifestPaths].filter((p) => !realPages.includes(p))

  check(`49a. page-coverage manifest has zero unclassified real pages (${realPages.length} real page.tsx files under [locale], all present in the manifest -- this is what catches a new customer/merchant page shipping without a coverage classification)`, unclassified.length === 0, { unclassified })
  check('49b. page-coverage manifest has zero stale entries (no manifest path pointing at a page that no longer exists)', stale.length === 0, { stale })

  const wiredCount = entryMatches.filter((m) => m[2] === 'wired').length
  const sharedLayoutCount = entryMatches.filter((m) => m[2] === 'shared-layout').length
  const unwiredCount = entryMatches.filter((m) => m[2] === 'unwired').length
  check(
    `49c. page-coverage counts are real and match the documented ground truth (${wiredCount} wired + ${sharedLayoutCount} shared-layout = ${wiredCount + sharedLayoutCount} localized / ${entryMatches.length} total -- NOT claimed as full 61/61 completion; see the closure report for the itemized remaining pages)`,
    entryMatches.length === realPages.length && wiredCount + sharedLayoutCount + unwiredCount === entryMatches.length
  )
  console.log(`  INFO: page coverage is ${wiredCount + sharedLayoutCount}/${entryMatches.length} (${wiredCount} fully wired + ${sharedLayoutCount} shared-layout chrome-only) -- ${unwiredCount} pages remain unwired`)
}

console.log('\n--- TRANSACTION-FLOW BATCH (PAGE COMPLETION PASS 1) ---')
{
  const manifestSrc = readFileSync(join(REPO_ROOT, 'src/i18n/page-coverage-manifest.ts'), 'utf8')
  const BATCH_ROUTES = [
    '(dashboard)/dashboard/barter/[id]/page.tsx',
    '(dashboard)/dashboard/barter/skill-task/[id]/offers/page.tsx',
    '(dashboard)/dashboard/disputes/[id]/page.tsx',
    '(dashboard)/dashboard/orders/[id]/checkout/page.tsx',
    '(dashboard)/dashboard/orders/page.tsx',
    '(dashboard)/dashboard/rent-to-buy/[id]/page.tsx',
    '(dashboard)/dashboard/rent-to-buy/page.tsx',
    '(dashboard)/dashboard/renter/bookings/[id]/checkout/page.tsx',
    '(dashboard)/dashboard/renter/bookings/[id]/dispute/page.tsx',
    '(dashboard)/dashboard/renter/bookings/[id]/media/page.tsx',
    '(dashboard)/dashboard/renter/bookings/[id]/review/page.tsx',
    '(dashboard)/dashboard/renter/bookings/page.tsx',
    '(dashboard)/dashboard/merchant/bookings/[id]/dispute/page.tsx',
    '(dashboard)/dashboard/merchant/bookings/[id]/review/page.tsx',
    '(dashboard)/dashboard/merchant/bookings/page.tsx',
    '(dashboard)/dashboard/merchant/orders/page.tsx',
    '(marketing)/barter/skill-task/[id]/page.tsx',
    '(marketing)/listings/[id]/book/page.tsx',
    '(marketing)/listings/[id]/buy/page.tsx',
    '(marketing)/listings/[id]/page.tsx',
    '(marketing)/looking-for/[id]/page.tsx',
  ]
  const notWired = BATCH_ROUTES.filter((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\{ path: '${escaped}', status: '(\\w[\\w-]*)'`)
    const m = manifestSrc.match(re)
    return !m || m[1] !== 'wired'
  })
  check(`52. all ${BATCH_ROUTES.length} transaction-flow batch routes are marked 'wired' in the page-coverage manifest`, notWired.length === 0, { notWired })

  // Representative locale-retention check: an unauthenticated request to a
  // batch route under /af must redirect to /af/login, never bare /login --
  // proves the withLocalePrefix fix (§8/§9) actually took effect at
  // runtime, not just in source.
  const representativeRoutes = [
    '/af/dashboard/renter/bookings',
    '/af/dashboard/orders',
    '/af/dashboard/disputes',
    '/zu/dashboard/barter',
    '/zu/dashboard/rent-to-buy',
  ]
  for (const path of representativeRoutes) {
    const localePrefix = path.startsWith('/af/') ? '/af' : '/zu'
    await httpCheck(`53. [${path}] unauthenticated redirect stays locale-prefixed (no locale drop)`, await fetchText(path), (_t, status, headers) => {
      const location = headers?.get?.('location') ?? ''
      check(
        `53. [${path}] unauthenticated redirect stays locale-prefixed (no locale drop)`,
        [301, 302, 307, 308].includes(status) && location.startsWith(`${localePrefix}/login`),
        { status, location }
      )
    })
  }

  // No-double-prefix guard: a redirectTo value built by withLocalePrefix()
  // must never be routed back through next-intl's locale-aware router (that
  // would prepend the current locale a second time, producing /af/af/...).
  // The one legitimate consumer is the login page, which must deliberately
  // use plain next/navigation, not @/i18n/navigation.
  const loginSrc = readFileSync(join(REPO_ROOT, "src/app/[locale]/(auth)/login/page.tsx"), 'utf8')
  const useRouterImportLine = (loginSrc.match(/^import \{[^}]*useRouter[^}]*\} from '[^']+'/m) ?? [''])[0]
  check(
    "54. login page consumes redirectTo via plain next/navigation's router (not the locale-aware router), preventing double locale-prefixing",
    /from 'next\/navigation'/.test(useRouterImportLine) && /router\.push\(redirectTo\)/.test(loginSrc),
    { useRouterImportLine }
  )
  for (const path of representativeRoutes) {
    const localePrefix = path.startsWith('/af/') ? '/af' : '/zu'
    await httpCheck(`54b. [${path}] redirectTo query param carries the prefix exactly once (no ${localePrefix}${localePrefix} double prefix)`, await fetchText(path), (_t, status, headers) => {
      const location = headers?.get?.('location') ?? ''
      check(
        `54b. [${path}] redirectTo query param carries the prefix exactly once (no ${localePrefix}${localePrefix} double prefix)`,
        !location.includes(`${localePrefix}${localePrefix}`) && !/redirectTo=.*%2F(af|zu)%2F(af|zu)%2F/.test(location),
        { status, location }
      )
    })
  }

  // Status-label coverage: dictionary status keys match the real, current
  // DB enum values (discovered via migration grep during this pass) --
  // catches drift between a dictionary edit and the actual enum, in either
  // direction.
  const rentStatus = Object.keys(loadMessages('en-ZA', 'rent').status ?? {})
  const buyStatus = Object.keys(loadMessages('en-ZA', 'buy').status ?? {})
  const barterStatus = Object.keys(loadMessages('en-ZA', 'barter').status ?? {})
  const BOOKING_STATUSES = ['requested', 'accepted', 'rejected', 'expired', 'cancelled_by_renter', 'cancelled_by_merchant', 'active', 'return_pending', 'returned', 'completed', 'cancelled', 'disputed']
  const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'disputed', 'cancelled']
  const BARTER_STATUSES = ['proposed', 'countered', 'accepted', 'preparing', 'in_transit', 'awaiting_confirmation', 'completed', 'rejected', 'cancelled', 'expired', 'disputed']
  check('55a. rent.json status keys exactly match the real BookingLifecycleStatus enum', BOOKING_STATUSES.every((s) => rentStatus.includes(s)) && rentStatus.every((s) => BOOKING_STATUSES.includes(s)), { rentStatus })
  check('55b. buy.json status keys exactly match the real OrderStatus enum', ORDER_STATUSES.every((s) => buyStatus.includes(s)) && buyStatus.every((s) => ORDER_STATUSES.includes(s)), { buyStatus })
  check('55c. barter.json status keys exactly match the real BarterStatus enum (snake_case in_transit/awaiting_confirmation, not camelCase)', BARTER_STATUSES.every((s) => barterStatus.includes(s)) && barterStatus.every((s) => BARTER_STATUSES.includes(s)), { barterStatus })

  const rtbJson = loadMessages('en-ZA', 'rtb')
  check('55d. rtb.json has agreement status, possession status, and installment status sections', !!rtbJson.status && !!rtbJson.possessionStatus && !!rtbJson.installmentStatus)

  // No-public-dictionary-leak: the 4 scoped-provider public pages must pass
  // a hand-picked subset object into NextIntlClientProvider, never the full
  // getMessages() result.
  const scopedProviderPages = [
    '(marketing)/listings/[id]/book/page.tsx',
    '(marketing)/listings/[id]/buy/page.tsx',
    '(marketing)/listings/[id]/page.tsx',
    '(marketing)/looking-for/[id]/page.tsx',
  ]
  const leaks = []
  for (const p of scopedProviderPages) {
    const src = readFileSync(join(REPO_ROOT, 'src/app/[locale]', p), 'utf8')
    if (!/NextIntlClientProvider messages=\{scoped\}/.test(src) || /NextIntlClientProvider messages=\{messages\}/.test(src)) leaks.push(p)
  }
  check('56. public transaction-adjacent pages pass a narrow scoped message subset, never the full dictionary tree', leaks.length === 0, { leaks })

  // Validation/error stable-identity coverage: evidence validators return
  // string-literal error codes, never raw English, so display text is
  // localized at the call site rather than baked into the validator.
  const disputeEvidenceSrc = readFileSync(join(REPO_ROOT, 'src/lib/disputes/evidence.ts'), 'utf8')
  const milestoneEvidenceSrc = readFileSync(join(REPO_ROOT, 'src/lib/barter/skill-task-evidence.ts'), 'utf8')
  check("57a. dispute evidence validation returns stable error codes ('unsupported_type'/'too_large'), not raw English strings", /EvidenceValidationError = 'unsupported_type' \| 'too_large'/.test(disputeEvidenceSrc))
  check("57b. barter milestone evidence validation returns stable error codes, not raw English strings", /MilestoneEvidenceValidationError = 'unsupported_type' \| 'too_large'/.test(milestoneEvidenceSrc))
}

console.log('\n--- MERCHANT / ACCOUNT BATCH (PAGE COMPLETION PASS 2) ---')
{
  const manifestSrc = readFileSync(join(REPO_ROOT, 'src/i18n/page-coverage-manifest.ts'), 'utf8')
  const MERCHANT_BATCH_ROUTES = [
    '(auth)/verify/page.tsx',
    '(dashboard)/dashboard/affiliate/page.tsx',
    '(dashboard)/dashboard/barter/skill-task/page.tsx',
    '(dashboard)/dashboard/merchant/affiliates/page.tsx',
    '(dashboard)/dashboard/merchant/listings/[id]/rent-to-buy/page.tsx',
    '(dashboard)/dashboard/merchant/page.tsx',
    '(dashboard)/dashboard/merchant/payouts/page.tsx',
    '(marketing)/pricing/page.tsx',
  ]
  const notWired = MERCHANT_BATCH_ROUTES.filter((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\{ path: '${escaped}', status: '(\\w[\\w-]*)'`)
    const m = manifestSrc.match(re)
    return !m || m[1] !== 'wired'
  })
  check(`58. all ${MERCHANT_BATCH_ROUTES.length} merchant/account batch routes are marked 'wired' in the page-coverage manifest`, notWired.length === 0, { notWired })

  // Locale-safe merchant navigation: an unauthenticated request to one of
  // this batch's newly-wired dashboard routes must redirect to the
  // correctly-prefixed login, never bare /login -- proves the shared
  // (dashboard) layout auth gate covers these new routes too, not just the
  // ones exercised in the prior pass.
  const merchantRepresentativeRoutes = ['/af/dashboard/merchant', '/af/dashboard/merchant/payouts', '/zu/dashboard/affiliate', '/zu/dashboard/merchant/affiliates']
  for (const path of merchantRepresentativeRoutes) {
    const localePrefix = path.startsWith('/af/') ? '/af' : '/zu'
    await httpCheck(`59. [${path}] unauthenticated redirect stays locale-prefixed (no locale drop)`, await fetchText(path), (_t, status, headers) => {
      const location = headers?.get?.('location') ?? ''
      check(
        `59. [${path}] unauthenticated redirect stays locale-prefixed (no locale drop)`,
        [301, 302, 307, 308].includes(status) && location.startsWith(`${localePrefix}/login`),
        { status, location }
      )
    })
  }

  // Profile language preference: the authenticated persistence route for
  // preferred_locale exists and writes to the real column (not a stub) --
  // this is the mechanism §10 of this pass required stay intact, not
  // something newly built by this batch.
  const localeRouteSrc = readFileSync(join(REPO_ROOT, 'src/app/api/profile/locale/route.ts'), 'utf8')
  check('60a. the profile locale-preference route writes preferred_locale (real persistence, not a stub)', /preferred_locale/.test(localeRouteSrc))
  const languageSelectorSrc = readFileSync(join(REPO_ROOT, 'src/components/shared/language-selector.tsx'), 'utf8')
  check('60b. LanguageSelector calls the locale-aware router with the target locale (never a bare navigation that would drop the current route)', /router\.replace\(href, \{ locale: next \}\)/.test(languageSelectorSrc))

  // Subscription/commission/payout/affiliate label coverage: the new
  // dictionary sections this batch introduced are real (non-placeholder)
  // and structurally match what their page actually renders.
  const pricingEn = loadMessages('en-ZA', 'merchant').pricing
  check('61. subscription (pricing) labels carry the real ICU rate placeholder, not a hardcoded percentage', typeof pricingEn.salesCommission === 'string' && pricingEn.salesCommission.includes('{rate}') && pricingEn.rentalCommission.includes('{rate}'))

  const affiliateProgramStatus = loadMessages('en-ZA', 'merchant').affiliateProgram.commissionStatus
  const AFFILIATE_COMMISSION_STATUSES = ['pending', 'held', 'approved', 'payout_queued', 'processing', 'paid', 'failed', 'voided', 'reversed']
  check('62. affiliate commission status labels cover every real AffiliateCommissionStatus value (admin-shared status map, translated at the dashboard call site only)', AFFILIATE_COMMISSION_STATUSES.every((s) => typeof affiliateProgramStatus[s] === 'string'))

  const payoutsPageStatus = loadMessages('en-ZA', 'merchant').payoutsPage.status
  const MERCHANT_PAYOUT_STATUSES = ['pending', 'processing', 'paid', 'failed']
  check('63. payout status labels exactly match the real MerchantPayout status union (pending/processing/paid/failed)', MERCHANT_PAYOUT_STATUSES.every((s) => typeof payoutsPageStatus[s] === 'string') && Object.keys(payoutsPageStatus).length === MERCHANT_PAYOUT_STATUSES.length)

  const merchantEn = loadMessages('en-ZA', 'merchant')
  check('64. merchant affiliate management + affiliate program dictionary sections both exist (merchant-side vs any-user-side affiliate UI kept distinct)', !!merchantEn.affiliateManagement && !!merchantEn.affiliateProgram)

  // Merchant status translation coverage: barter Skill/Task post lifecycle
  // status (draft/active/offers_received/matched/paused/closed/archived/
  // suspended) is translated, matching the real barter_skill_task_post_status
  // enum discovered during the transaction-flow pass.
  const postStatusEn = loadMessages('en-ZA', 'barter').postStatus
  const POST_STATUSES = ['draft', 'active', 'offers_received', 'matched', 'paused', 'closed', 'archived', 'suspended']
  check('65. barter Skill/Task post status labels cover every real barter_skill_task_post_status value', POST_STATUSES.every((s) => typeof postStatusEn[s] === 'string'))

  // Merchant validation coverage: the KYC verification flow's submit-error
  // path is translated via a stable namespace, not a hardcoded string
  // baked directly into the catch block.
  const kycFlowSrc = readFileSync(join(REPO_ROOT, "src/app/[locale]/(auth)/verify/kyc-flow.tsx"), 'utf8')
  check("66. KYC verification submit-error path is localized via tErrors('couldNotSubmit'), not a hardcoded English string", /tErrors\('couldNotSubmit'\)/.test(kycFlowSrc))

  // Accessibility / rich-text: the POPIA + Verification-and-Trust consent
  // links inside the KYC document-upload step use the locale-aware Link
  // component via t.rich(), not a raw <a href="/popia"> (which would both
  // drop the locale prefix and hardcode the English link text).
  check('67. KYC consent copy renders its internal links via the locale-aware Link component inside t.rich(), not raw <a> tags', /tDocs\.rich\('agreeToTerms'/.test(kycFlowSrc) && !/<a href="\/popia"/.test(kycFlowSrc))

  // No public dictionary expansion: the root layout's minimal public
  // client-message set must still be exactly navigation + the 2 advertising
  // disclosure keys -- this batch's substantial merchant.json growth must
  // never have been added here, since every page in this batch is either a
  // Server Component or lives behind the already-full-message (dashboard)
  // provider.
  const rootLayoutSrc = readFileSync(join(REPO_ROOT, 'src/app/[locale]/layout.tsx'), 'utf8')
  check(
    '68. the root layout public client-message set is still exactly navigation + 2 advertising keys (no merchant/account namespace growth leaked into the public provider)',
    /const publicClientMessages = \{[\s\S]*?navigation: messages\.navigation,[\s\S]*?sponsoredLabel:[\s\S]*?sponsoredSearchResult:[\s\S]*?\}/.test(rootLayoutSrc) &&
      !/publicClientMessages[\s\S]*?merchant:/.test(rootLayoutSrc)
  )
}

console.log('\n--- FINAL CONTENT-CREATION / PUBLIC-PROFILE BATCH (PAGE COMPLETION PASS 3) ---')
{
  const manifestSrc = readFileSync(join(REPO_ROOT, 'src/i18n/page-coverage-manifest.ts'), 'utf8')
  const FINAL_BATCH_ROUTES = [
    '(dashboard)/dashboard/barter/skill-task/[id]/edit/page.tsx',
    '(dashboard)/dashboard/barter/skill-task/new/page.tsx',
    '(dashboard)/dashboard/merchant/listings/new/page.tsx',
    '(marketing)/ambassadors/page.tsx',
    '(marketing)/chat/page.tsx',
    '(marketing)/looking-for/new/page.tsx',
    '(marketing)/profile/[id]/page.tsx',
  ]
  const notWired = FINAL_BATCH_ROUTES.filter((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\{ path: '${escaped}', status: '(\\w[\\w-]*)'`)
    const m = manifestSrc.match(re)
    return !m || m[1] !== 'wired'
  })
  check(`69. all ${FINAL_BATCH_ROUTES.length} final-batch routes are marked 'wired' in the page-coverage manifest`, notWired.length === 0, { notWired })

  // Full manifest closure: all 7 batch routes are wired (check 69).
  // Superseded by the gap-closure pass (checks 80+ below): the 3 pages
  // this check used to carve out as known-unwired (homepage,
  // advertising/new, subscription) are now genuinely wired, so the
  // manifest should show truthfully 0 unwired entries -- 61/61 real,
  // not fabricated.
  const entryMatches = [...manifestSrc.matchAll(/\{ path: '([^']+)', status: '(wired|shared-layout|unwired)'/g)]
  const wiredCount = entryMatches.filter((m) => m[2] === 'wired').length
  const sharedLayoutCount = entryMatches.filter((m) => m[2] === 'shared-layout').length
  const unwiredEntries = entryMatches.filter((m) => m[2] === 'unwired').map((m) => m[1])
  check(
    `70. page manifest is truthfully closed: 0 unwired entries remain -- ${wiredCount + sharedLayoutCount}/${entryMatches.length} localized`,
    unwiredEntries.length === 0 && wiredCount + sharedLayoutCount === entryMatches.length,
    { wiredCount, sharedLayoutCount, unwiredEntries, total: entryMatches.length }
  )

  // Skill/Task creation + edit: shared form is genuinely translated, and
  // core postForm keys this UI depends on actually exist (dictionary drift
  // guard, not a UI render test).
  const skillTaskFormSrc = readFileSync(join(REPO_ROOT, 'src/components/barter/skill-task-post-form.tsx'), 'utf8')
  check("71a. skill-task-post-form.tsx (shared by new + edit) calls useTranslations('barter.postForm')", /useTranslations\('barter\.postForm'\)/.test(skillTaskFormSrc))
  check('71b. skill-task-post-form.tsx uses the locale-aware @/i18n/navigation router, not next/navigation', /from '@\/i18n\/navigation'/.test(skillTaskFormSrc) && !/useRouter.*from 'next\/navigation'/.test(skillTaskFormSrc))
  const postFormEn = loadMessages('en-ZA', 'barter').postForm
  const POST_FORM_REQUIRED_KEYS = ['newPostHeading', 'editPostHeading', 'titleLabel', 'descriptionLabel', 'deliveryModeLabel', 'saveDraft', 'publish', 'errors']
  check('71c. barter.postForm dictionary section has every key the form component reads', POST_FORM_REQUIRED_KEYS.every((k) => k in (postFormEn ?? {})))

  // Merchant listing creation: the 8-step wizard reads its labels from the
  // dictionary and no longer imports the old hardcoded RISK_TIER_LABELS map.
  const listingFlowSrc = readFileSync(join(REPO_ROOT, 'src/app/[locale]/(dashboard)/dashboard/merchant/listings/new/create-listing-flow.tsx'), 'utf8')
  check("72a. create-listing-flow.tsx calls useTranslations('merchant.listingCreation')", /useTranslations\('merchant\.listingCreation'\)/.test(listingFlowSrc))
  check('72b. the old hardcoded RISK_TIER_LABELS import is gone (risk tier labels now come from the dictionary)', !/RISK_TIER_LABELS/.test(listingFlowSrc))
  check('72c. create-listing-flow.tsx uses the locale-aware @/i18n/navigation router', /useRouter, Link \} from '@\/i18n\/navigation'|Link \} from '@\/i18n\/navigation'/.test(listingFlowSrc))
  const listingCreationEn = loadMessages('en-ZA', 'merchant').listingCreation
  check('72d. merchant.listingCreation dictionary section exists and is substantial (all 8 wizard steps present)', !!listingCreationEn && !!listingCreationEn.basics && !!listingCreationEn.photos && !!listingCreationEn.ownership && !!listingCreationEn.pricing && !!listingCreationEn.requirements && !!listingCreationEn.affiliates && !!listingCreationEn.review)

  // Looking For creation: request form translated, standard redirectTo
  // param used (not the old nonstandard ?next=).
  const requestFormSrc = readFileSync(join(REPO_ROOT, 'src/components/marketplace/request-form.tsx'), 'utf8')
  check("73a. request-form.tsx calls useTranslations('lookingFor.newRequestPage')", /useTranslations\('lookingFor\.newRequestPage'\)/.test(requestFormSrc))
  const lookingForNewPageSrc = readFileSync(join(REPO_ROOT, 'src/app/[locale]/(marketing)/looking-for/new/page.tsx'), 'utf8')
  check("73b. looking-for/new/page.tsx uses the standard redirectTo param (not the old nonstandard ?next=)", /redirectTo=/.test(lookingForNewPageSrc) && !/\?next=/.test(lookingForNewPageSrc))

  // Chat: ChatThread stays admin-safe -- optional labels/locale props with
  // hardcoded English defaults, and the admin call site passes neither.
  const chatThreadSrc = readFileSync(join(REPO_ROOT, 'src/components/messaging/chat-thread.tsx'), 'utf8')
  check('74a. ChatThread declares an optional labels prop with a hardcoded-English DEFAULT_LABELS fallback (admin-safe pattern)', /labels\?:\s*ChatThreadLabels/.test(chatThreadSrc) && /const DEFAULT_LABELS: ChatThreadLabels = \{/.test(chatThreadSrc))
  check('74b. ChatThread never calls useTranslations() unconditionally (would break the admin call site, which has no i18n provider)', !/const t = useTranslations\(/.test(chatThreadSrc))
  const adminOrderPageSrc = readFileSync(join(REPO_ROOT, 'src/app/admin/orders/[id]/page.tsx'), 'utf8')
  const adminChatThreadCall = (adminOrderPageSrc.match(/<ChatThread[\s\S]*?\/>/) ?? [''])[0]
  check('74c. the admin order-detail ChatThread call site passes neither labels nor locale (zero admin changes this pass)', !/labels=/.test(adminChatThreadCall) && !/locale=/.test(adminChatThreadCall))
  const chatUiSrc = readFileSync(join(REPO_ROOT, 'src/app/[locale]/(marketing)/chat/chat-ui.tsx'), 'utf8')
  check("74d. chat-ui.tsx (the [locale] call site) actually supplies a resolved labels object to ChatThread", /labels=\{\{/.test(chatUiSrc))

  // Ambassadors: uses getTranslations, no invented benefit/commission
  // language beyond what merchant.ambassadors already documents.
  const ambassadorsSrc = readFileSync(join(REPO_ROOT, 'src/app/[locale]/(marketing)/ambassadors/page.tsx'), 'utf8')
  check("75. ambassadors/page.tsx calls getTranslations('merchant.ambassadors') for both metadata and body", (ambassadorsSrc.match(/getTranslations\('merchant\.ambassadors'\)/g) ?? []).length >= 2)

  // Public profile: narrow scoped provider (same leak-prevention pattern as
  // check 56), and the scoped object never references forbidden
  // private/moderation vocabulary by name.
  const profilePageSrc = readFileSync(join(REPO_ROOT, 'src/app/[locale]/(marketing)/profile/[id]/page.tsx'), 'utf8')
  const scopedBlockMatch = profilePageSrc.match(/const scoped = \{[\s\S]*?\n  \}/)
  const scopedBlock = scopedBlockMatch ? scopedBlockMatch[0] : ''
  check('76a. profile/[id]/page.tsx passes the narrow `scoped` object to every NextIntlClientProvider, never the full messages tree', (profilePageSrc.match(/NextIntlClientProvider messages=\{scoped\}/g) ?? []).length >= 2 && !/NextIntlClientProvider messages=\{messages\}/.test(profilePageSrc))
  const FORBIDDEN_PROFILE_VOCAB = ['preferred_locale', 'kyc_status', 'account_status', 'manual_review', 'moderation', 'payout', 'admin']
  check('76b. the scoped object literal never references preferred_locale/KYC-status/moderation/payout vocabulary by name', !!scopedBlock && FORBIDDEN_PROFILE_VOCAB.every((v) => !scopedBlock.includes(v)))
  check('76c. getPublicProfile is never called with a raw profiles table select beyond the public-safe column set (public_profiles boundary reused, not bypassed)', /getPublicProfile\(id\)/.test(profilePageSrc) && !/from\('profiles'\)/.test(profilePageSrc))

  // Public profile privacy at the dictionary level: common.profile itself
  // must never carry private-status vocabulary that a future scoped object
  // could accidentally serialize wholesale.
  const commonProfileEn = loadMessages('en-ZA', 'common').profile
  const profileDictJson = JSON.stringify(commonProfileEn)
  check('77. common.profile dictionary contains no private KYC/moderation vocabulary (rejected/manual review/verification reason)', !/rejected|manual review|verification reason|payout/i.test(profileDictJson))

  // Zero known locale drops in the final batch: representative
  // unauthenticated requests to the newly-wired auth-gated routes must
  // redirect to the correctly-prefixed login, never bare /login.
  const finalBatchRepresentativeRoutes = [
    '/af/dashboard/barter/skill-task/new',
    '/zu/dashboard/merchant/listings/new',
    '/af/chat',
    '/zu/looking-for/new',
  ]
  for (const path of finalBatchRepresentativeRoutes) {
    const localePrefix = path.startsWith('/af/') ? '/af' : '/zu'
    await httpCheck(`78. [${path}] unauthenticated redirect stays locale-prefixed (no locale drop)`, await fetchText(path), (_t, status, headers) => {
      const location = headers?.get?.('location') ?? ''
      check(
        `78. [${path}] unauthenticated redirect stays locale-prefixed (no locale drop)`,
        [301, 302, 307, 308].includes(status) && location.startsWith(`${localePrefix}/login`),
        { status, location }
      )
    })
  }

  // Public profile page itself is reachable (no auth gate) and locale-safe
  // across all 3 prefixes -- it is the one final-batch route that must
  // NOT redirect to login for an anonymous visitor.
  await httpCheck('79a. /profile/[id] (default locale, anonymous) does not redirect to login', await fetchText('/profile/00000000-0000-0000-0000-000000000000'), (_t, status) => {
    check('79a. /profile/[id] (default locale, anonymous) does not redirect to login', status === 404 || status === 200, { status })
  })
  await httpCheck('79b. /af/profile/[id] (Afrikaans, anonymous) does not redirect to login', await fetchText('/af/profile/00000000-0000-0000-0000-000000000000'), (_t, status) => {
    check('79b. /af/profile/[id] (Afrikaans, anonymous) does not redirect to login', status === 404 || status === 200, { status })
  })
}

console.log('\n--- GAP-CLOSURE PASS: 61/61 PAGE COMPLETION ---')
{
  // Homepage: genuinely reads from common.home, not just the one
  // pre-existing verified-badge label; generateMetadata uses it too.
  const homeSrc = readFileSync(join(REPO_ROOT, 'src/app/[locale]/(marketing)/page.tsx'), 'utf8')
  check("80a. homepage calls getTranslations('common.home') in both generateMetadata and the page body", (homeSrc.match(/getTranslations\('common\.home'\)/g) ?? []).length >= 2)
  check('80b. homepage no longer has any of the old raw English hero/section string literals in JSX', !/>RENT<|WHAT&apos;S AVAILABLE\.<|THREE STEPS\.<|FOUR WAYS TO USE UNITY\.<|START EARNING TODAY\.</.test(homeSrc))
  const homeEn = loadMessages('en-ZA', 'common').home
  check('80c. common.home dictionary section exists with hero/marquee/howItWorks/platformFeatures/trust/finalCta', !!homeEn && !!homeEn.hero && !!homeEn.marquee && !!homeEn.howItWorks && !!homeEn.platformFeatures && !!homeEn.trust && !!homeEn.finalCta)
  check('80d. homepage still uses the leak-safe server-resolved Verified label prop (unchanged mechanism)', /verifiedLabel=\{listing\.ownership_verified \? verifiedLabel : undefined\}/.test(homeSrc))
  const rootLayoutSrc2 = readFileSync(join(REPO_ROOT, 'src/app/[locale]/layout.tsx'), 'utf8')
  check(
    '80e. the root layout public client-message set is STILL exactly navigation + 2 advertising keys -- common.home is read server-side only, never broadening the public client provider',
    /const publicClientMessages = \{[\s\S]*?navigation: messages\.navigation,[\s\S]*?sponsoredLabel:[\s\S]*?sponsoredSearchResult:[\s\S]*?\}/.test(rootLayoutSrc2) &&
      !/publicClientMessages[\s\S]*?home:/.test(rootLayoutSrc2)
  )

  // Advertising create page: genuinely wired, not just useLocale-for-money.
  const adCreateSrc = readFileSync(join(REPO_ROOT, 'src/app/[locale]/(dashboard)/dashboard/merchant/advertising/new/page.tsx'), 'utf8')
  check("81a. advertising/new/page.tsx calls useTranslations('advertising.create')", /useTranslations\('advertising\.create'\)/.test(adCreateSrc))
  const adCreateEn = loadMessages('en-ZA', 'advertising').create
  check('81b. advertising.create dictionary section exists with listing/package/placements/errors', !!adCreateEn && !!adCreateEn.placements && !!adCreateEn.errors)
  check('81c. advertising/new/page.tsx no longer has the old hardcoded PLACEMENT_LABEL string map', !/const PLACEMENT_LABEL: Record<string, string> = \{\s*homepage_banner: 'Homepage banner'/.test(adCreateSrc))

  // Merchant subscription page: genuinely wired, formatDate replacing the
  // hardcoded toLocaleDateString('en-ZA') calls.
  const subSrc = readFileSync(join(REPO_ROOT, 'src/app/[locale]/(dashboard)/dashboard/merchant/subscription/page.tsx'), 'utf8')
  check("82a. subscription/page.tsx calls useTranslations('merchant.subscriptionPage')", /useTranslations\('merchant\.subscriptionPage'\)/.test(subSrc))
  check("82b. subscription/page.tsx no longer hardcodes toLocaleDateString\\('en-ZA'\\)", !/toLocaleDateString\('en-ZA'\)/.test(subSrc))
  check('82c. subscription/page.tsx uses the centralized formatDate helper', /formatDate\(/.test(subSrc) && /from '@\/lib\/i18n\/format'/.test(subSrc))
  const subEn = loadMessages('en-ZA', 'merchant').subscriptionPage
  check('82d. merchant.subscriptionPage dictionary section exists with the plan-comparison/billing copy', !!subEn && !!subEn.allPlans && !!subEn.billingNotice)

  // Four partial pages: no more of the exact previously-flagged raw
  // English fragments (heuristic string-literal absence, not a full
  // re-audit -- the full-scope audit already ran once this larger pass).
  const partialPageChecks = [
    { path: '(dashboard)/dashboard/merchant/advertising/page.tsx', mustNotContain: ['>Advertising</h1', '>Your campaigns<', '>Advertising Balance<'] },
    { path: '(dashboard)/dashboard/merchant/commissions/page.tsx', mustNotContain: ['>Earnings<', '>Transaction History<', '>Eligible amount<', '>Your proceeds basis<'] },
    { path: '(dashboard)/dashboard/merchant/listings/page.tsx', mustNotContain: ['>Your Listings<', '>My Listings<', '>No listings yet<'] },
    { path: '(dashboard)/dashboard/renter/page.tsx', mustNotContain: ['>Rentals<', '>Bookings<', '>Your Bookings<', '>No active rentals yet<'] },
  ]
  const partialPageFindings = []
  for (const { path, mustNotContain } of partialPageChecks) {
    const src = readFileSync(join(REPO_ROOT, 'src/app/[locale]', path), 'utf8')
    for (const needle of mustNotContain) {
      if (src.includes(needle)) partialPageFindings.push({ path, needle })
    }
  }
  check('83. the 4 previously-flagged partial pages no longer contain their identified raw-English fragments', partialPageFindings.length === 0, { partialPageFindings })

  // Legal inline cross-reference links: every one of the 12 legal pages
  // now imports the locale-aware Link, not plain next/link or a raw <a>
  // for internal navigation.
  const LEGAL_PAGES = [
    'terms', 'privacy', 'popia', 'rental-terms', 'payments-and-deposits',
    'cancellations', 'refunds', 'disputes', 'prohibited-items',
    'delivery-and-handover', 'verification-and-trust', 'contact',
  ]
  const legalFindings = []
  for (const slug of LEGAL_PAGES) {
    const src = readFileSync(join(REPO_ROOT, `src/app/[locale]/(marketing)/${slug}/page.tsx`), 'utf8')
    if (/import Link from 'next\/link'/.test(src)) legalFindings.push({ slug, issue: 'still imports plain next/link' })
    if (/<a href="\/[a-z]/.test(src)) legalFindings.push({ slug, issue: 'still has a raw <a href="/..."> internal link' })
    if (!/from '@\/i18n\/navigation'/.test(src)) legalFindings.push({ slug, issue: 'does not import the locale-aware Link' })
  }
  check('84. all 12 legal pages use the locale-aware Link for internal cross-references (no plain next/link, no raw <a> to an internal path)', legalFindings.length === 0, { legalFindings })

  // Live locale-retention proof for a representative legal inline link,
  // both directions, plus the no-double-prefix guard.
  await httpCheck('85a. [/af/terms] inline cross-reference to /privacy stays locale-prefixed', await fetchText('/af/terms'), (text) => {
    check('85a. [/af/terms] inline cross-reference to /privacy stays locale-prefixed', /href="\/af\/privacy"/.test(text) && !text.includes('href="/privacy"'))
  })
  await httpCheck('85b. [/zu/contact] inline cross-reference to /popia stays locale-prefixed', await fetchText('/zu/contact'), (text) => {
    check('85b. [/zu/contact] inline cross-reference to /popia stays locale-prefixed', /href="\/zu\/popia"/.test(text) && !text.includes('href="/popia"'))
  })
  await httpCheck('86. [/zu/terms] no double-prefix anywhere on the page (/zu/zu never appears)', await fetchText('/zu/terms'), (text) => {
    check('86. [/zu/terms] no double-prefix anywhere on the page (/zu/zu never appears)', !text.includes('/zu/zu') && !text.includes('/af/af'))
  })

  // Email invariant reconfirmed intact (already verified in depth at
  // 48a-48g; restated as a standalone, independently-computed check here
  // since this gap pass's own success condition names it explicitly and
  // "emails are closed, verify only" -- re-parsed fresh, not reusing an
  // out-of-scope variable from the earlier block).
  const catalogueSrc2 = readFileSync(join(REPO_ROOT, 'src/lib/email/templates/catalogue.ts'), 'utf8')
  const idMatches2 = [...catalogueSrc2.matchAll(/id: '([a-z0-9-]+)'/g)]
  let fullyCompleteCount2 = 0
  for (let i = 0; i < idMatches2.length; i++) {
    const start = idMatches2[i].index
    const end = i + 1 < idMatches2.length ? idMatches2[i + 1].index : catalogueSrc2.length
    const block = catalogueSrc2.slice(start, end)
    if (/localeVariants:[\s\S]*?'af-ZA':/.test(block) && /localeVariants:[\s\S]*?'zu-ZA':/.test(block)) fullyCompleteCount2++
  }
  check(`87. email invariant remains intact: 87/87/87 (${fullyCompleteCount2}/${idMatches2.length} templates fully localized)`, idMatches2.length === 87 && fullyCompleteCount2 === 87)
}

console.log('\n=== SUMMARY ===')
console.log(`checks: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}, skipped (explicitly, not silently): ${skipped}`)
if (failures > 0) process.exit(1)
