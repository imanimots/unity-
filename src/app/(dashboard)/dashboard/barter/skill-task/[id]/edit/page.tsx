import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { SkillTaskPostForm } from '@/components/barter/skill-task-post-form'
import type { BarterSkillTaskPost, BarterSkillTaskPostMilestoneTemplate } from '@/types'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Edit Skill/Task post — Unity' }

export default async function EditSkillTaskPostPage({ params }: PageProps) {
  const { id } = await params
  const requester = await requireAuth()
  if (!requester) redirect(`/login?redirectTo=/dashboard/barter/skill-task/${id}/edit`)

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) notFound()

  const { data: post } = await supabase.from('barter_skill_task_posts').select('*').eq('id', id).eq('owner_id', requester.userId).maybeSingle()
  if (!post) notFound()

  const [{ data: templates }, { data: category }] = await Promise.all([
    supabase.from('barter_skill_task_post_milestone_templates').select('*').eq('post_id', id).order('sequence', { ascending: true }),
    post.category_id ? supabase.from('categories').select('slug').eq('id', post.category_id).maybeSingle() : Promise.resolve({ data: null }),
  ])

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
      <div className="mb-8">
        <Link href="/dashboard/barter/skill-task" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back to Skills &amp; Tasks
        </Link>
        <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mt-4">Edit post</h1>
      </div>
      <SkillTaskPostForm
        initialPost={post as BarterSkillTaskPost}
        initialMilestoneTemplates={(templates ?? []) as BarterSkillTaskPostMilestoneTemplate[]}
        initialCategorySlug={category?.slug ?? undefined}
      />
    </div>
  )
}
