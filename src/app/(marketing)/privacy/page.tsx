import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'
import { getLegalDocument } from '@/lib/legal/registry'
import { legalRobotsMeta } from '@/lib/seo/legal-metadata'
import { absoluteUrl } from '@/lib/seo/config'

const doc = getLegalDocument('privacy')!

export const metadata: Metadata = {
  title: `${doc.title} — Unity`,
  description: 'How Unity collects, uses, and protects personal information.',
  alternates: { canonical: absoluteUrl('/privacy') },
  robots: legalRobotsMeta(doc),
}

export default function PrivacyPage() {
  return (
    <LegalPageLayout doc={doc}>
      <p>
        This is a draft Privacy Policy, published for Unity&apos;s public test phase and pending legal review. It
        describes the categories of personal information Unity&apos;s platform actually collects and how they are
        used. See also the <Link href="/popia" className="underline">POPIA Notice</Link> for South Africa-specific
        detail.
      </p>

      <LegalSection title="Categories of information we process">
        <ul className="list-disc pl-5 space-y-1.5">
          <li><strong>Account information</strong> — name, email, password (stored hashed by our authentication provider), and role (renter/merchant).</li>
          <li><strong>Public profile information</strong> — display name, rating/review data, and booking history relevant to other users.</li>
          <li><strong>Legal identity data</strong> — legal name, date of birth, ID/passport number and type, nationality, residential address, submitted during identity verification.</li>
          <li><strong>KYC documents</strong> — identity document and proof of address images, stored in a private, access-controlled location.</li>
          <li><strong>Ownership evidence</strong> — receipts, serial numbers, or media a merchant submits to support a listing.</li>
          <li><strong>Listing data</strong> — item descriptions, photos, pricing, and availability.</li>
          <li><strong>Booking data</strong> — rental dates, booking status, messages between renter and merchant.</li>
          <li><strong>Payment metadata</strong> — booking amounts, payment and deposit status, and (in test mode) simulated transaction references. Unity does not store raw card numbers.</li>
          <li><strong>Device, security and audit data</strong> — sign-in timestamps, IP-derived rate-limiting signals, and internal audit logs of account actions.</li>
          <li><strong>Messages and support</strong> — in-platform chat content (automatically filtered for contact details and payment requests) and any support correspondence.</li>
          <li><strong>Cookies</strong> — where used, limited to authentication session cookies and, if enabled, basic analytics.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Purpose">
        <p>
          Information is used to operate the platform: creating and managing accounts, enabling bookings and
          payments, verifying identity and listing ownership, moderating listings, preventing fraud, providing
          support, and complying with legal obligations.
        </p>
      </LegalSection>

      <LegalSection title="Third-party processors">
        <p>
          Unity uses infrastructure and service providers to operate the platform, including a database and
          authentication provider, and (in a live environment) a payment provider. Providers are engaged to process
          data only for the purposes described here.
        </p>
      </LegalSection>

      <LegalSection title="Retention">
        <p>
          Personal information is retained as required for legal, fraud, dispute and operational purposes. Unity has
          not yet finalized exact retention periods for every data category — this section will be updated once
          those periods are confirmed.
        </p>
      </LegalSection>

      <LegalSection title="Security">
        <p>
          Data is transmitted over encrypted connections. Identity and ownership documents are stored in private,
          access-controlled storage, viewable only via short-lived signed links generated for an authorized
          reviewer. Platform permissions are enforced server-side.
        </p>
      </LegalSection>

      <LegalSection title="Your rights">
        <p>
          Subject to applicable law, you may request access to, correction of, or deletion of your personal
          information, and may object to certain processing. Contact us using the details on the{' '}
          <Link href="/contact" className="underline">Contact page</Link> to make a request or raise a complaint.
        </p>
      </LegalSection>

      <LegalSection title="Cross-border processing">
        <p>
          Unity does not currently confirm that all personal information is stored exclusively within South Africa.
          Where a processor is located outside South Africa, Unity will rely on appropriate safeguards required by
          applicable law. This section is pending legal confirmation.
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}
