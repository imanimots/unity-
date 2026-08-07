import type { LegalDocument } from '@/lib/legal/registry'
import { PERMANENT_NOINDEX, getDefaultRobotsMeta, type RobotsMeta } from './config'

/**
 * Unity SEO Pre-Launch Hardening — Part F (draft legal pages).
 *
 * A draft policy (`status: 'draft'` in src/lib/legal/registry.ts) is
 * ALWAYS noindex, regardless of the future SEO_INDEXING_ENABLED flag —
 * turning general indexing on must never accidentally publish an
 * unreviewed legal position to search results. Only once a document's
 * own registry entry is explicitly changed to `status: 'approved'` (a
 * real, separate future action — never implied by this flag) does it
 * fall back to following the general indexing gate like any other page.
 */
export function legalRobotsMeta(doc: LegalDocument): RobotsMeta {
  if (doc.status === 'draft') return PERMANENT_NOINDEX
  return getDefaultRobotsMeta()
}
