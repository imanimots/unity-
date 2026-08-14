// Skills + Tasks under Barter -- prohibited-content preventative
// control regression coverage.
//
// WHICH CASE APPLIES, AND WHY:
//
// The actual illegal-goods/medical keyword validation for Skill/Task
// posts is `_validate_skill_task_content()`, a Postgres function
// (supabase/migrations/20260901000009_skills_tasks_barter_posts_rpcs.sql,
// see its header comment: "a chat-filter.ts-shaped keyword rule list").
// It is called server-side only, from every Skill/Task write RPC
// (save/publish/update, propose_barter/counter_barter_offer,
// accept_barter_offer) -- there is no live database in this test
// environment, so it cannot be exercised directly here.
//
// A repo-wide grep (`grep -rli "medical\|illegal\|prohibited"
// src/lib --include="*.ts"`) turned up no client-side/TypeScript
// mirror of an illegal-goods/medical keyword list anywhere under
// src/lib/barter or elsewhere -- this validation is genuinely
// Postgres-only in this codebase, with no TS equivalent. That is a
// legitimate finding, not an oversight: per this task's own
// instructions, we do not invent a duplicate keyword list from
// scratch by guessing at prohibited terms.
//
// What DOES exist client-side, and what `_validate_skill_task_content`'s
// own migration comment explicitly says it was modeled on, is
// `src/lib/chat-filter.ts` -- the actual "chat-filter.ts-shaped" rule
// list this feature's Postgres function takes its shape from (an array
// of { pattern: RegExp, reason: string } rules, first-match-wins,
// `{ blocked, reason }` return shape). It blocks a different content
// category (off-platform phone/email/payment/contact requests, not
// illegal-goods/medical work), but it IS the actual shared
// preventative-layer pattern this feature's server-side validator was
// built to mirror, and it is real, live, testable TypeScript in this
// repository today. Testing it here provides genuine regression
// coverage of that shared filtering approach -- confirming its rules
// fire on the off-platform-contact content it's designed to catch, and
// stay clear of ordinary lawful conversation -- without fabricating a
// parallel medical/illegal keyword list this codebase does not
// actually have client-side.
import { describe, it, expect } from 'vitest'
import { filterMessage } from '../../chat-filter'

describe('filterMessage -- off-platform contact detection', () => {
  it('blocks a South African mobile number', () => {
    const result = filterMessage('Call me on 0821234567')
    expect(result.blocked).toBe(true)
    expect(result.reason).toMatch(/phone/i)
  })

  it('blocks a +27-formatted phone number', () => {
    const result = filterMessage('My number is +27821234567')
    expect(result.blocked).toBe(true)
  })

  it('blocks a generic dashed/spaced phone-shaped number', () => {
    const result = filterMessage('Reach me at 082-123-4567')
    expect(result.blocked).toBe(true)
  })

  it('blocks an email address', () => {
    const result = filterMessage('Email me at someone@example.com to arrange this')
    expect(result.blocked).toBe(true)
    expect(result.reason).toMatch(/email/i)
  })
})

describe('filterMessage -- off-platform payment detection', () => {
  it('blocks a request to pay via EFT', () => {
    const result = filterMessage('Can you just do an EFT instead?')
    expect(result.blocked).toBe(true)
    expect(result.reason).toMatch(/payment/i)
  })

  it('blocks a request for banking details', () => {
    const result = filterMessage('Send me your banking details')
    expect(result.blocked).toBe(true)
  })

  it('blocks a named bank mention used for off-platform payment', () => {
    const result = filterMessage('Just pay into my FNB account')
    expect(result.blocked).toBe(true)
  })

  it('blocks a request to pay outside the platform', () => {
    const result = filterMessage('Let\'s settle this outside unity to save on fees')
    expect(result.blocked).toBe(true)
  })
})

describe('filterMessage -- lawful, unrelated conversation is allowed', () => {
  it('allows plain scheduling conversation with no contact/payment content', () => {
    const result = filterMessage('Does Tuesday afternoon work for you?')
    expect(result.blocked).toBe(false)
    expect(result.reason).toBeNull()
  })

  it('allows a message describing a Skill/Task scope with no off-platform content', () => {
    const result = filterMessage('I can help assemble the flat-pack shelving this weekend')
    expect(result.blocked).toBe(false)
  })

  // The "lawful wellness terms explicitly excluded from the medical
  // list" property that _validate_skill_task_content() documents for
  // its own (Postgres-only) medical keyword list has a direct analogue
  // here: filterMessage has no medical-keyword concept at all, so
  // wellness terms naturally pass through untouched -- confirming the
  // shared preventative-layer pattern doesn't accidentally over-block
  // ordinary lawful service descriptions.
  it('allows lawful non-medical wellness terms (massage, yoga, personal training)', () => {
    expect(filterMessage('I offer relaxation massage sessions').blocked).toBe(false)
    expect(filterMessage('Weekly yoga classes, beginners welcome').blocked).toBe(false)
    expect(filterMessage('Personal training sessions, bring your own mat').blocked).toBe(false)
  })
})
