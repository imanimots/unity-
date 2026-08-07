import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'
import { getLegalDocument } from '@/lib/legal/registry'
import { legalRobotsMeta } from '@/lib/seo/legal-metadata'
import { absoluteUrl } from '@/lib/seo/config'

const doc = getLegalDocument('verification-and-trust')!

export const metadata: Metadata = {
  title: `${doc.title} — Unity`,
  description: 'What Unity actually checks before you rent or list — and what "verified" does and does not mean.',
  alternates: { canonical: absoluteUrl('/verification-and-trust') },
  robots: legalRobotsMeta(doc),
}

export default function VerificationAndTrustPage() {
  return (
    <LegalPageLayout doc={doc}>
      <p>This page describes Unity&apos;s current trust system as actually implemented. It is a draft, pending legal review.</p>

      <LegalSection title="Public test environment — how verification currently works">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>Identity and ownership verification is currently performed manually, by Unity administrators, based on the documents and evidence submitted.</li>
          <li>Unity does not currently use Sumsub or any other automated identity-verification vendor — this is manual test verification.</li>
          <li>Unity does not verify identity against government databases.</li>
          <li>Unity does not verify identity or ownership against bank records.</li>
          <li>A completed review does not guarantee the authenticity of any document beyond what a reasonable manual review can confirm.</li>
        </ul>
      </LegalSection>

      <LegalSection title="What Unity actually reviews">
        <ul className="list-disc pl-5 space-y-1.5">
          <li><strong>Identity verification</strong> — legal name, date of birth, ID/passport, and submitted identity document and proof of address.</li>
          <li><strong>Ownership evidence</strong> — receipts, serial numbers, or media a merchant submits for a listing.</li>
          <li><strong>Listing moderation</strong> — a review of listing content and completeness before it goes live.</li>
          <li><strong>Risk tier</strong> — an automated classification (low/medium/high) based on a listing&apos;s value and category, which determines what evidence and requirements apply.</li>
          <li><strong>Declarations</strong> — statements a merchant confirms when submitting a listing (ownership authority, condition accuracy, image accuracy, legality and safety, and platform terms).</li>
          <li><strong>Reviews and Unity Score</strong>, where shown — ratings left by other users after a completed rental.</li>
          <li><strong>Booking history</strong> — a user&apos;s record of past bookings on the platform.</li>
          <li><strong>Payment status</strong> — whether a booking&apos;s required payment has been completed, shown on the relevant booking.</li>
          <li><strong>Audit records</strong> — an internal, immutable history of moderation and verification decisions.</li>
        </ul>
      </LegalSection>

      <LegalSection title="What &quot;verified&quot; means">
        <p className="font-semibold">
          &quot;Verified&quot; means the stated Unity review was completed based on available evidence. It does not
          guarantee future conduct, item performance, or legal title beyond the evidence reviewed.
        </p>
      </LegalSection>

      <LegalSection title="What we do promise">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>Documents and evidence are transmitted over encrypted connections.</li>
          <li>Private documents (identity documents, ownership evidence) are stored in private, access-controlled storage — never publicly listable.</li>
          <li>Access to review documents is server-authoritative and limited to authorized Unity administrators, via short-lived signed links generated per request.</li>
          <li>Every listing and user identity that goes through review is reviewed by Unity before being marked as such.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Related policies">
        <p>
          See also the <Link href="/privacy" className="underline">Privacy Policy</Link> and{' '}
          <Link href="/popia" className="underline">POPIA Notice</Link> for how identity documents are handled, and
          the <Link href="/prohibited-items" className="underline">Prohibited Items Policy</Link> for what cannot be
          listed regardless of ownership evidence.
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}
