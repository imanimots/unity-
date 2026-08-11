import { NextRequest, NextResponse } from 'next/server'
import { getPublicProfileReviews } from '@/lib/data/profiles'

interface RouteParams {
  params: Promise<{ id: string }>
}

const PAGE_SIZE = 10

/** GET /api/profile/[id]/reviews?offset=N -- paginated public reviews (Step X). Public, no auth required, same allowlist boundary as getPublicProfileReviews(). */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'Invalid profile id' }, { status: 400 })
  }

  const offsetParam = request.nextUrl.searchParams.get('offset')
  const offset = Math.max(0, Number.parseInt(offsetParam ?? '0', 10) || 0)

  const { reviews, total } = await getPublicProfileReviews(id, { limit: PAGE_SIZE, offset })
  return NextResponse.json({ reviews, total, offset, limit: PAGE_SIZE })
}
