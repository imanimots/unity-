export interface MockMessage {
  id: string
  sender_id: string
  content: string
  created_at: string
  is_blocked: boolean
  block_reason: string | null
}

export interface MockConversation {
  id: string
  other_user: { id: string; name: string; initials: string }
  listing_id: string
  listing_title: string
  listing_cover: string
  booking_id: string
  messages: MockMessage[]
  unread_count: number
}

export const MOCK_CONVERSATIONS: MockConversation[] = [
  {
    id: 'conv-1',
    other_user: { id: 'user-2', name: 'Aisha Patel', initials: 'AP' },
    listing_id: 'listing-1',
    listing_title: 'MacBook Pro 14" M3 Pro',
    listing_cover: 'https://picsum.photos/seed/macbook/800/600',
    booking_id: 'booking-r1',
    unread_count: 0,
    messages: [
      { id: 'm-1-1', sender_id: 'user-2', content: 'Hi Thabo! Thanks for your booking. Let me know if you have any questions about the MacBook.', created_at: '2026-05-01T08:55:00Z', is_blocked: false, block_reason: null },
      { id: 'm-1-2', sender_id: 'user-1', content: 'Hi Aisha! Does it come with all the original accessories?', created_at: '2026-05-01T09:10:00Z', is_blocked: false, block_reason: null },
      { id: 'm-1-3', sender_id: 'user-2', content: 'Yes — original MagSafe charger, USB-C to USB-A adapter, and the box. Everything in perfect condition.', created_at: '2026-05-01T09:18:00Z', is_blocked: false, block_reason: null },
      { id: 'm-1-4', sender_id: 'user-1', content: 'Great! My email is thabo.nkosi@gmail.com — can you send the rental agreement there?', created_at: '2026-05-01T09:25:00Z', is_blocked: true, block_reason: 'Email address detected' },
      { id: 'm-1-5', sender_id: 'user-2', content: 'Hey, looks like your last message was blocked. Please keep all communication on Unity — it protects us both.', created_at: '2026-05-01T09:30:00Z', is_blocked: false, block_reason: null },
      { id: 'm-1-6', sender_id: 'user-1', content: 'Of course, understood! See you Saturday at 10am for pickup.', created_at: '2026-05-01T09:35:00Z', is_blocked: false, block_reason: null },
      { id: 'm-1-7', sender_id: 'user-2', content: 'Perfect. I\'ll have it ready. Safe travels!', created_at: '2026-05-01T09:37:00Z', is_blocked: false, block_reason: null },
    ],
  },
  {
    id: 'conv-2',
    other_user: { id: 'user-4', name: 'Naledi Dlamini', initials: 'ND' },
    listing_id: 'listing-3',
    listing_title: 'Sony A7 IV Full-Frame Camera Kit',
    listing_cover: 'https://picsum.photos/seed/camera1/800/600',
    booking_id: 'booking-r2',
    unread_count: 1,
    messages: [
      { id: 'm-2-1', sender_id: 'user-1', content: 'Hi Naledi! Super excited to use the Sony kit for an event shoot this weekend.', created_at: '2026-06-07T10:00:00Z', is_blocked: false, block_reason: null },
      { id: 'm-2-2', sender_id: 'user-4', content: 'Hi Thabo! It\'s a beautiful kit — you\'ll love it. Let me know when you\'re coming for pickup.', created_at: '2026-06-07T10:08:00Z', is_blocked: false, block_reason: null },
      { id: 'm-2-3', sender_id: 'user-1', content: 'Quick question — are both memory cards included and formatted?', created_at: '2026-06-07T10:15:00Z', is_blocked: false, block_reason: null },
      { id: 'm-2-4', sender_id: 'user-4', content: 'Yes! Two 128GB CFexpress cards, both blank and formatted. Also two charged batteries.', created_at: '2026-06-07T10:20:00Z', is_blocked: false, block_reason: null },
      { id: 'm-2-5', sender_id: 'user-1', content: 'Can I just pay the deposit directly to your FNB account? Easier for me.', created_at: '2026-06-07T10:28:00Z', is_blocked: true, block_reason: 'Off-platform payment request' },
      { id: 'm-2-6', sender_id: 'user-4', content: 'All payments must go through Unity\'s checkout — it protects us both 😊 The system already handled it.', created_at: '2026-06-07T10:35:00Z', is_blocked: false, block_reason: null },
      { id: 'm-2-7', sender_id: 'user-1', content: 'Of course, makes total sense! See you on the 8th.', created_at: '2026-06-07T10:40:00Z', is_blocked: false, block_reason: null },
      { id: 'm-2-8', sender_id: 'user-4', content: 'See you then! Come after 9am. I\'ll have the kit packed and ready.', created_at: '2026-06-08T07:00:00Z', is_blocked: false, block_reason: null },
    ],
  },
  {
    id: 'conv-3',
    other_user: { id: 'user-3', name: 'Johan van der Berg', initials: 'JV' },
    listing_id: 'listing-7',
    listing_title: 'Trek Marlin 7 Mountain Bike (XL)',
    listing_cover: 'https://picsum.photos/seed/bike1/800/600',
    booking_id: 'booking-r4',
    unread_count: 1,
    messages: [
      { id: 'm-3-1', sender_id: 'user-1', content: 'Hi Johan, looking forward to the Marlin! Planning some trails in the Magalies.', created_at: '2026-06-09T08:00:00Z', is_blocked: false, block_reason: null },
      { id: 'm-3-2', sender_id: 'user-3', content: 'Nice choice! The Magalies are great. I\'ll have it freshly serviced before the 20th — new brake pads and chain lube.', created_at: '2026-06-09T08:15:00Z', is_blocked: false, block_reason: null },
    ],
  },
]
