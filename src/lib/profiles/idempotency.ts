import { createHash } from 'crypto'
import { checkIdempotentReplay } from '@/lib/bookings/idempotency'
export { checkIdempotentReplay }

/** Mirrors report_profile()'s request_hash formula exactly (supabase/migrations/20260830000001_clickable_profiles_report.sql). */
function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeReportProfileHash(reportedProfileId: string, reason: string, description: string | null | undefined): string {
  return md5(`${reportedProfileId}|${reason}|${description ?? ''}`)
}
