import type { BarterSkillTaskPublicPost, SkillTaskKind, SkillTaskDirection } from '@/types'

export interface SkillTaskBrowseFilters {
  query?: string
}

/**
 * Main Barter browse integration -- Skill+Available / Skill+Looking-For /
 * Task+Available / Task+Looking-For all read barter_skill_task_public_posts
 * (the only public surface for this feature, per R5-2), filtered by
 * kind/direction. No country dimension exists on this table (unlike
 * listings), so no country filter is applied here.
 */
export async function getSkillTaskPublicPosts(
  kind: SkillTaskKind,
  direction: SkillTaskDirection,
  filters: SkillTaskBrowseFilters = {}
): Promise<BarterSkillTaskPublicPost[]> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return []

  let request = supabase
    .from('barter_skill_task_public_posts')
    .select('*')
    .eq('kind', kind)
    .eq('direction', direction)
    .order('created_at', { ascending: false })

  if (filters.query) {
    request = request.or(`title.ilike.%${filters.query}%,description.ilike.%${filters.query}%`)
  }

  const { data } = await request
  return (data as BarterSkillTaskPublicPost[] | null) ?? []
}
