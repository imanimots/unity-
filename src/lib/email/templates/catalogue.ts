import { renderShell, type ShellInput } from './shared'
import type { Locale } from '@/i18n/locales'

export type TemplateVars = Record<string, string | number>

export interface EmailTemplateDef {
  id: string
  version: string
  event: string
  requiredVars: string[]
  subject: (v: TemplateVars) => string
  build: (v: TemplateVars) => ShellInput
  /**
   * Optional per-locale variants (i18n Phase 2 completion delta). Additive
   * only -- `subject`/`build` above remain the required, unconditional
   * en-ZA definition every template has always had; this map supplies
   * af-ZA/zu-ZA alternates for the templates that have been translated so
   * far. A template with no entry here (or missing a specific locale) is
   * NOT a bug -- renderTemplate() falls back to the en-ZA subject/build
   * functions, exactly matching the binding "missing translation must
   * never block a critical email" requirement. src/lib/email/coverage-manifest.ts
   * is the single source of truth for which templates are actually
   * complete per locale -- it inspects this map directly rather than a
   * hand-maintained parallel list, so it can never drift from reality.
   */
  localeVariants?: Partial<Record<Locale, { subject: (v: TemplateVars) => string; build: (v: TemplateVars) => ShellInput }>>
}

export interface RenderedTemplate {
  subject: string
  html: string
  text: string
}

const s = (v: TemplateVars, key: string): string => String(v[key] ?? '')

/**
 * The full event-to-template catalogue (Step 8). Each entry is a small
 * declarative object, not a hand-authored HTML file -- every one renders
 * through the single shared shell (src/lib/email/templates/shared.ts).
 * `id` is stable and never reused for a different meaning; bumping
 * `version` (not editing an id's wording in place) is how a template
 * changes without breaking delivery-record history that references an
 * older version. See docs/TRANSACTIONAL_EMAILS.md for the full
 * event-to-template matrix and the "why not X" notes for events that were
 * deliberately NOT given a separate template to avoid duplication
 * (e.g. booking.returned folded into booking.completed).
 */
export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  // ---------------- LISTING / MERCHANT ----------------
  {
    id: 'listing-submitted-merchant',
    version: '1',
    event: 'listing.submitted',
    requiredVars: ['merchantName', 'listingTitle'],
    subject: (v) => `Your listing "${s(v, 'listingTitle')}" was submitted for review`,
    build: (v) => ({
      preheader: `We're reviewing "${s(v, 'listingTitle')}"`,
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `Your listing "${s(v, 'listingTitle')}" has been submitted for review. A Unity administrator will review it shortly.`,
        `We'll email you as soon as a decision is made.`,
      ],
      cta: { label: 'View your listings', path: '/dashboard/merchant/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou notering "${s(v, 'listingTitle')}" is ingedien vir hersiening`,
        build: (v) => ({
          preheader: `Ons hersien tans "${s(v, 'listingTitle')}"`,
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Jou notering "${s(v, 'listingTitle')}" is ingedien vir hersiening. 'n Unity-administrateur sal dit binnekort hersien.`,
            `Ons sal jou e-pos stuur sodra 'n besluit geneem is.`,
          ],
          cta: { label: 'Bekyk jou noterings', path: '/dashboard/merchant/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Uhlu lwakho "${s(v, 'listingTitle')}" luthunyelwe ukuze lubuyekezwe`,
        build: (v) => ({
          preheader: `Sibuyekeza "${s(v, 'listingTitle')}"`,
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Uhlu lwakho "${s(v, 'listingTitle')}" luthunyelwe ukuze lubuyekezwe. Umlawuli we-Unity uzolubuyekeza maduzane.`,
            `Sizokuthumelela i-imeyili uma isinqumo sesenziwe.`,
          ],
          cta: { label: 'Buka izinhlu zakho', path: '/dashboard/merchant/listings' },
        }),
      },
    },
  },
  {
    id: 'listing-changes-requested-merchant',
    version: '1',
    event: 'listing.changes_requested',
    requiredVars: ['merchantName', 'listingTitle', 'feedback'],
    subject: (v) => `Changes requested on "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A Unity administrator asked for changes to your listing',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `A Unity administrator reviewed "${s(v, 'listingTitle')}" and requested changes before it can go live:`,
        s(v, 'feedback'),
        `Update your listing and resubmit it for review.`,
      ],
      cta: { label: 'Edit your listing', path: '/dashboard/merchant/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Veranderinge versoek op "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: "'n Unity-administrateur het veranderinge aan jou notering versoek",
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `'n Unity-administrateur het "${s(v, 'listingTitle')}" hersien en veranderinge versoek voordat dit regstreeks kan gaan:`,
            s(v, 'feedback'),
            `Werk jou notering by en dien dit weer in vir hersiening.`,
          ],
          cta: { label: 'Wysig jou notering', path: '/dashboard/merchant/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Kudingeka ushintsho ku-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Umlawuli we-Unity ucele ushintsho ohlwini lwakho',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Umlawuli we-Unity ubuyekeze "${s(v, 'listingTitle')}" futhi ucele ushintsho ngaphambi kokuba lusebenze:`,
            s(v, 'feedback'),
            `Buyekeza uhlu lwakho bese uluthumela futhi ukuze lubuyekezwe.`,
          ],
          cta: { label: 'Hlela uhlu lwakho', path: '/dashboard/merchant/listings' },
        }),
      },
    },
  },
  {
    id: 'listing-ownership-approved-merchant',
    version: '1',
    event: 'listing.ownership_approved',
    requiredVars: ['merchantName', 'listingTitle'],
    subject: (v) => `Ownership evidence approved for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your ownership evidence was approved',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`The ownership evidence you submitted for "${s(v, 'listingTitle')}" has been reviewed and approved.`],
      cta: { label: 'View your listings', path: '/dashboard/merchant/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Eienaarskapbewys goedgekeur vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou eienaarskapbewys is goedgekeur',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Die eienaarskapbewys wat jy vir "${s(v, 'listingTitle')}" ingedien het, is hersien en goedgekeur.`],
          cta: { label: 'Bekyk jou noterings', path: '/dashboard/merchant/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ubufakazi bobunikazi buvunyiwe be-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ubufakazi bakho bobunikazi buvunyiwe',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Ubufakazi bobunikazi obuwuthumele be-"${s(v, 'listingTitle')}" bubuyekeziwe futhi buvunyiwe.`],
          cta: { label: 'Buka izinhlu zakho', path: '/dashboard/merchant/listings' },
        }),
      },
    },
  },
  {
    id: 'listing-ownership-rejected-merchant',
    version: '1',
    event: 'listing.ownership_rejected',
    requiredVars: ['merchantName', 'listingTitle', 'feedback'],
    subject: (v) => `Ownership evidence needs attention for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your ownership evidence was not approved',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `The ownership evidence you submitted for "${s(v, 'listingTitle')}" was not approved:`,
        s(v, 'feedback'),
      ],
      cta: { label: 'Review and resubmit', path: '/dashboard/merchant/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Eienaarskapbewys benodig aandag vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou eienaarskapbewys is nie goedgekeur nie',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Die eienaarskapbewys wat jy vir "${s(v, 'listingTitle')}" ingedien het, is nie goedgekeur nie:`,
            s(v, 'feedback'),
          ],
          cta: { label: 'Hersien en dien weer in', path: '/dashboard/merchant/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ubufakazi bobunikazi budinga ukunakwa be-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ubufakazi bakho bobunikazi abuvunyiwe',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Ubufakazi bobunikazi obuwuthumele be-"${s(v, 'listingTitle')}" abuvunyiwe:`,
            s(v, 'feedback'),
          ],
          cta: { label: 'Buyekeza bese uthumela futhi', path: '/dashboard/merchant/listings' },
        }),
      },
    },
  },
  {
    id: 'listing-moderation-approved-merchant',
    version: '1',
    event: 'listing.moderation_approved',
    requiredVars: ['merchantName', 'listingTitle'],
    subject: (v) => `"${s(v, 'listingTitle')}" passed moderation`,
    build: (v) => ({
      preheader: 'Your listing passed moderation review',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `"${s(v, 'listingTitle')}" has passed Unity's moderation review. It will go live once activated.`,
      ],
      cta: { label: 'View your listings', path: '/dashboard/merchant/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `"${s(v, 'listingTitle')}" het modereer geslaag`,
        build: (v) => ({
          preheader: 'Jou notering het die moderasiehersiening geslaag',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `"${s(v, 'listingTitle')}" het Unity se moderasiehersiening geslaag. Dit sal regstreeks gaan sodra dit geaktiveer is.`,
          ],
          cta: { label: 'Bekyk jou noterings', path: '/dashboard/merchant/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `"${s(v, 'listingTitle')}" iphumelele ukubuyekezwa`,
        build: (v) => ({
          preheader: 'Uhlu lwakho luphumelele ukubuyekezwa',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `"${s(v, 'listingTitle')}" iphumelele ukubuyekezwa kwe-Unity. Izosebenza uma isivuliwe.`,
          ],
          cta: { label: 'Buka izinhlu zakho', path: '/dashboard/merchant/listings' },
        }),
      },
    },
  },
  {
    id: 'listing-moderation-rejected-merchant',
    version: '1',
    event: 'listing.moderation_rejected',
    requiredVars: ['merchantName', 'listingTitle', 'feedback'],
    subject: (v) => `"${s(v, 'listingTitle')}" was not approved`,
    build: (v) => ({
      preheader: 'Your listing was not approved',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`"${s(v, 'listingTitle')}" was reviewed and not approved:`, s(v, 'feedback')],
      cta: { label: 'View your listings', path: '/dashboard/merchant/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `"${s(v, 'listingTitle')}" is nie goedgekeur nie`,
        build: (v) => ({
          preheader: 'Jou notering is nie goedgekeur nie',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [`"${s(v, 'listingTitle')}" is hersien en nie goedgekeur nie:`, s(v, 'feedback')],
          cta: { label: 'Bekyk jou noterings', path: '/dashboard/merchant/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `"${s(v, 'listingTitle')}" ayivunyiwe`,
        build: (v) => ({
          preheader: 'Uhlu lwakho aluvunyiwe',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [`"${s(v, 'listingTitle')}" ibuyekeziwe futhi ayivunyiwe:`, s(v, 'feedback')],
          cta: { label: 'Buka izinhlu zakho', path: '/dashboard/merchant/listings' },
        }),
      },
    },
  },
  {
    id: 'listing-activated-merchant',
    version: '1',
    event: 'listing.activated',
    requiredVars: ['merchantName', 'listingTitle'],
    subject: (v) => `"${s(v, 'listingTitle')}" is now live`,
    build: (v) => ({
      preheader: 'Your listing is live on Unity',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`"${s(v, 'listingTitle')}" is now live and visible to renters on Unity.`],
      cta: { label: 'View your listing', path: '/dashboard/merchant/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `"${s(v, 'listingTitle')}" is nou regstreeks`,
        build: (v) => ({
          preheader: 'Jou notering is regstreeks op Unity',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [`"${s(v, 'listingTitle')}" is nou regstreeks en sigbaar vir huurders op Unity.`],
          cta: { label: 'Bekyk jou notering', path: '/dashboard/merchant/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `"${s(v, 'listingTitle')}" isisebenza manje`,
        build: (v) => ({
          preheader: 'Uhlu lwakho luyasebenza ku-Unity',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [`"${s(v, 'listingTitle')}" seluyasebenza manje futhi luyabonakala kubaqashi ku-Unity.`],
          cta: { label: 'Buka uhlu lwakho', path: '/dashboard/merchant/listings' },
        }),
      },
    },
  },
  {
    id: 'listing-suspended-merchant',
    version: '1',
    event: 'listing.suspended',
    requiredVars: ['merchantName', 'listingTitle', 'feedback'],
    subject: (v) => `"${s(v, 'listingTitle')}" has been suspended`,
    build: (v) => ({
      preheader: 'Your listing has been suspended',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`"${s(v, 'listingTitle')}" has been suspended and is no longer visible to renters:`, s(v, 'feedback')],
      cta: { label: 'Contact support', path: '/contact' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `"${s(v, 'listingTitle')}" is opgeskort`,
        build: (v) => ({
          preheader: 'Jou notering is opgeskort',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [`"${s(v, 'listingTitle')}" is opgeskort en is nie meer sigbaar vir huurders nie:`, s(v, 'feedback')],
          cta: { label: 'Kontak ondersteuning', path: '/contact' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `"${s(v, 'listingTitle')}" imisiwe okwesikhashana`,
        build: (v) => ({
          preheader: 'Uhlu lwakho lumiswe okwesikhashana',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [`"${s(v, 'listingTitle')}" imiswe okwesikhashana futhi ayisabonakali kubaqashi:`, s(v, 'feedback')],
          cta: { label: 'Xhumana nosizo', path: '/contact' },
        }),
      },
    },
  },

  // ---------------- IDENTITY VERIFICATION ----------------
  {
    id: 'verification-submitted-user',
    version: '1',
    event: 'verification.submitted',
    requiredVars: ['userName'],
    subject: () => 'Your identity verification was submitted',
    build: (v) => ({
      preheader: 'We received your verification submission',
      greeting: `Hi ${s(v, 'userName')},`,
      bodyParagraphs: [
        'Your identity verification has been submitted and is being reviewed by a Unity administrator (manual test verification).',
        "We'll email you as soon as a decision is made.",
      ],
      cta: { label: 'Check your status', path: '/verify' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: () => 'Jou identiteitsverifikasie is ingedien',
        build: (v) => ({
          preheader: 'Ons het jou verifikasie-indiening ontvang',
          greeting: `Hallo ${s(v, 'userName')},`,
          bodyParagraphs: [
            'Jou identiteitsverifikasie is ingedien en word tans hersien deur \'n Unity-administrateur (handmatige toetsverifikasie).',
            'Ons sal jou e-pos stuur sodra \'n besluit geneem is.',
          ],
          cta: { label: 'Gaan jou status na', path: '/verify' },
        }),
      },
      'zu-ZA': {
        subject: () => 'Ukuqinisekiswa kobunikazi bakho kuthunyelwe',
        build: (v) => ({
          preheader: 'Sitholé ukuthunyelwa kwakho kokuqinisekiswa',
          greeting: `Sawubona ${s(v, 'userName')},`,
          bodyParagraphs: [
            'Ukuqinisekiswa kobunikazi bakho kuthunyelwe futhi kubuyekezwa umlawuli we-Unity (ukuqinisekiswa kokuhlola okwenziwa ngesandla).',
            'Sizokuthumelela i-imeyili uma isinqumo sesenziwe.',
          ],
          cta: { label: 'Hlola isimo sakho', path: '/verify' },
        }),
      },
    },
  },
  {
    id: 'verification-info-requested-user',
    version: '1',
    event: 'verification.additional_information_requested',
    requiredVars: ['userName', 'feedback'],
    subject: () => 'More information needed for your verification',
    build: (v) => ({
      preheader: 'A Unity administrator needs more information from you',
      greeting: `Hi ${s(v, 'userName')},`,
      bodyParagraphs: [`A Unity administrator reviewed your verification and needs more information:`, s(v, 'feedback')],
      cta: { label: 'Update your submission', path: '/verify' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: () => 'Meer inligting benodig vir jou verifikasie',
        build: (v) => ({
          preheader: "'n Unity-administrateur benodig meer inligting van jou",
          greeting: `Hallo ${s(v, 'userName')},`,
          bodyParagraphs: [`'n Unity-administrateur het jou verifikasie hersien en benodig meer inligting:`, s(v, 'feedback')],
          cta: { label: 'Werk jou indiening by', path: '/verify' },
        }),
      },
      'zu-ZA': {
        subject: () => 'Kudingeka olunye ulwazi lokuqinisekiswa kwakho',
        build: (v) => ({
          preheader: 'Umlawuli we-Unity udinga olunye ulwazi kuwe',
          greeting: `Sawubona ${s(v, 'userName')},`,
          bodyParagraphs: [`Umlawuli we-Unity ubuyekeze ukuqinisekiswa kwakho futhi udinga olunye ulwazi:`, s(v, 'feedback')],
          cta: { label: 'Buyekeza okuthunyelwe kwakho', path: '/verify' },
        }),
      },
    },
  },
  {
    id: 'verification-approved-user',
    version: '1',
    event: 'verification.approved',
    requiredVars: ['userName'],
    subject: () => 'Your identity has been verified',
    build: (v) => ({
      preheader: 'Your identity verification was approved',
      greeting: `Hi ${s(v, 'userName')},`,
      bodyParagraphs: [
        'Your identity verification has been approved. You can now book items and list your own on Unity.',
        '"Approved" means the stated Unity review was completed based on the evidence you submitted.',
      ],
      cta: { label: 'Go to Unity', path: '/' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: () => 'Jou identiteit is geverifieer',
        build: (v) => ({
          preheader: 'Jou identiteitsverifikasie is goedgekeur',
          greeting: `Hallo ${s(v, 'userName')},`,
          bodyParagraphs: [
            'Jou identiteitsverifikasie is goedgekeur. Jy kan nou items bespreek en jou eie op Unity lys.',
            '"Goedgekeur" beteken die gestelde Unity-hersiening is voltooi op grond van die bewyse wat jy ingedien het.',
          ],
          cta: { label: 'Gaan na Unity', path: '/' },
        }),
      },
      'zu-ZA': {
        subject: () => 'Ubunikazi bakho buqinisekisiwe',
        build: (v) => ({
          preheader: 'Ukuqinisekiswa kobunikazi bakho kuvunyiwe',
          greeting: `Sawubona ${s(v, 'userName')},`,
          bodyParagraphs: [
            'Ukuqinisekiswa kobunikazi bakho kuvunyiwe. Manje ungabhukha izinto futhi ufake ezakho ohlwini ku-Unity.',
            '"Kuvunyiwe" kusho ukuthi ukubuyekezwa okushiwo kwe-Unity kuqediwe ngokususela ebufakazini obuwuthumele.',
          ],
          cta: { label: 'Iya ku-Unity', path: '/' },
        }),
      },
    },
  },
  {
    id: 'verification-rejected-user',
    version: '1',
    event: 'verification.rejected',
    requiredVars: ['userName', 'feedback'],
    subject: () => 'Your identity verification was not approved',
    build: (v) => ({
      preheader: 'Your identity verification was not approved',
      greeting: `Hi ${s(v, 'userName')},`,
      bodyParagraphs: [`Your identity verification was reviewed and not approved:`, s(v, 'feedback')],
      cta: { label: 'Resubmit your verification', path: '/verify' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: () => 'Jou identiteitsverifikasie is nie goedgekeur nie',
        build: (v) => ({
          preheader: 'Jou identiteitsverifikasie is nie goedgekeur nie',
          greeting: `Hallo ${s(v, 'userName')},`,
          bodyParagraphs: [`Jou identiteitsverifikasie is hersien en nie goedgekeur nie:`, s(v, 'feedback')],
          cta: { label: 'Dien jou verifikasie weer in', path: '/verify' },
        }),
      },
      'zu-ZA': {
        subject: () => 'Ukuqinisekiswa kobunikazi bakho akuvunyiwe',
        build: (v) => ({
          preheader: 'Ukuqinisekiswa kobunikazi bakho akuvunyiwe',
          greeting: `Sawubona ${s(v, 'userName')},`,
          bodyParagraphs: [`Ukuqinisekiswa kobunikazi bakho kubuyekeziwe futhi akuvunyiwe:`, s(v, 'feedback')],
          cta: { label: 'Thumela futhi ukuqinisekiswa kwakho', path: '/verify' },
        }),
      },
    },
  },

  // ---------------- BOOKINGS ----------------
  {
    id: 'booking-requested-renter',
    version: '1',
    event: 'booking.requested',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Your booking request for "${s(v, 'listingTitle')}" was sent`,
    build: (v) => ({
      preheader: 'Your booking request was sent to the merchant',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your request to book "${s(v, 'listingTitle')}" has been sent. The merchant needs to accept it before it's confirmed.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/renter/bookings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou besprekingsversoek vir "${s(v, 'listingTitle')}" is gestuur`,
        build: (v) => ({
          preheader: 'Jou besprekingsversoek is aan die handelaar gestuur',
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`Jou versoek om "${s(v, 'listingTitle')}" te bespreek, is gestuur. Die handelaar moet dit aanvaar voordat dit bevestig is.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bekyk jou besprekings', path: '/dashboard/renter/bookings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Isicelo sakho sokubhukha se-"${s(v, 'listingTitle')}" sithunyelwe`,
        build: (v) => ({
          preheader: 'Isicelo sakho sokubhukha sithunyelwe kumthengisi',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Isicelo sakho sokubhukha "${s(v, 'listingTitle')}" sithunyelwe. Umthengisi kudingeka asamukele ngaphambi kokuba siqinisekiswe.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buka ukubhukha kwakho', path: '/dashboard/renter/bookings' },
        }),
      },
    },
  },
  {
    id: 'booking-request-received-merchant',
    version: '1',
    event: 'booking.requested',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference', 'renterName'],
    subject: (v) => `New booking request for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'You have a new booking request',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`${s(v, 'renterName')} requested to book "${s(v, 'listingTitle')}". Accept or decline the request.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'Review request', path: '/dashboard/merchant/bookings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Nuwe besprekingsversoek vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jy het ’n nuwe besprekingsversoek',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [`${s(v, 'renterName')} het versoek om "${s(v, 'listingTitle')}" te bespreek. Aanvaar of weier die versoek.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Hersien versoek', path: '/dashboard/merchant/bookings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Isicelo esisha sokubhukha se-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Unesicelo esisha sokubhukha',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [`U-${s(v, 'renterName')} ucele ukubhukha "${s(v, 'listingTitle')}". Yamukela noma wenqabe isicelo.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buyekeza isicelo', path: '/dashboard/merchant/bookings' },
        }),
      },
    },
  },
  {
    id: 'booking-rejected-renter',
    version: '1',
    event: 'booking.rejected',
    requiredVars: ['renterName', 'listingTitle'],
    subject: (v) => `Your booking request for "${s(v, 'listingTitle')}" was declined`,
    build: (v) => ({
      preheader: 'Your booking request was declined',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your request to book "${s(v, 'listingTitle')}" was declined by the merchant.`],
      cta: { label: 'Browse other listings', path: '/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou besprekingsversoek vir "${s(v, 'listingTitle')}" is geweier`,
        build: (v) => ({
          preheader: 'Jou besprekingsversoek is geweier',
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`Jou versoek om "${s(v, 'listingTitle')}" te bespreek, is deur die handelaar geweier.`],
          cta: { label: 'Blaai deur ander noterings', path: '/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Isicelo sakho sokubhukha se-"${s(v, 'listingTitle')}" senqatshiwe`,
        build: (v) => ({
          preheader: 'Isicelo sakho sokubhukha senqatshiwe',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Isicelo sakho sokubhukha "${s(v, 'listingTitle')}" senqatshiwe umthengisi.`],
          cta: { label: 'Phequlula ezinye izinhlu', path: '/listings' },
        }),
      },
    },
  },
  {
    id: 'booking-cancelled-renter',
    version: '1',
    event: 'booking.cancelled',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Booking cancelled: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A booking has been cancelled',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your booking for "${s(v, 'listingTitle')}" has been cancelled.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/renter/bookings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Bespreking gekanselleer: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: "'n Bespreking is gekanselleer",
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`Jou bespreking vir "${s(v, 'listingTitle')}" is gekanselleer.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bekyk jou besprekings', path: '/dashboard/renter/bookings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukubhukha kukhanselwe: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ukubhukha kukhanselwe',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Ukubhukha kwakho kwe-"${s(v, 'listingTitle')}" kukhanselwe.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buka ukubhukha kwakho', path: '/dashboard/renter/bookings' },
        }),
      },
    },
  },
  {
    id: 'booking-cancelled-merchant',
    version: '1',
    event: 'booking.cancelled',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Booking cancelled: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A booking has been cancelled',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`A booking for "${s(v, 'listingTitle')}" has been cancelled. The dates are available again.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/merchant/bookings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Bespreking gekanselleer: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: "'n Bespreking is gekanselleer",
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [`'n Bespreking vir "${s(v, 'listingTitle')}" is gekanselleer. Die datums is weer beskikbaar.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bekyk jou besprekings', path: '/dashboard/merchant/bookings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukubhukha kukhanselwe: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ukubhukha kukhanselwe',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Ukubhukha kwe-"${s(v, 'listingTitle')}" kukhanselwe. Izinsuku ziyatholakala futhi.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buka ukubhukha kwakho', path: '/dashboard/merchant/bookings' },
        }),
      },
    },
  },
  {
    id: 'booking-expired-unanswered-renter',
    version: '1',
    event: 'booking.expired_unanswered',
    requiredVars: ['renterName', 'listingTitle'],
    subject: (v) => `Your booking request for "${s(v, 'listingTitle')}" expired`,
    build: (v) => ({
      preheader: 'Your booking request went unanswered and has expired',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your request to book "${s(v, 'listingTitle')}" went unanswered and has expired. You're welcome to try requesting again.`],
      cta: { label: 'Browse listings', path: '/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou besprekingsversoek vir "${s(v, 'listingTitle')}" het verval`,
        build: (v) => ({
          preheader: 'Jou besprekingsversoek is nie beantwoord nie en het verval',
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`Jou versoek om "${s(v, 'listingTitle')}" te bespreek, is nie beantwoord nie en het verval. Jy is welkom om weer te probeer.`],
          cta: { label: 'Blaai deur noterings', path: '/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Isicelo sakho sokubhukha se-"${s(v, 'listingTitle')}" siphelelwe yisikhathi`,
        build: (v) => ({
          preheader: 'Isicelo sakho sokubhukha asiphendulwanga futhi siphelelwe yisikhathi',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Isicelo sakho sokubhukha "${s(v, 'listingTitle')}" asiphendulwanga futhi siphelelwe yisikhathi. Wamukelekile ukuzama futhi.`],
          cta: { label: 'Phequlula izinhlu', path: '/listings' },
        }),
      },
    },
  },
  {
    id: 'booking-payment-required-renter',
    version: '1',
    event: 'booking.payment_required',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference', 'paymentDueAt', 'totalAmount'],
    subject: (v) => `Payment required for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Complete payment to secure your booking',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your booking for "${s(v, 'listingTitle')}" is accepted. Complete payment by the deadline below or the booking will expire.`],
      summary: {
        title: 'Payment due',
        rows: [
          { label: 'Reference', value: s(v, 'bookingReference') },
          { label: 'Total', value: s(v, 'totalAmount') },
          { label: 'Deadline', value: s(v, 'paymentDueAt') },
        ],
      },
      cta: { label: 'Complete checkout', path: '/dashboard/renter/bookings' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Betaling vereis vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Voltooi betaling om jou bespreking te verseker',
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`Jou bespreking vir "${s(v, 'listingTitle')}" is aanvaar. Voltooi betaling voor die sperdatum hieronder, anders sal die bespreking verval.`],
          summary: {
            title: 'Betaling verskuldig',
            rows: [
              { label: 'Verwysing', value: s(v, 'bookingReference') },
              { label: 'Totaal', value: s(v, 'totalAmount') },
              { label: 'Sperdatum', value: s(v, 'paymentDueAt') },
            ],
          },
          cta: { label: 'Voltooi uitbetaling', path: '/dashboard/renter/bookings' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkokhelo iyadingeka ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Qedela inkokhelo ukuze uqinisekise ukubhukha kwakho',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Ukubhukha kwakho kwe-"${s(v, 'listingTitle')}" kwamukelwe. Qedela inkokhelo ngaphambi komnqamulajuqu ongezansi noma ukubhukha kuzophelelwa yisikhathi.`],
          summary: {
            title: 'Inkokhelo Ekhokhwayo',
            rows: [
              { label: 'Inkomba', value: s(v, 'bookingReference') },
              { label: 'Isamba', value: s(v, 'totalAmount') },
              { label: 'Umnqamulajuqu', value: s(v, 'paymentDueAt') },
            ],
          },
          cta: { label: 'Qedela ukukhokha', path: '/dashboard/renter/bookings' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'booking-payment-reminder-renter',
    version: '1',
    event: 'booking.payment_reminder',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference', 'paymentDueAt'],
    subject: (v) => `Reminder: payment due soon for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your payment deadline is approaching',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`This is a reminder that payment for "${s(v, 'listingTitle')}" is due soon. Complete checkout before the deadline or the booking will expire.`],
      summary: {
        title: 'Payment due',
        rows: [
          { label: 'Reference', value: s(v, 'bookingReference') },
          { label: 'Deadline', value: s(v, 'paymentDueAt') },
        ],
      },
      cta: { label: 'Complete checkout', path: '/dashboard/renter/bookings' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Herinnering: betaling binnekort verskuldig vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou betalingsperdatum nader',
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`Dit is 'n herinnering dat betaling vir "${s(v, 'listingTitle')}" binnekort verskuldig is. Voltooi uitbetaling voor die sperdatum, anders sal die bespreking verval.`],
          summary: {
            title: 'Betaling verskuldig',
            rows: [
              { label: 'Verwysing', value: s(v, 'bookingReference') },
              { label: 'Sperdatum', value: s(v, 'paymentDueAt') },
            ],
          },
          cta: { label: 'Voltooi uitbetaling', path: '/dashboard/renter/bookings' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Isikhumbuzo: inkokhelo iyadingeka maduzane ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Umnqamulajuqu wenkokhelo yakho uyasondela',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Lesi yisikhumbuzo sokuthi inkokhelo ye-"${s(v, 'listingTitle')}" iyadingeka maduzane. Qedela ukukhokha ngaphambi komnqamulajuqu noma ukubhukha kuzophelelwa yisikhathi.`],
          summary: {
            title: 'Inkokhelo Ekhokhwayo',
            rows: [
              { label: 'Inkomba', value: s(v, 'bookingReference') },
              { label: 'Umnqamulajuqu', value: s(v, 'paymentDueAt') },
            ],
          },
          cta: { label: 'Qedela ukukhokha', path: '/dashboard/renter/bookings' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'booking-payment-expired-renter',
    version: '1',
    event: 'booking.payment_expired',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Booking expired: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your booking expired because payment was not completed in time',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your booking for "${s(v, 'listingTitle')}" expired because payment was not completed before the deadline. If you still want to rent this item, please make a new booking request.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'Browse listings', path: '/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Bespreking het verval: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou bespreking het verval omdat betaling nie betyds voltooi is nie',
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`Jou bespreking vir "${s(v, 'listingTitle')}" het verval omdat betaling nie voor die sperdatum voltooi is nie. Indien jy steeds hierdie item wil huur, maak asseblief 'n nuwe besprekingsversoek.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Blaai deur noterings', path: '/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukubhukha kuphelelwe yisikhathi: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ukubhukha kwakho kuphelelwe yisikhathi ngoba inkokhelo ayiqedwanga ngesikhathi',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Ukubhukha kwakho kwe-"${s(v, 'listingTitle')}" kuphelelwe yisikhathi ngoba inkokhelo ayiqedwanga ngaphambi komnqamulajuqu. Uma usafuna ukuqasha le nto, sicela wenze isicelo esisha sokubhukha.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Phequlula izinhlu', path: '/listings' },
        }),
      },
    },
  },
  {
    id: 'booking-payment-expired-merchant',
    version: '1',
    event: 'booking.payment_expired',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Booking expired unpaid: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A booking expired because the renter did not pay in time',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`A booking for "${s(v, 'listingTitle')}" expired because the renter did not complete payment in time. The dates are available again.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your listings', path: '/dashboard/merchant/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Bespreking onbetaald verval: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: "'n Bespreking het verval omdat die huurder nie betyds betaal het nie",
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [`'n Bespreking vir "${s(v, 'listingTitle')}" het verval omdat die huurder nie betyds betaal het nie. Die datums is weer beskikbaar.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bekyk jou noterings', path: '/dashboard/merchant/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukubhukha okungakhokhelwanga kuphelelwe yisikhathi: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ukubhukha kuphelelwe yisikhathi ngoba umqashi akakhokhanga ngesikhathi',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Ukubhukha kwe-"${s(v, 'listingTitle')}" kuphelelwe yisikhathi ngoba umqashi akaqedanga inkokhelo ngesikhathi. Izinsuku ziyatholakala futhi.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buka izinhlu zakho', path: '/dashboard/merchant/listings' },
        }),
      },
    },
  },
  {
    id: 'booking-financially-ready-renter',
    version: '1',
    event: 'booking.financially_ready',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `You're all set for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Payment complete — your booking is ready',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Payment for "${s(v, 'listingTitle')}" is complete. Your booking is financially ready — coordinate handover with the merchant when your rental period begins.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/renter/bookings' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jy is gereed vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Betaling voltooi — jou bespreking is gereed',
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`Betaling vir "${s(v, 'listingTitle')}" is voltooi. Jou bespreking is finansieel gereed — koördineer oorhandiging met die handelaar wanneer jou huurtydperk begin.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bekyk jou besprekings', path: '/dashboard/renter/bookings' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Usulungele i-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Inkokhelo iqediwe — ukubhukha kwakho sekulungile',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Inkokhelo ye-"${s(v, 'listingTitle')}" iqediwe. Ukubhukha kwakho sekulungele kwezezimali — hlela ukudluliselwa kwento nomthengisi lapho isikhathi sakho sokuqasha siqala.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buka ukubhukha kwakho', path: '/dashboard/renter/bookings' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'booking-financially-ready-merchant',
    version: '1',
    event: 'booking.financially_ready',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Payment received for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'The renter has completed payment',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`The renter's payment for "${s(v, 'listingTitle')}" is complete. Coordinate handover when the rental period begins.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/merchant/bookings' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Betaling ontvang vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Die huurder het betaling voltooi',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Die huurder se betaling vir "${s(v, 'listingTitle')}" is voltooi. Koördineer oorhandiging wanneer die huurtydperk begin.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bekyk jou besprekings', path: '/dashboard/merchant/bookings' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkokhelo itholiwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Umqashi uqedile ukukhokha',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Inkokhelo yomqashi ye-"${s(v, 'listingTitle')}" iqediwe. Hlela ukudluliselwa kwento lapho isikhathi sokuqasha siqala.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buka ukubhukha kwakho', path: '/dashboard/merchant/bookings' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'booking-started-renter',
    version: '1',
    event: 'booking.started',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Your rental has started: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your rental period has begun',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your rental of "${s(v, 'listingTitle')}" has started. Enjoy — and remember to return it in the condition you received it.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/renter/bookings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou huur het begin: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou huurtydperk het begin',
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`Jou huur van "${s(v, 'listingTitle')}" het begin. Geniet dit — en onthou om dit terug te gee in die toestand waarin jy dit ontvang het.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bekyk jou besprekings', path: '/dashboard/renter/bookings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukuqasha kwakho kuqalile: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Isikhathi sakho sokuqasha sesiqalile',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Ukuqasha kwakho "${s(v, 'listingTitle')}" kuqalile. Jabulela — futhi khumbula ukuyibuyisela esimweni owayithola kuso.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buka ukubhukha kwakho', path: '/dashboard/renter/bookings' },
        }),
      },
    },
  },
  {
    id: 'booking-started-merchant',
    version: '1',
    event: 'booking.started',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Rental started: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'The rental period has begun',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`The rental of "${s(v, 'listingTitle')}" has started.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/merchant/bookings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Huur het begin: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Die huurtydperk het begin',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Die huur van "${s(v, 'listingTitle')}" het begin.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bekyk jou besprekings', path: '/dashboard/merchant/bookings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukuqasha kuqalile: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Isikhathi sokuqasha sesiqalile',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Ukuqasha kwe-"${s(v, 'listingTitle')}" kuqalile.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buka ukubhukha kwakho', path: '/dashboard/merchant/bookings' },
        }),
      },
    },
  },
  {
    id: 'booking-return-initiated-notify',
    version: '1',
    event: 'booking.return_initiated',
    requiredVars: ['recipientName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Return initiated for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A return has been initiated on your booking',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`A return has been initiated for "${s(v, 'listingTitle')}". Please confirm once you've verified the item.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'Confirm return', path: '/dashboard/renter/bookings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Teruggawe begin vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: "'n Teruggawe is op jou bespreking begin",
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`'n Teruggawe is begin vir "${s(v, 'listingTitle')}". Bevestig asseblief sodra jy die item geverifieer het.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bevestig teruggawe', path: '/dashboard/renter/bookings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukubuyiselwa kuqalisiwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ukubuyiselwa kuqalisiwe ekubhukheni kwakho',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ukubuyiselwa kuqalisiwe ye-"${s(v, 'listingTitle')}". Sicela uqinisekise uma usuyihlolile into.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Qinisekisa ukubuyiselwa', path: '/dashboard/renter/bookings' },
        }),
      },
    },
  },
  {
    id: 'booking-completed-renter',
    version: '1',
    event: 'booking.completed',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Booking completed: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your rental is complete — return confirmed',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your rental of "${s(v, 'listingTitle')}" is complete — the return has been confirmed. Thanks for renting with Unity!`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'Leave a review', path: '/dashboard/renter/bookings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Bespreking voltooi: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou huur is voltooi — teruggawe bevestig',
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`Jou huur van "${s(v, 'listingTitle')}" is voltooi — die teruggawe is bevestig. Dankie dat jy by Unity gehuur het!`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Laat ’n resensie', path: '/dashboard/renter/bookings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukubhukha kuqediwe: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ukuqasha kwakho kuqediwe — ukubuyiselwa kuqinisekisiwe',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Ukuqasha kwakho "${s(v, 'listingTitle')}" kuqediwe — ukubuyiselwa kuqinisekisiwe. Siyabonga ngokuqasha ku-Unity!`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Shiya ukubuyekeza', path: '/dashboard/renter/bookings' },
        }),
      },
    },
  },
  {
    id: 'booking-completed-merchant',
    version: '1',
    event: 'booking.completed',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Booking completed: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'The rental is complete — return confirmed',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`The rental of "${s(v, 'listingTitle')}" is complete — the return has been confirmed.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/merchant/bookings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Bespreking voltooi: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Die huur is voltooi — teruggawe bevestig',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Die huur van "${s(v, 'listingTitle')}" is voltooi — die teruggawe is bevestig.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bekyk jou besprekings', path: '/dashboard/merchant/bookings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukubhukha kuqediwe: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ukuqasha kuqediwe — ukubuyiselwa kuqinisekisiwe',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Ukuqasha kwe-"${s(v, 'listingTitle')}" kuqediwe — ukubuyiselwa kuqinisekisiwe.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buka ukubhukha kwakho', path: '/dashboard/merchant/bookings' },
        }),
      },
    },
  },

  // ---------------- PAYMENT / TEST MODE ----------------
  {
    id: 'payment-declined-renter',
    version: '1',
    event: 'payment.declined',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Payment declined for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your payment was declined',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your payment for "${s(v, 'listingTitle')}" was declined and cannot be retried on this booking. Please contact the merchant or make a new booking request.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/renter/bookings' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Betaling geweier vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou betaling is geweier',
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`Jou betaling vir "${s(v, 'listingTitle')}" is geweier en kan nie op hierdie bespreking herprobeer word nie. Kontak asseblief die handelaar of maak 'n nuwe besprekingsversoek.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bekyk jou besprekings', path: '/dashboard/renter/bookings' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkokhelo inqatshiwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Inkokhelo yakho inqatshiwe',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Inkokhelo yakho ye-"${s(v, 'listingTitle')}" inqatshiwe futhi ayikwazi ukuzanywa futhi kulokhu kubhukha. Sicela uxhumane nomthengisi noma wenze isicelo esisha sokubhukha.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buka ukubhukha kwakho', path: '/dashboard/renter/bookings' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'payment-retryable-failure-renter',
    version: '1',
    event: 'payment.retryable_failure',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Payment issue for "${s(v, 'listingTitle')}" — please retry`,
    build: (v) => ({
      preheader: 'A temporary issue stopped your payment',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`A temporary issue stopped your payment for "${s(v, 'listingTitle')}". Please try again before the payment deadline.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'Retry payment', path: '/dashboard/renter/bookings' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Betalingskwessie vir "${s(v, 'listingTitle')}" — probeer asseblief weer`,
        build: (v) => ({
          preheader: "'n Tydelike kwessie het jou betaling gestop",
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`'n Tydelike kwessie het jou betaling vir "${s(v, 'listingTitle')}" gestop. Probeer asseblief weer voor die betalingsperdatum.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Probeer betaling weer', path: '/dashboard/renter/bookings' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkinga yenkokhelo ye-"${s(v, 'listingTitle')}" — sicela uzame futhi`,
        build: (v) => ({
          preheader: 'Inkinga yesikhashana imise inkokhelo yakho',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Inkinga yesikhashana imise inkokhelo yakho ye-"${s(v, 'listingTitle')}". Sicela uzame futhi ngaphambi komnqamulajuqu wenkokhelo.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Zama inkokhelo futhi', path: '/dashboard/renter/bookings' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'deposit-failed-renter',
    version: '1',
    event: 'deposit.failed',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Deposit issue for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your rental payment succeeded but the deposit did not',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your rental payment for "${s(v, 'listingTitle')}" succeeded, but the deposit authorization was declined and cannot be retried on this booking. Please contact the merchant or make a new booking request.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/renter/bookings' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Depositokwessie vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou huurbetaling het geslaag, maar die deposito nie',
          greeting: `Hallo ${s(v, 'renterName')},`,
          bodyParagraphs: [`Jou huurbetaling vir "${s(v, 'listingTitle')}" het geslaag, maar die depositomagtiging is geweier en kan nie op hierdie bespreking herprobeer word nie. Kontak asseblief die handelaar of maak 'n nuwe besprekingsversoek.`],
          summary: { title: 'Bespreking', rows: [{ label: 'Verwysing', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bekyk jou besprekings', path: '/dashboard/renter/bookings' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkinga yediphozithi ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Inkokhelo yakho yokuqasha iphumelele kodwa idiphozithi ayiphumelelanga',
          greeting: `Sawubona ${s(v, 'renterName')},`,
          bodyParagraphs: [`Inkokhelo yakho yokuqasha ye-"${s(v, 'listingTitle')}" iphumelele, kodwa imvume yediphozithi inqatshiwe futhi ayikwazi ukuzanywa futhi kulokhu kubhukha. Sicela uxhumane nomthengisi noma wenze isicelo esisha sokubhukha.`],
          summary: { title: 'Ukubhukha', rows: [{ label: 'Inkomba', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buka ukubhukha kwakho', path: '/dashboard/renter/bookings' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'dispute-opened-raiser',
    version: '1',
    event: 'dispute.opened',
    requiredVars: ['raiserName', 'title', 'transactionReference'],
    subject: (v) => `Your dispute "${s(v, 'title')}" has been opened`,
    build: (v) => ({
      preheader: 'Your dispute has been submitted',
      greeting: `Hi ${s(v, 'raiserName')},`,
      bodyParagraphs: [`Your dispute "${s(v, 'title')}" regarding ${s(v, 'transactionReference')} has been opened. An admin will review it shortly.`],
      cta: { label: 'View your dispute', path: '/dashboard/disputes' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou geskil "${s(v, 'title')}" is geopen`,
        build: (v) => ({
          preheader: 'Jou geskil is ingedien',
          greeting: `Hallo ${s(v, 'raiserName')},`,
          bodyParagraphs: [`Jou geskil "${s(v, 'title')}" rakende ${s(v, 'transactionReference')} is geopen. 'n Administrateur sal dit binnekort hersien.`],
          cta: { label: 'Bekyk jou geskil', path: '/dashboard/disputes' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukuphikisana kwakho "${s(v, 'title')}" kuvuliwe`,
        build: (v) => ({
          preheader: 'Ukuphikisana kwakho kuthunyelwe',
          greeting: `Sawubona ${s(v, 'raiserName')},`,
          bodyParagraphs: [`Ukuphikisana kwakho "${s(v, 'title')}" mayelana ne-${s(v, 'transactionReference')} kuvuliwe. Umlawuli uzokubuyekeza maduzane.`],
          cta: { label: 'Buka ukuphikisana kwakho', path: '/dashboard/disputes' },
        }),
      },
    },
  },
  {
    id: 'dispute-opened-respondent',
    version: '1',
    event: 'dispute.opened',
    requiredVars: ['respondentName', 'raiserName', 'title', 'transactionReference'],
    subject: (v) => `A dispute has been opened regarding ${s(v, 'transactionReference')}`,
    build: (v) => ({
      preheader: 'A dispute has been opened against a transaction you are party to',
      greeting: `Hi ${s(v, 'respondentName')},`,
      bodyParagraphs: [`${s(v, 'raiserName')} has opened a dispute ("${s(v, 'title')}") regarding ${s(v, 'transactionReference')}. An admin will review it shortly.`],
      cta: { label: 'View the dispute', path: '/dashboard/disputes' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `'n Geskil is geopen rakende ${s(v, 'transactionReference')}`,
        build: (v) => ({
          preheader: "'n Geskil is teen 'n transaksie geopen waarby jy betrokke is",
          greeting: `Hallo ${s(v, 'respondentName')},`,
          bodyParagraphs: [`${s(v, 'raiserName')} het 'n geskil geopen ("${s(v, 'title')}") rakende ${s(v, 'transactionReference')}. 'n Administrateur sal dit binnekort hersien.`],
          cta: { label: 'Bekyk die geskil', path: '/dashboard/disputes' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukuphikisana kuvuliwe mayelana ne-${s(v, 'transactionReference')}`,
        build: (v) => ({
          preheader: 'Ukuphikisana kuvulwe kwitransaksi oyingxenye yayo',
          greeting: `Sawubona ${s(v, 'respondentName')},`,
          bodyParagraphs: [`U-${s(v, 'raiserName')} uvule ukuphikisana ("${s(v, 'title')}") mayelana ne-${s(v, 'transactionReference')}. Umlawuli uzokubuyekeza maduzane.`],
          cta: { label: 'Buka ukuphikisana', path: '/dashboard/disputes' },
        }),
      },
    },
  },
  {
    id: 'dispute-evidence-requested',
    version: '1',
    event: 'dispute.evidence_requested',
    requiredVars: ['recipientName', 'title'],
    subject: (v) => `Evidence requested for your dispute "${s(v, 'title')}"`,
    build: (v) => ({
      preheader: 'An admin has requested more evidence',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `An admin has requested more evidence for the dispute "${s(v, 'title')}".`,
        v.note ? `Note from the admin: ${s(v, 'note')}` : '',
      ].filter(Boolean),
      cta: { label: 'Upload evidence', path: '/dashboard/disputes' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Bewys versoek vir jou geskil "${s(v, 'title')}"`,
        build: (v) => ({
          preheader: "'n Administrateur het meer bewys versoek",
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `'n Administrateur het meer bewys versoek vir die geskil "${s(v, 'title')}".`,
            v.note ? `Nota van die administrateur: ${s(v, 'note')}` : '',
          ].filter(Boolean),
          cta: { label: 'Laai bewys op', path: '/dashboard/disputes' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Kudingeka ubufakazi ekuphikisaneni kwakho "${s(v, 'title')}"`,
        build: (v) => ({
          preheader: 'Umlawuli ucele obunye ubufakazi',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Umlawuli ucele obunye ubufakazi bokuphikisana "${s(v, 'title')}".`,
            v.note ? `Inothi elivela kumlawuli: ${s(v, 'note')}` : '',
          ].filter(Boolean),
          cta: { label: 'Layisha ubufakazi', path: '/dashboard/disputes' },
        }),
      },
    },
  },
  {
    id: 'dispute-evidence-received',
    version: '1',
    event: 'dispute.evidence_received',
    requiredVars: ['recipientName', 'title'],
    subject: (v) => `New evidence was added to dispute "${s(v, 'title')}"`,
    build: (v) => ({
      preheader: 'New evidence was added to your dispute',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`New evidence was added to the dispute "${s(v, 'title')}".`],
      cta: { label: 'View the dispute', path: '/dashboard/disputes' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Nuwe bewys is by geskil "${s(v, 'title')}" gevoeg`,
        build: (v) => ({
          preheader: 'Nuwe bewys is by jou geskil gevoeg',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Nuwe bewys is by die geskil "${s(v, 'title')}" gevoeg.`],
          cta: { label: 'Bekyk die geskil', path: '/dashboard/disputes' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ubufakazi obusha bengezwe ekuphikisaneni "${s(v, 'title')}"`,
        build: (v) => ({
          preheader: 'Ubufakazi obusha bungezwe ekuphikisaneni kwakho',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ubufakazi obusha bengezwe ekuphikisaneni "${s(v, 'title')}".`],
          cta: { label: 'Buka ukuphikisana', path: '/dashboard/disputes' },
        }),
      },
    },
  },
  {
    id: 'dispute-under-review',
    version: '1',
    event: 'dispute.under_review',
    requiredVars: ['recipientName', 'title'],
    subject: (v) => `Your dispute "${s(v, 'title')}" is now under review`,
    build: (v) => ({
      preheader: 'An admin is now reviewing your dispute',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your dispute "${s(v, 'title')}" is now under review by an admin.`],
      cta: { label: 'View the dispute', path: '/dashboard/disputes' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou geskil "${s(v, 'title')}" word nou hersien`,
        build: (v) => ({
          preheader: "'n Administrateur hersien nou jou geskil",
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou geskil "${s(v, 'title')}" word nou deur 'n administrateur hersien.`],
          cta: { label: 'Bekyk die geskil', path: '/dashboard/disputes' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukuphikisana kwakho "${s(v, 'title')}" manje kuyabuyekezwa`,
        build: (v) => ({
          preheader: 'Umlawuli manje ubuyekeza ukuphikisana kwakho',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ukuphikisana kwakho "${s(v, 'title')}" manje kubuyekezwa umlawuli.`],
          cta: { label: 'Buka ukuphikisana', path: '/dashboard/disputes' },
        }),
      },
    },
  },
  {
    id: 'dispute-resolved',
    version: '1',
    event: 'dispute.resolved',
    requiredVars: ['recipientName', 'title', 'outcomeLabel'],
    subject: (v) => `Your dispute "${s(v, 'title')}" has been resolved`,
    build: (v) => ({
      preheader: 'Your dispute has been resolved',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your dispute "${s(v, 'title')}" has been resolved. Outcome: ${s(v, 'outcomeLabel')}.`],
      cta: { label: 'View the dispute', path: '/dashboard/disputes' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou geskil "${s(v, 'title')}" is opgelos`,
        build: (v) => ({
          preheader: 'Jou geskil is opgelos',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou geskil "${s(v, 'title')}" is opgelos. Uitkoms: ${s(v, 'outcomeLabel')}.`],
          cta: { label: 'Bekyk die geskil', path: '/dashboard/disputes' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukuphikisana kwakho "${s(v, 'title')}" kuxazululiwe`,
        build: (v) => ({
          preheader: 'Ukuphikisana kwakho kuxazululiwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ukuphikisana kwakho "${s(v, 'title')}" kuxazululiwe. Umphumela: ${s(v, 'outcomeLabel')}.`],
          cta: { label: 'Buka ukuphikisana', path: '/dashboard/disputes' },
        }),
      },
    },
  },
  {
    id: 'dispute-closed',
    version: '1',
    event: 'dispute.closed',
    requiredVars: ['recipientName', 'title'],
    subject: (v) => `Your dispute "${s(v, 'title')}" has been closed`,
    build: (v) => ({
      preheader: 'Your dispute has been closed',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`The dispute "${s(v, 'title')}" has now been closed.`],
      cta: { label: 'View the dispute', path: '/dashboard/disputes' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou geskil "${s(v, 'title')}" is gesluit`,
        build: (v) => ({
          preheader: 'Jou geskil is gesluit',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Die geskil "${s(v, 'title')}" is nou gesluit.`],
          cta: { label: 'Bekyk die geskil', path: '/dashboard/disputes' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukuphikisana kwakho "${s(v, 'title')}" kuvaliwe`,
        build: (v) => ({
          preheader: 'Ukuphikisana kwakho kuvaliwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ukuphikisana "${s(v, 'title')}" manje sekuvaliwe.`],
          cta: { label: 'Buka ukuphikisana', path: '/dashboard/disputes' },
        }),
      },
    },
  },
  {
    id: 'dispute-cancelled',
    version: '1',
    event: 'dispute.cancelled',
    requiredVars: ['recipientName', 'title'],
    subject: (v) => `Your dispute "${s(v, 'title')}" has been cancelled`,
    build: (v) => ({
      preheader: 'Your dispute has been cancelled',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `The dispute "${s(v, 'title')}" has been cancelled by an admin.`,
        v.cancellation_reason ? `Reason: ${s(v, 'cancellation_reason')}` : '',
      ].filter(Boolean),
      cta: { label: 'View the dispute', path: '/dashboard/disputes' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou geskil "${s(v, 'title')}" is gekanselleer`,
        build: (v) => ({
          preheader: 'Jou geskil is gekanselleer',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Die geskil "${s(v, 'title')}" is deur 'n administrateur gekanselleer.`,
            v.cancellation_reason ? `Rede: ${s(v, 'cancellation_reason')}` : '',
          ].filter(Boolean),
          cta: { label: 'Bekyk die geskil', path: '/dashboard/disputes' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukuphikisana kwakho "${s(v, 'title')}" kukhanseliwe`,
        build: (v) => ({
          preheader: 'Ukuphikisana kwakho kukhanseliwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Ukuphikisana "${s(v, 'title')}" kukhanselwe umqondisi.`,
            v.cancellation_reason ? `Isizathu: ${s(v, 'cancellation_reason')}` : '',
          ].filter(Boolean),
          cta: { label: 'Buka ukuphikisana', path: '/dashboard/disputes' },
        }),
      },
    },
  },
  // ---------------- BARTER (Step 11 Phase 4) ----------------
  {
    id: 'barter-accepted',
    version: '1',
    event: 'barter.accepted',
    requiredVars: ['recipientName', 'agreementReference', 'listingTitle'],
    subject: (v) => `Your trade for "${s(v, 'listingTitle')}" has been accepted`,
    build: (v) => ({
      preheader: 'Your barter trade has been accepted',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your trade ${s(v, 'agreementReference')} for "${s(v, 'listingTitle')}" has been accepted. If a deposit or cash adjustment is required, complete it to move the trade forward.`],
      cta: { label: 'View your trade', path: '/dashboard/barter' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou ruiltransaksie vir "${s(v, 'listingTitle')}" is aanvaar`,
        build: (v) => ({
          preheader: 'Jou ruiltransaksie is aanvaar',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou ruiltransaksie ${s(v, 'agreementReference')} vir "${s(v, 'listingTitle')}" is aanvaar. Indien 'n deposito of kontantaanpassing vereis word, voltooi dit om die ruiltransaksie te laat voortgaan.`],
          cta: { label: 'Bekyk jou ruiltransaksie', path: '/dashboard/barter' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukushintshanisa kwakho kwe-"${s(v, 'listingTitle')}" kwamukelwe`,
        build: (v) => ({
          preheader: 'Ukushintshanisa kwakho kwamukelwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ukushintshanisa kwakho ${s(v, 'agreementReference')} kwe-"${s(v, 'listingTitle')}" kwamukelwe. Uma kudingeka idiphozithi noma ukulungiswa kwemali, kuqedele ukuze ukushintshanisa kuqhubeke.`],
          cta: { label: 'Buka ukushintshanisa kwakho', path: '/dashboard/barter' },
        }),
      },
    },
  },
  {
    id: 'barter-deposit-required',
    version: '1',
    event: 'barter.deposit_required',
    requiredVars: ['recipientName', 'agreementReference', 'listingTitle'],
    subject: (v) => `A deposit is required for your trade ${s(v, 'agreementReference')}`,
    build: (v) => ({
      preheader: 'A deposit is required to move your trade forward',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`A deposit is required from you before your trade ${s(v, 'agreementReference')} for "${s(v, 'listingTitle')}" can proceed.`],
      cta: { label: 'Pay your deposit', path: '/dashboard/barter' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `'n Deposito word vereis vir jou ruiltransaksie ${s(v, 'agreementReference')}`,
        build: (v) => ({
          preheader: "'n Deposito word vereis om jou ruiltransaksie te laat voortgaan",
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`'n Deposito word van jou vereis voordat jou ruiltransaksie ${s(v, 'agreementReference')} vir "${s(v, 'listingTitle')}" kan voortgaan.`],
          cta: { label: 'Betaal jou deposito', path: '/dashboard/barter' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Idiphozithi iyadingeka koku shintshanisa kwakho ${s(v, 'agreementReference')}`,
        build: (v) => ({
          preheader: 'Idiphozithi iyadingeka ukuze ukushintshanisa kwakho kuqhubeke',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Idiphozithi iyadingeka kuwe ngaphambi kokuthi ukushintshanisa kwakho ${s(v, 'agreementReference')} kwe-"${s(v, 'listingTitle')}" kuqhubeke.`],
          cta: { label: 'Khokha idiphozithi yakho', path: '/dashboard/barter' },
        }),
      },
    },
  },
  {
    id: 'barter-ready-to-exchange',
    version: '1',
    event: 'barter.ready_to_exchange',
    requiredVars: ['recipientName', 'agreementReference', 'listingTitle'],
    subject: (v) => `Your trade ${s(v, 'agreementReference')} is ready to proceed`,
    build: (v) => ({
      preheader: 'All required payments are complete',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`All required payments for your trade ${s(v, 'agreementReference')} ("${s(v, 'listingTitle')}") are complete. You can now proceed with the exchange.`],
      cta: { label: 'View your trade', path: '/dashboard/barter' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou ruiltransaksie ${s(v, 'agreementReference')} is gereed om voort te gaan`,
        build: (v) => ({
          preheader: 'Alle vereiste betalings is voltooi',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Alle vereiste betalings vir jou ruiltransaksie ${s(v, 'agreementReference')} ("${s(v, 'listingTitle')}") is voltooi. Jy kan nou met die ruil voortgaan.`],
          cta: { label: 'Bekyk jou ruiltransaksie', path: '/dashboard/barter' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukushintshanisa kwakho ${s(v, 'agreementReference')} sekulungele ukuqhubeka`,
        build: (v) => ({
          preheader: 'Zonke izinkokhelo ezidingekayo ziqediwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Zonke izinkokhelo ezidingekayo zoku shintshanisa kwakho ${s(v, 'agreementReference')} ("${s(v, 'listingTitle')}") ziqediwe. Manje ungaqhubeka nokushintshana.`],
          cta: { label: 'Buka ukushintshanisa kwakho', path: '/dashboard/barter' },
        }),
      },
    },
  },
  {
    id: 'barter-completion-requested',
    version: '1',
    event: 'barter.completion_requested',
    requiredVars: ['recipientName', 'agreementReference', 'listingTitle'],
    subject: (v) => `Please confirm your trade ${s(v, 'agreementReference')} is complete`,
    build: (v) => ({
      preheader: 'The other party has confirmed the exchange is complete',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`The other party has confirmed the exchange for trade ${s(v, 'agreementReference')} ("${s(v, 'listingTitle')}") is complete. Please confirm on your side too to finish the trade.`],
      cta: { label: 'Confirm completion', path: '/dashboard/barter' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Bevestig asseblief dat jou ruiltransaksie ${s(v, 'agreementReference')} voltooi is`,
        build: (v) => ({
          preheader: 'Die ander party het bevestig dat die ruil voltooi is',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Die ander party het bevestig dat die ruil vir ruiltransaksie ${s(v, 'agreementReference')} ("${s(v, 'listingTitle')}") voltooi is. Bevestig asseblief ook aan jou kant om die ruiltransaksie af te handel.`],
          cta: { label: 'Bevestig voltooiing', path: '/dashboard/barter' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Sicela uqinisekise ukuthi ukushintshanisa kwakho ${s(v, 'agreementReference')} kuqediwe`,
        build: (v) => ({
          preheader: 'Elinye iqembu seliqinisekisile ukuthi ukushintshana kuqediwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Elinye iqembu seliqinisekisile ukuthi ukushintshana kokushintshanisa ${s(v, 'agreementReference')} ("${s(v, 'listingTitle')}") kuqediwe. Sicela uqinisekise nakwakho ukuze uqedele ukushintshanisa.`],
          cta: { label: 'Qinisekisa ukuqedwa', path: '/dashboard/barter' },
        }),
      },
    },
  },
  {
    id: 'barter-completed',
    version: '1',
    event: 'barter.completed',
    requiredVars: ['recipientName', 'agreementReference', 'listingTitle'],
    subject: (v) => `Your trade ${s(v, 'agreementReference')} is complete`,
    build: (v) => ({
      preheader: 'Your barter trade is complete',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your trade ${s(v, 'agreementReference')} for "${s(v, 'listingTitle')}" is now complete. Any deposits have been released.`],
      cta: { label: 'View your trade', path: '/dashboard/barter' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou ruiltransaksie ${s(v, 'agreementReference')} is voltooi`,
        build: (v) => ({
          preheader: 'Jou ruiltransaksie is voltooi',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou ruiltransaksie ${s(v, 'agreementReference')} vir "${s(v, 'listingTitle')}" is nou voltooi. Enige deposito's is vrygestel.`],
          cta: { label: 'Bekyk jou ruiltransaksie', path: '/dashboard/barter' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukushintshanisa kwakho ${s(v, 'agreementReference')} kuqediwe`,
        build: (v) => ({
          preheader: 'Ukushintshanisa kwakho kuqediwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ukushintshanisa kwakho ${s(v, 'agreementReference')} kwe-"${s(v, 'listingTitle')}" manje sekuqediwe. Noma yiziphi idiphozithi zikhishiwe.`],
          cta: { label: 'Buka ukushintshanisa kwakho', path: '/dashboard/barter' },
        }),
      },
    },
  },
  {
    id: 'barter-cancelled',
    version: '1',
    event: 'barter.cancelled',
    requiredVars: ['recipientName', 'agreementReference', 'listingTitle'],
    subject: (v) => `Your trade ${s(v, 'agreementReference')} has been cancelled`,
    build: (v) => ({
      preheader: 'Your barter trade has been cancelled',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `Your trade ${s(v, 'agreementReference')} for "${s(v, 'listingTitle')}" has been cancelled.`,
        v.cancellation_reason ? `Reason: ${s(v, 'cancellation_reason')}` : '',
      ].filter(Boolean),
      cta: { label: 'View your trades', path: '/dashboard/barter' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou ruiltransaksie ${s(v, 'agreementReference')} is gekanselleer`,
        build: (v) => ({
          preheader: 'Jou ruiltransaksie is gekanselleer',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Jou ruiltransaksie ${s(v, 'agreementReference')} vir "${s(v, 'listingTitle')}" is gekanselleer.`,
            v.cancellation_reason ? `Rede: ${s(v, 'cancellation_reason')}` : '',
          ].filter(Boolean),
          cta: { label: 'Bekyk jou ruiltransaksies', path: '/dashboard/barter' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukushintshanisa kwakho ${s(v, 'agreementReference')} kukhanseliwe`,
        build: (v) => ({
          preheader: 'Ukushintshanisa kwakho kukhanseliwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Ukushintshanisa kwakho ${s(v, 'agreementReference')} kwe-"${s(v, 'listingTitle')}" kukhanseliwe.`,
            v.cancellation_reason ? `Isizathu: ${s(v, 'cancellation_reason')}` : '',
          ].filter(Boolean),
          cta: { label: 'Buka ukushintshanisa kwakho', path: '/dashboard/barter' },
        }),
      },
    },
  },
  // ---------------- ORDERS (Step 11 Phase 6) ----------------
  {
    id: 'order-created-buyer',
    version: '1',
    event: 'order.created',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Your order for "${s(v, 'listingTitle')}" was placed`,
    build: (v) => ({
      preheader: 'Complete payment to secure your order',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your order for "${s(v, 'listingTitle')}" has been placed. Complete payment to secure it.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'Pay now', path: '/dashboard/orders' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou bestelling vir "${s(v, 'listingTitle')}" is geplaas`,
        build: (v) => ({
          preheader: 'Voltooi betaling om jou bestelling te verseker',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou bestelling vir "${s(v, 'listingTitle')}" is geplaas. Voltooi betaling om dit te verseker.`],
          summary: { title: 'Bestelling', rows: [{ label: 'Verwysing', value: s(v, 'orderReference') }] },
          cta: { label: 'Betaal nou', path: '/dashboard/orders' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `I-oda lakho le-"${s(v, 'listingTitle')}" lifakiwe`,
        build: (v) => ({
          preheader: 'Qedela inkokhelo ukuze uqinisekise i-oda lakho',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`I-oda lakho le-"${s(v, 'listingTitle')}" lifakiwe. Qedela inkokhelo ukuze uliqinisekise.`],
          summary: { title: 'I-oda', rows: [{ label: 'Inkomba', value: s(v, 'orderReference') }] },
          cta: { label: 'Khokha manje', path: '/dashboard/orders' },
        }),
      },
    },
  },
  {
    id: 'order-received-seller',
    version: '1',
    event: 'order.created',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `New order for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'You have a new order awaiting payment',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`A buyer has ordered "${s(v, 'listingTitle')}". We'll notify you once payment is complete.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'View your orders', path: '/dashboard/merchant/orders' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Nuwe bestelling vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jy het \'n nuwe bestelling wat op betaling wag',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`'n Koper het "${s(v, 'listingTitle')}" bestel. Ons sal jou in kennis stel sodra betaling voltooi is.`],
          summary: { title: 'Bestelling', rows: [{ label: 'Verwysing', value: s(v, 'orderReference') }] },
          cta: { label: 'Bekyk jou bestellings', path: '/dashboard/merchant/orders' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `I-oda elisha le-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Unesibonelo esisha esilinde inkokhelo',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Umthengi uodile i-"${s(v, 'listingTitle')}". Sizokwazisa lapho inkokhelo isiqediwe.`],
          summary: { title: 'I-oda', rows: [{ label: 'Inkomba', value: s(v, 'orderReference') }] },
          cta: { label: 'Buka ama-oda akho', path: '/dashboard/merchant/orders' },
        }),
      },
    },
  },
  {
    id: 'order-payment-received-buyer',
    version: '1',
    event: 'order.payment_received',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Payment received for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your payment is complete',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your payment for "${s(v, 'listingTitle')}" is complete. The seller will prepare your order for shipment.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'View your orders', path: '/dashboard/orders' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Betaling ontvang vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou betaling is voltooi',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou betaling vir "${s(v, 'listingTitle')}" is voltooi. Die verkoper sal jou bestelling vir verskeping voorberei.`],
          summary: { title: 'Bestelling', rows: [{ label: 'Verwysing', value: s(v, 'orderReference') }] },
          cta: { label: 'Bekyk jou bestellings', path: '/dashboard/orders' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkokhelo itholiwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Inkokhelo yakho iqediwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Inkokhelo yakho ye-"${s(v, 'listingTitle')}" iqediwe. Umthengisi uzolungiselela i-oda lakho ukuze lithunyelwe.`],
          summary: { title: 'I-oda', rows: [{ label: 'Inkomba', value: s(v, 'orderReference') }] },
          cta: { label: 'Buka ama-oda akho', path: '/dashboard/orders' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'order-payment-received-seller',
    version: '1',
    event: 'order.payment_received',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Payment received for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'The buyer has completed payment',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`The buyer's payment for "${s(v, 'listingTitle')}" is complete. Please prepare the item for shipment.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'View your orders', path: '/dashboard/merchant/orders' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Betaling ontvang vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Die koper het betaling voltooi',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Die koper se betaling vir "${s(v, 'listingTitle')}" is voltooi. Berei asseblief die item vir verskeping voor.`],
          summary: { title: 'Bestelling', rows: [{ label: 'Verwysing', value: s(v, 'orderReference') }] },
          cta: { label: 'Bekyk jou bestellings', path: '/dashboard/merchant/orders' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkokhelo itholiwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Umthengi useqedile ukukhokha',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Inkokhelo yomthengi ye-"${s(v, 'listingTitle')}" iqediwe. Sicela ulungiselele into ukuze ithunyelwe.`],
          summary: { title: 'I-oda', rows: [{ label: 'Inkomba', value: s(v, 'orderReference') }] },
          cta: { label: 'Buka ama-oda akho', path: '/dashboard/merchant/orders' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'order-shipped-buyer',
    version: '1',
    event: 'order.shipped',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Your order "${s(v, 'listingTitle')}" has shipped`,
    build: (v) => ({
      preheader: 'Your order is on its way',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`"${s(v, 'listingTitle')}" has been marked as shipped. Confirm delivery once you receive it.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'View your orders', path: '/dashboard/orders' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou bestelling "${s(v, 'listingTitle')}" is verskeep`,
        build: (v) => ({
          preheader: 'Jou bestelling is op pad',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`"${s(v, 'listingTitle')}" is as verskeep gemerk. Bevestig aflewering sodra jy dit ontvang.`],
          summary: { title: 'Bestelling', rows: [{ label: 'Verwysing', value: s(v, 'orderReference') }] },
          cta: { label: 'Bekyk jou bestellings', path: '/dashboard/orders' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `I-oda lakho le-"${s(v, 'listingTitle')}" selithunyelwe`,
        build: (v) => ({
          preheader: 'I-oda lakho lisendleleni',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`I-"${s(v, 'listingTitle')}" iphawulwe njengethunyelwe. Qinisekisa ukulethwa uma usuyitholile.`],
          summary: { title: 'I-oda', rows: [{ label: 'Inkomba', value: s(v, 'orderReference') }] },
          cta: { label: 'Buka ama-oda akho', path: '/dashboard/orders' },
        }),
      },
    },
  },
  {
    id: 'order-delivered-buyer',
    version: '1',
    event: 'order.delivered',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Order complete: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your order is complete — delivery confirmed',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your order for "${s(v, 'listingTitle')}" is complete — delivery has been confirmed. Thanks for buying on Unity!`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'Leave a review', path: '/dashboard/orders' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Bestelling voltooi: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou bestelling is voltooi — aflewering bevestig',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou bestelling vir "${s(v, 'listingTitle')}" is voltooi — aflewering is bevestig. Dankie dat jy by Unity gekoop het!`],
          summary: { title: 'Bestelling', rows: [{ label: 'Verwysing', value: s(v, 'orderReference') }] },
          cta: { label: 'Laat \'n resensie', path: '/dashboard/orders' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `I-oda liqediwe: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'I-oda lakho liqediwe — ukulethwa kuqinisekisiwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`I-oda lakho le-"${s(v, 'listingTitle')}" liqediwe — ukulethwa kuqinisekisiwe. Siyabonga ngokuthenga ku-Unity!`],
          summary: { title: 'I-oda', rows: [{ label: 'Inkomba', value: s(v, 'orderReference') }] },
          cta: { label: 'Shiya ukubuyekeza', path: '/dashboard/orders' },
        }),
      },
    },
  },
  {
    id: 'order-delivered-seller',
    version: '1',
    event: 'order.delivered',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Order complete: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'The order is complete — delivery confirmed',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`The order for "${s(v, 'listingTitle')}" is complete — the buyer confirmed delivery.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'View your orders', path: '/dashboard/merchant/orders' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Bestelling voltooi: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Die bestelling is voltooi — aflewering bevestig',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Die bestelling vir "${s(v, 'listingTitle')}" is voltooi — die koper het aflewering bevestig.`],
          summary: { title: 'Bestelling', rows: [{ label: 'Verwysing', value: s(v, 'orderReference') }] },
          cta: { label: 'Bekyk jou bestellings', path: '/dashboard/merchant/orders' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `I-oda liqediwe: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'I-oda liqediwe — ukulethwa kuqinisekisiwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`I-oda le-"${s(v, 'listingTitle')}" liqediwe — umthengi uqinisekise ukulethwa.`],
          summary: { title: 'I-oda', rows: [{ label: 'Inkomba', value: s(v, 'orderReference') }] },
          cta: { label: 'Buka ama-oda akho', path: '/dashboard/merchant/orders' },
        }),
      },
    },
  },
  {
    id: 'order-cancelled-buyer',
    version: '1',
    event: 'order.cancelled',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Order cancelled: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your order has been cancelled',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `Your order for "${s(v, 'listingTitle')}" has been cancelled.`,
        v.cancellation_reason ? `Reason: ${s(v, 'cancellation_reason')}` : '',
      ].filter(Boolean),
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'Browse listings', path: '/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Bestelling gekanselleer: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou bestelling is gekanselleer',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Jou bestelling vir "${s(v, 'listingTitle')}" is gekanselleer.`,
            v.cancellation_reason ? `Rede: ${s(v, 'cancellation_reason')}` : '',
          ].filter(Boolean),
          summary: { title: 'Bestelling', rows: [{ label: 'Verwysing', value: s(v, 'orderReference') }] },
          cta: { label: 'Blaai deur inskrywings', path: '/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `I-oda likhanseliwe: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'I-oda lakho likhanseliwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `I-oda lakho le-"${s(v, 'listingTitle')}" likhanseliwe.`,
            v.cancellation_reason ? `Isizathu: ${s(v, 'cancellation_reason')}` : '',
          ].filter(Boolean),
          summary: { title: 'I-oda', rows: [{ label: 'Inkomba', value: s(v, 'orderReference') }] },
          cta: { label: 'Phequlula izinto ezifakiwe', path: '/listings' },
        }),
      },
    },
  },
  {
    id: 'order-cancelled-seller',
    version: '1',
    event: 'order.cancelled',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Order cancelled: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'An order has been cancelled',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `The order for "${s(v, 'listingTitle')}" has been cancelled. The stock is available again.`,
        v.cancellation_reason ? `Reason: ${s(v, 'cancellation_reason')}` : '',
      ].filter(Boolean),
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'View your listings', path: '/dashboard/merchant/listings' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Bestelling gekanselleer: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: '\'n Bestelling is gekanselleer',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Die bestelling vir "${s(v, 'listingTitle')}" is gekanselleer. Die voorraad is weer beskikbaar.`,
            v.cancellation_reason ? `Rede: ${s(v, 'cancellation_reason')}` : '',
          ].filter(Boolean),
          summary: { title: 'Bestelling', rows: [{ label: 'Verwysing', value: s(v, 'orderReference') }] },
          cta: { label: 'Bekyk jou inskrywings', path: '/dashboard/merchant/listings' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `I-oda likhanseliwe: "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'I-oda likhanseliwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `I-oda le-"${s(v, 'listingTitle')}" likhanseliwe. Impahla iyatholakala futhi.`,
            v.cancellation_reason ? `Isizathu: ${s(v, 'cancellation_reason')}` : '',
          ].filter(Boolean),
          summary: { title: 'I-oda', rows: [{ label: 'Inkomba', value: s(v, 'orderReference') }] },
          cta: { label: 'Buka izinto zakho ezifakiwe', path: '/dashboard/merchant/listings' },
        }),
      },
    },
  },
  {
    id: 'order-payment-failed-buyer',
    version: '2',
    event: 'order.payment_failed',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    // Deliberately not "your payment failed" -- a timeout or a
    // retryable provider error may yet resolve on its own, and this
    // template is shared across all of provider_declined/
    // terminal_provider_error/retryable_provider_error/provider_timeout
    // (see docs/ORDER_ADMINISTRATION.md). "We couldn't complete your
    // payment" is accurate for every one of those cases without implying
    // a definitive, final decline.
    subject: (v) => `We couldn't complete your payment for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: "We couldn't complete your payment",
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`We couldn't complete your payment for "${s(v, 'listingTitle')}". You can try checking out again from your orders page.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'Retry payment', path: '/dashboard/orders' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Ons kon nie jou betaling vir "${s(v, 'listingTitle')}" voltooi nie`,
        build: (v) => ({
          preheader: 'Ons kon nie jou betaling voltooi nie',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ons kon nie jou betaling vir "${s(v, 'listingTitle')}" voltooi nie. Jy kan probeer om weer af te reken vanaf jou bestellings-bladsy.`],
          summary: { title: 'Bestelling', rows: [{ label: 'Verwysing', value: s(v, 'orderReference') }] },
          cta: { label: 'Probeer betaling weer', path: '/dashboard/orders' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Asikwazanga ukuqedela inkokhelo yakho ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Asikwazanga ukuqedela inkokhelo yakho',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Asikwazanga ukuqedela inkokhelo yakho ye-"${s(v, 'listingTitle')}". Ungazama ukukhokha futhi kusukela ekhasini lama-oda akho.`],
          summary: { title: 'I-oda', rows: [{ label: 'Inkomba', value: s(v, 'orderReference') }] },
          cta: { label: 'Zama futhi ukukhokha', path: '/dashboard/orders' },
          testModeNotice: true,
        }),
      },
    },
  },
  // ---------------- AFFILIATES (Step 11 Phase 7) ----------------
  {
    id: 'affiliate-enrolled',
    version: '1',
    event: 'affiliate.enrolled',
    requiredVars: ['recipientName', 'affiliateCode'],
    subject: () => `You're now a Unity affiliate`,
    build: (v) => ({
      preheader: 'Your affiliate code is ready',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `You're now enrolled as a Unity affiliate. Your code is ${s(v, 'affiliateCode')}.`,
        `You can generate a share link for any listing that has affiliates enabled from your affiliate dashboard. Commission is only earned on listings the merchant has specifically enabled — never on barter trades.`,
      ],
      cta: { label: 'Go to your affiliate dashboard', path: '/dashboard/affiliate' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: () => `Jy is nou 'n Unity-geaffilieerde`,
        build: (v) => ({
          preheader: 'Jou geaffilieerde kode is gereed',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Jy is nou ingeskryf as 'n Unity-geaffilieerde. Jou kode is ${s(v, 'affiliateCode')}.`,
            `Jy kan 'n deelskakel genereer vir enige inskrywing waarvoor geaffilieerdes geaktiveer is, vanaf jou geaffilieerde-paneelbord. Kommissie word slegs verdien op inskrywings wat die handelaar spesifiek geaktiveer het — nooit op ruiltransaksies nie.`,
          ],
          cta: { label: 'Gaan na jou geaffilieerde-paneelbord', path: '/dashboard/affiliate' },
        }),
      },
      'zu-ZA': {
        subject: () => `Manje usungumhlobo we-Unity`,
        build: (v) => ({
          preheader: 'Ikhodi yakho yomhlobo isilungile',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Manje usubhalisiwe njengomhlobo we-Unity. Ikhodi yakho ngu-${s(v, 'affiliateCode')}.`,
            `Ungakhiqiza isixhumanisi sokwabelana kunoma yisiphi isinto esifakiwe esinabahlobo abavuliwe kusuka ebhodini lakho lomhlobo. Ikhomishini itholakala kuphela ezintweni umthengisi aye wazivula ngokukhethekile — hhayi neze ekushintshaneni.`,
          ],
          cta: { label: 'Yiya ebhodini lakho lomhlobo', path: '/dashboard/affiliate' },
        }),
      },
    },
  },
  {
    id: 'affiliate-commission-approved',
    version: '1',
    event: 'affiliate.commission_approved',
    requiredVars: ['recipientName', 'listingTitle', 'commissionAmount', 'transactionReference'],
    subject: (v) => `Commission approved for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your commission has been approved',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your ${s(v, 'commissionAmount')} commission for "${s(v, 'listingTitle')}" has been approved and will be queued for payout.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }, { label: 'Amount', value: s(v, 'commissionAmount') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Kommissie goedgekeur vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou kommissie is goedgekeur',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou ${s(v, 'commissionAmount')} kommissie vir "${s(v, 'listingTitle')}" is goedgekeur en sal vir uitbetaling in die wagtou geplaas word.`],
          summary: { title: 'Kommissie', rows: [{ label: 'Verwysing', value: s(v, 'transactionReference') }, { label: 'Bedrag', value: s(v, 'commissionAmount') }] },
          cta: { label: 'Bekyk jou kommissies', path: '/dashboard/affiliate' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ikhomishini igunyaziwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ikhomishini yakho igunyaziwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ikhomishini yakho ye-${s(v, 'commissionAmount')} ye-"${s(v, 'listingTitle')}" igunyaziwe futhi izobekwa emgqeni wokukhokhwa.`],
          summary: { title: 'Ikhomishini', rows: [{ label: 'Inkomba', value: s(v, 'transactionReference') }, { label: 'Inani', value: s(v, 'commissionAmount') }] },
          cta: { label: 'Buka amakhomishini akho', path: '/dashboard/affiliate' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'affiliate-commission-held',
    version: '1',
    event: 'affiliate.commission_held',
    requiredVars: ['recipientName', 'listingTitle', 'commissionAmount', 'transactionReference'],
    subject: (v) => `Commission on hold for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A commission has been placed on hold for review',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your ${s(v, 'commissionAmount')} commission for "${s(v, 'listingTitle')}" has been placed on hold pending review. We'll email you once it's resolved.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Kommissie in gehou vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: "'n Kommissie is in gehou vir hersiening",
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou ${s(v, 'commissionAmount')} kommissie vir "${s(v, 'listingTitle')}" is in gehou hangende hersiening. Ons sal jou e-pos sodra dit opgelos is.`],
          summary: { title: 'Kommissie', rows: [{ label: 'Verwysing', value: s(v, 'transactionReference') }] },
          cta: { label: 'Bekyk jou kommissies', path: '/dashboard/affiliate' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ikhomishini imisiwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ikhomishini imisiwe ilinde ukubuyekezwa',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ikhomishini yakho ye-${s(v, 'commissionAmount')} ye-"${s(v, 'listingTitle')}" imisiwe ilinde ukubuyekezwa. Sizokuthumelela i-imeyili uma sekuxazululiwe.`],
          summary: { title: 'Ikhomishini', rows: [{ label: 'Inkomba', value: s(v, 'transactionReference') }] },
          cta: { label: 'Buka amakhomishini akho', path: '/dashboard/affiliate' },
        }),
      },
    },
  },
  {
    id: 'affiliate-payout-queued',
    version: '1',
    event: 'affiliate.payout_queued',
    requiredVars: ['recipientName', 'listingTitle', 'commissionAmount', 'transactionReference'],
    subject: (v) => `Payout queued for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your payout has been queued',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your ${s(v, 'commissionAmount')} commission for "${s(v, 'listingTitle')}" has been queued for payout.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Uitbetaling in die wagtou vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou uitbetaling is in die wagtou geplaas',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou ${s(v, 'commissionAmount')} kommissie vir "${s(v, 'listingTitle')}" is vir uitbetaling in die wagtou geplaas.`],
          summary: { title: 'Kommissie', rows: [{ label: 'Verwysing', value: s(v, 'transactionReference') }] },
          cta: { label: 'Bekyk jou kommissies', path: '/dashboard/affiliate' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkokhelo isohlwini lokulinda ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Inkokhelo yakho ibekwe ohlwini lokulinda',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ikhomishini yakho ye-${s(v, 'commissionAmount')} ye-"${s(v, 'listingTitle')}" ibekwe ohlwini lokulinda ukukhokhwa.`],
          summary: { title: 'Ikhomishini', rows: [{ label: 'Inkomba', value: s(v, 'transactionReference') }] },
          cta: { label: 'Buka amakhomishini akho', path: '/dashboard/affiliate' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'affiliate-commission-paid',
    version: '1',
    event: 'affiliate.commission_paid',
    requiredVars: ['recipientName', 'listingTitle', 'commissionAmount', 'transactionReference'],
    subject: (v) => `Commission paid for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your commission has been paid',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your ${s(v, 'commissionAmount')} commission for "${s(v, 'listingTitle')}" has been paid.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Kommissie betaal vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Jou kommissie is betaal',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou ${s(v, 'commissionAmount')} kommissie vir "${s(v, 'listingTitle')}" is betaal.`],
          summary: { title: 'Kommissie', rows: [{ label: 'Verwysing', value: s(v, 'transactionReference') }] },
          cta: { label: 'Bekyk jou kommissies', path: '/dashboard/affiliate' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ikhomishini ikhokhiwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ikhomishini yakho ikhokhiwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ikhomishini yakho ye-${s(v, 'commissionAmount')} ye-"${s(v, 'listingTitle')}" ikhokhiwe.`],
          summary: { title: 'Ikhomishini', rows: [{ label: 'Inkomba', value: s(v, 'transactionReference') }] },
          cta: { label: 'Buka amakhomishini akho', path: '/dashboard/affiliate' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'affiliate-payout-failed',
    version: '1',
    event: 'affiliate.payout_failed',
    requiredVars: ['recipientName', 'listingTitle', 'commissionAmount', 'transactionReference'],
    subject: (v) => `We couldn't process your payout for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: "We couldn't process your payout",
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`We couldn't process your ${s(v, 'commissionAmount')} payout for "${s(v, 'listingTitle')}". Our team will review and retry — no action is needed from you.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Ons kon nie jou uitbetaling vir "${s(v, 'listingTitle')}" verwerk nie`,
        build: (v) => ({
          preheader: 'Ons kon nie jou uitbetaling verwerk nie',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ons kon nie jou ${s(v, 'commissionAmount')} uitbetaling vir "${s(v, 'listingTitle')}" verwerk nie. Ons span sal dit hersien en weer probeer — geen aksie word van jou vereis nie.`],
          summary: { title: 'Kommissie', rows: [{ label: 'Verwysing', value: s(v, 'transactionReference') }] },
          cta: { label: 'Bekyk jou kommissies', path: '/dashboard/affiliate' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Asikwazanga ukucubungula inkokhelo yakho ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Asikwazanga ukucubungula inkokhelo yakho',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Asikwazanga ukucubungula inkokhelo yakho ye-${s(v, 'commissionAmount')} ye-"${s(v, 'listingTitle')}". Ithimba lethu lizobuyekeza futhi lizame futhi — akudingeki isenzo kuwe.`],
          summary: { title: 'Ikhomishini', rows: [{ label: 'Inkomba', value: s(v, 'transactionReference') }] },
          cta: { label: 'Buka amakhomishini akho', path: '/dashboard/affiliate' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'affiliate-commission-voided',
    version: '1',
    event: 'affiliate.commission_voided',
    requiredVars: ['recipientName', 'listingTitle', 'transactionReference', 'voidReason'],
    subject: (v) => `Commission voided for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A commission has been voided',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your commission for "${s(v, 'listingTitle')}" has been voided. Reason: ${s(v, 'voidReason')}.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Kommissie tersyde gestel vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: "'n Kommissie is tersyde gestel",
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou kommissie vir "${s(v, 'listingTitle')}" is tersyde gestel. Rede: ${s(v, 'voidReason')}.`],
          summary: { title: 'Kommissie', rows: [{ label: 'Verwysing', value: s(v, 'transactionReference') }] },
          cta: { label: 'Bekyk jou kommissies', path: '/dashboard/affiliate' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ikhomishini icishiwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ikhomishini icishiwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ikhomishini yakho ye-"${s(v, 'listingTitle')}" icishiwe. Isizathu: ${s(v, 'voidReason')}.`],
          summary: { title: 'Ikhomishini', rows: [{ label: 'Inkomba', value: s(v, 'transactionReference') }] },
          cta: { label: 'Buka amakhomishini akho', path: '/dashboard/affiliate' },
        }),
      },
    },
  },
  {
    id: 'affiliate-adjustment-created',
    version: '1',
    event: 'affiliate.adjustment_created',
    requiredVars: ['recipientName', 'listingTitle', 'transactionReference', 'adjustmentAmount'],
    subject: (v) => `An adjustment was recorded for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'An adjustment was recorded on your commission',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`An adjustment of ${s(v, 'adjustmentAmount')} was recorded against your commission for "${s(v, 'listingTitle')}".`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `'n Aanpassing is aangeteken vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: "'n Aanpassing is op jou kommissie aangeteken",
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`'n Aanpassing van ${s(v, 'adjustmentAmount')} is teen jou kommissie vir "${s(v, 'listingTitle')}" aangeteken.`],
          summary: { title: 'Kommissie', rows: [{ label: 'Verwysing', value: s(v, 'transactionReference') }] },
          cta: { label: 'Bekyk jou kommissies', path: '/dashboard/affiliate' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ukulungiswa kubhaliwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ukulungiswa kubhaliwe kwikhomishini yakho',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ukulungiswa kwe-${s(v, 'adjustmentAmount')} kubhaliwe kwikhomishini yakho ye-"${s(v, 'listingTitle')}".`],
          summary: { title: 'Ikhomishini', rows: [{ label: 'Inkomba', value: s(v, 'transactionReference') }] },
          cta: { label: 'Buka amakhomishini akho', path: '/dashboard/affiliate' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'merchant-affiliate-enabled',
    version: '1',
    event: 'merchant.affiliate_enabled',
    requiredVars: ['recipientName', 'listingTitle'],
    subject: (v) => `Affiliates enabled for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Affiliate promotion is now enabled for your listing',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `Affiliate promotion is now enabled for "${s(v, 'listingTitle')}". Affiliates can now generate a share link and earn commission on completed eligible sales or rental payments — never on deposits, refunds, or barter trades.`,
      ],
      cta: { label: 'Manage affiliate settings', path: '/dashboard/merchant/affiliates' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Geaffilieerdes geaktiveer vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Geaffilieerde-promosie is nou geaktiveer vir jou inskrywing',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Geaffilieerde-promosie is nou geaktiveer vir "${s(v, 'listingTitle')}". Geaffilieerdes kan nou 'n deelskakel genereer en kommissie verdien op voltooide, kwalifiserende verkope of huurbetalings — nooit op deposito's, terugbetalings of ruiltransaksies nie.`,
          ],
          cta: { label: 'Bestuur geaffilieerde-instellings', path: '/dashboard/merchant/affiliates' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Abahlobo bavuliwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ukukhuthazwa kwabahlobo manje sekuvuliwe esintweni sakho esifakiwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Ukukhuthazwa kwabahlobo manje sekuvuliwe kwe-"${s(v, 'listingTitle')}". Abahlobo manje bangakhiqiza isixhumanisi sokwabelana futhi bathole ikhomishini ekuthengisweni okuqediwe okufanelekile noma izinkokhelo zokuqasha — hhayi neze kumadiphozithi, izimbuyiselo, noma ukushintshana.`,
          ],
          cta: { label: 'Phatha izilungiselelo zabahlobo', path: '/dashboard/merchant/affiliates' },
        }),
      },
    },
  },
  {
    id: 'merchant-affiliate-disabled',
    version: '1',
    event: 'merchant.affiliate_disabled',
    requiredVars: ['recipientName', 'listingTitle'],
    subject: (v) => `Affiliates disabled for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Affiliate promotion is now disabled for your listing',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `Affiliate promotion is now disabled for "${s(v, 'listingTitle')}". No new affiliate referrals will be accepted for this listing. Commissions already earned before this change are unaffected and continue as normal.`,
      ],
      cta: { label: 'Manage affiliate settings', path: '/dashboard/merchant/affiliates' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Geaffilieerdes gedeaktiveer vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Geaffilieerde-promosie is nou gedeaktiveer vir jou inskrywing',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Geaffilieerde-promosie is nou gedeaktiveer vir "${s(v, 'listingTitle')}". Geen nuwe geaffilieerde-verwysings sal vir hierdie inskrywing aanvaar word nie. Kommissies wat reeds voor hierdie verandering verdien is, word nie geraak nie en gaan normaalweg voort.`,
          ],
          cta: { label: 'Bestuur geaffilieerde-instellings', path: '/dashboard/merchant/affiliates' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Abahlobo bavaliwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Ukukhuthazwa kwabahlobo manje sekuvaliwe esintweni sakho esifakiwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Ukukhuthazwa kwabahlobo manje sekuvaliwe kwe-"${s(v, 'listingTitle')}". Akukho ukudluliselwa kwabahlobo abasha okuzokwamukelwa kulesi sinto esifakiwe. Amakhomishini asevele atholiwe ngaphambi kwalolu shintsho awathinteki futhi aqhubeka njengokujwayelekile.`,
          ],
          cta: { label: 'Phatha izilungiselelo zabahlobo', path: '/dashboard/merchant/affiliates' },
        }),
      },
    },
  },
  // ---------------- MESSAGING (Step 11 Phase 3) ----------------
  {
    id: 'new-message-received',
    version: '1',
    event: 'message.new',
    requiredVars: ['recipientName', 'senderName', 'messagePreview'],
    subject: (v) => `New message from ${s(v, 'senderName')}`,
    build: (v) => ({
      preheader: 'You have a new message on Unity',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`${s(v, 'senderName')} sent you a message: "${s(v, 'messagePreview')}"`],
      cta: { label: 'Reply on Unity', path: '/chat' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Nuwe boodskap van ${s(v, 'senderName')}`,
        build: (v) => ({
          preheader: 'Jy het ’n nuwe boodskap op Unity',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`${s(v, 'senderName')} het vir jou 'n boodskap gestuur: "${s(v, 'messagePreview')}"`],
          cta: { label: 'Antwoord op Unity', path: '/chat' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Umlayezo omusha ovela ku-${s(v, 'senderName')}`,
        build: (v) => ({
          preheader: 'Unomlayezo omusha ku-Unity',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`U-${s(v, 'senderName')} ukuthumelele umlayezo: "${s(v, 'messagePreview')}"`],
          cta: { label: 'Phendula ku-Unity', path: '/chat' },
        }),
      },
    },
  },
  // ---------------- MERCHANT PAYOUTS (Step 11 Phase 8) ----------------
  {
    id: 'merchant-payout-created',
    version: '1',
    event: 'merchant_payout.created',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference', 'payoutAmount'],
    subject: (v) => `Payout created for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Unity has created a payout record for your completed rental',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `Unity has created a payout record for the completed rental of "${s(v, 'listingTitle')}". It has not started processing yet.`,
      ],
      summary: { title: 'Payout', rows: [{ label: 'Booking', value: s(v, 'bookingReference') }, { label: 'Amount', value: s(v, 'payoutAmount') }] },
      cta: { label: 'View your payouts', path: '/dashboard/merchant/payouts' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Uitbetaling geskep vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Unity het \'n uitbetalingsrekord vir jou voltooide verhuring geskep',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Unity het 'n uitbetalingsrekord geskep vir die voltooide verhuring van "${s(v, 'listingTitle')}". Dit het nog nie begin verwerk word nie.`,
          ],
          summary: { title: 'Uitbetaling', rows: [{ label: 'Bespreking', value: s(v, 'bookingReference') }, { label: 'Bedrag', value: s(v, 'payoutAmount') }] },
          cta: { label: 'Bekyk jou uitbetalings', path: '/dashboard/merchant/payouts' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkokhelo idalwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'I-Unity idale irekhodi lenkokhelo lokuqasha kwakho okuqediwe',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `I-Unity idale irekhodi lenkokhelo lokuqasha okuqediwe kwe-"${s(v, 'listingTitle')}". Ayikakaqali ukucutshungulwa.`,
          ],
          summary: { title: 'Inkokhelo', rows: [{ label: 'Ukubhukha', value: s(v, 'bookingReference') }, { label: 'Inani', value: s(v, 'payoutAmount') }] },
          cta: { label: 'Buka izinkokhelo zakho', path: '/dashboard/merchant/payouts' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'merchant-payout-processing',
    version: '1',
    event: 'merchant_payout.processing',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference', 'payoutAmount'],
    subject: (v) => `Payout processing for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Unity is processing this payout',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `Unity is processing your payout for "${s(v, 'listingTitle')}". No automated payout provider is currently connected — this records that payout processing has begun.`,
      ],
      summary: { title: 'Payout', rows: [{ label: 'Booking', value: s(v, 'bookingReference') }, { label: 'Amount', value: s(v, 'payoutAmount') }] },
      cta: { label: 'View your payouts', path: '/dashboard/merchant/payouts' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Uitbetaling word verwerk vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Unity verwerk tans hierdie uitbetaling',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Unity verwerk tans jou uitbetaling vir "${s(v, 'listingTitle')}". Geen outomatiese uitbetalingsverskaffer is tans gekoppel nie — dit teken aan dat uitbetalingsverwerking begin het.`,
          ],
          summary: { title: 'Uitbetaling', rows: [{ label: 'Bespreking', value: s(v, 'bookingReference') }, { label: 'Bedrag', value: s(v, 'payoutAmount') }] },
          cta: { label: 'Bekyk jou uitbetalings', path: '/dashboard/merchant/payouts' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkokhelo iyacutshungulwa ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'I-Unity icubungula manje le nkokhelo',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `I-Unity icubungula manje inkokhelo yakho ye-"${s(v, 'listingTitle')}". Akukho mhlinzeki wenkokhelo ozenzakalelayo oxhunyiwe njengamanje — lokhu kurekhoda ukuthi ukucubungulwa kwenkokhelo kuqalile.`,
          ],
          summary: { title: 'Inkokhelo', rows: [{ label: 'Ukubhukha', value: s(v, 'bookingReference') }, { label: 'Inani', value: s(v, 'payoutAmount') }] },
          cta: { label: 'Buka izinkokhelo zakho', path: '/dashboard/merchant/payouts' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'merchant-payout-paid',
    version: '1',
    event: 'merchant_payout.paid',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference', 'payoutAmount', 'payoutReference'],
    subject: (v) => `Payout marked as paid for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Manual payout recorded',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `Unity recorded this payout as paid for "${s(v, 'listingTitle')}". Manual payout recorded — no automated provider was used.`,
      ],
      summary: {
        title: 'Payout',
        rows: [
          { label: 'Booking', value: s(v, 'bookingReference') },
          { label: 'Amount', value: s(v, 'payoutAmount') },
          { label: 'Reference', value: s(v, 'payoutReference') },
        ],
      },
      cta: { label: 'View your payouts', path: '/dashboard/merchant/payouts' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Uitbetaling as betaal gemerk vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Handmatige uitbetaling aangeteken',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Unity het hierdie uitbetaling as betaal aangeteken vir "${s(v, 'listingTitle')}". Handmatige uitbetaling aangeteken — geen outomatiese verskaffer is gebruik nie.`,
          ],
          summary: {
            title: 'Uitbetaling',
            rows: [
              { label: 'Bespreking', value: s(v, 'bookingReference') },
              { label: 'Bedrag', value: s(v, 'payoutAmount') },
              { label: 'Verwysing', value: s(v, 'payoutReference') },
            ],
          },
          cta: { label: 'Bekyk jou uitbetalings', path: '/dashboard/merchant/payouts' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkokhelo iphawulwe njengekhokhiwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Inkokhelo ngesandla irekhodiwe',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `I-Unity irekhode le nkokhelo njengekhokhiwe ye-"${s(v, 'listingTitle')}". Inkokhelo ngesandla irekhodiwe — akukho mhlinzeki ozenzakalelayo osetshenzisiwe.`,
          ],
          summary: {
            title: 'Inkokhelo',
            rows: [
              { label: 'Ukubhukha', value: s(v, 'bookingReference') },
              { label: 'Inani', value: s(v, 'payoutAmount') },
              { label: 'Inkomba', value: s(v, 'payoutReference') },
            ],
          },
          cta: { label: 'Buka izinkokhelo zakho', path: '/dashboard/merchant/payouts' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'merchant-payout-failed',
    version: '1',
    event: 'merchant_payout.failed',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference', 'failureMessage'],
    subject: (v) => `Payout issue for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'This payout could not be completed',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `This payout could not be completed for "${s(v, 'listingTitle')}". ${s(v, 'failureMessage')} Unity will review or retry it.`,
      ],
      summary: { title: 'Payout', rows: [{ label: 'Booking', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your payouts', path: '/dashboard/merchant/payouts' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Uitbetalingskwessie vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Hierdie uitbetaling kon nie voltooi word nie',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Hierdie uitbetaling kon nie voltooi word vir "${s(v, 'listingTitle')}" nie. ${s(v, 'failureMessage')} Unity sal dit hersien of weer probeer.`,
          ],
          summary: { title: 'Uitbetaling', rows: [{ label: 'Bespreking', value: s(v, 'bookingReference') }] },
          cta: { label: 'Bekyk jou uitbetalings', path: '/dashboard/merchant/payouts' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkinga yenkokhelo ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Le nkokhelo ayikwazanga ukuqedwa',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Le nkokhelo ayikwazanga ukuqedwa ye-"${s(v, 'listingTitle')}". ${s(v, 'failureMessage')} I-Unity izoyibuyekeza noma izame futhi.`,
          ],
          summary: { title: 'Inkokhelo', rows: [{ label: 'Ukubhukha', value: s(v, 'bookingReference') }] },
          cta: { label: 'Buka izinkokhelo zakho', path: '/dashboard/merchant/payouts' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'merchant-payout-retry-started',
    version: '1',
    event: 'merchant_payout.retry_started',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference', 'payoutAmount'],
    subject: (v) => `Payout retry started for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Unity is retrying this payout',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `Unity is retrying your payout for "${s(v, 'listingTitle')}". No automated payout provider is currently connected — this records that payout processing has resumed.`,
      ],
      summary: { title: 'Payout', rows: [{ label: 'Booking', value: s(v, 'bookingReference') }, { label: 'Amount', value: s(v, 'payoutAmount') }] },
      cta: { label: 'View your payouts', path: '/dashboard/merchant/payouts' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Uitbetaling word weer probeer vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Unity probeer hierdie uitbetaling weer',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Unity probeer jou uitbetaling weer vir "${s(v, 'listingTitle')}". Geen outomatiese uitbetalingsverskaffer is tans gekoppel nie — dit teken aan dat uitbetalingsverwerking hervat het.`,
          ],
          summary: { title: 'Uitbetaling', rows: [{ label: 'Bespreking', value: s(v, 'bookingReference') }, { label: 'Bedrag', value: s(v, 'payoutAmount') }] },
          cta: { label: 'Bekyk jou uitbetalings', path: '/dashboard/merchant/payouts' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkokhelo izanywa futhi ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'I-Unity izama futhi le nkokhelo',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `I-Unity izama futhi inkokhelo yakho ye-"${s(v, 'listingTitle')}". Akukho mhlinzeki wenkokhelo ozenzakalelayo oxhunyiwe njengamanje — lokhu kurekhoda ukuthi ukucubungulwa kwenkokhelo kuqalile futhi.`,
          ],
          summary: { title: 'Inkokhelo', rows: [{ label: 'Ukubhukha', value: s(v, 'bookingReference') }, { label: 'Inani', value: s(v, 'payoutAmount') }] },
          cta: { label: 'Buka izinkokhelo zakho', path: '/dashboard/merchant/payouts' },
          testModeNotice: true,
        }),
      },
    },
  },

  // ---------------- MERCHANT SUBSCRIPTIONS (Unity Phase 1) ----------------
  {
    id: 'merchant-subscription-upgraded',
    version: '1',
    event: 'merchant_subscription.upgrade',
    requiredVars: ['merchantName', 'planName'],
    subject: (v) => `You're now on the ${s(v, 'planName')} plan`,
    build: (v) => ({
      preheader: 'Your Unity subscription has been upgraded',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`Your Unity merchant account has been upgraded to the ${s(v, 'planName')} plan, effective immediately. Your new rates apply from now on.`],
      cta: { label: 'View your subscription', path: '/dashboard/merchant/subscription' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jy is nou op die ${s(v, 'planName')}-plan`,
        build: (v) => ({
          preheader: 'Jou Unity-subskripsie is opgegradeer',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Jou Unity-handelaarrekening is opgegradeer na die ${s(v, 'planName')}-plan, met onmiddellike effek. Jou nuwe tariewe geld van nou af.`],
          cta: { label: 'Bekyk jou subskripsie', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Manje usohlelweni lwe-${s(v, 'planName')}`,
        build: (v) => ({
          preheader: 'Ukubhaliswa kwakho kwe-Unity kuthuthukisiwe',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [`I-akhawunti yakho yomthengisi ye-Unity ithuthukiswe yaya ohlelweni lwe-${s(v, 'planName')}, ngokushesha. Amanani akho amasha asebenza kusukela manje.`],
          cta: { label: 'Buka ukubhaliswa kwakho', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'merchant-subscription-downgrade-scheduled',
    version: '1',
    event: 'merchant_subscription.downgrade',
    requiredVars: ['merchantName', 'planName'],
    subject: (v) => `Your plan change to ${s(v, 'planName')} is scheduled`,
    build: (v) => ({
      preheader: 'Your Unity subscription downgrade is scheduled',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `You've scheduled a downgrade to the ${s(v, 'planName')} plan. You'll keep your current plan's rates and benefits until the start of your next billing period, when the change takes effect.`,
      ],
      cta: { label: 'Manage your subscription', path: '/dashboard/merchant/subscription' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou planverandering na ${s(v, 'planName')} is geskeduleer`,
        build: (v) => ({
          preheader: 'Jou Unity-subskripsie-afgradering is geskeduleer',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Jy het 'n afgradering na die ${s(v, 'planName')}-plan geskeduleer. Jy sal jou huidige plan se tariewe en voordele behou tot die begin van jou volgende faktureringstydperk, wanneer die verandering in werking tree.`,
          ],
          cta: { label: 'Bestuur jou subskripsie', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ushintsho lohlelo lwakho oluya ku-${s(v, 'planName')} luhlelwe`,
        build: (v) => ({
          preheader: 'Ukwehliswa kokubhaliswa kwakho kwe-Unity kuhlelwe',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            `Uhlele ukwehliswa uye ohlelweni lwe-${s(v, 'planName')}. Uzogcina amanani nezinzuzo zohlelo lwakho lwamanje kuze kube sekuqaleni kwesikhathi sakho sokukhokha esilandelayo, lapho ushintsho luzosebenza khona.`,
          ],
          cta: { label: 'Phatha ukubhaliswa kwakho', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'merchant-subscription-cancellation-scheduled',
    version: '1',
    event: 'merchant_subscription.cancellation',
    requiredVars: ['merchantName'],
    subject: () => 'Your subscription cancellation is scheduled',
    build: (v) => ({
      preheader: 'Your Unity subscription will revert to Starter',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        "You've cancelled your paid Unity plan. You'll keep your current plan's rates and benefits until the start of your next billing period, when your account reverts to Starter.",
      ],
      cta: { label: 'Manage your subscription', path: '/dashboard/merchant/subscription' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: () => 'Jou subskripsiekansellasie is geskeduleer',
        build: (v) => ({
          preheader: 'Jou Unity-subskripsie sal na Starter terugkeer',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            "Jy het jou betaalde Unity-plan gekanselleer. Jy sal jou huidige plan se tariewe en voordele behou tot die begin van jou volgende faktureringstydperk, wanneer jou rekening na Starter terugkeer.",
          ],
          cta: { label: 'Bestuur jou subskripsie', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: () => 'Ukukhanselwa kokubhaliswa kwakho kuhlelwe',
        build: (v) => ({
          preheader: 'Ukubhaliswa kwakho kwe-Unity kuzobuyela ku-Starter',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [
            "Ukhansele uhlelo lwakho lwe-Unity olukhokhelwayo. Uzogcina amanani nezinzuzo zohlelo lwakho lwamanje kuze kube sekuqaleni kwesikhathi sakho sokukhokha esilandelayo, lapho i-akhawunti yakho izobuyela khona ku-Starter.",
          ],
          cta: { label: 'Phatha ukubhaliswa kwakho', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'merchant-subscription-pending-change-cancelled',
    version: '1',
    event: 'merchant_subscription.pending_change_cancelled',
    requiredVars: ['merchantName'],
    subject: () => 'Your scheduled plan change has been cancelled',
    build: (v) => ({
      preheader: 'Your Unity subscription will stay on your current plan',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: ['Your scheduled plan change has been cancelled. You will stay on your current plan with no interruption.'],
      cta: { label: 'View your subscription', path: '/dashboard/merchant/subscription' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: () => 'Jou geskeduleerde planverandering is gekanselleer',
        build: (v) => ({
          preheader: 'Jou Unity-subskripsie sal op jou huidige plan bly',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: ['Jou geskeduleerde planverandering is gekanselleer. Jy sal sonder onderbreking op jou huidige plan bly.'],
          cta: { label: 'Bekyk jou subskripsie', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: () => 'Ushintsho lohlelo lwakho oluhleliwe lukhanseliwe',
        build: (v) => ({
          preheader: 'Ukubhaliswa kwakho kwe-Unity kuzohlala ohlelweni lwakho lwamanje',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: ['Ushintsho lohlelo lwakho oluhleliwe lukhanseliwe. Uzohlala ohlelweni lwakho lwamanje ngaphandle kokuphazamiseka.'],
          cta: { label: 'Buka ukubhaliswa kwakho', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'merchant-subscription-reverted',
    version: '1',
    event: 'merchant_subscription.reversion',
    requiredVars: ['merchantName'],
    subject: () => 'Your Unity plan has reverted to Starter',
    build: (v) => ({
      preheader: 'Your scheduled cancellation has taken effect',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: ['Your scheduled cancellation has taken effect and your Unity merchant account is now on the Starter plan.'],
      cta: { label: 'View your subscription', path: '/dashboard/merchant/subscription' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: () => 'Jou Unity-plan het na Starter teruggekeer',
        build: (v) => ({
          preheader: 'Jou geskeduleerde kansellasie het in werking getree',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: ['Jou geskeduleerde kansellasie het in werking getree en jou Unity-handelaarrekening is nou op die Starter-plan.'],
          cta: { label: 'Bekyk jou subskripsie', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: () => 'Uhlelo lwakho lwe-Unity lubuyele ku-Starter',
        build: (v) => ({
          preheader: 'Ukukhanselwa kwakho okuhleliwe kusebenzile',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: ['Ukukhanselwa kwakho okuhleliwe kusebenzile futhi i-akhawunti yakho yomthengisi ye-Unity manje isohlelweni lwe-Starter.'],
          cta: { label: 'Buka ukubhaliswa kwakho', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'merchant-subscription-downgrade-applied',
    version: '1',
    event: 'merchant_subscription.downgrade',
    requiredVars: ['merchantName'],
    subject: () => 'Your Unity plan change has taken effect',
    build: (v) => ({
      preheader: 'Your scheduled downgrade has taken effect',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: ['Your scheduled plan downgrade has taken effect. Your new rates apply from now on.'],
      cta: { label: 'View your subscription', path: '/dashboard/merchant/subscription' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: () => 'Jou Unity-planverandering het in werking getree',
        build: (v) => ({
          preheader: 'Jou geskeduleerde afgradering het in werking getree',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: ['Jou geskeduleerde planafgradering het in werking getree. Jou nuwe tariewe geld van nou af.'],
          cta: { label: 'Bekyk jou subskripsie', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: () => 'Ushintsho lohlelo lwakho lwe-Unity lusebenzile',
        build: (v) => ({
          preheader: 'Ukwehliswa kwakho okuhleliwe kusebenzile',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: ['Ukwehliswa kohlelo lwakho oluhleliwe kusebenzile. Amanani akho amasha asebenza kusukela manje.'],
          cta: { label: 'Buka ukubhaliswa kwakho', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
    },
  },
  {
    id: 'merchant-subscription-admin-corrected',
    version: '1',
    event: 'merchant_subscription.admin_correction',
    requiredVars: ['merchantName', 'planName'],
    subject: (v) => `Your Unity plan was updated to ${s(v, 'planName')}`,
    build: (v) => ({
      preheader: 'Unity support has updated your subscription plan',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`Unity support has updated your merchant account to the ${s(v, 'planName')} plan. If you have any questions, please contact support.`],
      cta: { label: 'View your subscription', path: '/dashboard/merchant/subscription' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou Unity-plan is opgedateer na ${s(v, 'planName')}`,
        build: (v) => ({
          preheader: 'Unity-ondersteuning het jou subskripsieplan opgedateer',
          greeting: `Hallo ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Unity-ondersteuning het jou handelaarrekening opgedateer na die ${s(v, 'planName')}-plan. Kontak asseblief ondersteuning as jy enige vrae het.`],
          cta: { label: 'Bekyk jou subskripsie', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Uhlelo lwakho lwe-Unity luvuselelwe luya ku-${s(v, 'planName')}`,
        build: (v) => ({
          preheader: 'Usekelo lwe-Unity luvuselele uhlelo lwakho lokubhaliswa',
          greeting: `Sawubona ${s(v, 'merchantName')},`,
          bodyParagraphs: [`Usekelo lwe-Unity luvuselele i-akhawunti yakho yomthengisi yaya ohlelweni lwe-${s(v, 'planName')}. Uma unemibuzo, sicela uxhumane nosekelo.`],
          cta: { label: 'Buka ukubhaliswa kwakho', path: '/dashboard/merchant/subscription' },
          testModeNotice: true,
        }),
      },
    },
  },

  // ---------------- UNITY COMMISSION (Unity Phase 2) ----------------
  {
    id: 'unity-commission-voided',
    version: '1',
    event: 'unity_commission.voided',
    requiredVars: ['recipientName', 'listingTitle', 'transactionReference', 'voidReason'],
    subject: (v) => `Commission voided for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A Unity commission charge has been voided',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`The Unity commission charged for "${s(v, 'listingTitle')}" has been voided. Reason: ${s(v, 'voidReason')}.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/merchant/commissions' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Kommissie tersyde gestel vir "${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: "'n Unity-kommissiekoste is tersyde gestel",
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Die Unity-kommissie wat gehef is vir "${s(v, 'listingTitle')}" is tersyde gestel. Rede: ${s(v, 'voidReason')}.`],
          summary: { title: 'Kommissie', rows: [{ label: 'Verwysing', value: s(v, 'transactionReference') }] },
          cta: { label: 'Bekyk jou kommissies', path: '/dashboard/merchant/commissions' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ikhomishini icishiwe ye-"${s(v, 'listingTitle')}"`,
        build: (v) => ({
          preheader: 'Intengo yekhomishini ye-Unity icishiwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ikhomishini ye-Unity ekhokhelwe i-"${s(v, 'listingTitle')}" icishiwe. Isizathu: ${s(v, 'voidReason')}.`],
          summary: { title: 'Ikhomishini', rows: [{ label: 'Inkomba', value: s(v, 'transactionReference') }] },
          cta: { label: 'Buka amakhomishini akho', path: '/dashboard/merchant/commissions' },
        }),
      },
    },
  },
  {
    id: 'unity-commission-adjusted',
    version: '1',
    event: 'unity_commission.adjusted',
    requiredVars: ['recipientName', 'listingTitle', 'transactionReference', 'adjustmentAmount'],
    subject: (v) => `Your Unity commission for "${s(v, 'listingTitle')}" was adjusted`,
    build: (v) => ({
      preheader: 'A Unity commission adjustment was recorded',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`An adjustment of ${s(v, 'adjustmentAmount')} was recorded against the Unity commission charged for "${s(v, 'listingTitle')}", following a partial refund.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/merchant/commissions' },
      testModeNotice: true,
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou Unity-kommissie vir "${s(v, 'listingTitle')}" is aangepas`,
        build: (v) => ({
          preheader: "'n Unity-kommissie-aanpassing is aangeteken",
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`'n Aanpassing van ${s(v, 'adjustmentAmount')} is aangeteken teen die Unity-kommissie gehef vir "${s(v, 'listingTitle')}", na aanleiding van 'n gedeeltelike terugbetaling.`],
          summary: { title: 'Kommissie', rows: [{ label: 'Verwysing', value: s(v, 'transactionReference') }] },
          cta: { label: 'Bekyk jou kommissies', path: '/dashboard/merchant/commissions' },
          testModeNotice: true,
        }),
      },
      'zu-ZA': {
        subject: (v) => `Ikhomishini yakho ye-Unity ye-"${s(v, 'listingTitle')}" ilungisiwe`,
        build: (v) => ({
          preheader: 'Ukulungiswa kwekhomishini ye-Unity kubhaliwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Ukulungiswa kwe-${s(v, 'adjustmentAmount')} kubhaliwe kwikhomishini ye-Unity ekhokhelwe i-"${s(v, 'listingTitle')}", ngemuva kwembuyiselo eyingxenye.`],
          summary: { title: 'Ikhomishini', rows: [{ label: 'Inkomba', value: s(v, 'transactionReference') }] },
          cta: { label: 'Buka amakhomishini akho', path: '/dashboard/merchant/commissions' },
          testModeNotice: true,
        }),
      },
    },
  },

  // ---------------- ESCROW (Phase 3) ----------------
  // One shared, transaction-type-neutral template -- the recipient
  // doesn't need different wording for sale/rental/barter, matching
  // barter-completed/dispute-resolved's own shared-template precedent.
  // No "TradeSafe" or provider-branded language anywhere -- TradeSafe is
  // a proposed provider only, not a live integration.
  {
    id: 'escrow-transaction-released',
    version: '1',
    event: 'escrow_transaction.released',
    requiredVars: ['recipientName', 'transactionReference'],
    subject: () => `Funds have been released for your transaction`,
    build: (v) => ({
      preheader: 'Held funds have been released',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`The funds Unity held securely for transaction ${s(v, 'transactionReference')} have now been released.`],
      cta: { label: 'View your dashboard', path: '/dashboard' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: () => `Fondse is vrygestel vir jou transaksie`,
        build: (v) => ({
          preheader: 'Gehoue fondse is vrygestel',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Die fondse wat Unity veilig gehou het vir transaksie ${s(v, 'transactionReference')} is nou vrygestel.`],
          cta: { label: 'Bekyk jou paneelbord', path: '/dashboard' },
        }),
      },
      'zu-ZA': {
        subject: () => `Imali ikhishiwe yokuthengiselana kwakho`,
        build: (v) => ({
          preheader: 'Imali ebibanjiwe ikhishiwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Imali i-Unity ebiyibambe ngokuphephile yokuthengiselana ${s(v, 'transactionReference')} manje isikhishiwe.`],
          cta: { label: 'Buka ibhodi lakho', path: '/dashboard' },
        }),
      },
    },
  },

  // ---------------- LOOKING FOR (Phase 4) ----------------
  {
    id: 'marketplace-offer-received',
    version: '1',
    event: 'marketplace_request.offer_received',
    requiredVars: ['recipientName', 'requestTitle'],
    subject: (v) => `You have a new response to "${s(v, 'requestTitle')}"`,
    build: (v) => ({
      preheader: 'Someone responded to your request',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your request "${s(v, 'requestTitle')}" received a new response.`],
      cta: { label: 'View responses', path: '/looking-for' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jy het 'n nuwe reaksie op "${s(v, 'requestTitle')}"`,
        build: (v) => ({
          preheader: 'Iemand het op jou versoek gereageer',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou versoek "${s(v, 'requestTitle')}" het 'n nuwe reaksie ontvang.`],
          cta: { label: 'Bekyk reaksies', path: '/looking-for' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Unempendulo entsha ku-"${s(v, 'requestTitle')}"`,
        build: (v) => ({
          preheader: 'Umuntu uphendule isicelo sakho',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Isicelo sakho "${s(v, 'requestTitle')}" sithole impendulo entsha.`],
          cta: { label: 'Buka izimpendulo', path: '/looking-for' },
        }),
      },
    },
  },
  {
    id: 'marketplace-offer-accepted',
    version: '1',
    event: 'marketplace_request.offer_accepted',
    requiredVars: ['recipientName', 'requestTitle'],
    subject: (v) => `Your response to "${s(v, 'requestTitle')}" was accepted`,
    build: (v) => ({
      preheader: 'Your response was accepted',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your response to "${s(v, 'requestTitle')}" was accepted. The transaction has been created in your dashboard.`],
      cta: { label: 'View your dashboard', path: '/dashboard' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou reaksie op "${s(v, 'requestTitle')}" is aanvaar`,
        build: (v) => ({
          preheader: 'Jou reaksie is aanvaar',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Jou reaksie op "${s(v, 'requestTitle')}" is aanvaar. Die transaksie is in jou paneelbord geskep.`],
          cta: { label: 'Bekyk jou paneelbord', path: '/dashboard' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Impendulo yakho ku-"${s(v, 'requestTitle')}" yamukelwe`,
        build: (v) => ({
          preheader: 'Impendulo yakho yamukelwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [`Impendulo yakho ku-"${s(v, 'requestTitle')}" yamukelwe. Ukuthengiselana kudaliwe ebhodini lakho.`],
          cta: { label: 'Buka ibhodi lakho', path: '/dashboard' },
        }),
      },
    },
  },

  // ---------------- RENT-TO-BUY (Phase 5) ----------------
  {
    id: 'rent-to-buy-agreement-accepted',
    version: '1',
    event: 'rent_to_buy.agreement_accepted',
    requiredVars: ['recipientName', 'listingTitle'],
    subject: (v) => `Your rent-to-buy agreement for "${s(v, 'listingTitle')}" is ready for the first payment`,
    build: (v) => ({
      preheader: 'Rent-to-buy agreement accepted',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `Your rent-to-buy agreement for "${s(v, 'listingTitle')}" has been accepted. Once the first payment settles, you may take possession of the item -- the merchant remains the owner until the full rent-to-buy amount has been paid.`,
      ],
      cta: { label: 'View your agreement', path: '/dashboard' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou huur-om-te-koop-ooreenkoms vir "${s(v, 'listingTitle')}" is gereed vir die eerste betaling`,
        build: (v) => ({
          preheader: 'Huur-om-te-koop-ooreenkoms aanvaar',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Jou huur-om-te-koop-ooreenkoms vir "${s(v, 'listingTitle')}" is aanvaar. Sodra die eerste betaling verreken is, mag jy die item in besit neem -- die handelaar bly die eienaar totdat die volle huur-om-te-koop-bedrag betaal is.`,
          ],
          cta: { label: 'Bekyk jou ooreenkoms', path: '/dashboard' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Isivumelwano sakho sokuqasha-ukuze-uthenge se-"${s(v, 'listingTitle')}" silungele inkokhelo yokuqala`,
        build: (v) => ({
          preheader: 'Isivumelwano sokuqasha-ukuze-uthenge samukelwe',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Isivumelwano sakho sokuqasha-ukuze-uthenge se-"${s(v, 'listingTitle')}" samukelwe. Uma inkokhelo yokuqala isihlaziyiwe, ungathatha into -- umthengisi uhlala engumnikazi kuze kube inani lokuqasha-ukuze-uthenge eliphelele likhokhiwe.`,
          ],
          cta: { label: 'Buka isivumelwano sakho', path: '/dashboard' },
        }),
      },
    },
  },
  {
    id: 'rent-to-buy-possession-eligible',
    version: '1',
    event: 'rent_to_buy.first_payment_settled',
    requiredVars: ['recipientName', 'listingTitle'],
    subject: (v) => `Your first payment for "${s(v, 'listingTitle')}" has settled`,
    build: (v) => ({
      preheader: 'You may now take possession',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `Your first payment for "${s(v, 'listingTitle')}" has settled. You may now take possession once handover is confirmed. Remember: the merchant remains the owner of the item until the full rent-to-buy amount has been paid.`,
      ],
      cta: { label: 'View your agreement', path: '/dashboard' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou eerste betaling vir "${s(v, 'listingTitle')}" is verreken`,
        build: (v) => ({
          preheader: 'Jy mag nou besit neem',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Jou eerste betaling vir "${s(v, 'listingTitle')}" is verreken. Jy mag nou besit neem sodra oordrag bevestig is. Onthou: die handelaar bly die eienaar van die item totdat die volle huur-om-te-koop-bedrag betaal is.`,
          ],
          cta: { label: 'Bekyk jou ooreenkoms', path: '/dashboard' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Inkokhelo yakho yokuqala ye-"${s(v, 'listingTitle')}" isihlaziyiwe`,
        build: (v) => ({
          preheader: 'Manje ungathatha into',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Inkokhelo yakho yokuqala ye-"${s(v, 'listingTitle')}" isihlaziyiwe. Manje ungathatha into uma sekuqinisekisiwe ukudluliselwa. Khumbula: umthengisi uhlala engumnikazi wento kuze kube inani lokuqasha-ukuze-uthenge eliphelele likhokhiwe.`,
          ],
          cta: { label: 'Buka isivumelwano sakho', path: '/dashboard' },
        }),
      },
    },
  },
  {
    id: 'rent-to-buy-defaulted',
    version: '1',
    event: 'rent_to_buy.defaulted',
    requiredVars: ['recipientName', 'listingTitle'],
    subject: (v) => `Your rent-to-buy agreement for "${s(v, 'listingTitle')}" requires attention`,
    build: (v) => ({
      preheader: 'Rent-to-buy purchase path ended',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `Your rent-to-buy agreement for "${s(v, 'listingTitle')}" has defaulted before the full purchase amount was paid. The purchase path has ended and the item must be returned to the merchant. The arrangement is treated as rental/use for the period you possessed the item.`,
      ],
      cta: { label: 'View your agreement', path: '/dashboard' },
    }),
    localeVariants: {
      'af-ZA': {
        subject: (v) => `Jou huur-om-te-koop-ooreenkoms vir "${s(v, 'listingTitle')}" vereis aandag`,
        build: (v) => ({
          preheader: 'Huur-om-te-koop-aankooppad beëindig',
          greeting: `Hallo ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Jou huur-om-te-koop-ooreenkoms vir "${s(v, 'listingTitle')}" het in gebreke gebly voordat die volle aankoopbedrag betaal is. Die aankooppad is beëindig en die item moet aan die handelaar terugbesorg word. Die reëling word as verhuring/gebruik hanteer vir die tydperk wat jy die item besit het.`,
          ],
          cta: { label: 'Bekyk jou ooreenkoms', path: '/dashboard' },
        }),
      },
      'zu-ZA': {
        subject: (v) => `Isivumelwano sakho sokuqasha-ukuze-uthenge se-"${s(v, 'listingTitle')}" sidinga ukunakwa`,
        build: (v) => ({
          preheader: 'Indlela yokuthenga yokuqasha-ukuze-uthenge iphelile',
          greeting: `Sawubona ${s(v, 'recipientName')},`,
          bodyParagraphs: [
            `Isivumelwano sakho sokuqasha-ukuze-uthenge se-"${s(v, 'listingTitle')}" sehlulekile ngaphambi kokuthi inani lokuthenga eliphelele likhokhwe. Indlela yokuthenga isiphelile futhi into kufanele ibuyiselwe kumthengisi. Isivumelwano siphathwa njengokuqasha/ukusetshenziswa ngesikhathi obusineso into.`,
          ],
          cta: { label: 'Buka isivumelwano sakho', path: '/dashboard' },
        }),
      },
    },
  },
]

const TEMPLATES_BY_ID = new Map(EMAIL_TEMPLATES.map((t) => [t.id, t]))

export function getEmailTemplate(templateId: string): EmailTemplateDef | undefined {
  return TEMPLATES_BY_ID.get(templateId)
}

export class TemplateValidationError extends Error {
  constructor(templateId: string, missing: string[]) {
    super(`Template "${templateId}" is missing required variables: ${missing.join(', ')}`)
    this.name = 'TemplateValidationError'
  }
}

/**
 * The one entry point every dispatch call renders through. Validates
 * required vars, never silently renders with a blank/undefined field.
 * `locale` defaults to en-ZA (unchanged prior behavior for every call site
 * that doesn't pass one, and for any template/locale combination with no
 * translated variant yet -- fail-safe English fallback, never a missing
 * key or blank field).
 */
export function renderTemplate(templateId: string, vars: TemplateVars, locale: Locale = 'en-ZA'): RenderedTemplate {
  const def = getEmailTemplate(templateId)
  if (!def) {
    throw new TemplateValidationError(templateId, ['(unknown template id)'])
  }
  const missing = def.requiredVars.filter((key) => vars[key] === undefined || vars[key] === null || vars[key] === '')
  if (missing.length > 0) {
    throw new TemplateValidationError(templateId, missing)
  }
  const variant = def.localeVariants?.[locale]
  const shellInput = { ...(variant ?? def).build(vars), locale }
  const { html, text } = renderShell(shellInput)
  return { subject: (variant ?? def).subject(vars), html, text }
}
