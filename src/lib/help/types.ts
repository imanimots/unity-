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
  keywords: string[]
  providerDependency: ProviderDependency
  status: TaskStatus
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
}

export const ROLE_LABELS: Record<HelpRole, string> = {
  guest: 'Guest',
  user: 'User',
  merchant: 'Merchant',
  admin: 'Admin',
}
