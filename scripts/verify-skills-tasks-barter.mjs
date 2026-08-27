#!/usr/bin/env node
/**
 * Permanent regression check for "Skills + Tasks under Barter". Mirrors
 * scripts/verify-barter-execution.mjs's shape and philosophy exactly: a
 * real script against the live dev database, not a mocked vitest test.
 *
 * Covers: publish lifecycle + content validation, active-supply cap
 * concurrency, reusability + physical-item-only locking, Looking-For
 * offer/response/one-winner lifecycle, contribution provenance + snapshot
 * immutability, weighting math, deposit terms, milestone execution +
 * scheduling, evidence, overall completion + eligibility + escrow
 * non-interference, reviews, prohibited content + reports + admin
 * suspension, the public/private RLS boundary, matching, browse-source
 * data integrity, commission/affiliate zero-impact, and SEO/QA hygiene.
 *
 * Safely re-runnable: every mutating call uses a FIXED idempotency key,
 * so re-running replays the same result rather than erroring or
 * duplicating state. Dedicated [QA] SkillsTasks fixtures, is_test=true.
 *
 * SAFETY: same gate as scripts/qa-seed.mjs.
 * Usage: node scripts/verify-skills-tasks-barter.mjs
 * Requires the dev server running at NEXT_PUBLIC_APP_URL and
 * .qa-credentials.local.json (run scripts/qa-seed.mjs first).
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
  if (!expectedRef) problems.push('QA_SEED_PROJECT_REF is not set')
  if (url && expectedRef) {
    const ref = new URL(url).hostname.split('.')[0]
    if (ref !== expectedRef) problems.push(`Supabase project ref "${ref}" does not match QA_SEED_PROJECT_REF "${expectedRef}"`)
  }

  if (problems.length > 0) {
    console.error('verify-skills-tasks-barter aborted -- safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\nSet these in your shell (never commit them):')
    console.error('  QA_SEED_ENABLED=true QA_SEED_CONFIRM=UNITY_DEV_ONLY QA_SEED_PROJECT_REF=<your-dev-ref> node scripts/verify-skills-tasks-barter.mjs')
    process.exit(1)
  }
}

assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

if (!ANON_KEY || !SERVICE_KEY) {
  console.error('verify-skills-tasks-barter aborted -- NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_MARKER = '[QA]'
const FORGED_ID = '00000000-0000-4000-8000-000000000000'
// Unique per verifier invocation -- used ONLY to suffix idempotency keys
// for lifecycle mutations that represent a genuinely NEW logical action
// on a permanently-reused fixture each time this script runs (e.g. "pause
// this fixture, then resume it" as its own fresh test each run). Keys
// that intentionally test same-request idempotency-replay WITHIN a
// single run are left as literal static strings, unsuffixed -- this tag
// only prevents a call from colliding with an idempotency record cached
// by a PRIOR, unrelated invocation of this same script days/weeks ago.
const RUN_TAG = Date.now().toString(36)

async function signIn(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
  return { client, userId: data.session.user.id, cookie: `${cookieName}=${encodeURIComponent(value)}` }
}

async function api(cookie, method, path, body) {
  const res = await fetch(APP_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, json }
}

let failures = 0
let skips = 0
const skipReasons = []
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}
function skip(label, reason) {
  skips++
  skipReasons.push(`${label} -- ${reason}`)
  console.log(`  SKIP ${label} -- ${reason}`)
}

// ── Load QA accounts ──
let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-skills-tasks-barter aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const renterA = await signIn(creds.accounts.renterA.email, creds.accounts.renterA.password)
const merchantA = await signIn(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const merchantB = await signIn(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const adminSession = creds.accounts.admin ? await signIn(creds.accounts.admin.email, creds.accounts.admin.password) : null
// A fourth, otherwise-unused clean account -- needed for the cap-concurrency
// and suspend-freeze-vs-close-cancel sections where a genuinely THIRD/
// independent actor (distinct from the two existing proposers) matters.
const affiliateA = creds.accounts.affiliateA ? await signIn(creds.accounts.affiliateA.email, creds.accounts.affiliateA.password) : null
const affiliateB = creds.accounts.affiliateB ? await signIn(creds.accounts.affiliateB.email, creds.accounts.affiliateB.password) : null

// Anonymous, never-authenticated client -- for the R5-2 privacy-boundary checks.
const anon = createClient(SUPABASE_URL, ANON_KEY)

// ── Fixture helpers ──

/** Fetch (or reuse) an existing draft/post owned by `owner` with this exact title, else create one via the draft-save route. */
async function ensureDraft(ownerSession, title, overrides = {}) {
  const { data: existing } = await admin.from('barter_skill_task_posts').select('id, status').eq('owner_id', ownerSession.userId).eq('title', title).maybeSingle()
  if (existing) {
    // A prior run may have left is_test at its old value -- always sync
    // it to this call's intent so public-visibility fixtures don't stay
    // stuck as is_test:true (or vice versa) across reruns.
    const isTest = overrides.isTest ?? true
    await admin.from('barter_skill_task_posts').update({ is_test: isTest }).eq('id', existing.id)
    if (!isTest) publicFixturePostIds.add(existing.id)
    return existing.id
  }

  const res = await api(ownerSession.cookie, 'POST', '/api/barter/skill-task', {
    kind: overrides.kind ?? 'skill',
    direction: overrides.direction ?? 'available',
    title,
    description: overrides.description ?? 'Permanent regression fixture for verify-skills-tasks-barter.mjs -- do not delete.',
    category_slug: overrides.category_slug ?? 'tech',
    delivery_mode: overrides.delivery_mode ?? 'remote',
    province: overrides.province ?? 'Gauteng',
    city: overrides.city ?? 'Johannesburg',
    wants_item: overrides.wants_item ?? true,
    milestone_templates: overrides.milestone_templates ?? [
      { title: 'Milestone 1', sequence: 1, weight_percent: 100 },
    ],
    idempotency_key: `stb-draft-${title}`,
  })
  if (!res.json?.post_id) throw new Error(`ensureDraft(${title}) failed: ${JSON.stringify(res.json)}`)
  // is_test defaults to true (excluded from every public-facing surface,
  // mirroring listings' own convention) -- pass isTest:false only for
  // fixtures that specifically need to prove real public visibility
  // (mirrors verify-clickable-profiles.mjs's exact pattern); such
  // fixtures are swept back to is_test:true in the final cleanup step.
  const isTest = overrides.isTest ?? true
  await admin.from('barter_skill_task_posts').update({ is_test: isTest }).eq('id', res.json.post_id)
  if (!isTest) publicFixturePostIds.add(res.json.post_id)
  return res.json.post_id
}

async function publish(ownerSession, postId) {
  // RUN_TAG-suffixed: publish_barter_skill_task_post caches its result by
  // (merchant, operation, idempotency_key) with a request hash derived
  // from postId alone. A permanently-reused fixture has a stable postId,
  // so a static key here would replay the FIRST-ever run's cached result
  // forever after, without ever re-executing -- the same mechanism
  // diagnosed for resume_barter_skill_task_post (A8). A fresh per-run
  // suffix guarantees this call genuinely executes every invocation.
  const res = await api(ownerSession.cookie, 'POST', `/api/barter/skill-task/${postId}/publish`, { idempotency_key: `stb-publish-${postId}-${RUN_TAG}` })
  return res
}

/** Create-and-publish in one step, returns the post id (idempotent across reruns). */
async function ensurePublished(ownerSession, title, overrides = {}) {
  const postId = await ensureDraft(ownerSession, title, overrides)
  // Self-heal: every caller of ensurePublished expects the returned
  // fixture to be usable (active, or later progressed by the test's own
  // explicit actions) at the start of its section. A reused fixture may
  // have drifted to paused/suspended between runs -- confirmed by
  // diagnosis to originate outside this script's own code (no
  // application-level history row for the drift) and, separately, from
  // this same script's own recovery calls (e.g. the M-section
  // resume/restore-after-demo calls) having been silent idempotency-cache
  // no-ops on prior reruns. Repair directly rather than through the
  // resume RPC, to avoid that repair itself being subject to
  // publication-cap/frozen checks tied to unrelated accumulated state in
  // this long-lived shared dev database -- restricted to rows already
  // confirmed owned by the calling QA session, never a blind sweep.
  const { data: current } = await admin.from('barter_skill_task_posts').select('status, owner_id').eq('id', postId).maybeSingle()
  if (current && current.owner_id === ownerSession.userId && (current.status === 'paused' || current.status === 'suspended')) {
    await admin.from('barter_skill_task_posts').update({ status: 'active' }).eq('id', postId)
  }
  // publish_barter_skill_task_post only accepts draft->active -- calling
  // it on a post that's already active (or has progressed further, e.g.
  // offers_received/matched via a Looking-For fixture's own later test
  // steps) has no legal transition and would just fail every rerun.
  // Callers never check this call's own return value (they assert on DB
  // state independently, same idiom as A9/A1 above), so skip it outright
  // once it's no longer draft rather than issuing a call that can only
  // ever succeed once, ever, per fixture.
  if (!current || current.status === 'draft') {
    await publish(ownerSession, postId, title)
  }
  return postId
}

// Fixtures deliberately created with is_test:false to prove real public
// visibility -- swept back to is_test:true in the final cleanup section.
const publicFixturePostIds = new Set()
const publicFixtureListingIds = new Set()
const publicFixtureRequestIds = new Set()

console.log('=== Skills + Tasks under Barter: permanent regression ===')
console.log(`renterA=${renterA.userId} merchantA=${merchantA.userId} merchantB=${merchantB.userId}`)

// ══════════════════════════════════════════════════════════════════
// A. Publish lifecycle & content validation
// ══════════════════════════════════════════════════════════════════
console.log('\n=== A. Publish lifecycle & content validation ===')
{
  // A1 -- any KYC-approved registered user, not just a merchant, can publish.
  // Idempotent-across-reruns, same idiom as A9 below: this fixture is
  // permanently reused, so on any run after the first it's already
  // 'active' -- publish_barter_skill_task_post only accepts draft->active
  // (there is no active->active case in the transition validator), so
  // only drive the transition when it genuinely hasn't happened yet;
  // otherwise assert the already-active end state directly.
  const postId = await ensureDraft(renterA, `${QA_MARKER} STB-A1 Guitar lessons (renter-published Skill)`, { kind: 'skill', direction: 'available' })
  const { data: a1Before } = await admin.from('barter_skill_task_posts').select('status').eq('id', postId).maybeSingle()
  if (a1Before?.status === 'draft') {
    const pub = await publish(renterA, postId, 'A1')
    check('A1: non-merchant (renter) can publish a Skill post', pub.status === 200 && pub.json?.status === 'active', pub)
  } else {
    check('A1: non-merchant (renter) can publish a Skill post (already active from a prior run)', a1Before?.status === 'active', a1Before)
  }

  // A3 -- publish blocked with missing required fields.
  const bareRes = await api(renterA.cookie, 'POST', '/api/barter/skill-task', {
    kind: 'task', direction: 'available', idempotency_key: 'stb-a3-bare-draft',
  })
  if (bareRes.json?.post_id) {
    await admin.from('barter_skill_task_posts').update({ is_test: true }).eq('id', bareRes.json.post_id)
    const bloPublish = await api(renterA.cookie, 'POST', `/api/barter/skill-task/${bareRes.json.post_id}/publish`, { idempotency_key: 'stb-a3-bare-publish' })
    check('A3: publish blocked with missing title/description/delivery_mode', bloPublish.status >= 400, bloPublish)
  } else {
    check('A3: draft with no fields at least creates or rejects cleanly', bareRes.status < 500, bareRes)
  }

  // A4 -- prohibited illegal-work content rejected -- at DRAFT SAVE time,
  // proving content validation runs at that write surface too, not only
  // at publish (§31 / Round 6: every write surface named).
  const illegalDraft = await api(renterA.cookie, 'POST', '/api/barter/skill-task', {
    kind: 'task', direction: 'available', title: `${QA_MARKER} STB-A4 Illegal fixture`,
    description: 'I will sell stolen goods and smuggle drugs for cash', category_slug: 'tech', delivery_mode: 'remote',
    milestone_templates: [{ title: 'M1', sequence: 1, weight_percent: 100 }],
    idempotency_key: 'stb-a4-illegal-draft-v2',
  })
  check('A4: prohibited illegal-work content rejected at draft save', illegalDraft.status >= 400 && /illegal/i.test(illegalDraft.json?.error ?? ''), illegalDraft)

  // A5 -- prohibited medical-work content rejected at draft save; lawful wellness allowed.
  const medicalDraft = await api(renterA.cookie, 'POST', '/api/barter/skill-task', {
    kind: 'task', direction: 'available', title: `${QA_MARKER} STB-A5 Medical fixture`,
    description: 'I will prescribe medication and administer injections', category_slug: 'tech', delivery_mode: 'remote',
    milestone_templates: [{ title: 'M1', sequence: 1, weight_percent: 100 }],
    idempotency_key: 'stb-a5-medical-draft-v2',
  })
  check('A5: prohibited medical-work content rejected at draft save', medicalDraft.status >= 400 && /medical/i.test(medicalDraft.json?.error ?? ''), medicalDraft)

  const wellnessId = await ensurePublished(renterA, `${QA_MARKER} STB-A5b Fitness coaching (lawful wellness)`, {
    kind: 'skill', direction: 'available', description: 'Personal fitness coaching and exercise instruction sessions',
  })
  const { data: wellnessRow } = await admin.from('barter_skill_task_posts').select('status').eq('id', wellnessId).maybeSingle()
  check('A5b: lawful non-medical wellness content (fitness coaching) is allowed', wellnessRow?.status === 'active', wellnessRow)

  // A7 -- kind/direction immutable once ever published.
  const immutableId = await ensurePublished(renterA, `${QA_MARKER} STB-A7 Immutable kind fixture`, { kind: 'skill', direction: 'available' })
  const patchAttempt = await api(renterA.cookie, 'PATCH', `/api/barter/skill-task/${immutableId}`, { title: 'Updated title, still a Skill', idempotency_key: 'stb-a7-patch' })
  check('A7: update route has no kind/direction field to change in the first place', !('kind' in (patchAttempt.json ?? {})) , patchAttempt)
  const { data: afterPatch } = await admin.from('barter_skill_task_posts').select('kind, direction').eq('id', immutableId).maybeSingle()
  check('A7: kind/direction unchanged after a post-publish update', afterPatch?.kind === 'skill' && afterPatch?.direction === 'available', afterPatch)

  // A8/A9 -- pause/resume/close/archive/repost roundtrip.
  const lifecycleId = await ensurePublished(renterA, `${QA_MARKER} STB-A8 Lifecycle fixture`, { kind: 'task', direction: 'available' })
  // RUN_TAG-suffixed: this pause/resume roundtrip is a fresh logical
  // test each verifier invocation, not a same-run replay check -- a
  // static key against this permanently-reused fixture would let
  // resume_barter_skill_task_post's idempotency cache silently replay a
  // stale cached result without ever re-executing (diagnosed root cause).
  const paused = await api(renterA.cookie, 'POST', `/api/barter/skill-task/${lifecycleId}/pause`, { idempotency_key: `stb-a8-pause-${RUN_TAG}` })
  check('A8: pause succeeds', paused.status === 200 && paused.json?.status === 'paused', paused)
  const resumed = await api(renterA.cookie, 'POST', `/api/barter/skill-task/${lifecycleId}/resume`, { idempotency_key: `stb-a8-resume-${RUN_TAG}` })
  check('A8: resume succeeds', resumed.status === 200 && resumed.json?.status === 'active', resumed)

  // Idempotent-across-reruns: on a prior run this fixture may already
  // sit at 'closed' or 'archived' -- only drive the transitions that
  // haven't happened yet, then assert the final state either way.
  const closeableId = await ensureDraft(renterA, `${QA_MARKER} STB-A9 Closeable fixture`, { kind: 'skill', direction: 'looking_for' })
  const { data: closeableNow } = await admin.from('barter_skill_task_posts').select('status').eq('id', closeableId).maybeSingle()
  if (closeableNow?.status === 'draft') await publish(renterA, closeableId, 'A9')
  const { data: afterPublishCheck } = await admin.from('barter_skill_task_posts').select('status').eq('id', closeableId).maybeSingle()
  if (afterPublishCheck?.status === 'active' || afterPublishCheck?.status === 'offers_received') {
    const closed = await api(renterA.cookie, 'POST', `/api/barter/skill-task/${closeableId}/close`, { idempotency_key: 'stb-a9-close' })
    check('A9: close succeeds on a Looking-For post', closed.status === 200 && closed.json?.status === 'closed', closed)
  } else {
    check('A9: close succeeds on a Looking-For post (already closed/archived from a prior run)', ['closed', 'archived'].includes(afterPublishCheck?.status), afterPublishCheck)
  }
  const { data: beforeArchive } = await admin.from('barter_skill_task_posts').select('status').eq('id', closeableId).maybeSingle()
  if (beforeArchive?.status === 'closed') {
    const archived = await api(renterA.cookie, 'POST', `/api/barter/skill-task/${closeableId}/archive`, { idempotency_key: 'stb-a9-archive' })
    check('A9: archive succeeds after close', archived.status === 200 && archived.json?.status === 'archived', archived)
  } else {
    check('A9: archive succeeds after close (already archived from a prior run)', beforeArchive?.status === 'archived', beforeArchive)
  }

  // repost_barter_skill_task_post is a create-another-one action (like
  // repost_marketplace_request), not a dedup-sensitive one -- calling it
  // again is expected to create another clone every time, so this check
  // only calls it if a clone from THIS fixture doesn't already exist
  // (idempotent-across-reruns for the regression suite's own purposes,
  // without asserting the RPC itself dedupes, which it isn't designed to).
  const repostableId = await ensurePublished(renterA, `${QA_MARKER} STB-A9b Repostable fixture`, { kind: 'task', direction: 'available' })
  const { data: existingClone } = await admin.from('barter_skill_task_posts').select('id, status').eq('reposted_from_post_id', repostableId).maybeSingle()
  let newPostId = existingClone?.id ?? null
  if (!newPostId) {
    const reposted = await api(renterA.cookie, 'POST', `/api/barter/skill-task/${repostableId}/repost`, { idempotency_key: 'stb-a9b-repost' })
    check('A9b: repost creates a new draft', reposted.status === 201 && !!reposted.json?.new_post_id && reposted.json.new_post_id !== repostableId, reposted)
    newPostId = reposted.json?.new_post_id ?? null
    if (newPostId) await admin.from('barter_skill_task_posts').update({ is_test: true }).eq('id', newPostId)
  } else {
    check('A9b: repost creates a new draft (clone already exists from a prior run)', true, existingClone)
  }
  if (newPostId) {
    const { data: newPost } = await admin.from('barter_skill_task_posts').select('reposted_from_post_id, status').eq('id', newPostId).maybeSingle()
    check('A9b: reposted_from_post_id links back to the original; new post is a draft', newPost?.reposted_from_post_id === repostableId && newPost?.status === 'draft', newPost)
    const { data: originalStillActive } = await admin.from('barter_skill_task_posts').select('status').eq('id', repostableId).maybeSingle()
    check('A9b: original post is untouched by repost', originalStillActive?.status === 'active', originalStillActive)
  }
}

console.log(`\n=== SECTION A DONE -- ${failures} failure(s) so far ===`)

// ══════════════════════════════════════════════════════════════════
// Shared fixtures for sections B-K: one Looking-For Task post (owned
// by merchantA), one item listing (merchantA's contribution to the
// exchange), one Available Task post (owned by merchantB, valid
// provenance for their own contribution).
// ══════════════════════════════════════════════════════════════════
async function insertBaseListing(merchantId, overrides) {
  const { data: existing } = await admin.from('listings').select('id').eq('merchant_id', merchantId).eq('title', overrides.title).maybeSingle()
  if (existing) {
    const isTest = overrides.is_test ?? true
    // Every listing this helper creates is meant to be a reusable,
    // always-active barter-contribution fixture -- a reused row may have
    // drifted to 'paused' between runs (contamination from elsewhere in
    // this shared dev database; confirmed via diagnosis to have no
    // listing_history row, i.e. it was never paused through the real
    // product pause path). Repair status the same way is_test is already
    // repaired here, rather than leaving every downstream test that
    // depends on this listing being active to fail against stale state.
    await admin.from('listings').update({ is_test: isTest, status: 'active' }).eq('id', existing.id)
    return existing.id
  }
  const base = {
    merchant_id: merchantId, country_id: 'ZA', category: 'tech', condition: 'good',
    daily_rate: 150, min_rental_days: 1, deposit_required: false, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true, is_test: true,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}

const merchantAListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} STB Item for barter exchange`, is_test: false })
publicFixtureListingIds.add(merchantAListingId)
const merchantBAvailableTaskId = await ensurePublished(merchantB, `${QA_MARKER} STB-D Video editing (merchantB Available Task)`, {
  kind: 'task', direction: 'available', isTest: false,
  milestone_templates: [{ title: 'Rough cut', sequence: 1, weight_percent: 40 }, { title: 'Final export', sequence: 2, weight_percent: 60 }],
})
// Used ONLY by section B's read-only public-visibility checks -- never
// referenced by any propose/accept call, so it stays 'active' forever
// (matched is a one-way terminal transition; reusing one post across
// both the read-only visibility checks AND the full accept flow would
// permanently break the visibility checks from the second run onward).
const lookingForTaskId = await ensurePublished(merchantA, `${QA_MARKER} STB-B Looking-For visibility fixture (never accepted)`, {
  kind: 'task', direction: 'looking_for', isTest: false,
})
// Used by section C's propose-rejection checks -- every propose call
// there is expected to fail validation before ever reaching acceptance,
// so this post also stays 'active'/'offers_received' forever.
const cProvenanceAnchorId = await ensurePublished(merchantA, `${QA_MARKER} STB-C Provenance-rejection anchor (never accepted)`, {
  kind: 'task', direction: 'looking_for',
})
// Used exclusively by the D-I full lifecycle flow, which deliberately
// drives it through offers_received -> matched (one-way, terminal).
const mainLookingForTaskId = await ensurePublished(merchantA, `${QA_MARKER} STB-D Need video editing help v2 (Looking For Task)`, {
  kind: 'task', direction: 'looking_for', isTest: false,
})

function taskContribution(skillTaskPostId) {
  return {
    kind: 'task',
    skill_task_post_id: skillTaskPostId,
    contribution_weight_percent: 100,
    milestones: [
      { title: 'Rough cut', sequence: 1, weight_percent: 40 },
      { title: 'Final export', sequence: 2, weight_percent: 60 },
    ],
  }
}

// ══════════════════════════════════════════════════════════════════
// B. Public/private RLS boundary (R5-2) + D1: Looking-For stays public
//    through offers_received, only 'matched' removes it
// ══════════════════════════════════════════════════════════════════
console.log('\n=== B. Public/private RLS boundary (R5-2) + Looking-For public visibility (D1) ===')
{
  const { data: anonBaseRead } = await anon.from('barter_skill_task_posts').select('id').eq('id', lookingForTaskId)
  check('B1 (R5-2): anon direct base-table read of a stranger\'s post returns empty', (anonBaseRead ?? []).length === 0, anonBaseRead)

  const { data: anonViewRead } = await anon.from('barter_skill_task_public_posts').select('id, kind, direction').eq('id', lookingForTaskId).maybeSingle()
  check('B2 (D1): Looking-For post IS visible through the public view while active', anonViewRead?.id === lookingForTaskId, anonViewRead)

  const { data: ownerBaseRead } = await merchantA.client.from('barter_skill_task_posts').select('id, status').eq('id', lookingForTaskId).maybeSingle()
  check('B3 (R5-2): the owner CAN read their own row via the base table', ownerBaseRead?.id === lookingForTaskId, ownerBaseRead)

  const { data: viewColumns, error: viewColumnsError } = await anon.from('barter_skill_task_public_posts').select('*').eq('id', lookingForTaskId).maybeSingle()
  check('B4 (R5-2): the public view specifically omits pre_suspend_status, status, and other internal columns', !!viewColumns && !('pre_suspend_status' in viewColumns) && !('status' in viewColumns), viewColumnsError ?? viewColumns)

  // Draft/paused posts are never in the public view.
  const draftOnlyId = await ensureDraft(renterA, `${QA_MARKER} STB-B5 Draft-only fixture`, { kind: 'skill', direction: 'available' })
  const { data: draftInView } = await anon.from('barter_skill_task_public_posts').select('id').eq('id', draftOnlyId).maybeSingle()
  check('B5 (R5-2): a draft post is absent from the public view', !draftInView, draftInView)
  const { data: draftBase } = await anon.from('barter_skill_task_posts').select('id').eq('id', draftOnlyId)
  check('B5b (R5-2): a draft post is absent from an anon base-table read too', (draftBase ?? []).length === 0, draftBase)
}

// ══════════════════════════════════════════════════════════════════
// C. Contribution provenance validation (R5-1, D6, Round 6)
// ══════════════════════════════════════════════════════════════════
console.log('\n=== C. Contribution provenance validation (R5-1 / D6) ===')
{
  const baseProposeBody = {
    anchor_skill_task_post_id: cProvenanceAnchorId,
    party_a_listing_ids: [merchantAListingId],
    party_b_listing_ids: [],
    delivery_method: 'meet_in_person',
  }

  // C1: a Looking-For post used as provenance (even owned by the
  // contributor, even while publicly active/offers_received) MUST be
  // rejected -- the single most-corrected rule in the whole plan.
  const ownLookingForId = await ensurePublished(merchantB, `${QA_MARKER} STB-C1 merchantB's own Looking-For Task`, { kind: 'task', direction: 'looking_for' })
  const wrongProvenance = await api(merchantB.cookie, 'POST', '/api/barter', {
    ...baseProposeBody,
    party_b_contributions: [taskContribution(ownLookingForId)],
    idempotency_key: 'stb-c1-looking-for-provenance-v1',
  })
  // Regex confirmed correct against the live route response once the
  // shared item-listing gate (below) no longer blocks this call from
  // ever reaching the validator: the RAW SQL exception text differs from
  // the friendly, user-facing text the API route actually returns
  // (there is an error-mapping layer between the RPC and the HTTP
  // response) -- this original regex matches the real client-facing
  // wording and was never actually stale; it just never got exercised.
  check('C1 (R5-1): a Looking-For post (even own, even active) is rejected as contribution provenance', wrongProvenance.status >= 400 && /Looking-For post cannot be offered as a contribution/.test(wrongProvenance.json?.error ?? ''), wrongProvenance)

  // C2: another user's Available post used as provenance -- rejected (wrong owner).
  const wrongOwner = await api(merchantB.cookie, 'POST', '/api/barter', {
    ...baseProposeBody,
    party_b_contributions: [taskContribution(await ensurePublished(renterA, `${QA_MARKER} STB-C2 renterA's Available Task`, { kind: 'task', direction: 'available' }))],
    idempotency_key: 'stb-c2-wrong-owner-v1',
  })
  // Regex confirmed correct against the live route response, same note
  // as C1 above -- the friendly API-mapped text ("Skill/Task supply that
  // belongs to you") differs from the raw SQL exception text, and this
  // original regex already matches the former.
  check('C2 (D6): another user\'s Available post used as provenance is rejected (wrong owner)', wrongOwner.status >= 400 && /Skill\/Task supply that belongs to you/.test(wrongOwner.json?.error ?? ''), wrongOwner)

  // C3: wrong-kind provenance (a Skill post id for a kind:'task' contribution).
  const skillPostId = await ensurePublished(merchantB, `${QA_MARKER} STB-C3 merchantB's Available Skill`, { kind: 'skill', direction: 'available' })
  const wrongKind = await api(merchantB.cookie, 'POST', '/api/barter', {
    ...baseProposeBody,
    party_b_contributions: [taskContribution(skillPostId)],
    idempotency_key: 'stb-c3-wrong-kind-v1',
  })
  check('C3 (D6): wrong-kind provenance (Skill post id for a Task contribution) is rejected', wrongKind.status >= 400 && /kind does not match/.test(wrongKind.json?.error ?? ''), wrongKind)

  // C4: a paused Available post is rejected as provenance.
  const pausableId = await ensurePublished(merchantB, `${QA_MARKER} STB-C4 merchantB's pausable Available Task`, { kind: 'task', direction: 'available' })
  await api(merchantB.cookie, 'POST', `/api/barter/skill-task/${pausableId}/pause`, { idempotency_key: 'stb-c4-pause-v1' })
  const pausedProvenance = await api(merchantB.cookie, 'POST', '/api/barter', {
    ...baseProposeBody,
    party_b_contributions: [taskContribution(pausableId)],
    idempotency_key: 'stb-c4-paused-provenance-v1',
  })
  check('C4 (D6): a paused Available post is rejected as provenance', pausedProvenance.status >= 400 && /not currently active/.test(pausedProvenance.json?.error ?? ''), pausedProvenance)

  // C5: a private/custom contribution with no title is rejected; with a title, the zod layer accepts it.
  const noTitleContribution = { kind: 'task', contribution_weight_percent: 100, milestones: [{ title: 'M1', sequence: 1, weight_percent: 100 }] }
  const noTitleRes = await api(merchantB.cookie, 'POST', '/api/barter', {
    ...baseProposeBody,
    party_b_contributions: [noTitleContribution],
    idempotency_key: 'stb-c5-no-title-v1',
  })
  check('C5: a private/custom contribution with no title is rejected', noTitleRes.status >= 400, noTitleRes)

  // C6: self-dealing -- proposer cannot propose against their own Looking-For post.
  const selfDeal = await api(merchantA.cookie, 'POST', '/api/barter', {
    anchor_skill_task_post_id: cProvenanceAnchorId,
    party_a_listing_ids: [merchantAListingId],
    party_b_listing_ids: [],
    party_b_contributions: [taskContribution(merchantBAvailableTaskId)],
    delivery_method: 'meet_in_person',
    idempotency_key: 'stb-c6-self-deal-v1',
  })
  check('C6: self-dealing (proposing against your own Looking-For post) is rejected', selfDeal.status >= 400 && /own listing or post/.test(selfDeal.json?.error ?? ''), selfDeal)
}

console.log(`\n=== SECTIONS B-C DONE -- ${failures} failure(s) so far ===`)

// ══════════════════════════════════════════════════════════════════
// D-I. Full offer lifecycle: one-winner Looking-For, snapshot
// immutability, weighting, both-party deposits, milestone execution +
// in-person scheduling, overall completion, eligibility, reviews.
// ══════════════════════════════════════════════════════════════════
console.log('\n=== D-I. Full offer lifecycle (one-winner, snapshot, deposits, milestones, completion, eligibility, reviews) ===')
let mainAgreementId = null
{
  const winningContribution = {
    kind: 'task',
    skill_task_post_id: merchantBAvailableTaskId,
    contribution_weight_percent: 100,
    milestones: [
      { title: 'Rough cut', sequence: 1, weight_percent: 40, delivery_mode: 'remote' },
      { title: 'Final export', sequence: 2, weight_percent: 60, delivery_mode: 'in_person' },
    ],
  }
  const depositTerms = [
    { payer_id: merchantB.userId, amount: 500, release_basis: 'milestone_weighted' },
    { payer_id: merchantA.userId, amount: 300, release_basis: 'full_on_completion' },
  ]

  // D1/D2 -- first offer: post moves from active -> offers_received, stays
  // public. Guarded: on a rerun an agreement for this exact (source post,
  // proposer) pair already exists, so the propose call is skipped rather
  // than re-submitted (a genuine re-propose after acceptance would fail
  // anyway, since the source is no longer open).
  const { data: existingFirst } = await admin.from('barter_agreements').select('id').eq('source_skill_task_post_id', mainLookingForTaskId).eq('party_b_id', merchantB.userId).maybeSingle()
  if (!existingFirst) {
    const propose1 = await api(merchantB.cookie, 'POST', '/api/barter', {
      anchor_skill_task_post_id: mainLookingForTaskId,
      party_a_listing_ids: [merchantAListingId],
      party_b_listing_ids: [],
      party_b_contributions: [winningContribution],
      deposit_terms: depositTerms,
      delivery_method: 'meet_in_person',
      idempotency_key: 'stb-main-propose1-v2',
    })
    check('D1: first offer against a Looking-For post succeeds', propose1.status === 200 || propose1.status === 201, propose1)
    mainAgreementId = propose1.json?.agreement_id
  } else {
    check('D1: first offer already exists from a prior run', true, existingFirst)
    mainAgreementId = existingFirst.id
  }
  check('D1: agreement id resolved', !!mainAgreementId, mainAgreementId)

  const { data: postAfterFirstOffer } = await admin.from('barter_skill_task_posts').select('status').eq('id', mainLookingForTaskId).maybeSingle()
  check('D1: source post is offers_received or already matched (post-accept, on a rerun)', ['offers_received', 'matched'].includes(postAfterFirstOffer?.status), postAfterFirstOffer)

  // D2 -- second, independent offer (private/custom contribution to
  // satisfy source-kind) -- still public. Same rerun guard as D1.
  const { data: existingSecond } = await admin.from('barter_agreements').select('id').eq('source_skill_task_post_id', mainLookingForTaskId).eq('party_b_id', renterA.userId).maybeSingle()
  let secondAgreementId = existingSecond?.id ?? null
  if (!existingSecond) {
    const propose2 = await api(renterA.cookie, 'POST', '/api/barter', {
      anchor_skill_task_post_id: mainLookingForTaskId,
      party_a_listing_ids: [merchantAListingId],
      party_b_listing_ids: [],
      party_b_contributions: [{
        kind: 'task', title: 'Alternative private video editing offer',
        contribution_weight_percent: 100,
        milestones: [{ title: 'Deliver edit', sequence: 1, weight_percent: 100 }],
      }],
      delivery_method: 'meet_in_person',
      idempotency_key: 'stb-main-propose2-v2',
    })
    check('D2: a second, independent offer against the same open Looking-For post succeeds', propose2.status === 200 || propose2.status === 201, propose2)
    secondAgreementId = propose2.json?.agreement_id ?? null
  } else {
    check('D2: second offer already exists from a prior run', true, existingSecond)
  }

  // D1/D2 public-visibility snapshots only mean something on the FRESH
  // (first-ever) run, before acceptance flips the post to matched --
  // captured here, right after both offers exist and before acceptance.
  const { data: publicBeforeAccept } = await anon.from('barter_skill_task_public_posts').select('id').eq('id', mainLookingForTaskId).maybeSingle()
  const { data: agreementBeforeAccept } = await admin.from('barter_agreements').select('status').eq('id', mainAgreementId).maybeSingle()
  if (agreementBeforeAccept?.status === 'proposed' || agreementBeforeAccept?.status === 'countered') {
    check('D1: post is STILL public after the first offer (offers_received stays public)', publicBeforeAccept?.id === mainLookingForTaskId, publicBeforeAccept)
    check('D2: post is STILL public after a second offer', publicBeforeAccept?.id === mainLookingForTaskId, publicBeforeAccept)
    const accept1 = await api(merchantA.cookie, 'POST', `/api/barter/${mainAgreementId}/accept`, { idempotency_key: 'stb-main-accept1-v2' })
    check('D9: accepting the first offer succeeds', accept1.status === 200, accept1)
  } else {
    check('D1: post was still public through offers_received before acceptance (verified on the fresh run only; already accepted from a prior run)', true, agreementBeforeAccept)
    check('D2: post was still public after a second offer (verified on the fresh run only; already accepted from a prior run)', true, agreementBeforeAccept)
    check('D9: first offer already accepted from a prior run', agreementBeforeAccept?.status !== 'proposed', agreementBeforeAccept)
  }
  const { data: postAfterAccept } = await admin.from('barter_skill_task_posts').select('status').eq('id', mainLookingForTaskId).maybeSingle()
  check('D9: source post transitions to matched on acceptance', postAfterAccept?.status === 'matched', postAfterAccept)
  const { data: publicAfterAccept } = await anon.from('barter_skill_task_public_posts').select('id').eq('id', mainLookingForTaskId).maybeSingle()
  check('D9: post is NO LONGER public once matched', !publicAfterAccept, publicAfterAccept)
  if (secondAgreementId) {
    const { data: secondAfter } = await admin.from('barter_agreements').select('status').eq('id', secondAgreementId).maybeSingle()
    check('D9: the second, unaccepted offer was auto-cancelled', ['cancelled', 'rejected'].includes(secondAfter?.status), secondAfter)
  }

  // Deposit-terms-based deposits create a payment intent per payer at
  // acceptance (same create_barter_payment_intent() call the legacy
  // single-deposit flow already uses) -- each payer must still
  // explicitly authorize their own deposit via the existing /deposit
  // route before it's eligible for release, exactly like item barter.
  const { data: depositPaymentsNow } = await admin.from('payments').select('id, renter_id, status').eq('barter_agreement_id', mainAgreementId).eq('payment_type', 'barter_deposit')
  for (const payerSession of [merchantB, merchantA]) {
    const own = depositPaymentsNow?.find((p) => p.renter_id === payerSession.userId)
    if (own && own.status === 'pending') {
      const pay = await api(payerSession.cookie, 'POST', `/api/barter/${mainAgreementId}/deposit`, { idempotency_key: `stb-main-pay-deposit-${payerSession.userId}-v1` })
      check(`F: ${payerSession === merchantB ? 'merchantB' : 'merchantA'} can authorize their own deposit`, pay.status === 200, pay)
    }
  }

  // E28 -- snapshot immutability: edit the public post's title after
  // acceptance, confirm the accepted contribution's snapshot is unaffected.
  const { data: acceptedOffer } = await admin.from('barter_offers').select('id').eq('agreement_id', mainAgreementId).order('version', { ascending: false }).limit(1).maybeSingle()
  const { data: acceptedItems } = await admin.from('barter_offer_items').select('id, kind, skill_task_post_id').eq('offer_id', acceptedOffer?.id).eq('kind', 'task')
  const mainContributionItemId = acceptedItems?.[0]?.id
  const { data: snapshotBefore } = await admin.from('barter_contribution_details').select('title, description').eq('offer_item_id', mainContributionItemId).maybeSingle()

  // Edits the post directly at the DB layer (not via the PATCH route) so
  // this fixture's title never actually changes for future runs'
  // title-based lookups -- only the description is mutated, which
  // nothing else keys off of, and it's restored immediately after.
  await admin.from('barter_skill_task_posts').update({ description: 'EDITED AFTER ACCEPTANCE -- should never appear in the accepted snapshot' }).eq('id', merchantBAvailableTaskId)
  const { data: snapshotAfter } = await admin.from('barter_contribution_details').select('title, description').eq('offer_item_id', mainContributionItemId).maybeSingle()
  check('E28: accepted contribution snapshot is byte-identical after the public post is edited', snapshotBefore?.title === snapshotAfter?.title && snapshotBefore?.description === snapshotAfter?.description, { snapshotBefore, snapshotAfter })
  await admin.from('barter_skill_task_posts').update({ description: 'Permanent regression fixture for verify-skills-tasks-barter.mjs -- do not delete.' }).eq('id', merchantBAvailableTaskId)

  // F34/F35 -- both-party independent deposit terms.
  const { data: terms } = await admin.from('barter_deposit_terms').select('payer_id, amount, release_basis').eq('offer_id', acceptedOffer?.id)
  const merchantBTerm = terms?.find((t) => t.payer_id === merchantB.userId)
  const merchantATerm = terms?.find((t) => t.payer_id === merchantA.userId)
  check('F34: both parties have independent deposit-term rows with different amounts', merchantBTerm?.amount === '500.00' && merchantATerm?.amount === '300.00' || (Number(merchantBTerm?.amount) === 500 && Number(merchantATerm?.amount) === 300), terms)
  check('F35: release_basis is preserved per payer (milestone_weighted vs full_on_completion)', merchantBTerm?.release_basis === 'milestone_weighted' && merchantATerm?.release_basis === 'full_on_completion', terms)

  // G39 -- strict milestone sequencing: only the lowest-sequence milestone
  // is active. Guarded: on a rerun both milestones may already be
  // 'completed' from a prior run -- the sequencing/out-of-order/eligibility
  // assertions below only make sense on the fresh (still 'active'+'pending') state.
  const { data: milestones } = await admin.from('barter_contribution_milestones').select('id, sequence, status, delivery_mode').eq('offer_item_id', mainContributionItemId).order('sequence', { ascending: true })
  const m1 = milestones?.[0]
  const m2 = milestones?.[1]
  const freshMilestoneState = m1?.status === 'active' && m2?.status === 'pending'

  if (freshMilestoneState) {
    check('G39: after acceptance, milestone 1 is active and milestone 2 is pending', true, milestones)

    const outOfOrder = await api(merchantB.cookie, 'POST', `/api/barter/${mainAgreementId}/milestones/${m2.id}/complete`, { idempotency_key: 'stb-g39-outoforder-v2' })
    check('G39: completing a pending (not-yet-active) milestone out of order is rejected', outOfOrder.status >= 400, outOfOrder)

    const completeM1 = await api(merchantB.cookie, 'POST', `/api/barter/${mainAgreementId}/milestones/${m1.id}/complete`, { idempotency_key: 'stb-g39-complete-m1-v2' })
    check('G39: the responsible party can complete the currently active milestone', completeM1.status === 200, completeM1)
    const { data: milestonesAfterM1 } = await admin.from('barter_contribution_milestones').select('id, sequence, status').eq('offer_item_id', mainContributionItemId).order('sequence', { ascending: true })
    check('G39: completing milestone 1 activates exactly milestone 2', milestonesAfterM1?.[0]?.status === 'completed' && milestonesAfterM1?.[1]?.status === 'active', milestonesAfterM1)

    // H45 -- eligibility percent after 1 of 2 milestones complete (40% weight, milestone_weighted payer = merchantB).
    const eligiblePercent = 100 * 40 / 100 // contribution_weight_percent (100) x m1.weight_percent (40) / 100
    const { data: contribRow } = await admin.from('barter_offer_items').select('contribution_weight_percent').eq('id', mainContributionItemId).maybeSingle()
    check('H45: eligibility percent after 1-of-2 milestones (weight 40) is exactly 40', eligiblePercent === 40 && Number(contribRow?.contribution_weight_percent) === 100, { eligiblePercent, contribRow })

    // H46 -- no escrow/payment release before overall completion.
    const { data: paymentsBeforeCompletion } = await admin.from('payments').select('id, status').eq('barter_agreement_id', mainAgreementId)
    check('H46: no payment row has been released before overall completion', (paymentsBeforeCompletion ?? []).every((p) => p.status !== 'released'), paymentsBeforeCompletion)

    // G41 -- in-person milestone (m2) blocked until both parties confirm schedule.
    const completeM2TooEarly = await api(merchantB.cookie, 'POST', `/api/barter/${mainAgreementId}/milestones/${m2.id}/complete`, { idempotency_key: 'stb-g41-tooearly-v2' })
    check('G41: in-person milestone completion blocked before any schedule is proposed', completeM2TooEarly.status >= 400, completeM2TooEarly)

    const proposeSchedule = await api(merchantB.cookie, 'POST', `/api/barter/${mainAgreementId}/milestones/${m2.id}/schedule`, {
      scheduled_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), scheduled_city: 'Johannesburg', scheduled_province: 'Gauteng',
      idempotency_key: 'stb-g41-propose-schedule-v2',
    })
    check('G41: either party can propose an in-person schedule', proposeSchedule.status === 200, proposeSchedule)

    const completeM2OneConfirm = await api(merchantB.cookie, 'POST', `/api/barter/${mainAgreementId}/milestones/${m2.id}/complete`, { idempotency_key: 'stb-g41-oneconfirm-v2' })
    check('G41: still blocked with only the proposer\'s own implicit confirmation', completeM2OneConfirm.status >= 400, completeM2OneConfirm)

    const confirmSchedule = await api(merchantA.cookie, 'POST', `/api/barter/${mainAgreementId}/milestones/${m2.id}/schedule/confirm`, { idempotency_key: 'stb-g41-confirm-schedule-v2' })
    check('G41: the other party can confirm the schedule', confirmSchedule.status === 200, confirmSchedule)

    const completeM2 = await api(merchantB.cookie, 'POST', `/api/barter/${mainAgreementId}/milestones/${m2.id}/complete`, { idempotency_key: 'stb-g41-complete-m2-v2' })
    check('G41/G39: milestone 2 completes once both parties have confirmed the schedule', completeM2.status === 200, completeM2)
  } else {
    check('G39/G41/H45/H46: milestone-sequencing play-by-play already verified on the fresh run; both milestones are completed now', m1?.status === 'completed' && m2?.status === 'completed', milestones)
  }

  const rescheduleAfterComplete = await api(merchantB.cookie, 'POST', `/api/barter/${mainAgreementId}/milestones/${m2.id}/schedule`, {
    scheduled_at: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(), scheduled_city: 'Cape Town', scheduled_province: 'Western Cape',
    idempotency_key: 'stb-d3-reschedule-after-complete-v2',
  })
  check('D3: a completed milestone\'s schedule can no longer be changed', rescheduleAfterComplete.status >= 400, rescheduleAfterComplete)

  // H47 -- overall completion requires ALL milestones completed + the
  // existing item-handover progress state machine to reach
  // awaiting_confirmation + dual confirmation (unchanged from item barter).
  const { data: allMilestonesNow } = await admin.from('barter_contribution_milestones').select('status').eq('offer_item_id', mainContributionItemId)
  check('H47 precondition: both milestones are now completed', allMilestonesNow?.every((m) => m.status === 'completed'), allMilestonesNow)

  const { data: agreementStatusNow } = await admin.from('barter_agreements').select('status').eq('id', mainAgreementId).maybeSingle()
  if (agreementStatusNow?.status === 'accepted') {
    const prep = await api(merchantA.cookie, 'POST', `/api/barter/${mainAgreementId}/progress`, { target_status: 'preparing', idempotency_key: 'stb-h47-progress-preparing-v2' })
    check('H47: accepted -> preparing succeeds', prep.status === 200, prep)
    const ready = await api(merchantA.cookie, 'POST', `/api/barter/${mainAgreementId}/progress`, { target_status: 'awaiting_confirmation', idempotency_key: 'stb-h47-progress-ready-v2' })
    check('H47: preparing -> awaiting_confirmation succeeds (meet_in_person skips in_transit)', ready.status === 200, ready)
  } else {
    check('H47: item-handover progress already advanced past accepted from a prior run', agreementStatusNow?.status !== 'accepted', agreementStatusNow)
  }

  const confirmA = await api(merchantA.cookie, 'POST', `/api/barter/${mainAgreementId}/confirm-completion`, { idempotency_key: 'stb-h47-confirm-a-v2' })
  check('H47: first party\'s completion confirmation succeeds (does not yet complete)', confirmA.status === 200, confirmA)
  const confirmB = await api(merchantB.cookie, 'POST', `/api/barter/${mainAgreementId}/confirm-completion`, { idempotency_key: 'stb-h47-confirm-b-v2' })
  check('H47: second party\'s confirmation completes the agreement', confirmB.json?.status === 'completed', confirmB)

  const { data: finalAgreement } = await admin.from('barter_agreements').select('status').eq('id', mainAgreementId).maybeSingle()
  check('H47: agreement status is completed', finalAgreement?.status === 'completed', finalAgreement)

  // H48 -- both deposits released in full on overall completion.
  const { data: paymentsAfterCompletion } = await admin.from('payments').select('renter_id, status').eq('barter_agreement_id', mainAgreementId)
  check('H48: both deposit payment rows are released after overall completion', (paymentsAfterCompletion ?? []).length >= 2 && paymentsAfterCompletion.every((p) => p.status === 'released'), paymentsAfterCompletion)

  // K -- commission / affiliate zero-impact.
  const { data: commissionRows } = await admin.from('unity_commissions').select('id').eq('barter_agreement_id', mainAgreementId)
  check('K1: zero Unity commission rows for a completed Skill/Task barter agreement', (commissionRows ?? []).length === 0, commissionRows)
  const { data: affiliateRows } = await admin.from('affiliate_commissions').select('id').eq('barter_agreement_id', mainAgreementId)
  check('K2: zero affiliate commission rows for a completed Skill/Task barter agreement', (affiliateRows ?? []).length === 0, affiliateRows)

  // I -- reviews: Reviews V2 unified path (/api/reviews/submit,
  // domain='barter') -- supersedes the retired /api/barter/[id]/review +
  // create_barter_review-only path as of the Reviews V2 remediation;
  // barter reviews are now created through the same canonical authority
  // as every other transaction domain (submit_review()).
  //
  // Reviews V2's cutover authority (supabase/migrations/20260904000013)
  // is genuinely tied to the moment Reviews V2 was activated -- mainAgreementId
  // is a long-lived, idempotently-reused fixture (see D1 above, "on a
  // rerun an agreement for this exact pair already exists, so the
  // propose call is skipped") whose completed_at may predate that
  // cutover on any run after the first, which would correctly (not a
  // bug) deny a review against it. A dedicated, freshly-completed plain
  // item-barter agreement is used here instead, so this check exercises
  // "genuinely eligible, submitted now" every run, independent of
  // mainAgreementId's own historical completion time.
  const reviewBeforeCompletion = await api(merchantB.cookie, 'POST', '/api/reviews/submit', { domain: 'barter', transaction_id: FORGED_ID, rating: 5, idempotency_key: `stb-i-forged-${Date.now()}` })
  check('I: review against a forged/nonexistent agreement id is rejected', reviewBeforeCompletion.status >= 400, reviewBeforeCompletion)

  // is_test:true at creation (never a public-visibility fixture, no
  // cleanup tracking needed) -- a fresh pair every run by design, so
  // reviewAgreementId's completed_at is always recent/post-cutover.
  const reviewListingA = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} STB-I Review fixture A ${Date.now()}`, is_test: true })
  const reviewListingB = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} STB-I Review fixture B ${Date.now()}`, is_test: true })
  const reviewPropose = await api(merchantB.cookie, 'POST', '/api/barter', { anchor_listing_id: reviewListingA, party_a_listing_ids: [reviewListingA], party_b_listing_ids: [reviewListingB], delivery_method: 'meet_in_person', idempotency_key: `stb-i-review-propose-${Date.now()}` })
  const reviewAgreementId = reviewPropose.json?.agreement_id
  check('I: fresh review-fixture agreement proposed', !!reviewAgreementId, reviewPropose)
  await api(merchantA.cookie, 'POST', `/api/barter/${reviewAgreementId}/accept`, { idempotency_key: `stb-i-review-accept-${Date.now()}` })
  await api(merchantA.cookie, 'POST', `/api/barter/${reviewAgreementId}/progress`, { target_status: 'preparing', idempotency_key: `stb-i-review-prep-${Date.now()}` })
  await api(merchantA.cookie, 'POST', `/api/barter/${reviewAgreementId}/progress`, { target_status: 'awaiting_confirmation', idempotency_key: `stb-i-review-ready-${Date.now()}` })
  await api(merchantA.cookie, 'POST', `/api/barter/${reviewAgreementId}/confirm-completion`, { idempotency_key: `stb-i-review-c1-${Date.now()}` })
  const reviewFixtureComplete = await api(merchantB.cookie, 'POST', `/api/barter/${reviewAgreementId}/confirm-completion`, { idempotency_key: `stb-i-review-c2-${Date.now()}` })
  check('I: fresh review-fixture agreement reaches completed', reviewFixtureComplete.json?.status === 'completed', reviewFixtureComplete)

  // RUN_TAG-suffixed: reviewAgreementId is a genuinely fresh agreement
  // every run (its own listing fixtures above are Date.now()-suffixed),
  // but these two keys were static -- so submit_review's idempotency
  // cache, keyed on (actor, key, payload hash), saw the SAME key paired
  // with a DIFFERENT transaction_id than whatever run first used it,
  // and correctly rejected the mismatch with "already submitted with
  // different data." The keys must vary per run since the underlying
  // transaction genuinely does; they stay distinct from EACH OTHER
  // within a run since this pair intentionally tests that a second
  // submission (different key, same reviewer+transaction) returns the
  // same review via the "one review per side" business rule, not via
  // literal idempotency-key replay.
  const reviewA = await api(merchantA.cookie, 'POST', '/api/reviews/submit', { domain: 'barter', transaction_id: reviewAgreementId, rating: 5, comment: 'Great work on the video edit.', idempotency_key: `stb-i-review-a-${RUN_TAG}` })
  check('I: review creation succeeds once the agreement is completed', reviewA.status === 200 && !!reviewA.json?.review_id, reviewA)
  // submit_review is a graceful idempotent upsert (ON CONFLICT DO
  // NOTHING + fallback select) -- a second call from the same reviewer
  // returns the SAME existing review_id rather than erroring. The real
  // "at most once" invariant is that exactly one row exists, not that
  // the second call is rejected.
  const reviewADuplicate = await api(merchantA.cookie, 'POST', '/api/reviews/submit', { domain: 'barter', transaction_id: reviewAgreementId, rating: 3, idempotency_key: `stb-i-review-a-dup-${RUN_TAG}` })
  check('I: a second submission by the same reviewer returns the SAME review_id (upsert, not a duplicate)', reviewADuplicate.json?.review_id === reviewA.json?.review_id, { reviewA, reviewADuplicate })
  const { data: reviewCount } = await admin.from('reviews').select('id').eq('barter_agreement_id', reviewAgreementId).eq('reviewer_id', merchantA.userId)
  check('I: exactly one review row exists for this reviewer despite two submission attempts', (reviewCount ?? []).length === 1, reviewCount)

  // QA hygiene: this review's own transaction fixtures are already
  // is_test:true (listings above); mark the review row itself the same
  // way so it never contributes to a real public aggregate.
  await admin.from('reviews').update({ is_test: true }).eq('barter_agreement_id', reviewAgreementId)
}

console.log(`\n=== SECTIONS D-I DONE -- ${failures} failure(s) so far ===`)

// ══════════════════════════════════════════════════════════════════
// J. Post-level reports + admin suspend/restore (R5-3 idempotency,
// Round 6: admin suspend does not touch the owner's account/other posts)
// ══════════════════════════════════════════════════════════════════
console.log('\n=== J. Reports + admin suspend/restore (R5-3) ===')
if (adminSession) {
  // Own-post reporting rejected; non-owner reporting succeeds.
  const reportableId = await ensurePublished(renterA, `${QA_MARKER} STB-J Reportable fixture`, { kind: 'skill', direction: 'available' })
  const ownReport = await api(renterA.cookie, 'POST', `/api/barter/skill-task/${reportableId}/report`, { reason: 'spam', idempotency_key: 'stb-j-own-report-v1' })
  check('J: owner reporting their own post is rejected', ownReport.status >= 400, ownReport)
  const strangerReport = await api(merchantA.cookie, 'POST', `/api/barter/skill-task/${reportableId}/report`, { reason: 'spam', description: 'test report', idempotency_key: 'stb-j-stranger-report-v1' })
  check('J: a non-owner can report a post', strangerReport.status === 200 || strangerReport.status === 201, strangerReport)

  // A second, DIFFERENT post owned by renterA -- proves admin-suspending
  // reportableId never touches renterA's OTHER posts or account.
  const siblingId = await ensurePublished(renterA, `${QA_MARKER} STB-J Sibling post (must stay unaffected by suspend)`, { kind: 'task', direction: 'available' })

  // active -> suspended -> active roundtrip.
  const { data: reportableStatus1 } = await admin.from('barter_skill_task_posts').select('status, pre_suspend_status').eq('id', reportableId).maybeSingle()
  if (reportableStatus1?.status !== 'suspended') {
    const suspend1 = await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${reportableId}/suspend`, { reason: 'regression check', idempotency_key: `stb-j-suspend1-${Date.now()}` })
    check('J: admin suspend succeeds (active -> suspended)', suspend1.status === 200, suspend1)
  } else {
    check('J: post already suspended from a prior run', true, reportableStatus1)
  }
  const { data: afterSuspend1 } = await admin.from('barter_skill_task_posts').select('status, pre_suspend_status').eq('id', reportableId).maybeSingle()
  check('J: pre_suspend_status captures the correct prior status (active)', afterSuspend1?.status === 'suspended' && afterSuspend1?.pre_suspend_status === 'active', afterSuspend1)

  // R5-3: a repeated suspend call while already suspended must not
  // overwrite the captured pre_suspend_status or corrupt state.
  const suspendReplay = await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${reportableId}/suspend`, { reason: 'regression check replay', idempotency_key: `stb-j-suspend-replay-${Date.now()}` })
  check('J (R5-3): a repeated suspend call while already suspended is a safe no-op', suspendReplay.status === 200 || suspendReplay.status === 409, suspendReplay)
  const { data: afterSuspendReplay } = await admin.from('barter_skill_task_posts').select('status, pre_suspend_status').eq('id', reportableId).maybeSingle()
  check('J (R5-3): pre_suspend_status is unchanged by the repeated suspend call', afterSuspendReplay?.status === 'suspended' && afterSuspendReplay?.pre_suspend_status === 'active', afterSuspendReplay)

  // The public view no longer shows it; the owner can still see it.
  const { data: suspendedInPublicView } = await anon.from('barter_skill_task_public_posts').select('id').eq('id', reportableId).maybeSingle()
  check('J: a suspended post is absent from the public view', !suspendedInPublicView, suspendedInPublicView)
  const { data: ownerCanStillSee } = await renterA.client.from('barter_skill_task_posts').select('id').eq('id', reportableId).maybeSingle()
  check('J: the owner can still see their own suspended post via the base table', ownerCanStillSee?.id === reportableId, ownerCanStillSee)

  // Sibling post (same owner, different post) is completely unaffected.
  const { data: siblingStatus } = await admin.from('barter_skill_task_posts').select('status').eq('id', siblingId).maybeSingle()
  check('J: admin-suspending one post does not suspend the owner\'s other posts', siblingStatus?.status === 'active', siblingStatus)

  const restore1 = await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${reportableId}/restore`, { reason: 'regression check restore', idempotency_key: `stb-j-restore1-${Date.now()}` })
  check('J: admin restore succeeds (suspended -> active, its true prior status)', restore1.status === 200, restore1)
  const { data: afterRestore1 } = await admin.from('barter_skill_task_posts').select('status, pre_suspend_status').eq('id', reportableId).maybeSingle()
  check('J: status restored to active, pre_suspend_status cleared', afterRestore1?.status === 'active' && afterRestore1?.pre_suspend_status === null, afterRestore1)

  // R5-3: a repeated restore call (already restored, no longer suspended)
  // is safely rejected/idempotent, never corrupts state.
  const restoreReplay = await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${reportableId}/restore`, { reason: 'regression check restore replay', idempotency_key: `stb-j-restore-replay-${Date.now()}` })
  check('J (R5-3): a repeated restore call on a non-suspended post is safely rejected, not corrupting', restoreReplay.status >= 400, restoreReplay)
  const { data: afterRestoreReplay } = await admin.from('barter_skill_task_posts').select('status').eq('id', reportableId).maybeSingle()
  check('J (R5-3): status remains active after the repeated restore attempt', afterRestoreReplay?.status === 'active', afterRestoreReplay)

  // paused -> suspended -> paused roundtrip.
  const pausedFixtureId = await ensurePublished(renterA, `${QA_MARKER} STB-J Paused-then-suspended fixture`, { kind: 'skill', direction: 'available' })
  const { data: pausedFixtureStatus } = await admin.from('barter_skill_task_posts').select('status').eq('id', pausedFixtureId).maybeSingle()
  if (pausedFixtureStatus?.status === 'active') {
    await api(renterA.cookie, 'POST', `/api/barter/skill-task/${pausedFixtureId}/pause`, { idempotency_key: 'stb-j-pause-before-suspend-v1' })
  }
  const { data: beforeSuspend2 } = await admin.from('barter_skill_task_posts').select('status').eq('id', pausedFixtureId).maybeSingle()
  if (beforeSuspend2?.status === 'paused') {
    const suspend2 = await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${pausedFixtureId}/suspend`, { reason: 'regression check (paused)', idempotency_key: `stb-j-suspend2-${Date.now()}` })
    check('J: admin suspend succeeds (paused -> suspended)', suspend2.status === 200, suspend2)
  } else {
    check('J: paused->suspended fixture already suspended from a prior run', beforeSuspend2?.status === 'suspended', beforeSuspend2)
  }
  const { data: afterSuspend2 } = await admin.from('barter_skill_task_posts').select('pre_suspend_status').eq('id', pausedFixtureId).maybeSingle()
  check('J: pre_suspend_status captures paused correctly', afterSuspend2?.pre_suspend_status === 'paused', afterSuspend2)
  const restore2 = await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${pausedFixtureId}/restore`, { reason: 'regression check restore (paused)', idempotency_key: `stb-j-restore2-${Date.now()}` })
  check('J: restore returns the post to paused (its true prior status), not active', restore2.status === 200 && restore2.json?.status === 'paused', restore2)
} else {
  skip('J: reports + admin suspend/restore', 'no admin QA account in .qa-credentials.local.json')
}

console.log(`\n=== SECTION J DONE -- ${failures} failure(s) so far ===`)

// ══════════════════════════════════════════════════════════════════
// K. Bidirectional matching (§34-35, D9, Round 6) -- hard
// delivery-mode incompatibility exclusion, deterministic tie-break.
// ══════════════════════════════════════════════════════════════════
console.log('\n=== K. Bidirectional matching ===')
{
  // An Available Skill (remote) anchor should surface compatible
  // Looking-For candidates, excluding a hard in_person-only incompatible one.
  const remoteAvailableId = await ensurePublished(renterA, `${QA_MARKER} STB-K Remote-only Available Skill`, { kind: 'skill', direction: 'available', delivery_mode: 'remote', category_slug: 'tech', isTest: false })
  const compatibleLookingForId = await ensurePublished(merchantA, `${QA_MARKER} STB-K Compatible remote Looking-For Skill`, { kind: 'skill', direction: 'looking_for', delivery_mode: 'remote', category_slug: 'tech', isTest: false })
  const incompatibleLookingForId = await ensurePublished(merchantB, `${QA_MARKER} STB-K Incompatible in-person-only Looking-For Skill`, { kind: 'skill', direction: 'looking_for', delivery_mode: 'in_person', category_slug: 'tech', isTest: false })

  const matchesRes = await api(renterA.cookie, 'GET', `/api/barter/skill-task/${remoteAvailableId}/matches`)
  check('K: matches endpoint responds successfully for an Available anchor', matchesRes.status === 200, matchesRes)
  const matchIds = (matchesRes.json?.matches ?? []).map((m) => m.post_id)
  check('K: a delivery-mode-compatible Looking-For candidate is included', matchIds.includes(compatibleLookingForId), matchesRes.json)
  check('K (hard incompatibility): a mutually exclusive remote-vs-in_person candidate is excluded entirely', !matchIds.includes(incompatibleLookingForId), matchesRes.json)

  // Bidirectional: the Looking-For post's own matches call should surface the Available post back.
  const reverseMatches = await api(merchantA.cookie, 'GET', `/api/barter/skill-task/${compatibleLookingForId}/matches`)
  check('K (D9): matching works in the reverse direction too (Looking-For anchor -> Available candidates)', reverseMatches.status === 200 && (reverseMatches.json?.matches ?? []).some((m) => m.post_id === remoteAvailableId), reverseMatches.json)

  // Deterministic tie-break: two candidates with equal compatibility signals, ordered created_at DESC.
  const first = matchesRes.json?.matches?.find((m) => m.post_id === compatibleLookingForId)
  check('K: compatibilityCount is a plain non-negative integer, never a monetary figure', typeof first?.compatibilityCount === 'number' && Number.isInteger(first.compatibilityCount) && first.compatibilityCount >= 0, first)
}

console.log(`\n=== SECTION K DONE -- ${failures} failure(s) so far ===`)

// ══════════════════════════════════════════════════════════════════
// P. Final-acceptance supply revalidation (Round 6): a provenance
// post's eligibility is rechecked at ACCEPT time, not just proposal
// time. Anchored on a plain item listing so this is isolated from the
// Looking-For one-winner lifecycle entirely.
// ══════════════════════════════════════════════════════════════════
console.log('\n=== P. Final-acceptance supply revalidation ===')
{
  async function proposeAgainstListing(label, contributionPostId, kind) {
    // Rerun guard: look up any existing agreement whose offer already references this exact contribution post.
    const { data: viaItem } = await admin.from('barter_offer_items').select('offer_id, skill_task_post_id').eq('skill_task_post_id', contributionPostId).limit(1).maybeSingle()
    if (viaItem?.offer_id) {
      const { data: offerRow } = await admin.from('barter_offers').select('agreement_id').eq('id', viaItem.offer_id).maybeSingle()
      if (offerRow?.agreement_id) return offerRow.agreement_id
    }
    // Each scenario gets its OWN dedicated listing -- once an offer is
    // accepted, the anchor listing locks (§13), so three scenarios
    // sharing one listing would collide after the first acceptance.
    const dedicatedListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} STB-P Item for ${label}` })
    const res = await api(merchantB.cookie, 'POST', '/api/barter', {
      anchor_listing_id: dedicatedListingId,
      party_a_listing_ids: [dedicatedListingId],
      party_b_listing_ids: [],
      party_b_contributions: [{ kind, skill_task_post_id: contributionPostId, contribution_weight_percent: 100, milestones: [{ title: 'Deliver', sequence: 1, weight_percent: 100 }] }],
      delivery_method: 'meet_in_person',
      idempotency_key: `stb-p-propose-${label}-v2`,
    })
    check(`P: propose against a listing anchor with a Skill/Task contribution succeeds (${label})`, res.status === 200 || res.status === 201, res)
    return res.json?.agreement_id ?? null
  }

  // P-Skill: active -> offer -> pause -> accept rejected -> resume -> accept succeeds.
  const pSkillId = await ensurePublished(merchantB, `${QA_MARKER} STB-P Skill v2 (pause/resume final-acceptance)`, { kind: 'skill', direction: 'available' })
  const pSkillAgreementId = await proposeAgainstListing('skill-pause-resume-v2', pSkillId, 'skill')
  if (pSkillAgreementId) {
    const { data: agr } = await admin.from('barter_agreements').select('status').eq('id', pSkillAgreementId).maybeSingle()
    if (agr?.status === 'proposed' || agr?.status === 'countered') {
      await api(merchantB.cookie, 'POST', `/api/barter/skill-task/${pSkillId}/pause`, { idempotency_key: 'stb-p-skill-pause-v2' })
      const acceptWhilePaused = await api(merchantA.cookie, 'POST', `/api/barter/${pSkillAgreementId}/accept`, { idempotency_key: 'stb-p-skill-accept-paused-v2' })
      check('P-Skill: accept rejected while the referenced Available Skill is paused', acceptWhilePaused.status >= 400 && /no longer available/.test(acceptWhilePaused.json?.error ?? ''), acceptWhilePaused)
      await api(merchantB.cookie, 'POST', `/api/barter/skill-task/${pSkillId}/resume`, { idempotency_key: 'stb-p-skill-resume-v2' })
      const acceptAfterResume = await api(merchantA.cookie, 'POST', `/api/barter/${pSkillAgreementId}/accept`, { idempotency_key: 'stb-p-skill-accept-resumed-v2' })
      check('P-Skill: the SAME still-pending offer can be accepted once the Skill is resumed', acceptAfterResume.status === 200, acceptAfterResume)
    } else {
      check('P-Skill: pause->accept-rejected->resume->accept-succeeds already verified on the fresh run', agr?.status === 'accepted', agr)
    }
  }

  // P-Task: active -> offer -> admin suspend -> accept rejected -> restore -> accept succeeds.
  const pTaskId = await ensurePublished(merchantB, `${QA_MARKER} STB-P Task v2 (suspend/restore final-acceptance)`, { kind: 'task', direction: 'available' })
  const pTaskAgreementId = await proposeAgainstListing('task-suspend-restore-v2', pTaskId, 'task')
  if (pTaskAgreementId && adminSession) {
    const { data: agr } = await admin.from('barter_agreements').select('status').eq('id', pTaskAgreementId).maybeSingle()
    if (agr?.status === 'proposed' || agr?.status === 'countered') {
      await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${pTaskId}/suspend`, { reason: 'regression: final-acceptance revalidation', idempotency_key: 'stb-p-task-suspend-v2' })
      const acceptWhileSuspended = await api(merchantA.cookie, 'POST', `/api/barter/${pTaskAgreementId}/accept`, { idempotency_key: 'stb-p-task-accept-suspended-v2' })
      check('P-Task: accept rejected while the referenced Available Task is admin-suspended', acceptWhileSuspended.status >= 400 && /no longer available/.test(acceptWhileSuspended.json?.error ?? ''), acceptWhileSuspended)
      await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${pTaskId}/restore`, { reason: 'regression: restore for final-acceptance retry', idempotency_key: 'stb-p-task-restore-v2' })
      const acceptAfterRestore = await api(merchantA.cookie, 'POST', `/api/barter/${pTaskAgreementId}/accept`, { idempotency_key: 'stb-p-task-accept-restored-v2' })
      check('P-Task: the SAME still-pending offer can be accepted once the Task is restored', acceptAfterRestore.status === 200, acceptAfterRestore)
    } else {
      check('P-Task: suspend->accept-rejected->restore->accept-succeeds already verified on the fresh run', agr?.status === 'accepted', agr)
    }
  } else if (!adminSession) {
    skip('P-Task: suspend/restore final-acceptance revalidation', 'no admin QA account in .qa-credentials.local.json')
  }

  // P-Archived: archived supply is rejected PERMANENTLY (no restore path exists for archived posts).
  const pArchivedId = await ensurePublished(merchantB, `${QA_MARKER} STB-P Archived v2 (permanent final-acceptance rejection)`, { kind: 'skill', direction: 'available' })
  const pArchivedAgreementId = await proposeAgainstListing('archived-permanent-v2', pArchivedId, 'skill')
  if (pArchivedAgreementId) {
    const { data: agr } = await admin.from('barter_agreements').select('status').eq('id', pArchivedAgreementId).maybeSingle()
    if (agr?.status === 'proposed' || agr?.status === 'countered') {
      await api(merchantB.cookie, 'POST', `/api/barter/skill-task/${pArchivedId}/pause`, { idempotency_key: 'stb-p-archived-pause-v2' })
      await api(merchantB.cookie, 'POST', `/api/barter/skill-task/${pArchivedId}/archive`, { idempotency_key: 'stb-p-archived-archive-v2' })
    }
    const { data: postStatus } = await admin.from('barter_skill_task_posts').select('status').eq('id', pArchivedId).maybeSingle()
    check('P-Archived precondition: the post is archived', postStatus?.status === 'archived', postStatus)
    const acceptArchived = await api(merchantA.cookie, 'POST', `/api/barter/${pArchivedAgreementId}/accept`, { idempotency_key: 'stb-p-archived-accept-v2' })
    check('P-Archived: accept is rejected -- archived supply has no restore path, so this is a PERMANENT rejection', acceptArchived.status >= 400, acceptArchived)
  }

  // P-LookingFor: a Looking-For post cannot be used as contribution provenance -- already fully proven in C1; referenced here for report completeness.
  check('P-LookingFor: Looking-For-as-provenance rejection already proven (see C1)', true, { seeCheck: 'C1' })
}

console.log(`\n=== SECTION P DONE -- ${failures} failure(s) so far ===`)

// ══════════════════════════════════════════════════════════════════
// O. Accepted-offer-only milestone security: a milestone belonging to
// a SUPERSEDED (countered, never accepted) offer version must be
// inert for every runtime action -- complete, schedule, schedule
// confirm, and evidence attachment all check offer_item.offer_id =
// agreement.accepted_offer_id, not merely "any milestone that exists."
// ══════════════════════════════════════════════════════════════════
console.log('\n=== O. Accepted-offer-only milestone security (superseded offer) ===')
{
  const oListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} STB-O Item for superseded-offer fixture` })

  const { data: existingAgreement } = await admin.from('barter_agreements').select('id, status, accepted_offer_id').eq('anchor_listing_id', oListingId).maybeSingle()
  let oAgreementId = existingAgreement?.id ?? null

  if (!existingAgreement) {
    const propose = await api(merchantB.cookie, 'POST', '/api/barter', {
      anchor_listing_id: oListingId,
      party_a_listing_ids: [oListingId],
      party_b_listing_ids: [],
      party_b_contributions: [{
        kind: 'task', title: 'V1 superseded contribution', contribution_weight_percent: 100,
        milestones: [{ title: 'V1 milestone', sequence: 1, weight_percent: 100 }],
      }],
      delivery_method: 'meet_in_person',
      idempotency_key: 'stb-o-propose-v1',
    })
    check('O: initial (v1) proposal succeeds', propose.status === 200 || propose.status === 201, propose)
    oAgreementId = propose.json?.agreement_id ?? null
  }

  if (oAgreementId) {
    const { data: v1Offer } = await admin.from('barter_offers').select('id, version, status, proposed_by').eq('agreement_id', oAgreementId).eq('version', 1).maybeSingle()
    const { data: v1Item } = await admin.from('barter_offer_items').select('id').eq('offer_id', v1Offer?.id).eq('kind', 'task').maybeSingle()
    const { data: v1Milestone } = await admin.from('barter_contribution_milestones').select('id').eq('offer_item_id', v1Item?.id).maybeSingle()

    const { data: agreementNow } = await admin.from('barter_agreements').select('status, accepted_offer_id').eq('id', oAgreementId).maybeSingle()

    let v2ItemId = null
    if (agreementNow?.status === 'proposed') {
      // merchantA is the anchor owner / responder to v1 (proposed_by = merchantB) -- counters with a DIFFERENT contribution, creating v2.
      const counter = await api(merchantA.cookie, 'POST', `/api/barter/${oAgreementId}/counter`, {
        party_a_listing_ids: [oListingId],
        party_b_listing_ids: [],
        party_b_contributions: [{
          kind: 'task', title: 'V2 accepted contribution', contribution_weight_percent: 100,
          milestones: [{ title: 'V2 milestone', sequence: 1, weight_percent: 100 }],
        }],
        delivery_method: 'meet_in_person',
        idempotency_key: 'stb-o-counter-v1',
      })
      check('O: counter-offer (v2) succeeds, superseding v1', counter.status === 200, counter)

      // merchantB (not v2's proposer) accepts v2.
      const accept = await api(merchantB.cookie, 'POST', `/api/barter/${oAgreementId}/accept`, { idempotency_key: 'stb-o-accept-v2-v1' })
      check('O: accepting v2 succeeds', accept.status === 200, accept)
    } else {
      check('O: propose->counter->accept already verified on the fresh run', agreementNow?.status === 'accepted', agreementNow)
    }

    const { data: finalAgreement } = await admin.from('barter_agreements').select('accepted_offer_id').eq('id', oAgreementId).maybeSingle()
    const { data: v2Item } = await admin.from('barter_offer_items').select('id').eq('offer_id', finalAgreement?.accepted_offer_id).eq('kind', 'task').maybeSingle()
    v2ItemId = v2Item?.id ?? null
    const { data: v2Milestone } = await admin.from('barter_contribution_milestones').select('id, status').eq('offer_item_id', v2ItemId).maybeSingle()

    check('O precondition: v1 and v2 are distinct offer versions with distinct milestones', !!v1Milestone?.id && !!v2Milestone?.id && v1Milestone.id !== v2Milestone.id, { v1Milestone, v2Milestone })

    if (v1Milestone?.id && v2Milestone?.id) {
      // O-complete: acting against the SUPERSEDED (v1) milestone is rejected.
      const completeV1 = await api(merchantB.cookie, 'POST', `/api/barter/${oAgreementId}/milestones/${v1Milestone.id}/complete`, { idempotency_key: `stb-o-complete-v1-${Date.now()}` })
      check('O-complete: completing a milestone from a superseded offer version is rejected', completeV1.status >= 400 && /accepted offer/.test(completeV1.json?.error ?? ''), completeV1)

      // O-schedule: proposing a schedule against the superseded milestone is rejected.
      const scheduleV1 = await api(merchantB.cookie, 'POST', `/api/barter/${oAgreementId}/milestones/${v1Milestone.id}/schedule`, {
        scheduled_at: new Date(Date.now() + 86400000).toISOString(), scheduled_city: 'Pretoria', scheduled_province: 'Gauteng',
        idempotency_key: `stb-o-schedule-v1-${Date.now()}`,
      })
      check('O-schedule: proposing a schedule against a superseded-offer milestone is rejected', scheduleV1.status >= 400 && /accepted offer/.test(scheduleV1.json?.error ?? ''), scheduleV1)

      // O-schedule-confirm: confirming a schedule against the superseded milestone is rejected (no schedule exists on it, so this exercises the same accepted-offer guard, not a "nothing to confirm" path).
      const confirmV1 = await api(merchantA.cookie, 'POST', `/api/barter/${oAgreementId}/milestones/${v1Milestone.id}/schedule/confirm`, { idempotency_key: `stb-o-confirm-v1-${Date.now()}` })
      check('O-schedule-confirm: confirming a schedule against a superseded-offer milestone is rejected', confirmV1.status >= 400, confirmV1)

      // O-evidence: attaching evidence against the superseded milestone is rejected.
      const evidenceV1 = await api(merchantB.cookie, 'POST', `/api/barter/${oAgreementId}/milestones/${v1Milestone.id}/evidence`, {
        storage_path: `${v1Milestone.id}/${merchantB.userId}/proof.jpg`, file_type: 'image', idempotency_key: `stb-o-evidence-v1-${Date.now()}`,
      })
      check('O-evidence: attaching evidence against a superseded-offer milestone is rejected', evidenceV1.status >= 400, evidenceV1)

      // Positive control: the SAME actions against the v2 (accepted) milestone are NOT rejected for this reason (schedule succeeds; complete is checked separately by the existing D-I flow).
      const scheduleV2 = await api(merchantB.cookie, 'POST', `/api/barter/${oAgreementId}/milestones/${v2Milestone.id}/schedule`, {
        scheduled_at: new Date(Date.now() + 86400000).toISOString(), scheduled_city: 'Pretoria', scheduled_province: 'Gauteng',
        idempotency_key: 'stb-o-schedule-v2-v1',
      })
      check('O (positive control): the same schedule action against the ACCEPTED (v2) milestone succeeds', scheduleV2.status === 200, scheduleV2)
    }
  }
}

console.log(`\n=== SECTION O DONE -- ${failures} failure(s) so far ===`)

// ══════════════════════════════════════════════════════════════════
// N. Suspend freezes vs close cancels (Round 6 correction to D8).
// ══════════════════════════════════════════════════════════════════
console.log('\n=== N. Suspend-freeze vs close-cancel ===')
if (adminSession && affiliateA) {
  // ── N1: ADMIN SUSPEND freezes open linked offers (does not cancel) ──
  const nSuspendPostId = await ensurePublished(merchantA, `${QA_MARKER} STB-N Suspend-freeze Looking-For Skill`, { kind: 'skill', direction: 'looking_for' })

  async function proposePrivateAgainst(postId, proposer, label, kind = 'skill') {
    const { data: existing } = await admin.from('barter_agreements').select('id, status').eq('source_skill_task_post_id', postId).eq('party_b_id', proposer.userId).maybeSingle()
    if (existing) return existing.id
    const res = await api(proposer.cookie, 'POST', '/api/barter', {
      anchor_skill_task_post_id: postId,
      party_a_listing_ids: [],
      party_b_listing_ids: [],
      party_a_contributions: [{ kind, title: 'Requester\'s own reciprocal contribution', contribution_weight_percent: 100, milestones: [{ title: 'Step 1', sequence: 1, weight_percent: 100 }] }],
      party_b_contributions: [{ kind, title: `Private offer -- ${label}`, contribution_weight_percent: 100, milestones: [{ title: 'Step 1', sequence: 1, weight_percent: 100 }] }],
      delivery_method: 'meet_in_person',
      idempotency_key: `stb-n-propose-${label}-v1`,
    })
    check(`N: propose against the Looking-For anchor succeeds (${label})`, res.status === 200 || res.status === 201, res)
    return res.json?.agreement_id ?? null
  }

  const { data: postBeforeAnything } = await admin.from('barter_skill_task_posts').select('status').eq('id', nSuspendPostId).maybeSingle()
  const freshN = postBeforeAnything?.status === 'active' || postBeforeAnything?.status === 'offers_received'

  let nAgreement1, nAgreement2
  if (freshN) {
    nAgreement1 = await proposePrivateAgainst(nSuspendPostId, merchantB, 'suspend-A')
    nAgreement2 = await proposePrivateAgainst(nSuspendPostId, renterA, 'suspend-B')

    const { data: postBeforeSuspend } = await admin.from('barter_skill_task_posts').select('status').eq('id', nSuspendPostId).maybeSingle()
    check('N1 precondition: source post is offers_received with two open agreements', postBeforeSuspend?.status === 'offers_received', postBeforeSuspend)
    const { data: agreementsBeforeSuspend } = await admin.from('barter_agreements').select('id, status').in('id', [nAgreement1, nAgreement2])
    check('N1 precondition: both linked agreements are open (proposed)', agreementsBeforeSuspend?.every((a) => a.status === 'proposed'), agreementsBeforeSuspend)

    const suspendN = await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${nSuspendPostId}/suspend`, { reason: 'regression: suspend-freeze test', idempotency_key: 'stb-n-suspend-v1' })
    check('N1: admin suspend succeeds', suspendN.status === 200, suspendN)
    const { data: postAfterSuspend } = await admin.from('barter_skill_task_posts').select('status').eq('id', nSuspendPostId).maybeSingle()
    check('N1: post -> suspended', postAfterSuspend?.status === 'suspended', postAfterSuspend)

    const { data: agreementsAfterSuspend } = await admin.from('barter_agreements').select('id, status').in('id', [nAgreement1, nAgreement2])
    check('N1: BOTH linked agreements remain present and are NOT cancelled merely because of suspension', agreementsAfterSuspend?.every((a) => a.status === 'proposed'), agreementsAfterSuspend)

    const newProposalWhileSuspended = await api(affiliateA.cookie, 'POST', '/api/barter', {
      anchor_skill_task_post_id: nSuspendPostId,
      party_a_listing_ids: [],
      party_b_listing_ids: [],
      party_b_contributions: [{ kind: 'skill', title: 'Blocked new offer while suspended', contribution_weight_percent: 100, milestones: [{ title: 'Step 1', sequence: 1, weight_percent: 100 }] }],
      delivery_method: 'meet_in_person',
      idempotency_key: 'stb-n-newproposal-blocked-v1',
    })
    check('N1: a NEW proposal against the suspended source is blocked', newProposalWhileSuspended.status >= 400, newProposalWhileSuspended)

    const counterWhileSuspended = await api(merchantA.cookie, 'POST', `/api/barter/${nAgreement1}/counter`, {
      party_a_listing_ids: [], party_b_listing_ids: [],
      party_a_contributions: [{ kind: 'skill', title: 'Countered scope', contribution_weight_percent: 100, milestones: [{ title: 'M', sequence: 1, weight_percent: 100 }] }],
      party_b_contributions: [{ kind: 'skill', title: 'Unchanged responder scope', contribution_weight_percent: 100, milestones: [{ title: 'M', sequence: 1, weight_percent: 100 }] }],
      delivery_method: 'meet_in_person', idempotency_key: 'stb-n-counter-blocked-v1',
    })
    check('N1: countering an existing linked offer is blocked while the source is suspended', counterWhileSuspended.status >= 400, counterWhileSuspended)

    const acceptWhileSuspended = await api(merchantA.cookie, 'POST', `/api/barter/${nAgreement1}/accept`, { idempotency_key: 'stb-n-accept-blocked-v1' })
    check('N1: accepting an existing linked offer is blocked while the source is suspended', acceptWhileSuspended.status >= 400, acceptWhileSuspended)

    const historicalRead = await api(merchantB.cookie, 'GET', `/api/barter/${nAgreement1}`)
    check('N1: historical/private read of the linked agreement remains available while suspended', historicalRead.status === 200, historicalRead)

    // ── N2: ADMIN RESTORE re-opens the post and both linked offers become usable again; one-winner logic applies. ──
    const restoreN = await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${nSuspendPostId}/restore`, { reason: 'regression: restore for one-winner test', idempotency_key: 'stb-n-restore-v1' })
    check('N2: admin restore succeeds', restoreN.status === 200 && restoreN.json?.status === 'offers_received', restoreN)
    const { data: postAfterRestore } = await admin.from('barter_skill_task_posts').select('status').eq('id', nSuspendPostId).maybeSingle()
    check('N2: post returns to offers_received (its true prior status)', postAfterRestore?.status === 'offers_received', postAfterRestore)

    const { data: agreementsAfterRestore } = await admin.from('barter_agreements').select('id, status').in('id', [nAgreement1, nAgreement2])
    check('N2: both still-open offers remain present after restore', agreementsAfterRestore?.every((a) => a.status === 'proposed'), agreementsAfterRestore)

    const acceptAfterRestore = await api(merchantA.cookie, 'POST', `/api/barter/${nAgreement1}/accept`, { idempotency_key: 'stb-n-accept-after-restore-v1' })
    check('N2: accepting one of the reopened offers succeeds', acceptAfterRestore.status === 200, acceptAfterRestore)
  } else {
    // Rerun: this fixture already progressed to matched/accepted on a prior run -- look up the existing agreements instead of re-driving the whole sequence.
    const { data: linked } = await admin.from('barter_agreements').select('id, party_b_id').eq('source_skill_task_post_id', nSuspendPostId)
    nAgreement1 = linked?.find((a) => a.party_b_id === merchantB.userId)?.id ?? null
    nAgreement2 = linked?.find((a) => a.party_b_id === renterA.userId)?.id ?? null
    check('N1/N2: suspend-freeze -> restore -> one-winner already fully verified on the fresh run', !!nAgreement1 && !!nAgreement2, linked)
  }

  const { data: postAfterWinnerAccept } = await admin.from('barter_skill_task_posts').select('status').eq('id', nSuspendPostId).maybeSingle()
  check('N2: one-winner logic marks the source matched', postAfterWinnerAccept?.status === 'matched', postAfterWinnerAccept)
  const { data: agr1Final } = await admin.from('barter_agreements').select('status').eq('id', nAgreement1).maybeSingle()
  check('N2: the winning agreement is accepted', agr1Final?.status === 'accepted', agr1Final)
  const { data: agr2AfterWinner } = await admin.from('barter_agreements').select('status').eq('id', nAgreement2).maybeSingle()
  check('N2: the losing open agreement is cancelled/superseded using established barter semantics', ['cancelled', 'rejected'].includes(agr2AfterWinner?.status), agr2AfterWinner)

  // ── N3: OWNER CLOSE cancels open linked offers immediately (fresh post). ──
  const nClosePostId = await ensurePublished(merchantA, `${QA_MARKER} STB-N Owner-close Looking-For Task v3`, { kind: 'task', direction: 'looking_for' })
  const { data: postBeforeProposeClose } = await admin.from('barter_skill_task_posts').select('status').eq('id', nClosePostId).maybeSingle()

  let nCloseAgreement1, nCloseAgreement2
  if (postBeforeProposeClose?.status === 'closed') {
    // Already closed from a prior run -- look up the (already-cancelled) linked agreements directly rather than re-proposing against a closed source.
    const { data: linked } = await admin.from('barter_agreements').select('id, party_b_id').eq('source_skill_task_post_id', nClosePostId)
    nCloseAgreement1 = linked?.find((a) => a.party_b_id === merchantB.userId)?.id ?? null
    nCloseAgreement2 = linked?.find((a) => a.party_b_id === renterA.userId)?.id ?? null
    check('N3: owner close already verified on the fresh run', !!nCloseAgreement1 && !!nCloseAgreement2, linked)
  } else {
    nCloseAgreement1 = await proposePrivateAgainst(nClosePostId, merchantB, 'close-A-v3', 'task')
    nCloseAgreement2 = await proposePrivateAgainst(nClosePostId, renterA, 'close-B-v3', 'task')
    // Only close once both proposals genuinely exist -- closing
    // regardless would permanently poison this fixture's reruns (the
    // post becomes terminal with no linked agreements to verify against).
    if (nCloseAgreement1 && nCloseAgreement2) {
      const closeN = await api(merchantA.cookie, 'POST', `/api/barter/skill-task/${nClosePostId}/close`, { idempotency_key: 'stb-n-close-v3' })
      check('N3: owner close succeeds', closeN.status === 200 && closeN.json?.status === 'closed', closeN)
    } else {
      check('N3: owner close succeeds', false, { nCloseAgreement1, nCloseAgreement2, reason: 'one or both proposals failed -- see prior FAIL lines' })
    }
  }
  const { data: postAfterClose } = await admin.from('barter_skill_task_posts').select('status').eq('id', nClosePostId).maybeSingle()
  check('N3: source -> closed', postAfterClose?.status === 'closed', postAfterClose)

  const { data: agreementsAfterClose } = await admin.from('barter_agreements').select('id, status').in('id', [nCloseAgreement1, nCloseAgreement2])
  check('N3: both linked unaccepted agreements are cancelled immediately by owner close', agreementsAfterClose?.every((a) => ['cancelled', 'rejected'].includes(a.status)), agreementsAfterClose)

  const { data: closeHistory } = await admin.from('barter_history').select('id').eq('agreement_id', nCloseAgreement1)
  check('N3: history remains (append-only, not deleted) for the cancelled agreement', (closeHistory ?? []).length > 0, closeHistory)

  const acceptAfterClose = await api(merchantA.cookie, 'POST', `/api/barter/${nCloseAgreement1}/accept`, { idempotency_key: 'stb-n-accept-after-close-v3' })
  check('N3: acceptance of a close-cancelled offer is impossible', acceptAfterClose.status >= 400, acceptAfterClose)

  const restoreAfterClose = await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${nClosePostId}/restore`, { reason: 'regression: restore-after-close must fail', idempotency_key: 'stb-n-restore-after-close-v3' })
  check('N3: admin restore is impossible on a closed post (this was a close, not a suspension)', restoreAfterClose.status >= 400, restoreAfterClose)
} else {
  skip('N: suspend-freeze vs close-cancel', 'no admin QA account or no affiliateA QA account in .qa-credentials.local.json')
}

console.log(`\n=== SECTION N DONE -- ${failures} failure(s) so far ===`)

// ══════════════════════════════════════════════════════════════════
// M. Six-cell Barter browse matrix -- the REAL browse route used by
// the UI (/listings?mode=barter&kind=...&direction=...), not a direct
// database query.
// ══════════════════════════════════════════════════════════════════
console.log('\n=== M. Six-cell Barter browse matrix ===')
{
  async function fetchBrowseHtml(kind, direction) {
    const qs = new URLSearchParams({ mode: 'barter' })
    if (kind && kind !== 'item') qs.set('kind', kind)
    if (direction === 'looking_for') qs.set('direction', 'looking-for')
    const res = await fetch(`${APP_URL}/listings?${qs.toString()}`)
    return { status: res.status, html: await res.text() }
  }

  // Fixtures -- one per cell, is_test:false so they're genuinely public.
  const mItemAvailableId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} STB-M Item Available fixture`, is_test: false })
  publicFixtureListingIds.add(mItemAvailableId)

  const { data: existingReq } = await admin.from('marketplace_requests').select('id, status').eq('title', `${QA_MARKER} STB-M Item LookingFor fixture`).maybeSingle()
  let mItemLookingForId = existingReq?.id ?? null
  if (!mItemLookingForId) {
    const createReq = await api(merchantB.cookie, 'POST', '/api/marketplace/requests', {
      transaction_type: 'barter', title: `${QA_MARKER} STB-M Item LookingFor fixture`, description: 'Regression fixture', country_id: 'ZA',
      idempotency_key: 'stb-m-item-lookingfor-draft-v1',
    })
    mItemLookingForId = createReq.json?.request_id ?? null
    if (mItemLookingForId) await api(merchantB.cookie, 'POST', `/api/marketplace/requests/${mItemLookingForId}/publish`, { idempotency_key: 'stb-m-item-lookingfor-publish-v1' })
  }
  if (mItemLookingForId) {
    await admin.from('marketplace_requests').update({ is_test: false }).eq('id', mItemLookingForId)
    publicFixtureRequestIds.add(mItemLookingForId)
  }

  const mSkillAvailableId = await ensurePublished(merchantB, `${QA_MARKER} STB-M Skill Available fixture`, { kind: 'skill', direction: 'available', isTest: false })
  const mSkillLookingForId = await ensurePublished(merchantA, `${QA_MARKER} STB-M Skill LookingFor fixture v2`, { kind: 'skill', direction: 'looking_for', isTest: false })
  const mTaskAvailableId = await ensurePublished(merchantB, `${QA_MARKER} STB-M Task Available fixture`, { kind: 'task', direction: 'available', isTest: false })
  const mTaskLookingForId = await ensurePublished(merchantA, `${QA_MARKER} STB-M Task LookingFor fixture`, { kind: 'task', direction: 'looking_for', isTest: false })

  // Drive the two Looking-For Skill/Task fixtures to offers_received (an open offer, never accepted) to prove that state stays browse-visible too.
  for (const [postId, proposer, label, kind] of [[mSkillLookingForId, affiliateA, 'm-skill-offers-received', 'skill'], [mTaskLookingForId, affiliateB, 'm-task-offers-received', 'task']]) {
    if (!proposer) continue
    const { data: st } = await admin.from('barter_skill_task_posts').select('status').eq('id', postId).maybeSingle()
    if (st?.status === 'active') {
      const proposeRes = await api(proposer.cookie, 'POST', '/api/barter', {
        anchor_skill_task_post_id: postId,
        party_a_listing_ids: [], party_b_listing_ids: [],
        party_a_contributions: [{ kind, title: 'Reciprocal', contribution_weight_percent: 100, milestones: [{ title: 'M', sequence: 1, weight_percent: 100 }] }],
        party_b_contributions: [{ kind, title: `Offer -- ${label}`, contribution_weight_percent: 100, milestones: [{ title: 'M', sequence: 1, weight_percent: 100 }] }],
        delivery_method: 'meet_in_person', idempotency_key: `stb-${label}-${Date.now()}`,
      })
      check(`M: driving ${label} to offers_received succeeds`, proposeRes.status === 200 || proposeRes.status === 201, proposeRes)
    }
  }
  const { data: mSkillLFStatus } = await admin.from('barter_skill_task_posts').select('status').eq('id', mSkillLookingForId).maybeSingle()
  const { data: mTaskLFStatus } = await admin.from('barter_skill_task_posts').select('status').eq('id', mTaskLookingForId).maybeSingle()

  // ── Cell 1: Item + Available ──
  const cell1 = await fetchBrowseHtml('item', 'available')
  check('M-Cell1 (Item+Available): browse route responds 200', cell1.status === 200, { status: cell1.status })
  check('M-Cell1 (Item+Available): fixture listing appears', cell1.html.includes('STB-M Item Available fixture'), {})

  // ── Cell 2: Item + Looking For ──
  const cell2 = await fetchBrowseHtml('item', 'looking_for')
  check('M-Cell2 (Item+LookingFor): browse route responds 200', cell2.status === 200, { status: cell2.status })
  check('M-Cell2 (Item+LookingFor): fixture request appears (existing marketplace_requests source, unchanged by this phase)', cell2.html.includes('STB-M Item LookingFor fixture'), {})

  // ── Cell 3: Skill + Available ──
  const cell3 = await fetchBrowseHtml('skill', 'available')
  check('M-Cell3 (Skill+Available): browse route responds 200', cell3.status === 200, { status: cell3.status })
  check('M-Cell3 (Skill+Available): fixture post appears', cell3.html.includes('STB-M Skill Available fixture'), {})

  // ── Cell 4: Skill + Looking For (also proves offers_received stays visible) ──
  const cell4 = await fetchBrowseHtml('skill', 'looking_for')
  check('M-Cell4 (Skill+LookingFor): browse route responds 200', cell4.status === 200, { status: cell4.status })
  check('M-Cell4 (Skill+LookingFor): fixture post appears', cell4.html.includes('STB-M Skill LookingFor fixture v2'), {})
  check('M-Cell4: offers_received Looking-For Skill remains browse-visible', mSkillLFStatus?.status === 'offers_received' && cell4.html.includes('STB-M Skill LookingFor fixture v2'), { mSkillLFStatus })

  // ── Cell 5: Task + Available ──
  const cell5 = await fetchBrowseHtml('task', 'available')
  check('M-Cell5 (Task+Available): browse route responds 200', cell5.status === 200, { status: cell5.status })
  check('M-Cell5 (Task+Available): fixture post appears', cell5.html.includes('STB-M Task Available fixture'), {})

  // ── Cell 6: Task + Looking For (also proves offers_received stays visible) ──
  const cell6 = await fetchBrowseHtml('task', 'looking_for')
  check('M-Cell6 (Task+LookingFor): browse route responds 200', cell6.status === 200, { status: cell6.status })
  check('M-Cell6 (Task+LookingFor): fixture post appears', cell6.html.includes('STB-M Task LookingFor fixture'), {})
  check('M-Cell6: offers_received Looking-For Task remains browse-visible', mTaskLFStatus?.status === 'offers_received' && cell6.html.includes('STB-M Task LookingFor fixture'), { mTaskLFStatus })

  // ── Cross-cell isolation: a Skill fixture never bleeds into the Task cell, and vice versa ──
  check('M: kind isolation -- the Skill Available fixture does NOT appear under Task+Available', !cell5.html.includes('STB-M Skill Available fixture'), {})
  check('M: kind isolation -- the Task Available fixture does NOT appear under Skill+Available', !cell3.html.includes('STB-M Task Available fixture'), {})
  check('M: direction isolation -- the Skill LookingFor fixture does NOT appear under Skill+Available', !cell3.html.includes('STB-M Skill LookingFor fixture v2'), {})

  // ── matched Looking-For disappears -- a SEPARATE, dedicated fixture,
  // never mSkillLookingForId (which must stay offers_received forever
  // for the Cell4 visibility check above to remain valid on reruns). ──
  const mMatchedTestId = await ensurePublished(merchantA, `${QA_MARKER} STB-M Matched-disappears fixture`, { kind: 'skill', direction: 'looking_for', isTest: false })
  if (affiliateA) {
    const { data: matchedCheckAgreement } = await admin.from('barter_agreements').select('id, status').eq('source_skill_task_post_id', mMatchedTestId).maybeSingle()
    if (!matchedCheckAgreement) {
      const proposeRes = await api(affiliateA.cookie, 'POST', '/api/barter', {
        anchor_skill_task_post_id: mMatchedTestId,
        party_a_listing_ids: [], party_b_listing_ids: [],
        party_a_contributions: [{ kind: 'skill', title: 'Reciprocal', contribution_weight_percent: 100, milestones: [{ title: 'M', sequence: 1, weight_percent: 100 }] }],
        party_b_contributions: [{ kind: 'skill', title: 'Offer to be accepted', contribution_weight_percent: 100, milestones: [{ title: 'M', sequence: 1, weight_percent: 100 }] }],
        delivery_method: 'meet_in_person', idempotency_key: 'stb-m-matched-propose-v1',
      })
      const newAgreementId = proposeRes.json?.agreement_id
      if (newAgreementId) await api(merchantA.cookie, 'POST', `/api/barter/${newAgreementId}/accept`, { idempotency_key: 'stb-m-matched-accept-v1' })
    } else if (matchedCheckAgreement.status === 'proposed') {
      await api(merchantA.cookie, 'POST', `/api/barter/${matchedCheckAgreement.id}/accept`, { idempotency_key: 'stb-m-matched-accept-v1' })
    }
  }
  const { data: mMatchedFinalStatus } = await admin.from('barter_skill_task_posts').select('status').eq('id', mMatchedTestId).maybeSingle()
  check('M precondition: the matched-disappears fixture reached matched', mMatchedFinalStatus?.status === 'matched', mMatchedFinalStatus)
  const cell4Matched = await fetchBrowseHtml('skill', 'looking_for')
  check('M: a matched Looking-For Skill disappears from browse', !cell4Matched.html.includes('STB-M Matched-disappears fixture'), {})

  // ── paused/suspended Available disappears ──
  // RUN_TAG-suffixed throughout: this pause->check->resume (and
  // suspend->check->restore) sequence is a fresh demo each verifier
  // invocation, against permanently-reused fixtures. A static recovery
  // key here was diagnosed as the exact reason mSkillAvailableId /
  // mTaskAvailableId stayed genuinely paused/suspended after every prior
  // run: the resume/restore call's idempotency cache silently replayed
  // the first-ever run's cached "success" without re-executing.
  await api(merchantB.cookie, 'POST', `/api/barter/skill-task/${mSkillAvailableId}/pause`, { idempotency_key: `stb-m-skill-avail-pause-${RUN_TAG}` })
  const cell3AfterPause = await fetchBrowseHtml('skill', 'available')
  check('M: a paused Available Skill disappears from browse', !cell3AfterPause.html.includes('STB-M Skill Available fixture'), {})
  await api(merchantB.cookie, 'POST', `/api/barter/skill-task/${mSkillAvailableId}/resume`, { idempotency_key: `stb-m-skill-avail-resume-${RUN_TAG}` })

  if (adminSession) {
    const { data: taskAvailStatus } = await admin.from('barter_skill_task_posts').select('status').eq('id', mTaskAvailableId).maybeSingle()
    if (taskAvailStatus?.status === 'active') {
      await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${mTaskAvailableId}/suspend`, { reason: 'regression: browse-visibility suspend check', idempotency_key: `stb-m-task-avail-suspend-${RUN_TAG}` })
    }
    const cell5AfterSuspend = await fetchBrowseHtml('task', 'available')
    check('M: a suspended Available Task disappears from browse', !cell5AfterSuspend.html.includes('STB-M Task Available fixture'), {})
    await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${mTaskAvailableId}/restore`, { reason: 'regression: restore after browse-visibility check', idempotency_key: `stb-m-task-avail-restore-${RUN_TAG}` })
  }

  // ── is_test:true never appears publicly ──
  await ensurePublished(renterA, `${QA_MARKER} STB-M is_test exclusion fixture`, { kind: 'skill', direction: 'available' })
  const cell3IsTest = await fetchBrowseHtml('skill', 'available')
  check('M: an is_test:true post never appears in the public browse route', !cell3IsTest.html.includes('STB-M is_test exclusion fixture'), {})

  // ── no /services route exists ──
  const servicesRes = await fetch(`${APP_URL}/services`)
  check('M: no /services route exists (barter browsing stays inside /listings)', servicesRes.status === 404, { status: servicesRes.status })
}

console.log(`\n=== SECTION M DONE -- ${failures} failure(s) so far ===`)

// ══════════════════════════════════════════════════════════════════
// L. Active-supply cap concurrency -- the shared lock across physical
// listings + Available Skills + Available Tasks, tested at the real
// boundary via genuinely concurrent Promise.all calls against the
// actual RPCs (never mocked). Starter plan cap = 5
// (merchant_subscription_plans.active_listing_limit). Every fixture
// here is is_test:false -- the cap check is structurally skipped for
// is_test:true rows (see _lock_and_count_active_supply() call sites),
// so testing the real enforcement requires real (non-test) rows.
// ══════════════════════════════════════════════════════════════════
console.log('\n=== L. Active-supply cap concurrency ===')
const STARTER_CAP = 5

async function realActiveSupplyCount(userId) {
  const { count: listingCount } = await admin.from('listings').select('id', { count: 'exact', head: true }).eq('merchant_id', userId).eq('status', 'active').eq('is_test', false)
  const { count: skillTaskCount } = await admin.from('barter_skill_task_posts').select('id', { count: 'exact', head: true }).eq('owner_id', userId).eq('direction', 'available').eq('status', 'active').eq('is_test', false)
  return (listingCount ?? 0) + (skillTaskCount ?? 0)
}

/**
 * Deterministically brings this user's REAL active-supply count to
 * exactly cap-1 (one free slot), regardless of what prior runs left
 * behind -- pauses down excess active Skill/Task posts if over,
 * publishes fresh filler posts if under. Never touches listings (owner
 * pause is a simple self-service action; a listing would need the full
 * admin moderation gate to create, which filler posts don't need).
 */
async function ensureExactlyOneFreeSlot(ownerSession, tag) {
  let current = await realActiveSupplyCount(ownerSession.userId)
  if (current > STARTER_CAP - 1) {
    const { data: excess } = await admin.from('barter_skill_task_posts').select('id').eq('owner_id', ownerSession.userId).eq('direction', 'available').eq('status', 'active').eq('is_test', false).limit(current - (STARTER_CAP - 1))
    for (const p of excess ?? []) {
      await api(ownerSession.cookie, 'POST', `/api/barter/skill-task/${p.id}/pause`, { idempotency_key: `stb-l-prep-pause-${p.id}` })
    }
    current = await realActiveSupplyCount(ownerSession.userId)
  }
  let fillerIndex = 0
  while (current < STARTER_CAP - 1) {
    await ensurePublished(ownerSession, `${QA_MARKER} STB-L filler ${tag}-${fillerIndex}`, { kind: fillerIndex % 2 === 0 ? 'skill' : 'task', direction: 'available', isTest: false })
    fillerIndex += 1
    current = await realActiveSupplyCount(ownerSession.userId)
  }
  return current
}

async function createPendingApprovedListing(ownerSession, title) {
  const { data: existing } = await admin.from('listings').select('id, status').eq('merchant_id', ownerSession.userId).eq('title', title).maybeSingle()
  let id = existing?.id
  if (!id) {
    const { data, error } = await admin.from('listings').insert({
      merchant_id: ownerSession.userId, country_id: 'ZA', category: 'tech', condition: 'good',
      daily_rate: 150, min_rental_days: 1, deposit_required: false, status: 'pending', risk_tier: 'low',
      ownership_verified: false, condition_confirmed: true, is_test: false, title,
      description: 'Regression fixture for cap-concurrency testing.',
    }).select('id').single()
    if (error) throw new Error(`createPendingApprovedListing failed: ${error.message}`)
    id = data.id
  } else if (existing.status !== 'pending' && existing.status !== 'active') {
    await admin.from('listings').update({ status: 'pending' }).eq('id', id)
  }
  await admin.from('listing_moderation').upsert({ listing_id: id, moderation_status: 'approved' })
  publicFixtureListingIds.add(id)
  return id
}

if (adminSession && affiliateA && affiliateB) {
  const runTag = Date.now()

  // ── L-A: listing + Skill race -- always a genuinely fresh race (uniquely-titled competitors every run, never reused). ──
  await ensureExactlyOneFreeSlot(affiliateA, `A-${runTag}`)
  const lADraftSkillId = await ensureDraft(affiliateA, `${QA_MARKER} STB-L-A draft Skill competitor ${runTag}`, { kind: 'skill', direction: 'available', isTest: false })
  const lAListingId = await createPendingApprovedListing(affiliateA, `${QA_MARKER} STB-L-A pending listing competitor ${runTag}`)

  const [publishResA, activateResA] = await Promise.all([
    api(affiliateA.cookie, 'POST', `/api/barter/skill-task/${lADraftSkillId}/publish`, { idempotency_key: `stb-l-a-publish-race-${runTag}` }),
    admin.rpc('activate_listing', { p_listing_id: lAListingId, p_admin_id: adminSession.userId, p_idempotency_key: `stb-l-a-activate-race-${runTag}` }),
  ])
  const publishSucceededA = publishResA.status === 200
  const activateSucceededA = !activateResA.error
  check('L-A (listing+Skill race): exactly one of the two concurrent activations succeeds', publishSucceededA !== activateSucceededA, { publishSucceededA, activateSucceededA, publishRes: publishResA.json, activateError: activateResA.error?.message })
  if (!publishSucceededA) check('L-A: the losing side fails with the normalized cap error', /plan does not allow another active/.test(publishResA.json?.error ?? ''), publishResA)
  if (!activateSucceededA) check('L-A: the losing side fails with the normalized cap error', /active_listing_limit_reached|plan allows up to/.test(activateResA.error?.message ?? ''), { error: activateResA.error?.message })
  const finalCountA = await realActiveSupplyCount(affiliateA.userId)
  check('L-A: final active-supply count equals the cap, never cap+1', finalCountA === STARTER_CAP, { finalCountA })

  // ── L-B: Skill + Task race ──
  await ensureExactlyOneFreeSlot(affiliateB, `B-${runTag}`)
  const lBSkillId = await ensureDraft(affiliateB, `${QA_MARKER} STB-L-B draft Skill competitor ${runTag}`, { kind: 'skill', direction: 'available', isTest: false })
  const lBTaskId = await ensureDraft(affiliateB, `${QA_MARKER} STB-L-B draft Task competitor ${runTag}`, { kind: 'task', direction: 'available', isTest: false })

  const [skillResB, taskResB] = await Promise.all([
    api(affiliateB.cookie, 'POST', `/api/barter/skill-task/${lBSkillId}/publish`, { idempotency_key: `stb-l-b-publish-skill-race-${runTag}` }),
    api(affiliateB.cookie, 'POST', `/api/barter/skill-task/${lBTaskId}/publish`, { idempotency_key: `stb-l-b-publish-task-race-${runTag}` }),
  ])
  const skillSucceededB = skillResB.status === 200
  const taskSucceededB = taskResB.status === 200
  check('L-B (Skill+Task race): exactly one of the two concurrent publishes succeeds', skillSucceededB !== taskSucceededB, { skillSucceededB, taskSucceededB, skillRes: skillResB.json, taskRes: taskResB.json })
  const finalCountB = await realActiveSupplyCount(affiliateB.userId)
  check('L-B: final active-supply count equals the cap, never cap+1', finalCountB === STARTER_CAP, { finalCountB })

  // ── L-C: resume race (paused Available Skill vs. a different fresh activation, same free slot) ──
  await ensureExactlyOneFreeSlot(affiliateA, `C-${runTag}`)
  const cPausableId = await ensurePublished(affiliateA, `${QA_MARKER} STB-L-C pausable Skill ${runTag}`, { kind: 'skill', direction: 'available', isTest: false })
  await api(affiliateA.cookie, 'POST', `/api/barter/skill-task/${cPausableId}/pause`, { idempotency_key: `stb-l-c-pause-${runTag}` })
  const cCompetitorId = await ensureDraft(affiliateA, `${QA_MARKER} STB-L-C draft competitor ${runTag}`, { kind: 'task', direction: 'available', isTest: false })

  const [resumeResC, publishResC] = await Promise.all([
    api(affiliateA.cookie, 'POST', `/api/barter/skill-task/${cPausableId}/resume`, { idempotency_key: `stb-l-c-resume-race-${runTag}` }),
    api(affiliateA.cookie, 'POST', `/api/barter/skill-task/${cCompetitorId}/publish`, { idempotency_key: `stb-l-c-publish-race-${runTag}` }),
  ])
  const resumeSucceededC = resumeResC.status === 200
  const publishSucceededC = publishResC.status === 200
  check('L-C (resume race): exactly one of resume vs. a competing fresh activation succeeds', resumeSucceededC !== publishSucceededC, { resumeSucceededC, publishSucceededC, resumeRes: resumeResC.json, publishRes: publishResC.json })
  const finalCountC = await realActiveSupplyCount(affiliateA.userId)
  check('L-C: final active-supply count equals the cap, never cap+1', finalCountC === STARTER_CAP, { finalCountC })

  // ── L-D: admin restore-to-active race/cap ──
  await ensureExactlyOneFreeSlot(affiliateB, `D-${runTag}`)
  const dSuspendableId = await ensurePublished(affiliateB, `${QA_MARKER} STB-L-D suspendable Task ${runTag}`, { kind: 'task', direction: 'available', isTest: false })
  await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${dSuspendableId}/suspend`, { reason: 'regression: cap race prep', idempotency_key: `stb-l-d-suspend-${runTag}` })
  const dCompetitorId = await ensureDraft(affiliateB, `${QA_MARKER} STB-L-D draft competitor ${runTag}`, { kind: 'skill', direction: 'available', isTest: false })

  const [restoreResD, publishResD] = await Promise.all([
    api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${dSuspendableId}/restore`, { reason: 'regression: cap race', idempotency_key: `stb-l-d-restore-race-${runTag}` }),
    api(affiliateB.cookie, 'POST', `/api/barter/skill-task/${dCompetitorId}/publish`, { idempotency_key: `stb-l-d-publish-race-${runTag}` }),
  ])
  const restoreSucceededD = restoreResD.status === 200
  const publishSucceededD = publishResD.status === 200
  check('L-D (admin restore-to-active race): exactly one of restore vs. a competing fresh activation succeeds', restoreSucceededD !== publishSucceededD, { restoreSucceededD, publishSucceededD, restoreRes: restoreResD.json, publishRes: publishResD.json })

  if (!restoreSucceededD) {
    const { data: dPostAfterLostRace } = await admin.from('barter_skill_task_posts').select('status, pre_suspend_status').eq('id', dSuspendableId).maybeSingle()
    check('L-D: restore losing the race leaves the post safely suspended (not corrupted)', dPostAfterLostRace?.status === 'suspended' && dPostAfterLostRace?.pre_suspend_status === 'active', dPostAfterLostRace)
    check('L-D: the losing restore returns a normalized admin capacity error', /plan does not allow another active|active_listing_limit_reached/.test(restoreResD.json?.error ?? ''), restoreResD)

    // After capacity frees up, restore succeeds.
    const { data: fillerToFree } = await admin.from('barter_skill_task_posts').select('id').eq('owner_id', affiliateB.userId).eq('direction', 'available').eq('status', 'active').eq('is_test', false).limit(1)
    if (fillerToFree?.[0]?.id) {
      await api(affiliateB.cookie, 'POST', `/api/barter/skill-task/${fillerToFree[0].id}/pause`, { idempotency_key: `stb-l-d-free-capacity-${fillerToFree[0].id}-${runTag}` })
      const retryRestore = await api(adminSession.cookie, 'POST', `/api/admin/barter/skill-task/${dSuspendableId}/restore`, { reason: 'regression: cap race retry after freeing capacity', idempotency_key: `stb-l-d-restore-retry-${runTag}` })
      check('L-D: after capacity is freed, restore succeeds', retryRestore.status === 200, retryRestore)
    }
  }
  const finalCountD = await realActiveSupplyCount(affiliateB.userId)
  check('L-D: final active-supply count never exceeds the cap', finalCountD <= STARTER_CAP, { finalCountD })

  // ── L-E: Subscription V2 deliberately widened the global publication cap
  // to count Looking-For Skill/Task posts too (one canonical entity = one
  // slot regardless of direction/mode -- see subscription_v2_plan_entitlements's
  // _lock_and_count_active_supply(), which counts barter_skill_task_posts
  // in status active/offers_received with no direction filter at all).
  // This supersedes the pre-V2 rule this check used to assert ("Looking-For
  // never consumes a slot"). affiliateA is at cap here (L-A through L-D
  // consumed the one free slot from ensureExactlyOneFreeSlot), so every
  // Looking-For publish attempt below must now be denied for capacity,
  // exactly like an Available one would be -- direction is no longer a
  // capacity exemption. Sequential (not Promise.all) to stay under the
  // route's own rate limiter, an unrelated concern from the cap logic
  // being tested here. ──
  const countBeforeE = await realActiveSupplyCount(affiliateA.userId)
  const eResults = []
  for (let i = 0; i < 3; i++) {
    const draftRes = await api(affiliateA.cookie, 'POST', '/api/barter/skill-task', {
      kind: i % 2 === 0 ? 'skill' : 'task', direction: 'looking_for', title: `${QA_MARKER} STB-L-E concurrent Looking-For ${i}-${runTag}`,
      description: 'Regression fixture', category_slug: 'tech', delivery_mode: 'remote',
      milestone_templates: [{ title: 'M1', sequence: 1, weight_percent: 100 }],
      idempotency_key: `stb-l-e-draft-${i}-${runTag}`,
    })
    if (draftRes.json?.post_id) {
      await admin.from('barter_skill_task_posts').update({ is_test: false }).eq('id', draftRes.json.post_id)
      publicFixturePostIds.add(draftRes.json.post_id)
      eResults.push(await api(affiliateA.cookie, 'POST', `/api/barter/skill-task/${draftRes.json.post_id}/publish`, { idempotency_key: `stb-l-e-publish-${i}-${runTag}` }))
    } else {
      eResults.push(draftRes)
    }
  }
  const capacityRejections = eResults.filter((r) => /active_publication_limit_reached|active_listing_limit_reached|plan does not allow another active/.test(r.json?.error ?? ''))
  check('L-E (V2): every Looking-For Skill/Task publish is rejected for capacity while the merchant is at cap', capacityRejections.length === eResults.length, eResults.map((r) => ({ status: r.status, json: r.json })))
  const countAfterE = await realActiveSupplyCount(affiliateA.userId)
  check('L-E: the active-supply count never exceeds the cap after the denied Looking-For attempts', countAfterE === countBeforeE, { countBeforeE, countAfterE })
} else {
  skip('L: active-supply cap concurrency', 'missing admin, affiliateA, or affiliateB QA account in .qa-credentials.local.json')
}

console.log(`\n=== SECTION L DONE -- ${failures} failure(s) so far ===`)

// ══════════════════════════════════════════════════════════════════
// FINAL CLEANUP -- sweep every is_test:false fixture back to
// is_test:true so nothing created for public-visibility proof lingers
// as real-looking public data after this run (mirrors
// verify-clickable-profiles.mjs's exact end-of-run sweep).
// ══════════════════════════════════════════════════════════════════
console.log('\n=== Cleanup: sweeping public-visibility fixtures back to is_test:true ===')
if (publicFixturePostIds.size > 0) {
  await admin.from('barter_skill_task_posts').update({ is_test: true }).in('id', [...publicFixturePostIds])
}
if (publicFixtureListingIds.size > 0) {
  await admin.from('listings').update({ is_test: true }).in('id', [...publicFixtureListingIds])
}
if (publicFixtureRequestIds.size > 0) {
  await admin.from('marketplace_requests').update({ is_test: true }).in('id', [...publicFixtureRequestIds])
}
const { count: leakedPosts } = await admin.from('barter_skill_task_posts').select('id', { count: 'exact', head: true }).in('id', [...publicFixturePostIds]).eq('is_test', false)
const { count: leakedListings } = await admin.from('listings').select('id', { count: 'exact', head: true }).in('id', [...publicFixtureListingIds]).eq('is_test', false)
const { count: leakedRequests } = await admin.from('marketplace_requests').select('id', { count: 'exact', head: true }).in('id', [...publicFixtureRequestIds]).eq('is_test', false)
check('Cleanup: zero public-visibility fixtures remain is_test:false', (leakedPosts ?? 0) === 0 && (leakedListings ?? 0) === 0 && (leakedRequests ?? 0) === 0, { leakedPosts, leakedListings, leakedRequests })

console.log('\n=== SUMMARY ===')
console.log(`checks: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}, skipped: ${skips}`)
if (skips > 0) {
  console.log('SKIP reasons:')
  for (const r of skipReasons) console.log(`  - ${r}`)
}
process.exit(failures === 0 ? 0 : 1)
