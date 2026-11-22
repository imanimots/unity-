/**
 * LEARN_ARTICLES -- the "Learn About Unity" half of the Help Center.
 * See types.ts's LearnArticle doc comment for why this is a separate
 * shape from HelpTask rather than a forced fit into one. Slugs here
 * share the same /help/[slug] route namespace as HELP_TASKS (see
 * registries.test.ts's cross-registry uniqueness check), and every
 * cross-reference (relatedTaskIds / relatedLearnIds) is validated
 * against the real id sets in both registries by that same test --
 * there is no untested link in either direction.
 *
 * Every explanation below is grounded in the actual implementation,
 * not invented: search_listings (20260902000004 + later filter/rent-
 * to-buy migrations), the booking/listing/dispute/kyc status enums
 * and their widening migrations, reviews_v2, the advertising MVP's
 * ADVERTISING_ENABLED flag and sponsored-label UI, and the provider-
 * neutral payment/escrow/KYC/logistics state already established
 * throughout this engagement's own audits. Nothing here names Peach,
 * PayFast, TradeSafe, Bob Go or a KYC vendor as a live production
 * authority -- see each payments/verification/delivery article's own
 * wording.
 */

import type { LearnArticle } from './types'

export const LEARN_ARTICLES: LearnArticle[] = [
  // ──────────────────────────────────────────────────────────────
  // SEARCH & DISCOVERY
  // ──────────────────────────────────────────────────────────────
  {
    id: 'learn-how-search-works',
    slug: 'how-unity-search-works',
    title: 'How Unity Search Works',
    articleType: 'learn',
    role: ['guest', 'user', 'merchant'],
    category: 'search-discovery',
    summary: 'What happens when you search, and why some listings show up before others.',
    quickAnswer: [
      'An exact title match always ranks first.',
      'A keyword match ranks next, best keyword coverage first.',
      'A close-but-not-exact match (e.g. a typo or a similar word) ranks last, and only if it’s a fairly close match.',
      'Filters (category, location, price, dates, mode) narrow the list before any of that ranking happens.',
    ],
    sections: [
      {
        heading: 'What gets searched',
        body: [
          'Every search looks at each listing’s title (and, for a keyword match, its full searchable text) across all active, published listings on Unity -- never draft listings, never suspended or removed listings, and never test/QA listings.',
          'A listing only appears in search results if it’s currently active and published. A paused, suspended, draft, or rented-out (for a once-off sale) listing won’t show up, even if it matches your search perfectly.',
        ],
      },
      {
        heading: 'How a match is ranked',
        body: [
          'Unity ranks a listing into one of three tiers, and always shows higher tiers first:',
          '1. Exact title match -- your search text matches the listing title exactly (ignoring case and extra spaces). This always ranks highest.',
          '2. Keyword match -- your search words appear in the listing’s title or description as real words (not just a coincidental substring). Listings matching more of your words, or more important words, rank higher within this tier.',
          '3. Close match -- no exact or keyword match was found, but the listing title is textually similar to what you typed (useful for typos or near-miss wording). This is the lowest-confidence tier, and only applies above a similarity threshold -- a search that’s too different from any listing won’t force a match just to show you something.',
          'If you search with no text at all (browsing a category with filters only), every eligible listing is shown with no ranking tier applied, ordered by whatever sort you’ve chosen.',
        ],
      },
      {
        heading: 'Filters narrow the list first',
        body: [
          'Before ranking happens, Unity removes any listing that doesn’t match your active filters: category, country, province, city, price range, Buy/Rent/Barter mode, and -- for rentals -- your chosen dates. A listing that would otherwise match your search text perfectly still won’t appear if it fails one of these filters.',
          'Rent-to-Buy listings appear automatically when you search in Rent mode (Rent-to-Buy is a feature of renting, not a separate mode) -- see "Buy, Rent, Barter & Rent-to-Buy Explained" for why.',
          'A listing that’s currently part of an active barter trade or an active Rent-to-Buy agreement is temporarily hidden from search while that transaction is in progress, so you never see something you can’t actually get.',
        ],
      },
      {
        heading: 'Sorting',
        body: [
          'By default, results are sorted by relevance when you search with text, or by newest-first when you’re browsing without a search term.',
          'You can also sort by price (low to high or high to low) at any time -- this overrides the relevance ranking above and simply orders the filtered list by price.',
        ],
      },
      {
        heading: 'Why results can change',
        body: [
          'Results reflect the marketplace right now -- a listing that disappears between two searches was likely paused, booked out for the dates you picked, suspended, or simply removed by its owner. Nothing is cached long enough to show you stale availability.',
        ],
      },
    ],
    relatedTaskIds: ['search-item', 'filter-listings', 'browse-items'],
    relatedLearnIds: [
      'learn-better-search-results',
      'learn-search-filters-explained',
      'learn-why-not-seeing-results',
      'learn-search-ranking-and-promoted-listings',
    ],
    keywords: ['search', 'ranking', 'relevance', 'how search works', 'results order'],
    synonyms: ['why does my search show this', 'search algorithm', 'how are results sorted'],
    providerDependency: null,
  },
  {
    id: 'learn-better-search-results',
    slug: 'how-to-get-better-search-results',
    title: 'How to Get Better Search Results',
    articleType: 'learn',
    role: ['guest', 'user'],
    category: 'search-discovery',
    summary: 'Practical ways to find what you’re looking for faster.',
    quickAnswer: [
      'Search the item, not the use case.',
      'Start broad, then add filters one at a time.',
      'If nothing comes back, remove your most restrictive filter first.',
    ],
    sections: [
      {
        heading: 'Search for the thing, not the task',
        body: [
          'Unity matches listing titles and descriptions, not intentions -- searching for what you want to DO rarely works as well as searching for the ITEM itself.',
        ],
      },
      {
        heading: 'Start broad, then narrow',
        body: [
          'A single strong keyword, with no filters yet, shows you the full range of what’s available. Add one filter at a time -- category, then price, then location -- and watch how the results shrink. If you add all your filters at once and get zero results, you won’t know which one was too strict.',
        ],
      },
      {
        heading: 'Try alternative words',
        body: [
          'If your first search comes back thin, try a more generic or a more specific version of the same word -- "drill" instead of "power tool," or "cordless drill" instead of just "drill" if you’re getting too many unrelated results. Checking spelling helps too -- Unity’s close-match tier (see "How Unity Search Works") can catch a typo, but only when the rest of your search is already fairly specific.',
        ],
      },
      {
        heading: 'Use filters deliberately',
        body: [
          'Location: widening your province/city filter (or clearing it) often reveals more results than changing your search text.',
          'Price: a narrow price range is one of the most common reasons a good listing gets filtered out -- try widening it before giving up on a search term.',
          'Dates (for rentals): if nothing is available for your exact dates, try a shorter window or slightly different dates -- an item can be genuinely booked for part of a date range and free for the rest.',
          'Mode: an item listed for Barter won’t appear when you’re searching in Buy mode, and vice versa -- if you’re open to more than one transaction type, try searching in each mode.',
        ],
      },
      {
        heading: 'When search genuinely can’t help',
        body: [
          'If nothing like what you need exists on Unity right now, posting a Marketplace Request lets sellers and merchants come to you instead -- see "How Marketplace Requests Work."',
        ],
      },
    ],
    example: [
      { label: 'Too vague', text: 'Looking for something cheap that I can use to drill walls' },
      { label: 'Better', text: 'cordless drill' },
      { label: 'Then narrow with filters', text: 'Category: Tools · Price: under R500 · Location: your city' },
    ],
    relatedTaskIds: ['search-item', 'filter-listings', 'cannot-find', 'post-looking-for'],
    relatedLearnIds: ['learn-how-search-works', 'learn-why-not-seeing-results', 'learn-search-filters-explained'],
    keywords: ['better search results', 'search tips', 'how to find items', 'search help'],
    synonyms: ['can’t find item', 'search not working', 'improve my search'],
    providerDependency: null,
  },
  {
    id: 'learn-search-filters-explained',
    slug: 'search-filters-explained',
    title: 'Search Filters Explained',
    articleType: 'reference',
    role: ['guest', 'user'],
    category: 'search-discovery',
    summary: 'What each real search filter does, and when to use it.',
    sections: [
      {
        heading: 'Category',
        body: ['Narrows results to one product category. Use it when your search term is common across unrelated categories (e.g. "stand" could be a tripod stand or a market stall stand).'],
      },
      {
        heading: 'Mode: Buy, Rent, Barter',
        body: [
          'Buy shows listings for sale. Rent shows rental listings -- including any listing with Rent-to-Buy terms enabled, since Rent-to-Buy is a way of renting, not a separate mode. Barter shows listings open to trade rather than cash.',
        ],
      },
      {
        heading: 'Location (province / city)',
        body: ['Province matches your selection exactly. City matches as a partial, case-insensitive text match, since sellers enter city as free text -- "sandton" will match "Sandton" and "Sandton City."'],
      },
      {
        heading: 'Price range',
        body: ['Filters by the listing’s daily rental rate or sale price, whichever applies to that listing.'],
      },
      {
        heading: 'Rental dates',
        body: [
          'For rentals, choosing a start and end date filters out any listing that’s already booked, or that the merchant has blocked out, for any part of that range. This is a "likely available" signal at search time, not a guaranteed hold -- availability is only locked in once your booking is actually accepted.',
        ],
      },
    ],
    relatedTaskIds: ['filter-listings', 'search-item'],
    relatedLearnIds: ['learn-how-search-works', 'learn-better-search-results'],
    keywords: ['search filters', 'filter listings', 'location filter', 'price filter', 'date filter'],
    synonyms: ['narrow search', 'filter options'],
    providerDependency: null,
  },
  {
    id: 'learn-why-not-seeing-results',
    slug: 'why-am-i-not-seeing-results',
    title: 'Why Am I Not Seeing Results?',
    articleType: 'learn',
    role: ['guest', 'user'],
    category: 'search-discovery',
    summary: 'The real reasons a listing might not show up, and what to check first.',
    sections: [
      {
        heading: 'Checklist',
        body: [
          'Filters too narrow -- a combination of price, location, and category can rule out everything at once. Remove filters one at a time, starting with price range or location.',
          'Dates unavailable -- for rentals, your exact date range may not be free for anything that matches, even if the item exists. Try a shorter or different range.',
          'Wrong mode -- an item for Barter won’t show up when searching Buy, and vice versa.',
          'Listing paused, suspended, or removed -- only active, published listings appear in search. A listing you saw before and can’t find again may have been paused by its owner or removed for a policy reason.',
          'Spelling or wording -- try a more common or more generic word for the item.',
          'It genuinely doesn’t exist on Unity yet -- consider posting a Marketplace Request instead of continuing to search.',
        ],
      },
    ],
    relatedTaskIds: ['cannot-find', 'filter-listings', 'post-looking-for'],
    relatedLearnIds: ['learn-how-search-works', 'learn-better-search-results', 'learn-search-filters-explained'],
    keywords: ['no search results', 'empty results', 'why no results', 'not seeing listings'],
    synonyms: ['search broken', 'zero results', 'nothing found'],
    providerDependency: null,
  },
  {
    id: 'learn-search-ranking-and-promoted-listings',
    slug: 'search-ranking-and-promoted-listings',
    title: 'Search Ranking & Promoted Listings',
    articleType: 'learn',
    role: ['guest', 'user', 'merchant'],
    category: 'search-discovery',
    summary: 'How organic ranking works, and how a promoted listing would be labeled if you saw one.',
    sections: [
      {
        heading: 'Organic ranking is the same for everyone',
        body: [
          'Every search result you see today is ranked purely by match quality and your own filters -- exact title match, then keyword match, then close match (see "How Unity Search Works"). There is no personalization or behavioral targeting behind these results.',
        ],
      },
      {
        heading: 'Promoted content, if you ever see it',
        body: [
          'Unity has a "Sponsored" label built in for promoted placements, and a listing carrying that label would always be clearly marked as sponsored -- never blended invisibly into organic results.',
          'Advertising is not switched on in production today, so you will not currently encounter a sponsored listing while searching or browsing.',
        ],
      },
      {
        heading: 'What promotion can and can’t buy',
        body: [
          'A promoted placement, when active, only ever affects where a listing appears -- it cannot purchase reviews, verification status, or organic reputation. Those are earned the same way for every seller and merchant, promoted or not.',
        ],
      },
      {
        heading: 'Why two people might see different results',
        body: [
          'Everyone sees the same ranking for the same search text and filters. If you and someone else see different results for what feels like the same search, check whether your filters (location, dates, mode) actually match -- that’s almost always the real difference, not personalization.',
        ],
      },
    ],
    relatedTaskIds: [],
    relatedLearnIds: ['learn-how-search-works', 'learn-better-search-results'],
    keywords: ['promoted listings', 'sponsored', 'advertising', 'search ranking', 'why did results change'],
    synonyms: ['paid listings', 'ads on unity', 'boosted listings'],
    providerDependency: null,
  },

  // ──────────────────────────────────────────────────────────────
  // GETTING STARTED
  // ──────────────────────────────────────────────────────────────
  {
    id: 'learn-buy-rent-barter-rtb',
    slug: 'buy-rent-barter-and-rent-to-buy-explained',
    title: 'Buy, Rent, Barter & Rent-to-Buy Explained',
    articleType: 'learn',
    role: ['guest', 'user'],
    category: 'getting-started',
    summary: 'The three ways to transact on Unity, and where Rent-to-Buy fits in.',
    quickAnswer: [
      'Buy and Sell -- a straightforward once-off purchase, like any marketplace.',
      'Rent -- borrow an item for a set period and return it.',
      'Barter -- trade an item, skill, or task directly with someone else, no cash required.',
      'Rent-to-Buy is a feature of Rent, not a fourth separate mode -- it’s a rental with the option to end in ownership.',
    ],
    sections: [
      {
        heading: 'Buy',
        body: ['A listing marked for sale transfers ownership to the buyer once the transaction completes -- the same as buying anything secondhand, just with Unity handling the listing, messaging, and transaction record.'],
      },
      {
        heading: 'Rent',
        body: [
          'A rental listing stays owned by the merchant throughout. You choose dates, the merchant accepts (or declines) your request, and the item comes back to them at the end of the rental period.',
          'Some rental listings also offer Rent-to-Buy terms -- see the next section.',
        ],
      },
      {
        heading: 'Rent-to-Buy',
        body: [
          'Rent-to-Buy is a specific kind of rental agreement, not a separate transaction type: you pay in installments over time, and if you complete the agreed installments, ownership transfers to you at the end instead of returning the item.',
          'Because it’s a feature of renting, Rent-to-Buy-enabled listings appear automatically whenever you search or browse in Rent mode -- you don’t need a separate mode or tab to find them.',
        ],
      },
      {
        heading: 'Barter',
        body: ['Barter trades an item, a skill, or a task directly for something else of value -- another item, a skill, a task, or a combination plus a cash top-up, with no money changing hands for the base trade itself.'],
      },
    ],
    relatedTaskIds: ['browse-items', 'buy-item', 'rent-item', 'barter-item', 'find-rtb-item'],
    relatedLearnIds: ['learn-how-search-works'],
    keywords: ['buy', 'rent', 'barter', 'rent-to-buy', 'how unity works', 'transaction types'],
    synonyms: ['what is unity', 'marketplace modes', 'ways to transact'],
    providerDependency: null,
  },
  {
    id: 'learn-glossary',
    slug: 'unity-glossary',
    title: 'Unity Glossary',
    articleType: 'reference',
    role: ['guest', 'user', 'merchant'],
    category: 'getting-started',
    summary: 'Plain-language definitions of terms used across Unity.',
    sections: [],
    definitions: [
      { term: 'Listing', definition: 'An item a merchant or user has published for sale, rent, or barter.' },
      { term: 'Merchant', definition: 'A seller account type that can list items, hold a subscription plan, and access merchant-specific tools.' },
      { term: 'Buyer / Seller', definition: 'The two parties in a once-off purchase transaction.' },
      { term: 'Renter', definition: 'The person renting an item for a set period.' },
      { term: 'Rental', definition: 'A booking for an item over a chosen date range, returned at the end.' },
      { term: 'Barter', definition: 'Trading an item, skill, or task directly for something else of value, without cash.' },
      { term: 'Rent-to-Buy', definition: 'A rental agreement where completing the agreed installments transfers ownership to the renter.' },
      { term: 'Marketplace Request', definition: 'A post describing something you’re looking for, so sellers can respond with offers instead of you searching listings.' },
      { term: 'Offer', definition: 'A response to a Marketplace Request, or a counter-proposal in a barter negotiation.' },
      { term: 'Booking', definition: 'A confirmed or requested rental for specific dates.' },
      { term: 'Order', definition: 'A confirmed once-off Buy/Sell transaction.' },
      { term: 'Payment', definition: 'A charge associated with a booking or order -- see "How Payments Work on Unity" for the full lifecycle.' },
      { term: 'Refund', definition: 'Money returned to a payer, in full or in part, usually following a cancellation or dispute outcome.' },
      { term: 'Dispute', definition: 'A formal disagreement raised about a transaction, reviewed with evidence from both sides.' },
      { term: 'Verification', definition: 'A manual review of identity (and, for merchants, business) information before certain actions are allowed.' },
      { term: 'Commission', definition: 'The percentage Unity retains from a qualifying transaction, set by the seller’s plan.' },
      { term: 'Platform Fee', definition: 'A general term for amounts Unity retains for operating the marketplace -- see commission for the specific mechanism.' },
      { term: 'Availability', definition: 'The dates a rental listing is free to book, based on the merchant’s own calendar and any existing bookings.' },
      { term: 'Promoted Listing', definition: 'A listing shown in a paid placement, always labeled "Sponsored" -- distinct from organic search ranking.' },
      { term: 'Review', definition: 'Feedback left after a completed, verified transaction.' },
      { term: 'Rating', definition: 'The numeric score attached to a review.' },
      { term: 'Handover', definition: 'The point where an item physically changes hands -- collection, delivery, or return.' },
      { term: 'Payout', definition: 'Money transferred to a merchant’s payout destination for completed sales or rentals.' },
    ],
    relatedTaskIds: [],
    relatedLearnIds: ['learn-buy-rent-barter-rtb'],
    keywords: ['glossary', 'definitions', 'terms', 'what does this mean'],
    synonyms: ['unity terms', 'dictionary', 'what is a booking', 'what is an order'],
    providerDependency: null,
  },

  // ──────────────────────────────────────────────────────────────
  // LISTINGS / MARKETPLACE REQUESTS
  // ──────────────────────────────────────────────────────────────
  {
    id: 'learn-listing-statuses',
    slug: 'understanding-listing-statuses',
    title: 'Understanding Listing Statuses',
    articleType: 'learn',
    role: ['user', 'merchant'],
    category: 'selling-listing',
    summary: 'What each listing status means, and why a listing might change status.',
    sections: [
      {
        heading: 'The statuses',
        body: [
          'Draft -- saved but not published; only you can see it.',
          'Pending -- submitted and awaiting a check before it goes live.',
          'Active -- published and visible in search and browse.',
          'Paused -- temporarily hidden by its owner, without losing its history or settings.',
          'Suspended -- hidden by Unity, usually for a policy reason -- see "Marketplace Rules & Prohibited Behaviour."',
          'Rented -- (sale listings specifically) sold and no longer available.',
        ],
      },
      {
        heading: 'Temporarily hidden for a different reason',
        body: [
          'A listing currently tied up in an active barter trade or an in-progress Rent-to-Buy agreement is temporarily excluded from search and browse, even while its status is still Active -- this protects buyers from committing to something that’s already spoken for, and reverses automatically once that transaction ends.',
        ],
      },
      {
        heading: 'Why availability or price can change',
        body: [
          'A merchant can edit price and availability at any time for a listing that isn’t already part of a confirmed booking -- so a listing you saved earlier may show different terms than when you first found it.',
        ],
      },
    ],
    relatedTaskIds: ['list-an-item', 'publish-listing', 'pause-listing', 'edit-listing'],
    relatedLearnIds: ['learn-how-to-write-a-findable-listing'],
    keywords: ['listing status', 'why is my listing hidden', 'listing suspended', 'listing paused'],
    synonyms: ['listing disappeared', 'why listing removed'],
    providerDependency: null,
  },
  {
    id: 'learn-how-to-write-a-findable-listing',
    slug: 'how-to-write-a-listing-that-gets-found',
    title: 'How to Write a Listing That Gets Found',
    articleType: 'learn',
    role: ['user', 'merchant'],
    category: 'selling-listing',
    summary: 'Why your listing’s title, category, and photos matter for how often it’s seen.',
    sections: [
      {
        heading: 'Title',
        body: ['Search ranks an exact title match highest and a keyword match second -- a plain, accurate, commonly-searched title ("Cordless drill, 18V") will be found far more often than a creative or vague one ("Great deal, must see!").'],
      },
      {
        heading: 'Category',
        body: ['Choosing the correct category matters because category is one of the filters buyers actually use to narrow results -- a mis-categorized listing is invisible to anyone filtering by category, no matter how good the title is.'],
      },
      {
        heading: 'Photos and description',
        body: [
          'Clear photos and an honest, complete description (including visible defects) build buyer confidence and reduce back-and-forth messaging -- and a complete, accurate listing is simply more trustworthy to act on quickly.',
          'Avoid stuffing a title or description with unrelated keywords to try to match more searches -- it doesn’t improve ranking (search ranks real keyword matches and exact matches, not keyword density) and it damages buyer trust.',
        ],
      },
      {
        heading: 'Pricing and availability',
        body: ['A realistic price and accurate availability both reduce declined requests and last-minute cancellations, which matters more to your reputation over time than any single listing’s visibility.'],
      },
      {
        heading: 'Keeping it current',
        body: ['Edit a listing when price, availability, or condition genuinely changes, rather than leaving outdated information live -- an accurate, recently-updated listing is more useful to buyers than a stale one, even if nothing about the photos or title changed.'],
      },
    ],
    relatedTaskIds: ['list-an-item', 'edit-listing', 'create-rental-listing', 'create-sale-listing'],
    relatedLearnIds: ['learn-how-search-works', 'learn-listing-statuses', 'learn-getting-better-results-on-unity'],
    keywords: ['good listing', 'listing tips', 'improve listing', 'listing performance', 'sell faster'],
    synonyms: ['get more views', 'why no one is buying', 'better listing photos'],
    providerDependency: null,
  },
  {
    id: 'learn-marketplace-requests',
    slug: 'how-marketplace-requests-work',
    title: 'How Marketplace Requests Work',
    articleType: 'learn',
    role: ['guest', 'user', 'merchant'],
    category: 'looking-for',
    summary: 'When to post a request instead of searching, and how responses work.',
    sections: [
      {
        heading: 'When to use a request instead of search',
        body: ['If you’ve searched and nothing matches -- or you want something specific enough that waiting for the right seller to find you makes more sense -- posting a request flips the usual direction: sellers come to you.'],
      },
      {
        heading: 'What makes a request useful',
        body: [
          'Be specific about what you want, your budget range, your location, and (for a rental need) your dates -- a vague request gets vague or no responses.',
        ],
      },
      {
        heading: 'Receiving and comparing responses',
        body: ['Responses can link an existing listing, make a private offer, or just start a conversation. Compare responses the same way you’d compare listings -- price, condition, location, and the responder’s profile and reviews.'],
      },
      {
        heading: 'Closing or cancelling a request',
        body: ['Once you’ve found what you need, close the request so others stop responding to it. You can cancel a request at any time if you no longer need it.'],
      },
      {
        heading: 'Safety when responding to requests',
        body: ['The same safety practices apply as any other Unity transaction -- keep communication on the platform and never pay or share sensitive information outside it. See "Marketplace Safety" for the full guidance.'],
      },
    ],
    relatedTaskIds: ['post-looking-for', 'cannot-find'],
    relatedLearnIds: ['learn-better-search-results'],
    keywords: ['marketplace request', 'looking for', 'post a request', 'how requests work'],
    synonyms: ['request an item', 'ask for something'],
    providerDependency: null,
  },

  // ──────────────────────────────────────────────────────────────
  // REVIEWS / VERIFICATION
  // ──────────────────────────────────────────────────────────────
  {
    id: 'learn-how-reviews-work',
    slug: 'how-reviews-work',
    title: 'How Reviews Work',
    articleType: 'learn',
    role: ['user', 'merchant'],
    category: 'reviews',
    summary: 'Who can leave a review, when, and how moderation protects them.',
    sections: [
      {
        heading: 'Who can review, and when',
        body: ['A review can only be left for a real, completed transaction between the two parties involved -- you can’t review someone you haven’t actually transacted with, and there’s a window after completion during which a review can be submitted.'],
      },
      {
        heading: 'What makes a review useful',
        body: ['Specific, honest feedback about the actual item, communication, or transaction helps the next person far more than a generic rating -- mention what matched (or didn’t match) the listing, how handover went, and anything future buyers should know.'],
      },
      {
        heading: 'Prohibited review behavior',
        body: ['Fake reviews, revenge reviews unrelated to the actual transaction, and any attempt to manipulate another user’s rating are against the rules and can be reported.'],
      },
      {
        heading: 'Reporting and moderation',
        body: ['A review can be reported if it looks fake, abusive, or unrelated to a real transaction. Reported reviews are checked, and a review found to violate the rules can be removed.'],
      },
    ],
    relatedTaskIds: ['leave-review'],
    relatedLearnIds: ['learn-what-verification-means'],
    keywords: ['reviews', 'ratings', 'how reviews work', 'fake reviews', 'review removed'],
    synonyms: ['leave feedback', 'rate a seller', 'review disappeared'],
    providerDependency: null,
  },
  {
    id: 'learn-what-verification-means',
    slug: 'what-verification-means',
    title: 'What Verification Means (and Doesn’t Mean)',
    articleType: 'learn',
    role: ['guest', 'user', 'merchant'],
    category: 'account-privacy',
    summary: 'Why verification exists, what it checks today, and what it never guarantees.',
    sections: [
      {
        heading: 'Why verification exists',
        body: ['Verification links an account to a real identity before certain actions (like publishing a listing or booking certain transactions) are allowed -- it raises the cost of creating a fake or disposable account to misuse the marketplace.'],
      },
      {
        heading: 'How it works today',
        body: [
          'Identity documents you submit are reviewed manually by Unity’s own team today -- there is no third-party automated verification vendor connected yet. A submission moves through a pending state while it’s being reviewed, and ends in either approval or rejection, with a reason if rejected.',
          'If more information is needed, you may be asked to resubmit or clarify something before a decision is made.',
        ],
      },
      {
        heading: 'What verification does NOT guarantee',
        body: [
          'Verification confirms identity, not honesty, item condition, or transaction outcome. A verified account can still misrepresent an item or behave unreasonably -- verification is one safety layer, not a substitute for your own judgment.',
          'Verification cannot be purchased, and promoted listings never buy or bypass verification -- see "Search Ranking & Promoted Listings."',
        ],
      },
    ],
    relatedTaskIds: ['verify-identity', 'verify-merchant-account'],
    relatedLearnIds: ['learn-how-to-recognise-a-scam'],
    keywords: ['verification', 'kyc', 'identity verification', 'what does verified mean'],
    synonyms: ['verification pending', 'verification failed', 'why verify my account'],
    providerDependency: 'kyc',
  },

  // ──────────────────────────────────────────────────────────────
  // PAYMENTS & FEES
  // ──────────────────────────────────────────────────────────────
  {
    id: 'learn-how-payments-work',
    slug: 'how-payments-work-on-unity',
    title: 'How Payments Work on Unity',
    articleType: 'learn',
    role: ['user', 'merchant'],
    category: 'payments-fees',
    summary: 'The general shape of a Unity payment, kept provider-neutral until the production payment provider is activated.',
    sections: [
      {
        heading: 'The general lifecycle',
        body: [
          'A payment on Unity moves through a few conceptual stages regardless of which provider ultimately processes it: it’s requested, authorised, and then captured once the transaction is confirmed. For transactions that hold funds temporarily (certain rentals and disputes), funds are held and then released once the conditions for release are met.',
          'A failed or declined payment simply means the charge didn’t go through -- you’ll be asked to try again or use a different payment method, and no transaction proceeds until payment succeeds.',
        ],
      },
      {
        heading: 'Refunds',
        body: ['A refund returns some or all of a payment, most commonly following a cancellation under the applicable policy or a dispute resolved in the payer’s favor. A refund’s status is visible on the relevant booking or order.'],
      },
      {
        heading: 'Where this stands today',
        body: ['Unity’s payment infrastructure is provider-neutral by design -- the specific production payment provider is not yet the live authority for real transactions, so this article deliberately describes the general model rather than naming a specific vendor. This will be updated once a production provider is active.'],
      },
    ],
    relatedTaskIds: ['manage-order', 'view-bookings'],
    relatedLearnIds: ['learn-fees-and-commissions', 'learn-cancellations-refunds-disputes'],
    keywords: ['payments', 'how payments work', 'refund', 'held funds', 'failed payment'],
    synonyms: ['money back', 'payment pending', 'payment status'],
    providerDependency: 'tradesafe',
  },
  {
    id: 'learn-fees-and-commissions',
    slug: 'fees-and-commissions-explained',
    title: 'Fees & Commissions Explained',
    articleType: 'learn',
    role: ['merchant'],
    category: 'payments-fees',
    summary: 'How Unity’s commission works, and why it can differ between merchants.',
    sections: [
      {
        heading: 'How commission works',
        body: [
          'Unity retains a commission -- a percentage of a qualifying sale or rental payment -- rather than charging a flat listing fee. The exact percentage depends on the merchant’s subscription plan: a higher-tier plan carries a lower commission rate.',
          'Barter transactions never carry a commission, on any plan -- this is a fixed rule, not a promotional rate.',
        ],
      },
      {
        heading: 'When commission is finalized',
        body: ['A commission is calculated once a payment qualifies, and only becomes final after the applicable review window passes with no refund or dispute affecting it. A refund or an approved partial dispute outcome can reduce or void a commission that hasn’t finalized yet.'],
      },
      {
        heading: 'Payout timing, conceptually',
        body: ['Funds owed to a merchant become part of their payout once a transaction completes and clears any holding/dispute window -- see "How Payments Work on Unity" for the general lifecycle this follows.'],
      },
    ],
    relatedTaskIds: ['view-earnings', 'view-plan', 'upgrade-downgrade'],
    relatedLearnIds: ['learn-how-payments-work'],
    keywords: ['commission', 'platform fee', 'merchant fees', 'how much does unity take'],
    synonyms: ['unity cut', 'seller fees', 'merchant commission rate'],
    providerDependency: null,
  },

  // ──────────────────────────────────────────────────────────────
  // DISPUTES / SAFETY / DELIVERY
  // ──────────────────────────────────────────────────────────────
  {
    id: 'learn-cancellations-refunds-disputes',
    slug: 'cancellations-refunds-and-disputes',
    title: 'Cancellations, Refunds & Disputes: How They Work',
    articleType: 'learn',
    role: ['user', 'merchant'],
    category: 'problems-disputes',
    summary: 'The canonical explanation of what happens when a transaction doesn’t go as planned.',
    sections: [
      {
        heading: 'Cancelling before anything has started',
        body: ['Either party can usually cancel a booking before it becomes active, subject to the specific transaction’s own cancellation terms -- renter-initiated and merchant-initiated cancellations are both supported, with the resulting refund (if any) depending on how far along the booking was.'],
      },
      {
        heading: 'Raising a dispute',
        body: [
          'A dispute is for when a transaction has already progressed and something went wrong -- the item didn’t match its description, wasn’t returned on time, was damaged, or a payment issue needs resolving.',
          'Opening a dispute moves the transaction into a formal review: both sides can submit evidence (messages, photos, condition documentation) before Unity reviews the case.',
        ],
      },
      {
        heading: 'What evidence actually helps',
        body: ['Photos and documentation from BEFORE and AFTER handover (condition evidence), and relevant messages, are the most useful evidence -- see the condition-evidence and dispute-evidence how-to guides for exactly where to upload these.'],
      },
      {
        heading: 'What happens during review',
        body: ['An admin reviews the submitted evidence from both parties and the transaction’s own history before reaching a resolution. A resolution can restore the booking, direct a refund, or close the dispute without further action, depending on what the evidence supports.'],
      },
      {
        heading: 'After resolution',
        body: ['Once a dispute resolves, any financial adjustment (refund, released hold, or adjusted commission) follows automatically from that outcome -- see "How Payments Work on Unity" for how holds and refunds move.'],
      },
    ],
    relatedTaskIds: ['raise-dispute', 'respond-to-dispute', 'upload-evidence', 'check-dispute', 'cancel-rental', 'report-purchase-problem'],
    relatedLearnIds: ['learn-how-payments-work', 'learn-how-to-recognise-a-scam'],
    keywords: ['disputes', 'cancellation', 'refund', 'how disputes work', 'evidence'],
    synonyms: ['money back', 'item not as described', 'problem with transaction'],
    providerDependency: null,
  },
  {
    id: 'learn-how-to-recognise-a-scam',
    slug: 'how-to-recognise-a-scam',
    title: 'How to Recognise a Scam',
    articleType: 'safety',
    role: ['guest', 'user', 'merchant'],
    category: 'safety',
    summary: 'Common warning signs, in plain language, before you act on them.',
    sections: [
      {
        heading: 'Common warning signs',
        body: [
          'A price that’s far below similar listings, with pressure to decide quickly.',
          'A request to pay, or to continue the conversation, outside Unity -- this removes every protection the platform gives you.',
          'A "payment confirmation" screenshot sent to you directly instead of appearing on your own Unity booking or order -- always check your own account, never trust a forwarded confirmation.',
          'Anyone claiming to represent Unity and asking for your password, one-time PIN, or verification documents through chat or email -- Unity will never ask for your password or OTP.',
          'A link sent in a message that asks you to log in somewhere unfamiliar.',
          'Someone claiming to already be "verified" or "trusted" as a reason to skip a normal safety step.',
        ],
      },
      {
        heading: 'What to do if something feels off',
        body: ['Slow down, keep the conversation on Unity, and report the user or message if anything matches the signs above -- see "Marketplace Safety" for how to report.'],
      },
    ],
    relatedTaskIds: ['contact-user', 'report-purchase-problem'],
    relatedLearnIds: ['learn-staying-safe-meeting-someone', 'learn-what-verification-means', 'learn-cancellations-refunds-disputes'],
    keywords: ['scam', 'fraud', 'phishing', 'suspicious', 'is this a scam'],
    synonyms: ['fake buyer', 'fake seller', 'too good to be true', 'suspicious message'],
    providerDependency: null,
  },
  {
    id: 'learn-staying-safe-meeting-someone',
    slug: 'staying-safe-when-meeting-someone',
    title: 'Staying Safe When Meeting Someone',
    articleType: 'safety',
    role: ['guest', 'user'],
    category: 'safety',
    summary: 'Practical precautions for collection, delivery, and in-person handover.',
    sections: [
      {
        heading: 'Before you meet',
        body: ['Agree on a public, well-lit location and a specific time through Unity messaging, so there’s a record of what was agreed.'],
      },
      {
        heading: 'At handover',
        body: ['Check the item matches its listing before completing the exchange. For rentals, use condition photos at collection -- this protects both you and the other party if a dispute comes up later.'],
      },
      {
        heading: 'If something feels wrong',
        body: ['You’re never obligated to go through with an in-person exchange that feels unsafe -- leave, and report the situation afterward.'],
      },
    ],
    relatedTaskIds: ['manage-delivery', 'upload-pre-rental-media'],
    relatedLearnIds: ['learn-how-to-recognise-a-scam', 'learn-delivery-collection-handover'],
    keywords: ['meeting safely', 'in person exchange', 'collection safety', 'delivery safety'],
    synonyms: ['safe meetup', 'where to meet buyer'],
    providerDependency: null,
  },
  {
    id: 'learn-delivery-collection-handover',
    slug: 'delivery-collection-and-handover',
    title: 'Delivery, Collection & Handover',
    articleType: 'learn',
    role: ['user', 'merchant'],
    category: 'renting',
    summary: 'How handover works today, kept logistics-provider-neutral.',
    sections: [
      {
        heading: 'Arranging handover',
        body: ['Collection and delivery are arranged directly between the two parties through Unity messaging -- agree on a method, location, and time that works for both of you.'],
      },
      {
        heading: 'Documenting condition',
        body: ['For rentals especially, photograph the item’s condition at both collection and return -- this is the evidence a dispute would actually rely on if something is later disputed about damage or condition.'],
      },
      {
        heading: 'Where this stands today',
        body: ['A dedicated courier/logistics integration is not yet active in production, so delivery today is arranged directly between the parties rather than through an automated shipping/tracking provider. This article will be updated once that changes.'],
      },
      {
        heading: 'If handover fails or is delayed',
        body: ['If the other party doesn’t show up or handover is significantly delayed, message them first through Unity, and raise a dispute if it can’t be resolved -- see "Cancellations, Refunds & Disputes."'],
      },
    ],
    relatedTaskIds: ['manage-delivery', 'upload-pre-rental-media', 'upload-post-rental-media'],
    relatedLearnIds: ['learn-staying-safe-meeting-someone', 'learn-cancellations-refunds-disputes'],
    keywords: ['delivery', 'collection', 'handover', 'courier', 'tracking'],
    synonyms: ['shipping', 'how do i get the item', 'drop off'],
    providerDependency: 'bob-go',
  },
  {
    id: 'learn-marketplace-rules',
    slug: 'marketplace-rules-and-prohibited-behaviour',
    title: 'Marketplace Rules & Prohibited Behaviour',
    articleType: 'reference',
    role: ['guest', 'user', 'merchant'],
    category: 'account-privacy',
    summary: 'A plain-language summary of marketplace conduct rules.',
    sections: [
      {
        heading: 'Not allowed',
        body: [
          'Prohibited or illegal items, and misrepresenting an item’s condition, ownership, or authenticity.',
          'Spam, duplicate listings for the same item, and keyword-stuffed titles or descriptions.',
          'Harassment, abuse, or impersonating another person or Unity itself.',
          'Fake, manipulated, or revenge reviews.',
          'Attempting to move payment or communication off-platform to avoid fees or safety protections.',
        ],
      },
      {
        heading: 'Reporting and consequences',
        body: ['Any of the above can be reported directly from the relevant listing, profile, or message. Confirmed violations can lead to content removal, account restriction, or suspension depending on severity.'],
      },
      {
        heading: 'Full legal terms',
        body: ['This page summarizes the practical rules in plain language -- it doesn’t replace Unity’s full Terms of Service or Privacy Policy, which govern the legal relationship and take precedence over this summary.'],
      },
    ],
    relatedTaskIds: ['report-purchase-problem'],
    relatedLearnIds: ['learn-how-to-recognise-a-scam'],
    keywords: ['rules', 'prohibited', 'conduct', 'terms', 'what is not allowed'],
    synonyms: ['banned items', 'community guidelines', 'reporting abuse'],
    providerDependency: null,
  },

  // ──────────────────────────────────────────────────────────────
  // CURATED LEARNING PATH
  // ──────────────────────────────────────────────────────────────
  {
    id: 'learn-getting-better-results-on-unity',
    slug: 'getting-better-results-on-unity',
    title: 'Getting Better Results on Unity',
    articleType: 'reference',
    role: ['guest', 'user', 'merchant'],
    category: 'getting-started',
    summary: 'A curated path through Unity’s own guides for finding, listing, and trading more effectively.',
    sections: [
      {
        heading: 'As a buyer or renter',
        body: ['Start with "How to Get Better Search Results," then "Search Filters Explained" if you want to go deeper, and "How Marketplace Requests Work" for when searching alone isn’t enough.'],
      },
      {
        heading: 'As a seller or merchant',
        body: ['Start with "How to Write a Listing That Gets Found," then "Understanding Listing Statuses" to avoid common visibility surprises, and "Fees & Commissions Explained" to understand your plan’s economics.'],
      },
      {
        heading: 'For everyone',
        body: ['"What Verification Means (and Doesn’t Mean)" and "How Reviews Work" both help you build -- and correctly read -- trust signals on the platform. "How to Recognise a Scam" is worth reading once, regardless of how long you’ve used Unity.'],
      },
    ],
    relatedTaskIds: [],
    relatedLearnIds: [
      'learn-better-search-results',
      'learn-search-filters-explained',
      'learn-marketplace-requests',
      'learn-how-to-write-a-findable-listing',
      'learn-listing-statuses',
      'learn-fees-and-commissions',
      'learn-what-verification-means',
      'learn-how-reviews-work',
      'learn-how-to-recognise-a-scam',
    ],
    keywords: ['getting better results', 'learning path', 'tips', 'how to improve'],
    synonyms: ['how to use unity well', 'unity tips'],
    providerDependency: null,
  },
]
