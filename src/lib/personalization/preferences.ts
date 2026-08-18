import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_PERSONALIZATION_SETTINGS, type PersonalizationKind, type PersonalizationMode, type PersonalizationSettings } from './types'

/**
 * Reads/writes user_personalization_settings via the migration's
 * SECURITY DEFINER RPCs (update_personalization_settings,
 * reset_personalization_history) -- never a direct table write, matching
 * this codebase's established RPC-only convention for new user-owned
 * tables (see barter_agreements, merchant_subscriptions).
 *
 * IMPORTANT (development-environment note, not a product behavior): the
 * underlying table/RPCs are defined in
 * supabase/migrations/20260818161508_personalization_v1_schema.sql,
 * authored but NOT YET APPLIED to the live database in this environment
 * (Supabase CLI authentication unavailable, no direct Postgres access).
 * Every function here fails closed -- a missing-relation error is
 * treated identically to "no settings row yet" (i.e. defaults), so the
 * rest of the app degrades to the generic experience rather than
 * crashing. Once the migration is applied, this same code starts
 * persisting for real with no further changes required.
 */

function isMissingRelationError(error: { code?: string; message?: string } | null): boolean {
  // Postgres 42P01 = undefined_table; PostgREST surfaces missing
  // functions/relations this way too.
  return error?.code === '42P01' || error?.code === 'PGRST202' || !!error?.message?.includes('does not exist')
}

export async function getPersonalizationSettings(supabase: SupabaseClient, userId: string): Promise<PersonalizationSettings> {
  const { data, error } = await supabase.from('user_personalization_settings').select('*').eq('user_id', userId).maybeSingle()

  if (error && !isMissingRelationError(error)) {
    // A real, unexpected error -- still degrade to defaults rather than
    // throwing into a page render, but this is not the expected "schema
    // not applied yet" path.
    return { userId, ...DEFAULT_PERSONALIZATION_SETTINGS }
  }
  if (!data) return { userId, ...DEFAULT_PERSONALIZATION_SETTINGS }

  return {
    userId,
    personalizationEnabled: data.personalization_enabled,
    preferredModes: (data.preferred_modes ?? []) as PersonalizationMode[],
    preferredCategories: data.preferred_categories ?? [],
    preferredBarterKinds: (data.preferred_barter_kinds ?? []) as PersonalizationKind[],
    interestedLookingFor: data.interested_looking_for,
    interestedRtb: data.interested_rtb,
    preferredProvince: data.preferred_province,
    preferredCity: data.preferred_city,
    personalizationResetAt: data.personalization_reset_at,
  }
}

export interface UpdatePersonalizationSettingsInput {
  personalizationEnabled?: boolean
  preferredModes?: PersonalizationMode[]
  preferredCategories?: string[]
  preferredBarterKinds?: PersonalizationKind[]
  interestedLookingFor?: boolean
  interestedRtb?: boolean
  preferredProvince?: string | null
  preferredCity?: string | null
}

export async function updatePersonalizationSettings(
  supabase: SupabaseClient,
  userId: string,
  input: UpdatePersonalizationSettingsInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc('update_personalization_settings', {
    p_user_id: userId,
    p_personalization_enabled: input.personalizationEnabled ?? null,
    p_preferred_modes: input.preferredModes ?? null,
    p_preferred_categories: input.preferredCategories ?? null,
    p_preferred_barter_kinds: input.preferredBarterKinds ?? null,
    p_interested_looking_for: input.interestedLookingFor ?? null,
    p_interested_rtb: input.interestedRtb ?? null,
    p_preferred_province: input.preferredProvince ?? null,
    p_preferred_city: input.preferredCity ?? null,
  })

  if (error) {
    if (isMissingRelationError(error)) {
      return { ok: false, error: 'personalization_not_provisioned' }
    }
    return { ok: false, error: 'could_not_save_settings' }
  }
  return { ok: true }
}

/** Section 38/39: wipes behavioral history, bumps the reset cutoff.
 * Never touches financial/transaction records or the settings values
 * themselves (modes/categories/etc. are preserved so re-enabling
 * restores them, per the binding V1 interpretation). */
export async function resetPersonalizationHistory(supabase: SupabaseClient, userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc('reset_personalization_history', { p_user_id: userId })
  if (error) {
    if (isMissingRelationError(error)) return { ok: false, error: 'personalization_not_provisioned' }
    return { ok: false, error: 'could_not_reset_history' }
  }
  return { ok: true }
}
