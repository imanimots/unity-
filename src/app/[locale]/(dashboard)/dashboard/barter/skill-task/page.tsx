import { redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Plus, Inbox } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { SkillTaskPostActions } from '@/components/barter/skill-task-post-actions'
import { withLocalePrefix, type Locale } from '@/i18n/locales'
import type { BarterSkillTaskPost } from '@/types'

export const metadata = { title: 'Skills & Tasks — Unity' }

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
  active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  offers_received: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  matched: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  paused: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  closed: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
  archived: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
  suspended: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

export default async function SkillTaskPostsPage() {
  const locale = (await getLocale()) as Locale
  const requester = await requireAuth()
  if (!requester) {
    const target = withLocalePrefix('/dashboard/barter/skill-task', locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) redirect(withLocalePrefix('/login', locale))

  const { data: posts } = await supabase
    .from('barter_skill_task_posts')
    .select('*')
    .eq('owner_id', requester.userId)
    .order('created_at', { ascending: false })

  const rows = (posts ?? []) as BarterSkillTaskPost[]

  const t = await getTranslations('merchant.skillTaskPosts')
  const tSkills = await getTranslations('skills')
  const tTasks = await getTranslations('tasks')
  const tMarketplace = await getTranslations('marketplace.direction')
  const tPostStatus = await getTranslations('barter.postStatus')

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-8">
        <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">{t('heading')}</h1>
        <Link
          href="/dashboard/barter/skill-task/new"
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#8B1A1A] text-white text-sm font-semibold hover:bg-[#7A1616] transition-colors"
        >
          <Plus size={15} /> {t('newPost')}
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="text-center py-24 rounded-2xl border border-dashed border-[#F2EDE8] dark:border-[#2A1A1A]">
          <p className="text-5xl mb-5">🤝</p>
          <h2 className="text-lg font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">{t('emptyTitle')}</h2>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{t('emptyDesc')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((post) => (
            <div key={post.id} className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1.5">
                    <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]">
                      {post.kind === 'skill' ? tSkills('label') : tTasks('label')} · {post.direction === 'available' ? tMarketplace('available') : tMarketplace('lookingFor')}
                    </span>
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLES[post.status] ?? ''}`}>
                      {tPostStatus(post.status)}
                    </span>
                  </div>
                  <h2 className="font-bold text-[#1A0A0A] dark:text-[#F5F0ED] truncate">{post.title || t('untitledDraft')}</h2>
                  {post.description && <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] line-clamp-2 mt-0.5">{post.description}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {post.status !== 'draft' && (
                    <Link href={`/barter/skill-task/${post.id}`} className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6B5B55] dark:text-[#9B8B85] hover:underline">
                      {t('view')}
                    </Link>
                  )}
                  <Link href={`/dashboard/barter/skill-task/${post.id}/edit`} className="text-xs font-semibold uppercase tracking-[0.08em] text-[#8B1A1A] hover:underline">
                    {t('edit')}
                  </Link>
                  {post.direction === 'looking_for' && (post.status === 'active' || post.status === 'offers_received') && (
                    <Link
                      href={`/dashboard/barter/skill-task/${post.id}/offers`}
                      className="flex items-center gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-[#8B1A1A] hover:underline"
                    >
                      <Inbox size={12} /> {t('offers')}
                    </Link>
                  )}
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
                <SkillTaskPostActions postId={post.id} status={post.status} direction={post.direction} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
