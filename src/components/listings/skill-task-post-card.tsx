import { useTranslations } from 'next-intl'
import { MapPin, Wifi } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import type { BarterSkillTaskPublicPost } from '@/types'
import { useSkillTaskLabels } from '@/hooks/use-skill-task-labels'

/** No photos, no price -- a Skill/Task card is deliberately simpler than ListingCard, mirroring RequestCard's own "demand-side, simpler card" precedent. */
export function SkillTaskPostCard({ post }: { post: BarterSkillTaskPublicPost }) {
  const t = useTranslations('marketplace')
  const { kindLabel, directionLabel } = useSkillTaskLabels()
  const DELIVERY_LABELS: Record<string, string> = {
    remote: t('deliveryMode.remote'),
    in_person: t('deliveryMode.inPerson'),
    either: t('deliveryMode.either'),
  }
  const location = [post.city, post.province].filter(Boolean).join(', ')

  return (
    <Link href={`/barter/skill-task/${post.id}`} className="group block rounded-2xl border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] p-5 hover:border-[#8B1A1A]/40 transition-colors">
      <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] mb-3">
        {kindLabel(post.kind)} · {directionLabel(post.direction)}
      </span>
      <h3 className="font-bold text-[#1A0A0A] dark:text-[#F5F0ED] mb-1 line-clamp-2">{post.title}</h3>
      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] line-clamp-2 mb-2">{post.description}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
        {location && (
          <span className="flex items-center gap-1">
            <MapPin size={12} /> {location}
          </span>
        )}
        {post.delivery_mode && (
          <span className="flex items-center gap-1">
            <Wifi size={12} /> {DELIVERY_LABELS[post.delivery_mode] ?? post.delivery_mode}
          </span>
        )}
      </div>
    </Link>
  )
}
