#!/usr/bin/env node
/**
 * Wave 0 controlled-pilot supply readiness reporter.
 *
 * STRICTLY READ-ONLY: every call below is a `.select()`. No insert, update,
 * delete, storage mutation, or RPC call of any kind exists in this file.
 *
 * Project identity is never assumed. The script compares the connected
 * project's ref (parsed from NEXT_PUBLIC_SUPABASE_URL) against
 * QA_SEED_PROJECT_REF and prints an explicit warning instead of claiming
 * "Production" when they match -- this repository's own .env.local points
 * at the project named by QA_SEED_PROJECT_REF, which is not independently
 * confirmed to be the live production database.
 *
 * "Active" listing = listings.status = 'active' (supabase/migrations/
 * 20260613000001_initial_schema.sql). Test listings (is_test = true,
 * supabase/migrations/20260821000001_listings_is_test_column.sql) are
 * always excluded from every Wave 0 metric below.
 *
 * Ownership verification is only "required" for risk_tier in
 * ('medium', 'high') -- src/lib/risk/engine.ts's getRiskRequirements()
 * leaves ownershipVerificationRequired false for 'low'.
 *
 * Never prints SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY, or
 * any other credential value.
 *
 * Usage: node scripts/wave0-supply-readiness.mjs
 */

import { config } from 'dotenv'

config({ path: '.env.local' })

const WAVE0_CATEGORIES = ['outdoor', 'events', 'sports', 'baby', 'tools']

const MIN_TARGET = {
  merchants: 12,
  listings: 25,
  perCategory: 3,
  photoCompletenessPct: 90,
  ownershipVerifiedPct: 95,
  locationCompletenessPct: 100,
}

const PREFERRED_TARGET = {
  merchants: 20,
  listings: 40,
  perCategory: 5,
  photoCompletenessPct: 95,
  ownershipVerifiedPct: 100,
  locationCompletenessPct: 100,
}

function reportProjectIdentity(url) {
  let ref = 'unknown'
  try {
    ref = new URL(url).hostname.split('.')[0]
  } catch {
    // leave ref as 'unknown' -- handled below
  }

  const qaRef = process.env.QA_SEED_PROJECT_REF

  console.log('=== Project identity ===')
  console.log(`Connected project ref: ${ref}`)

  if (!qaRef) {
    console.log('WARNING: QA_SEED_PROJECT_REF is not set in this environment -- cannot even rule out the QA/seed project. Do not label this run "Production" without independent confirmation.')
  } else if (ref === qaRef) {
    console.log('WARNING: this project ref matches QA_SEED_PROJECT_REF. This run is reading the QA/seed project, NOT a confirmed production database. Treat every number below as a QA/seed-environment observation, not real marketplace supply, unless independently proven otherwise.')
  } else {
    console.log('This project ref does NOT match QA_SEED_PROJECT_REF. It may be production, but this script has no independent way to confirm that -- it only knows it is not the known QA/seed project.')
  }
  console.log('')
}

function pct(numerator, denominator) {
  if (denominator === 0) return null
  return Math.round((numerator / denominator) * 1000) / 10
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured in this environment.')
    process.exitCode = 1
    return
  }

  reportProjectIdentity(url)

  const { createClient } = await import('@supabase/supabase-js')
  const admin = createClient(url, serviceKey)

  const { count: totalListings, error: totalErr } = await admin
    .from('listings')
    .select('id', { count: 'exact', head: true })
  if (totalErr) {
    console.error('Could not read listings (total count).', totalErr.message)
    process.exitCode = 1
    return
  }

  const { count: activeTestCount, error: activeTestErr } = await admin
    .from('listings')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
    .eq('is_test', true)
  if (activeTestErr) {
    console.error('Could not read active test listings.', activeTestErr.message)
    process.exitCode = 1
    return
  }

  const { data: activeNonTest, error: activeErr } = await admin
    .from('listings')
    .select('id, merchant_id, category, risk_tier, province, city, collection_area, ownership_verified')
    .eq('status', 'active')
    .eq('is_test', false)
  if (activeErr) {
    console.error('Could not read active non-test listings.', activeErr.message)
    process.exitCode = 1
    return
  }

  const listings = activeNonTest ?? []
  const listingIds = listings.map((l) => l.id)
  const merchantIds = new Set(listings.map((l) => l.merchant_id))

  const categoryCounts = Object.fromEntries(WAVE0_CATEGORIES.map((c) => [c, 0]))
  for (const listing of listings) {
    if (categoryCounts[listing.category] !== undefined) categoryCounts[listing.category] += 1
  }

  let photosByListing = new Map()
  if (listingIds.length > 0) {
    const { data: mediaRows, error: mediaErr } = await admin
      .from('listing_media')
      .select('listing_id, type')
      .eq('type', 'photo')
      .in('listing_id', listingIds)
    if (mediaErr) {
      console.error('Could not read listing_media.', mediaErr.message)
      process.exitCode = 1
      return
    }
    for (const row of mediaRows ?? []) {
      photosByListing.set(row.listing_id, (photosByListing.get(row.listing_id) ?? 0) + 1)
    }
  }

  const missing = { photos: [], province: [], city: [], collectionArea: [], ownershipVerification: [] }
  let withEnoughPhotos = 0
  let requiringOwnership = 0
  let ownershipSatisfied = 0
  let fullLocationComplete = 0

  for (const listing of listings) {
    const photoCount = photosByListing.get(listing.id) ?? 0
    if (photoCount >= 3) withEnoughPhotos += 1
    else missing.photos.push(listing.id)

    const requiresOwnership = listing.risk_tier === 'medium' || listing.risk_tier === 'high'
    if (requiresOwnership) {
      requiringOwnership += 1
      if (listing.ownership_verified) ownershipSatisfied += 1
      else missing.ownershipVerification.push(listing.id)
    }

    const hasProvince = !!listing.province
    const hasCity = !!listing.city
    const hasCollectionArea = !!listing.collection_area
    if (!hasProvince) missing.province.push(listing.id)
    if (!hasCity) missing.city.push(listing.id)
    if (!hasCollectionArea) missing.collectionArea.push(listing.id)
    if (hasProvince && hasCity && hasCollectionArea) fullLocationComplete += 1
  }

  const photoCompletenessPct = pct(withEnoughPhotos, listings.length)
  const ownershipVerifiedPct = pct(ownershipSatisfied, requiringOwnership)
  const locationCompletenessPct = pct(fullLocationComplete, listings.length)

  console.log('=== Wave 0 supply readiness ===')
  console.log(`TOTAL LISTINGS (all statuses, test + non-test): ${totalListings ?? 'unknown'}`)
  console.log(`ACTIVE TEST LISTINGS: ${activeTestCount ?? 'unknown'}`)
  console.log(`ACTIVE NON-TEST LISTINGS: ${listings.length}`)
  console.log(`ACTIVE NON-TEST MERCHANTS: ${merchantIds.size}`)
  console.log('')
  console.log('CATEGORY COUNTS (active, non-test):')
  for (const cat of WAVE0_CATEGORIES) {
    console.log(`  ${cat}: ${categoryCounts[cat]}`)
  }
  console.log('')
  console.log(`PHOTO COMPLETENESS (>=3 photos): ${photoCompletenessPct === null ? 'n/a (0 active non-test listings)' : `${photoCompletenessPct}%`}`)
  console.log(`OWNERSHIP VERIFICATION WHERE REQUIRED (risk_tier medium/high): ${ownershipVerifiedPct === null ? 'n/a (no listing currently requires it)' : `${ownershipVerifiedPct}%`} (${ownershipSatisfied}/${requiringOwnership} required listings verified)`)
  console.log(`LOCATION COMPLETENESS (province + city + collection_area all set): ${locationCompletenessPct === null ? 'n/a (0 active non-test listings)' : `${locationCompletenessPct}%`}`)
  console.log('')
  console.log('LISTINGS MISSING:')
  console.log(`  photos (<3): ${missing.photos.length}`)
  console.log(`  province: ${missing.province.length}`)
  console.log(`  city: ${missing.city.length}`)
  console.log(`  collection_area: ${missing.collectionArea.length}`)
  console.log(`  ownership verification (where required): ${missing.ownershipVerification.length}`)
  console.log('')

  const perCategoryMin = WAVE0_CATEGORIES.every((c) => categoryCounts[c] >= MIN_TARGET.perCategory)
  const perCategoryPreferred = WAVE0_CATEGORIES.every((c) => categoryCounts[c] >= PREFERRED_TARGET.perCategory)

  const meetsMinimum =
    merchantIds.size >= MIN_TARGET.merchants &&
    listings.length >= MIN_TARGET.listings &&
    perCategoryMin &&
    (photoCompletenessPct ?? 0) >= MIN_TARGET.photoCompletenessPct &&
    (ownershipVerifiedPct ?? 100) >= MIN_TARGET.ownershipVerifiedPct &&
    (locationCompletenessPct ?? 0) >= MIN_TARGET.locationCompletenessPct

  const meetsPreferred =
    meetsMinimum &&
    merchantIds.size >= PREFERRED_TARGET.merchants &&
    listings.length >= PREFERRED_TARGET.listings &&
    perCategoryPreferred &&
    (photoCompletenessPct ?? 0) >= PREFERRED_TARGET.photoCompletenessPct &&
    (ownershipVerifiedPct ?? 100) >= PREFERRED_TARGET.ownershipVerifiedPct &&
    (locationCompletenessPct ?? 0) >= PREFERRED_TARGET.locationCompletenessPct

  console.log('=== WAVE 0 SUPPLY STATUS ===')
  if (meetsPreferred) console.log('PREFERRED READY')
  else if (meetsMinimum) console.log('MINIMUM READY')
  else console.log('NOT READY')
}

main()
