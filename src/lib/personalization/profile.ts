import type { SupabaseClient } from '@supabase/supabase-js'
import { getPersonalizationSettings } from './preferences'
import { getCompletedTransactionAffinity, getServerViews } from './signals'
import { buildAnonymousViewRecords } from './anonymous'
import type { PersonalizationProfileInput, PersonalizationSettings } from './types'

/**
 * Builds the single input shape the deterministic recommendation engine
 * (recommendations.ts) consumes -- identical shape for signed-in and
 * anonymous users, only the source of `views` differs.
 */
export async function buildAuthenticatedProfile(supabase: SupabaseClient, userId: string): Promise<{ profile: PersonalizationProfileInput; settings: PersonalizationSettings }> {
  const settings = await getPersonalizationSettings(supabase, userId)

  // Section 37 (binding): disabled personalization means behavioral +
  // explicit-preference signal is not used for discovery at all -- the
  // caller gets an empty profile back, which naturally makes every
  // candidate fall through to "newest" (cold-start/generic) in the
  // scorer.
  if (!settings.personalizationEnabled) {
    return { profile: { views: [], completedCategories: [], completedModes: [], settings: null }, settings }
  }

  const [views, completed] = await Promise.all([
    getServerViews(supabase, userId),
    getCompletedTransactionAffinity(supabase, userId, settings.personalizationResetAt),
  ])

  return {
    profile: {
      views,
      completedCategories: completed.categories,
      completedModes: completed.modes,
      settings: {
        preferredModes: settings.preferredModes,
        preferredCategories: settings.preferredCategories,
        preferredBarterKinds: settings.preferredBarterKinds,
        preferredProvince: settings.preferredProvince,
        preferredCity: settings.preferredCity,
      },
    },
    settings,
  }
}

/** Anonymous equivalent -- local browser history only, no explicit
 * settings/completed-transaction signal exists without an account. */
export function buildAnonymousProfile(): PersonalizationProfileInput {
  return {
    views: buildAnonymousViewRecords(),
    completedCategories: [],
    completedModes: [],
    settings: null,
  }
}
