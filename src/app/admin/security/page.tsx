import { requireAdmin } from '@/lib/supabase/require-admin'
import { AdminPageHeader } from '@/components/admin/ui'
import { MfaEnrollmentPanel } from './mfa-enrollment-panel'

/**
 * E47 Phase 2: lets an admin enroll a TOTP factor ahead of any future
 * ADMIN_MFA_ENFORCED rollout (src/lib/supabase/admin-mfa.ts,
 * docs/operations/ADMIN_MFA_ROLLOUT_CHECKLIST.md). This page never
 * enforces anything on its own -- enrolling here does not change
 * what any admin, including the one enrolling, can currently access.
 */
export default async function AdminSecurityPage() {
  const requester = await requireAdmin()
  if (!requester) {
    return <div className="p-8 text-sm text-[#9B8B85]">You must be signed in as an administrator.</div>
  }

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-2xl">
      <AdminPageHeader eyebrow="Security" title="Two-Factor Authentication" />
      <MfaEnrollmentPanel />
    </div>
  )
}
