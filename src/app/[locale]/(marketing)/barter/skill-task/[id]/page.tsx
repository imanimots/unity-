import { notFound } from 'next/navigation'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getListingsByMerchant } from '@/lib/data/listings'
import { getAllBarterLockedListingIds } from '@/lib/barter/listing-lock'
import { displayNameOf } from '@/lib/data/profiles'
import { SkillTaskPostDetailClient } from '@/components/barter/skill-task-post-detail-client'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'
import type { BarterSkillTaskPost, BarterSkillTaskPublicPost, BarterSkillTaskPostMilestoneTemplate } from '@/types'

interface PageProps {
  params: Promise<{ id: string }>
}

async function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  return createServiceClient(url, serviceKey)
}

/**
 * SEO indexing stays OFF for this feature unconditionally, per the
 * approved plan -- deliberately NOT wired to the marketplace indexing
 * gate the way /listings/[id] or /looking-for/[id] are.
 */
export async function generateMetadata({ params }: PageProps) {
  const { id } = await params
  const admin = await serviceClient()
  if (!admin) return { title: 'Skill/Task — Unity', robots: PERMANENT_NOINDEX }

  const { data: post } = await admin.from('barter_skill_task_public_posts').select('title, kind').eq('id', id).maybeSingle()
  if (!post) return { title: 'Post not found — Unity', robots: PERMANENT_NOINDEX }

  return { title: `${post.title} — ${post.kind === 'skill' ? 'Skill' : 'Task'} — Unity`, robots: PERMANENT_NOINDEX }
}

export default async function SkillTaskPostDetailPage({ params }: PageProps) {
  const { id } = await params
  const admin = await serviceClient()
  if (!admin) notFound()

  const requester = await getRequestProfile()

  let post: BarterSkillTaskPost | BarterSkillTaskPublicPost | null = null
  let isOwner = false
  let ownerStatus: BarterSkillTaskPost['status'] | null = null

  if (requester) {
    const { data: own } = await admin.from('barter_skill_task_posts').select('*').eq('id', id).eq('owner_id', requester.userId).maybeSingle()
    if (own) {
      post = own as BarterSkillTaskPost
      isOwner = true
      ownerStatus = own.status
    }
  }

  if (!post) {
    const { data: pub } = await admin.from('barter_skill_task_public_posts').select('*').eq('id', id).maybeSingle()
    if (!pub) notFound()
    post = pub as BarterSkillTaskPublicPost
  }

  const [{ data: templates }, { data: ownerProfile }] = await Promise.all([
    admin.from('barter_skill_task_post_milestone_templates').select('*').eq('post_id', id).order('sequence', { ascending: true }),
    admin.from('public_profiles').select('id, display_name, full_name').eq('id', post.owner_id).maybeSingle(),
  ])

  const ownerName = ownerProfile ? displayNameOf(ownerProfile) : 'Unity user'

  const canPropose = Boolean(requester) && !isOwner
  let myListings: Awaited<ReturnType<typeof getListingsByMerchant>> = []
  let ownerListings: Awaited<ReturnType<typeof getListingsByMerchant>> = []
  let mySkillTaskOptions: BarterSkillTaskPublicPost[] = []
  let ownerSkillTaskOptions: BarterSkillTaskPublicPost[] = []

  if (canPropose) {
    const [rawMyListings, rawOwnerListings, { data: myOpts }, { data: ownerOpts }] = await Promise.all([
      getListingsByMerchant(requester!.userId),
      getListingsByMerchant(post.owner_id),
      admin.from('barter_skill_task_public_posts').select('*').eq('owner_id', requester!.userId).eq('direction', 'available'),
      admin.from('barter_skill_task_public_posts').select('*').eq('owner_id', post.owner_id).eq('direction', 'available'),
    ])
    const lockedIds = await getAllBarterLockedListingIds()
    myListings = rawMyListings.filter((l) => l.status === 'active' && !lockedIds.has(l.id))
    ownerListings = rawOwnerListings.filter((l) => l.status === 'active' && !lockedIds.has(l.id))
    mySkillTaskOptions = (myOpts ?? []) as BarterSkillTaskPublicPost[]
    ownerSkillTaskOptions = (ownerOpts ?? []) as BarterSkillTaskPublicPost[]
  }

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen">
      <SkillTaskPostDetailClient
        post={post as BarterSkillTaskPublicPost}
        isOwner={isOwner}
        ownerStatus={ownerStatus}
        milestoneTemplates={(templates ?? []) as BarterSkillTaskPostMilestoneTemplate[]}
        ownerName={ownerName}
        currentUserId={requester?.userId ?? null}
        myListings={myListings}
        ownerListings={ownerListings}
        mySkillTaskOptions={mySkillTaskOptions}
        ownerSkillTaskOptions={ownerSkillTaskOptions}
      />
    </div>
  )
}
