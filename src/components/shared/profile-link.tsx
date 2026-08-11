import Link from 'next/link'

/**
 * The one reusable "clickable customer identity" component. Wraps a
 * display name (optionally with an avatar) in a link to the public
 * profile page. Renders as plain, non-interactive text when `userId`
 * is missing/self-referential/blank, so callers never need their own
 * conditional -- just always render <ProfileLink>.
 */
export function ProfileLink({
  userId,
  displayName,
  currentUserId,
  className,
  children,
}: {
  userId: string | null | undefined
  displayName: string
  /** When this equals `userId`, renders plain text -- a self-link inside a review/listing card is not useful. */
  currentUserId?: string | null
  className?: string
  children?: React.ReactNode
}) {
  if (!userId || userId === currentUserId) {
    return <span className={className}>{children ?? displayName}</span>
  }

  return (
    <Link href={`/profile/${userId}`} className={className ? `${className} hover:underline` : 'hover:underline'}>
      {children ?? displayName}
    </Link>
  )
}
