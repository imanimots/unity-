/**
 * Shared types for the public Sitemap (/sitemap) and task-based Help
 * Center (/help). Deliberately separate from the admin Knowledge Base
 * (src/app/admin/knowledge-base -- AI-assistant retrieval content,
 * client-state-only, categorized platform/faq/policy/listing): that
 * system serves a different purpose (AI assistant grounding) and uses
 * a different content shape (unstructured prose, not numbered steps
 * with prerequisites/routes/related tasks). Reusing it here would mean
 * forcing task-guide content into a shape it wasn't designed for, and
 * risking the existing admin CRUD/re-embed workflow -- so this is a
 * separate, purpose-built registry instead (E46 Phase P decision).
 */

export type HelpRole = 'guest' | 'user' | 'merchant' | 'admin'

export type HelpCategory =
  | 'getting-started'
  | 'renting'
  | 'buying'
  | 'selling-listing'
  | 'rent-to-buy'
  | 'barter'
  | 'looking-for'
  | 'messages'
  | 'problems-disputes'
  | 'reviews'
  | 'money-payouts'
  | 'affiliate'
  | 'account-privacy'
  | 'admin-help'
  | 'search-discovery'
  | 'safety'
  | 'payments-fees'

export type ProviderDependency = 'tradesafe' | 'bob-go' | 'kyc' | null

export type TaskStatus = 'live' | 'partial' | 'pending-provider'

export interface HelpTask {
  id: string
  slug: string
  title: string
  /** "I want to..." phrasing shown as the card/article heading. */
  iWantTo: string
  role: HelpRole[]
  category: HelpCategory
  /** One short sentence -- the GOAL field. */
  summary: string
  prerequisites: string[]
  steps: string[]
  /** Real route(s) this task is performed from. First entry is primary. */
  routes: { path: string; label: string }[]
  whatHappensNext: string
  commonIssues: string[]
  relatedTaskIds: string[]
  /** Cross-links into the conceptual Learn registry -- kept as a separate
   * field (not merged into relatedTaskIds) so a How-To article can point
   * at the system explanation behind it without the two registries'
   * id namespaces needing to overlap. */
  relatedLearnIds?: string[]
  keywords: string[]
  providerDependency: ProviderDependency
  status: TaskStatus
}

/**
 * LEARN ABOUT UNITY -- the educational/explanatory counterpart to
 * HelpTask's "how do I do X" guides. A Learn article explains WHY the
 * system behaves a given way (search ranking, review lifecycle, what
 * verification does and doesn't mean) so a How-To guide never has to
 * repeat that explanation -- it just links here instead. Deliberately
 * NOT forced into HelpTask's procedural shape (prerequisites/steps/
 * routes don't fit prose explanation), but shares the same registry
 * pattern, category taxonomy, and /help/[slug] route namespace as
 * HelpTask -- genuinely one Help Center, not a second disconnected
 * content system (see help-registry.ts's own header for the slug-
 * uniqueness contract this implies).
 */
export type LearnArticleType = 'learn' | 'safety' | 'reference'

export interface LearnSection {
  heading: string
  body: string[]
}

export interface LearnArticle {
  id: string
  slug: string
  title: string
  articleType: LearnArticleType
  role: HelpRole[]
  category: HelpCategory
  /** One short sentence shown on cards and as the meta description. */
  summary: string
  /** Short bullet points shown as a "Quick answer" / TL;DR block before
   * the full sections -- optional, used for longer explanatory articles. */
  quickAnswer?: string[]
  sections: LearnSection[]
  /** A worked example, shown after sections when it materially helps
   * understanding (e.g. a poor-vs-better search query). Plain text pairs,
   * not steps -- this is illustration, not instruction. */
  example?: { label: string; text: string }[]
  relatedTaskIds?: string[]
  relatedLearnIds?: string[]
  /** Flat term -> definition pairs, used only by the Glossary article
   * instead of forcing a term list into prose sections. */
  definitions?: { term: string; definition: string }[]
  keywords: string[]
  /** Extra search terms a user might type that don't appear in the
   * article's own visible text (plain-language synonyms) -- kept
   * separate from `keywords` so visible copy is never keyword-stuffed
   * just to make search match (see CORE CONTENT PRINCIPLE / SEO rules). */
  synonyms: string[]
  providerDependency: ProviderDependency
}

export type SitemapSection = 'public' | 'user' | 'merchant' | 'admin'

export interface SitemapEntry {
  id: string
  label: string
  path: string
  description: string
  section: SitemapSection
  requiresLogin: boolean
  requiresMerchant: boolean
  requiresAdmin: boolean
  providerDependency: ProviderDependency
}

export const CATEGORY_LABELS: Record<HelpCategory, string> = {
  'getting-started': 'Getting Started',
  renting: 'Renting',
  buying: 'Buying',
  'selling-listing': 'Selling & Listing',
  'rent-to-buy': 'Rent-to-Buy',
  barter: 'Barter',
  'looking-for': 'Looking For',
  messages: 'Messages',
  'problems-disputes': 'Problems & Disputes',
  reviews: 'Reviews',
  'money-payouts': 'Money & Payouts',
  affiliate: 'Affiliate',
  'account-privacy': 'Account & Privacy',
  'admin-help': 'Admin Help',
  'search-discovery': 'Search & Discovery',
  safety: 'Marketplace Safety',
  'payments-fees': 'Payments & Fees',
}

/** One-line subtitle shown under each category's header card on /help (E47 Phase 2) -- content/taxonomy text, same English-authoritative precedent as CATEGORY_LABELS. */
export const CATEGORY_DESCRIPTIONS: Record<HelpCategory, string> = {
  'getting-started': 'Learn the basics about Unity and how it works.',
  renting: 'Find answers about booking and renting items.',
  buying: 'Find answers about buying and selling items outright.',
  'selling-listing': 'Everything about creating and managing your listings.',
  'rent-to-buy': 'How Rent-to-Buy agreements and payments work.',
  barter: 'Trading items and skills directly, no cash involved.',
  'looking-for': 'Posting and responding to Looking For requests.',
  messages: 'Contacting and messaging other members.',
  'problems-disputes': 'Raising and resolving a problem with a transaction.',
  reviews: 'Leaving and managing reviews.',
  'money-payouts': 'Earnings, commissions, and payout destinations.',
  affiliate: 'Joining the affiliate program and tracking referrals.',
  'account-privacy': 'Your account, profile, and privacy settings.',
  'admin-help': 'Platform operations for Unity administrators.',
  'search-discovery': 'How search works, and how to find things faster.',
  safety: 'Recognising scams and staying safe on the marketplace.',
  'payments-fees': 'How payments, fees, and commissions work.',
}

export const ROLE_LABELS: Record<HelpRole, string> = {
  guest: 'Guest',
  user: 'User',
  merchant: 'Merchant',
  admin: 'Admin',
}
