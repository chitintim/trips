import { describe, it, expect } from 'vitest'
import { getWaitlistQueue, getNextWaitlistOffer, computeOfferExpiry, DEFAULT_WAITLIST_OFFER_HOURS } from './waitlist'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

function participant(overrides: Partial<ParticipantWithUser> & { user_id: string }): ParticipantWithUser {
  return {
    trip_id: 'trip-1',
    role: 'participant',
    active: true,
    confirmation_status: 'waitlist',
    confirmation_note: null,
    confirmed_at: null,
    conditional_type: 'none',
    conditional_date: null,
    conditional_user_ids: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    waitlist_offer_expires_at: null,
    user: { id: overrides.user_id, full_name: overrides.user_id, email: `${overrides.user_id}@example.com` } as ParticipantWithUser['user'],
    ...overrides,
  } as ParticipantWithUser
}

describe('getWaitlistQueue', () => {
  it('orders by updated_at ascending (earliest waitlisted first)', () => {
    const participants = [
      participant({ user_id: 'b', updated_at: '2026-02-02T00:00:00Z' }),
      participant({ user_id: 'a', updated_at: '2026-02-01T00:00:00Z' }),
    ]
    const queue = getWaitlistQueue(participants)
    expect(queue.map((e) => e.participant.user_id)).toEqual(['a', 'b'])
    expect(queue[0].position).toBe(1)
    expect(queue[1].position).toBe(2)
  })

  it('excludes non-waitlisted participants', () => {
    const participants = [participant({ user_id: 'a', confirmation_status: 'confirmed' })]
    expect(getWaitlistQueue(participants)).toHaveLength(0)
  })

  it('flags an active offer when expiry is in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const participants = [participant({ user_id: 'a', waitlist_offer_expires_at: future })]
    const queue = getWaitlistQueue(participants)
    expect(queue[0].hasActiveOffer).toBe(true)
    expect(queue[0].offerExpired).toBe(false)
  })

  it('flags an expired offer when expiry is in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const participants = [participant({ user_id: 'a', waitlist_offer_expires_at: past })]
    const queue = getWaitlistQueue(participants)
    expect(queue[0].hasActiveOffer).toBe(false)
    expect(queue[0].offerExpired).toBe(true)
  })
})

describe('getNextWaitlistOffer', () => {
  it('returns the first person in queue when nobody has an active offer', () => {
    const queue = getWaitlistQueue([participant({ user_id: 'a' }), participant({ user_id: 'b', updated_at: '2026-02-02T00:00:00Z' })])
    expect(getNextWaitlistOffer(queue)?.participant.user_id).toBe('a')
  })

  it('returns null when someone already has a live offer (one at a time)', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const queue = getWaitlistQueue([participant({ user_id: 'a', waitlist_offer_expires_at: future })])
    expect(getNextWaitlistOffer(queue)).toBeNull()
  })

  it('skips past an expired offer to the next unresolved person', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const queue = getWaitlistQueue([
      participant({ user_id: 'a', waitlist_offer_expires_at: past, updated_at: '2026-02-01T00:00:00Z' }),
      participant({ user_id: 'b', updated_at: '2026-02-02T00:00:00Z' }),
    ])
    expect(getNextWaitlistOffer(queue)?.participant.user_id).toBe('b')
  })
})

describe('computeOfferExpiry', () => {
  it('defaults to 48 hours out', () => {
    const now = Date.now()
    const expiry = new Date(computeOfferExpiry(now)).getTime()
    expect(expiry - now).toBe(DEFAULT_WAITLIST_OFFER_HOURS * 60 * 60 * 1000)
  })

  it('respects a custom hours window', () => {
    const now = Date.now()
    const expiry = new Date(computeOfferExpiry(now, 24)).getTime()
    expect(expiry - now).toBe(24 * 60 * 60 * 1000)
  })
})
