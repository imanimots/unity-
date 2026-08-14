import Link from 'next/link'
import { MapPin, Wifi, Users, Pencil } from 'lucide-react'
import { ProposeTradeButton } from './propose-trade-button'
import { ReportSkillTaskPostDialog } from './report-skill-task-post-dialog'
import { SkillTaskPostActions } from './skill-task-post-actions'
import { ProfileLink } from '@/components/shared/profile-link'
import type {
  BarterSkillTaskPublicPost, BarterSkillTaskPostMilestoneTemplate, BarterSkillTaskPostStatus, Listing,
} from '@/types'

const DELIVERY_LABELS: Record<string, string> = { remote: 'Remote', in_person: 'In person', either: 'Remote or in person' }

interface SkillTaskPostDetailClientProps {
  post: BarterSkillTaskPublicPost
  isOwner: boolean
  ownerStatus: BarterSkillTaskPostStatus | null
  milestoneTemplates: BarterSkillTaskPostMilestoneTemplate[]
  ownerName: string
  currentUserId: string | null
  myListings: Listing[]
  ownerListings: Listing[]
  mySkillTaskOptions: BarterSkillTaskPublicPost[]
  ownerSkillTaskOptions: BarterSkillTaskPublicPost[]
}

export function SkillTaskPostDetailClient({
  post, isOwner, ownerStatus, milestoneTemplates, ownerName, currentUserId, myListings, ownerListings, mySkillTaskOptions, ownerSkillTaskOptions,
}: SkillTaskPostDetailClientProps) {
  const location = [post.city, post.province].filter(Boolean).join(', ')
  const wants = [post.wants_item && 'an item', post.wants_skill && 'a skill', post.wants_task && 'a task', post.wants_cash_adjustment && 'cash top-up'].filter(Boolean)

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-8">
      <div>
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span className="inline-block px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]">
            {post.kind === 'skill' ? 'Skill' : 'Task'}
          </span>
          <span className="inline-block px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]">
            {post.direction === 'available' ? 'Available' : 'Looking For'}
          </span>
        </div>
        <h1 className="text-3xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-2">{post.title}</h1>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">
          By <ProfileLink userId={post.owner_id} displayName={ownerName} currentUserId={currentUserId} className="font-medium" />
        </p>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
        {location && (
          <span className="flex items-center gap-1.5">
            <MapPin size={14} /> {location}
          </span>
        )}
        {post.delivery_mode && (
          <span className="flex items-center gap-1.5">
            <Wifi size={14} /> {DELIVERY_LABELS[post.delivery_mode] ?? post.delivery_mode}
          </span>
        )}
        {wants.length > 0 && (
          <span className="flex items-center gap-1.5">
            <Users size={14} /> Wants {wants.join(', ')}
          </span>
        )}
      </div>

      <div>
        <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Description</h2>
        <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-pre-wrap">{post.description}</p>
      </div>

      {post.desired_exchange_notes && (
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Looking to receive</h2>
          <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-pre-wrap">{post.desired_exchange_notes}</p>
        </div>
      )}

      {(post.exclusions || post.materials_arrangement || post.evidence_expectations) && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {post.exclusions && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-[#9B8B85] mb-1">Exclusions</h3>
              <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{post.exclusions}</p>
            </div>
          )}
          {post.materials_arrangement && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-[#9B8B85] mb-1">Materials</h3>
              <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{post.materials_arrangement}</p>
            </div>
          )}
          {post.evidence_expectations && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-[#9B8B85] mb-1">Evidence expectations</h3>
              <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{post.evidence_expectations}</p>
            </div>
          )}
        </div>
      )}

      {(post.availability_notes || post.preferred_start_date || post.deadline || post.expected_duration_notes) && (
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Availability</h2>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
            {post.preferred_start_date && <span>Preferred start: {post.preferred_start_date}{post.preferred_start_time ? ` ${post.preferred_start_time}` : ''}</span>}
            {post.deadline && <span>Deadline: {post.deadline}</span>}
            {post.expected_duration_notes && <span>{post.expected_duration_notes}</span>}
          </div>
          {post.availability_notes && <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-1">{post.availability_notes}</p>}
        </div>
      )}

      {milestoneTemplates.length > 0 && (
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Milestone preview</h2>
          <p className="text-xs text-[#9B8B85] mb-3">Discovery preview only — not binding. Real milestones are set when an offer is made.</p>
          <div className="space-y-2">
            {milestoneTemplates
              .slice()
              .sort((a, b) => a.sequence - b.sequence)
              .map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm">
                  <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">{m.sequence}. {m.title}</span>
                  <span className="text-[#9B8B85] shrink-0">{m.weight_percent}%</span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="pt-4 border-t border-[#F2EDE8] dark:border-[#2A1A1A] space-y-4">
        {isOwner ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <Link href={`/dashboard/barter/skill-task/${post.id}/edit`} className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-[#8B1A1A] text-[#8B1A1A] text-sm font-semibold hover:bg-[#8B1A1A]/5 transition-colors">
                <Pencil size={14} /> Edit
              </Link>
              {post.direction === 'looking_for' && ownerStatus && (ownerStatus === 'active' || ownerStatus === 'offers_received') && (
                <Link href={`/dashboard/barter/skill-task/${post.id}/offers`} className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors">
                  View offers
                </Link>
              )}
            </div>
            {ownerStatus && <SkillTaskPostActions postId={post.id} status={ownerStatus} direction={post.direction} />}
          </div>
        ) : currentUserId ? (
          <div className="flex flex-wrap gap-3">
            <ProposeTradeButton
              anchorSkillTaskPost={post}
              currentUserId={currentUserId}
              myListings={myListings}
              ownerListings={ownerListings}
              mySkillTaskOptions={mySkillTaskOptions}
              ownerSkillTaskOptions={ownerSkillTaskOptions}
            />
            <ReportSkillTaskPostDialog postId={post.id} />
          </div>
        ) : (
          <Link href={`/login?redirectTo=/barter/skill-task/${post.id}`} className="inline-flex items-center justify-center px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#7A1616] transition-colors">
            Sign in to {post.direction === 'looking_for' ? 'help' : 'make an offer'}
          </Link>
        )}
      </div>
    </div>
  )
}
