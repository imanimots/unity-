import { NextResponse } from 'next/server'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'

/** GET /api/advertising/packages -- the public, purchasable package catalogue (ad_packages_public view: active, non-test rows only). */
export async function GET() {
  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.from('ad_packages_public').select('*').order('placement_type').order('placement_tier')
  if (error) {
    return NextResponse.json({ error: 'Could not load packages' }, { status: 500 })
  }

  return NextResponse.json({ packages: data ?? [] })
}
