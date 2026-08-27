import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Eligibility notifications fire before either party has submitted a
 * review, so reviews.header_snapshot won't exist yet -- this resolves
 * the title fresh from the domain's own transaction/listing row in that
 * case, falling back to an already-submitted review's snapshot (cheaper,
 * and consistent with what will actually be displayed) when one exists.
 * Shared by the submit/reply routes (post-success notification) and the
 * internal deadline processor (eligibility/reminder/expiry notification).
 */
export async function resolveTransactionTitle(admin: SupabaseClient, domain: string, transactionId: string): Promise<string> {
  const column = { buy: 'order_id', rent: 'booking_id', barter: 'barter_agreement_id', rent_to_buy: 'rent_to_buy_agreement_id' }[domain]
  if (column) {
    const { data: existing } = await admin.from('reviews').select('header_snapshot').eq(column, transactionId).limit(1).maybeSingle()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const title = (existing?.header_snapshot as any)?.title
    if (title) return title
  }

  if (domain === 'buy') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await admin.from('orders').select('listings(title)').eq('id', transactionId).maybeSingle<any>()
    return data?.listings?.title ?? 'your order'
  }
  if (domain === 'rent') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await admin.from('bookings').select('listings(title)').eq('id', transactionId).maybeSingle<any>()
    return data?.listings?.title ?? 'your rental'
  }
  if (domain === 'barter') {
    const { data: agreement } = await admin
      .from('barter_agreements')
      .select('anchor_listing_id, anchor_skill_task_post_id, source_skill_task_post_id, listings:anchor_listing_id(title)')
      .eq('id', transactionId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .maybeSingle<any>()
    if (agreement?.listings?.title) return agreement.listings.title
    const postId = agreement?.anchor_skill_task_post_id ?? agreement?.source_skill_task_post_id
    if (postId) {
      const { data: post } = await admin.from('barter_skill_task_posts').select('title').eq('id', postId).maybeSingle()
      if (post?.title) return post.title
    }
    return 'your trade'
  }
  if (domain === 'rent_to_buy') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await admin.from('rent_to_buy_agreements').select('listings(title)').eq('id', transactionId).maybeSingle<any>()
    return data?.listings?.title ?? 'your rent-to-buy agreement'
  }
  return 'your transaction'
}

export async function resolveRecipientName(admin: SupabaseClient, userId: string): Promise<string> {
  const { data } = await admin.from('profiles').select('display_name, full_name').eq('id', userId).maybeSingle()
  return data?.display_name ?? data?.full_name ?? 'there'
}
