import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { mapRentToBuyRpcError } from '@/lib/rent-to-buy/rpc-errors'
import { z } from 'zod'

interface RouteParams {
  params: Promise<{ id: string }>
}

const bodySchema = z.object({ case_id: z.string().uuid() })

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid agreement id' }, { status: 400 })

  const gate = await requireAdminForRoute(request, 'admin:rtb:confirm-return')
  if (!gate.ok) return gate.response

  let body: unknown
  try { body = await request.json() } catch { body = {} }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'A case_id is required' }, { status: 400 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })

  const { data, error } = await admin.rpc('confirm_rent_to_buy_return_completed', { p_admin_id: gate.requester.userId, p_case_id: parsed.data.case_id, p_idempotency_key: null })
  if (error) {
    const mapped = mapRentToBuyRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  return NextResponse.json(data)
}
