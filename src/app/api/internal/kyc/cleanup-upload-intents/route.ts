import { NextRequest, NextResponse } from 'next/server'
import { resolveExpiredKycUploadIntent, type ExpiredIntentCandidate, type CleanupOutcome } from '@/lib/identity-verification/cleanup-upload-intent'

/** Server-defined only -- never a request parameter. Matches this repo's
 * established internal-sweep batch sizing (AFFILIATE_SWEEP_BATCH_LIMIT). */
const BATCH_LIMIT = 100

/**
 * POST /api/internal/kyc/cleanup-upload-intents -- KYC B3C. Secret-
 * authenticated, machine-to-machine (no signed-in user concept), same
 * shape as every other /api/internal/* sweep route: 503 if
 * INTERNAL_CRON_SECRET is unset, 401 on a bad bearer, service-role
 * client, no caller-controlled input of any kind.
 *
 * One bounded iteration: atomically claim up to BATCH_LIMIT expired
 * intent candidates via claim_expired_kyc_upload_intents() (a
 * service-role-only SECURITY DEFINER function that transitions
 * first-time `pending`+past-deadline rows to `expired` in its own
 * transaction and also returns already-`expired` retry rows -- never
 * the same id twice), then resolve each candidate's Storage fate
 * independently. One candidate's failure never aborts the batch.
 *
 * NOT a scheduler -- this is invocation capability only. Automatic
 * cadence is B3D. Never touches identity_verifications.status,
 * verification history, providers, or the admin review workflow.
 *
 * Response is aggregate counters only -- never an intent id, user id,
 * storage path, document type, MIME, or size.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal KYC cleanup endpoint is not configured' }, { status: 503 })
  }

  const provided = request.headers.get('authorization')
  if (provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'KYC storage is not configured' }, { status: 503 })
  }

  const started = Date.now()
  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data, error } = await admin.rpc('claim_expired_kyc_upload_intents', { p_limit: BATCH_LIMIT })
    if (error) {
      console.error('[internal.kyc.cleanup-upload-intents] claim RPC error', { code: (error as { code?: string }).code })
      return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 })
    }

    const candidates = ((data as { candidates?: unknown })?.candidates ?? []) as ExpiredIntentCandidate[]

    let cleaned = 0
    let preserved = 0
    let storageErrors = 0
    let metadataErrors = 0
    let invalidPaths = 0

    for (const candidate of candidates) {
      let outcome: CleanupOutcome
      try {
        outcome = await resolveExpiredKycUploadIntent(admin, candidate)
      } catch {
        // Head-of-line-blocking guard. resolveExpiredKycUploadIntent is
        // written never to throw; this is a pure safety net so one
        // candidate can never abort the remaining batch.
        console.error('[internal.kyc.cleanup-upload-intents] unexpected candidate error')
        storageErrors += 1
        continue
      }
      if (outcome === 'cleaned') cleaned += 1
      else if (outcome === 'preserved') preserved += 1
      else if (outcome === 'storage_error') storageErrors += 1
      else if (outcome === 'metadata_error') metadataErrors += 1
      else if (outcome === 'invalid_path') invalidPaths += 1
    }

    const result = {
      scanned: candidates.length,
      claimed_first_time: candidates.filter((c) => !c.is_retry).length,
      claimed_retry: candidates.filter((c) => c.is_retry).length,
      cleaned,
      preserved,
      storage_errors: storageErrors,
      metadata_errors: metadataErrors,
      invalid_paths: invalidPaths,
      duration_ms: Date.now() - started,
    }
    console.log('[internal.kyc.cleanup-upload-intents] run complete', result)
    return NextResponse.json(result)
  } catch {
    console.error('[internal.kyc.cleanup-upload-intents] unexpected error')
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 })
  }
}
