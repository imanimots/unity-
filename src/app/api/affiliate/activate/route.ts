import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'

function generateAffiliateCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `AFC-${code}`
}

export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`activate:${getClientKey(request)}`, 5, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createClient(url, serviceKey)
  const affiliateCode = generateAffiliateCode()

  const { data, error } = await admin
    .from('profiles')
    .update({ is_affiliate: true, affiliate_code: affiliateCode })
    .eq('id', requester.userId)
    .select('affiliate_code')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ affiliate_code: data.affiliate_code })
}
