import { EMAIL_TEMPLATES, renderTemplate, type TemplateVars } from '@/lib/email'

export const metadata = { title: 'Email Previews — Unity Admin' }

/**
 * Development/admin-only template preview (Step 8). Gated by the parent
 * admin layout's requireAdmin() (src/app/admin/layout.tsx) -- this page
 * adds no auth of its own, matching every other page under /admin.
 *
 * Never sends anything and never touches real user data -- every
 * template is rendered with clearly-fake synthetic values so a reviewer
 * can see the exact HTML/text a real event would produce, without
 * exposing a real booking, listing, or person. Lists every template id
 * and version, satisfying "list all template ids and versions."
 */

const SYNTHETIC_VARS: TemplateVars = {
  merchantName: 'Jane Merchant (example)',
  renterName: 'Sam Renter (example)',
  userName: 'Alex User (example)',
  recipientName: 'Alex User (example)',
  listingTitle: 'DJI Mavic 3 Pro Drone Kit (example)',
  bookingReference: 'UN-PREVIEW1',
  feedback: 'This is example feedback text shown here only to demonstrate template layout.',
  paymentDueAt: '15 Aug 2026, 14:00',
  totalAmount: 'R2,500.00',
}

export default function EmailPreviewsPage() {
  const rendered = EMAIL_TEMPLATES.map((def) => {
    try {
      return { def, result: renderTemplate(def.id, SYNTHETIC_VARS), error: null as string | null }
    } catch (err) {
      return { def, result: null, error: err instanceof Error ? err.message : 'render error' }
    }
  })

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div className="mb-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Development Tool</p>
        <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-white tracking-tight">Email Previews</h1>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-2">
          {rendered.length} templates. Rendered with synthetic example data — never sent, never real user data.
        </p>
      </div>

      <div className="space-y-6">
        {rendered.map(({ def, result, error }) => (
          <div key={def.id} className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
            <div className="px-4 py-3 bg-[#FAF8F5] dark:bg-[#1A1010] border-b border-[#F2EDE8] dark:border-[#2A1A1A] flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-[#1A0A0A] dark:text-white">{def.id}</p>
                <p className="text-xs text-[#9B8B85]">event: {def.event} · version {def.version} · requires: {def.requiredVars.join(', ')}</p>
              </div>
              {result && <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] max-w-sm text-right">{result.subject}</p>}
            </div>
            {error ? (
              <p className="p-4 text-xs text-red-600">Render error: {error}</p>
            ) : (
              <iframe title={def.id} srcDoc={result!.html} className="w-full h-[420px] bg-white" sandbox="" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
