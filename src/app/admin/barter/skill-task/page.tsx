import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { AdminPageHeader, Pill, formatDate } from '@/components/admin/ui'
import { SkillTaskAdminActions } from '@/components/barter/skill-task-admin-actions'
import type { BarterSkillTaskPost, BarterSkillTaskPostStatus } from '@/types'

export const metadata = { title: 'Skill/Task reports — Unity Admin' }

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  offers_received: 'bg-amber-100 text-amber-700',
  matched: 'bg-blue-100 text-blue-700',
  paused: 'bg-amber-100 text-amber-700',
  closed: 'bg-[#F2EDE8] text-[#9B8B85]',
  archived: 'bg-[#F2EDE8] text-[#9B8B85]',
  suspended: 'bg-red-100 text-red-700',
  draft: 'bg-[#F2EDE8] text-[#9B8B85]',
}

interface ReportRow {
  id: string
  post_id: string
  reason: string
  description: string | null
  status: string
  created_at: string
}

/**
 * Admin surface for post-level moderation -- lists Skill/Task posts
 * with at least one open report (barter_skill_task_post_reports),
 * with Suspend/Restore actions calling the existing admin RPCs' routes.
 * Server-rendered with the service-role admin client (this table has
 * zero client read policy at all, per §32).
 */
export default async function AdminSkillTaskReportsPage() {
  const requester = await requireAdmin()
  if (!requester) redirect('/login')

  const admin = await getAdminServiceClient()
  if (!admin) notFound()

  const { data: reports } = await admin
    .from('barter_skill_task_post_reports')
    .select('id, post_id, reason, description, status, created_at')
    .eq('status', 'open')
    .order('created_at', { ascending: false })

  const reportRows = (reports ?? []) as ReportRow[]
  const postIds = [...new Set(reportRows.map((r) => r.post_id))]

  const { data: posts } = postIds.length
    ? await admin.from('barter_skill_task_posts').select('*').in('id', postIds)
    : { data: [] as BarterSkillTaskPost[] }
  const postById = new Map(((posts ?? []) as BarterSkillTaskPost[]).map((p) => [p.id, p]))

  const reportsByPost = new Map<string, ReportRow[]>()
  for (const r of reportRows) {
    const list = reportsByPost.get(r.post_id) ?? []
    list.push(r)
    reportsByPost.set(r.post_id, list)
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Link href="/admin/barter" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
        <ArrowLeft size={13} /> Back to barter trades
      </Link>

      <AdminPageHeader eyebrow="Marketplace" title="Skill/Task reports" />

      {reportsByPost.size === 0 ? (
        <p className="text-sm text-[#9B8B85]">No open reports.</p>
      ) : (
        <div className="space-y-4 max-w-3xl">
          {[...reportsByPost.entries()].map(([postId, postReports]) => {
            const post = postById.get(postId)
            if (!post) return null
            return (
              <div key={postId} className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-bold uppercase tracking-wide text-[#9B8B85]">{post.kind} · {post.direction}</span>
                      <Pill value={post.status} styles={STATUS_STYLES} />
                    </div>
                    <h2 className="font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{post.title || 'Untitled'}</h2>
                  </div>
                  <a href={`/barter/skill-task/${post.id}`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-[#8B1A1A] hover:underline">
                    View public post
                  </a>
                </div>

                <div className="space-y-1.5">
                  {postReports.map((r) => (
                    <div key={r.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85] border-l-2 border-[#F2EDE8] dark:border-[#2A1A1A] pl-2.5">
                      <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{r.reason.replace('_', ' ')}</span> — {formatDate(r.created_at)}
                      {r.description && <p className="mt-0.5">{r.description}</p>}
                    </div>
                  ))}
                </div>

                <SkillTaskAdminActions postId={post.id} status={post.status as BarterSkillTaskPostStatus} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
