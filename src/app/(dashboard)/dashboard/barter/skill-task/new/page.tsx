import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { SkillTaskPostForm } from '@/components/barter/skill-task-post-form'

export const metadata = { title: 'New Skill/Task post — Unity' }

export default async function NewSkillTaskPostPage() {
  const requester = await requireAuth()
  if (!requester) redirect('/login?redirectTo=/dashboard/barter/skill-task/new')

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
      <div className="mb-8">
        <Link href="/dashboard/barter/skill-task" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back to Skills &amp; Tasks
        </Link>
        <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mt-4">New Skill or Task post</h1>
      </div>
      <SkillTaskPostForm />
    </div>
  )
}
