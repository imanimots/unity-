import { describe, it, expect } from 'vitest'
import { isValidSkillTaskPostTransition } from '../status-transitions'

describe('isValidSkillTaskPostTransition -- AVAILABLE direction', () => {
  it('draft -> active is legal for the owner (publish)', () => {
    expect(isValidSkillTaskPostTransition('draft', 'active', 'available', 'owner')).toBe(true)
  })

  it('active -> paused is legal for the owner', () => {
    expect(isValidSkillTaskPostTransition('active', 'paused', 'available', 'owner')).toBe(true)
  })

  it('paused -> active is legal for the owner (resume)', () => {
    expect(isValidSkillTaskPostTransition('paused', 'active', 'available', 'owner')).toBe(true)
  })

  it('active -> archived is legal for the owner', () => {
    expect(isValidSkillTaskPostTransition('active', 'archived', 'available', 'owner')).toBe(true)
  })

  it('paused -> archived is legal for the owner', () => {
    expect(isValidSkillTaskPostTransition('paused', 'archived', 'available', 'owner')).toBe(true)
  })

  it('active -> suspended is legal, but only for admin', () => {
    expect(isValidSkillTaskPostTransition('active', 'suspended', 'available', 'admin')).toBe(true)
    expect(isValidSkillTaskPostTransition('active', 'suspended', 'available', 'owner')).toBe(false)
  })

  it('paused -> suspended is legal, but only for admin', () => {
    expect(isValidSkillTaskPostTransition('paused', 'suspended', 'available', 'admin')).toBe(true)
    expect(isValidSkillTaskPostTransition('paused', 'suspended', 'available', 'owner')).toBe(false)
  })

  it('suspended -> active is legal, but only for admin (restore)', () => {
    expect(isValidSkillTaskPostTransition('suspended', 'active', 'available', 'admin')).toBe(true)
    expect(isValidSkillTaskPostTransition('suspended', 'active', 'available', 'owner')).toBe(false)
  })

  it('suspended -> paused is legal, but only for admin (restore to prior paused state)', () => {
    expect(isValidSkillTaskPostTransition('suspended', 'paused', 'available', 'admin')).toBe(true)
    expect(isValidSkillTaskPostTransition('suspended', 'paused', 'available', 'owner')).toBe(false)
  })

  it('Available never reaches offers_received -- illegal from every current status', () => {
    expect(isValidSkillTaskPostTransition('draft', 'offers_received', 'available', 'owner')).toBe(false)
    expect(isValidSkillTaskPostTransition('active', 'offers_received', 'available', 'owner')).toBe(false)
    expect(isValidSkillTaskPostTransition('active', 'offers_received', 'available', 'system')).toBe(false)
  })

  it('Available never reaches matched -- illegal from every current status', () => {
    expect(isValidSkillTaskPostTransition('active', 'matched', 'available', 'system')).toBe(false)
    expect(isValidSkillTaskPostTransition('offers_received', 'matched', 'available', 'system')).toBe(false)
  })

  it('draft -> offers_received is illegal (must publish to active first)', () => {
    expect(isValidSkillTaskPostTransition('draft', 'offers_received', 'available', 'owner')).toBe(false)
  })

  it('draft -> paused is illegal (must publish first)', () => {
    expect(isValidSkillTaskPostTransition('draft', 'paused', 'available', 'owner')).toBe(false)
  })

  it('archived is a terminal state -- archived -> active is illegal', () => {
    expect(isValidSkillTaskPostTransition('archived', 'active', 'available', 'owner')).toBe(false)
  })

  it('closed is not a legal Available status at all -- active -> closed is illegal', () => {
    expect(isValidSkillTaskPostTransition('active', 'closed', 'available', 'owner')).toBe(false)
  })
})

describe('isValidSkillTaskPostTransition -- LOOKING_FOR direction', () => {
  it('draft -> active is legal for the owner (publish)', () => {
    expect(isValidSkillTaskPostTransition('draft', 'active', 'looking_for', 'owner')).toBe(true)
  })

  it('active -> offers_received is legal, but only for the system actor (first offer)', () => {
    expect(isValidSkillTaskPostTransition('active', 'offers_received', 'looking_for', 'system')).toBe(true)
    expect(isValidSkillTaskPostTransition('active', 'offers_received', 'looking_for', 'owner')).toBe(false)
    expect(isValidSkillTaskPostTransition('active', 'offers_received', 'looking_for', 'admin')).toBe(false)
  })

  it('offers_received -> matched is legal, but only for the system actor (on accept)', () => {
    expect(isValidSkillTaskPostTransition('offers_received', 'matched', 'looking_for', 'system')).toBe(true)
    expect(isValidSkillTaskPostTransition('offers_received', 'matched', 'looking_for', 'owner')).toBe(false)
    expect(isValidSkillTaskPostTransition('offers_received', 'matched', 'looking_for', 'admin')).toBe(false)
  })

  it('active -> closed is legal for the owner', () => {
    expect(isValidSkillTaskPostTransition('active', 'closed', 'looking_for', 'owner')).toBe(true)
  })

  it('offers_received -> closed is legal for the owner', () => {
    expect(isValidSkillTaskPostTransition('offers_received', 'closed', 'looking_for', 'owner')).toBe(true)
  })

  it('closed -> archived is legal for the owner', () => {
    expect(isValidSkillTaskPostTransition('closed', 'archived', 'looking_for', 'owner')).toBe(true)
  })

  it('matched -> archived is legal for the owner', () => {
    expect(isValidSkillTaskPostTransition('matched', 'archived', 'looking_for', 'owner')).toBe(true)
  })

  it('active -> suspended is legal, but only for admin', () => {
    expect(isValidSkillTaskPostTransition('active', 'suspended', 'looking_for', 'admin')).toBe(true)
    expect(isValidSkillTaskPostTransition('active', 'suspended', 'looking_for', 'owner')).toBe(false)
  })

  it('offers_received -> suspended is legal, but only for admin', () => {
    expect(isValidSkillTaskPostTransition('offers_received', 'suspended', 'looking_for', 'admin')).toBe(true)
    expect(isValidSkillTaskPostTransition('offers_received', 'suspended', 'looking_for', 'owner')).toBe(false)
  })

  it('suspended -> active is legal, but only for admin (restore)', () => {
    expect(isValidSkillTaskPostTransition('suspended', 'active', 'looking_for', 'admin')).toBe(true)
    expect(isValidSkillTaskPostTransition('suspended', 'active', 'looking_for', 'owner')).toBe(false)
  })

  it('suspended -> offers_received is legal, but only for admin (restore to prior offers_received state)', () => {
    expect(isValidSkillTaskPostTransition('suspended', 'offers_received', 'looking_for', 'admin')).toBe(true)
    expect(isValidSkillTaskPostTransition('suspended', 'offers_received', 'looking_for', 'owner')).toBe(false)
  })

  it('has no paused state at all -- active -> paused is illegal, unlike Available', () => {
    expect(isValidSkillTaskPostTransition('active', 'paused', 'looking_for', 'owner')).toBe(false)
    expect(isValidSkillTaskPostTransition('active', 'paused', 'looking_for', 'admin')).toBe(false)
  })

  it('draft -> matched is illegal (must go through the full offer lifecycle)', () => {
    expect(isValidSkillTaskPostTransition('draft', 'matched', 'looking_for', 'system')).toBe(false)
  })

  it('active -> matched is illegal -- must pass through offers_received first', () => {
    expect(isValidSkillTaskPostTransition('active', 'matched', 'looking_for', 'system')).toBe(false)
  })

  it('archived is terminal -- archived -> active is illegal', () => {
    expect(isValidSkillTaskPostTransition('archived', 'active', 'looking_for', 'admin')).toBe(false)
  })

  it('closed -> active is illegal (no reopening a closed Looking-For post)', () => {
    expect(isValidSkillTaskPostTransition('closed', 'active', 'looking_for', 'owner')).toBe(false)
  })
})

describe('isValidSkillTaskPostTransition -- direction is significant (same pair, different result)', () => {
  it('active -> paused is legal for Available but illegal for Looking-For', () => {
    expect(isValidSkillTaskPostTransition('active', 'paused', 'available', 'owner')).toBe(true)
    expect(isValidSkillTaskPostTransition('active', 'paused', 'looking_for', 'owner')).toBe(false)
  })

  it('active -> closed is legal for Looking-For but illegal for Available', () => {
    expect(isValidSkillTaskPostTransition('active', 'closed', 'looking_for', 'owner')).toBe(true)
    expect(isValidSkillTaskPostTransition('active', 'closed', 'available', 'owner')).toBe(false)
  })
})
