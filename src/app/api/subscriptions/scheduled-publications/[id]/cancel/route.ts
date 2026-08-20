import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/subscriptions/scheduled-publications/[id]/cancel -- owner-only, only while still pending. */
export async function POST(_request: Request, { params }: RouteParams) {
  const { id } = await params
  if (!isValidUuid(id)) return NextResponse.json({ error: 'Invalid schedule id' }, { status: 400 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })

  const { data, error } = await admin.rpc('cancel_scheduled_publication', { p_merchant_id: requester.userId, p_schedule_id: id })
  if (error) {
    const message = error.message ?? ''
    if (message.includes('not found')) return NextResponse.json({ error: 'Schedule not found.' }, { status: 404 })
    if (message.includes('only a pending schedule can be cancelled')) return NextResponse.json({ error: 'Only a pending schedule can be cancelled.' }, { status: 409 })
    return NextResponse.json({ error: 'Could not cancel this schedule — please try again' }, { status: 500 })
  }

  return NextResponse.json(data)
}
